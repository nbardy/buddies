import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  ExpeditionProposal,
  ExpeditionQuestion,
  ExpeditionStep,
  ExpeditionView,
} from '@unleashd/shared';
import type { ExecutionGate } from '../buddies/execution-gate';
import type { Call } from './author';
import { type CallDeps, type Receipt, execute } from './call';
import { resolveBase } from './cambium';
import { runPlan } from './child';
import { type Contract, defaultCap, gates } from './gates';

export const hash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
// The manager can propose these terms. Only the existing owner-answer route can accept them.
const revisable = ['goal', 'rules', 'done', 'autoApply'] as const;
type Revision = {
  from: number;
  hash: string;
  contract: Contract;
  why: string;
  keep: string[];
};
type Entry =
  | {
      t: 'launch';
      workspaceId: string;
      contract: Contract;
      repo: string;
      base: string;
      baseLine: string;
      at: number;
    }
  | {
      t: 'plan';
      version: number;
      hash: string;
      revision?: Revision;
      retire?: string[];
      approval?: string;
    }
  | { t: 'start'; call: Call; hash: string }
  | { t: 'result'; key: string; hash: string; receipt: Receipt }
  | { t: 'wake'; key: string; cost: number }
  | ({ t: 'question'; revision?: Revision } & ExpeditionQuestion)
  | { t: 'answer'; key: string; value: unknown }
  | { t: 'status'; status: ExpeditionView['status']; reason?: string };
// Pattern: one-store-one-index (docs/patterns.md#one-store-one-index)
// Fold each entry once, on append or boot. Guard: expedition-backend replay and budget.
class Run {
  launch!: Extract<Entry, { t: 'launch' }>;
  readonly steps = new Map<string, { call: Call; receipt?: Receipt }>();
  readonly questions = new Map<string, ExpeditionQuestion & { revision?: Revision }>();
  readonly answers = new Map<string, Extract<Entry, { t: 'answer' }>>();
  readonly wakes = new Map<string, number>();
  readonly versions: number[] = [];
  status: Extract<Entry, { t: 'status' }> = { t: 'status', status: 'running' };
  readonly active = new Map<string, { abort: AbortController; done: Promise<Receipt> }>();
  readonly waiters = new Map<string, (v: unknown) => void>();
  child?: ReturnType<typeof runPlan>;
  constructor(
    readonly id: string,
    readonly folder: string,
    entries: Entry[] = []
  ) {
    for (const e of entries) this.fold(e);
  }
  fold(e: Entry) {
    switch (e.t) {
      case 'launch':
        this.launch = e;
        break;
      case 'plan':
        this.versions.push(e.version);
        if (e.revision) {
          this.launch = { ...this.launch, contract: e.revision.contract };
          this.status = { t: 'status', status: 'running', reason: e.revision.why };
        }
        if (e.approval) this.answers.set(e.approval, { t: 'answer', key: e.approval, value: true });
        for (const key of e.retire ?? []) {
          if (this.questions.get(key)?.kind === 'manager' && e.revision)
            this.answers.set(key, { t: 'answer', key, value: e.revision.why });
          this.questions.delete(key);
        }
        break;
      case 'start':
        this.steps.set(e.hash, { call: e.call });
        break;
      case 'result':
        this.steps.get(e.hash)!.receipt = e.receipt;
        break;
      case 'wake':
        this.wakes.set(e.key, e.cost);
        break;
      case 'question':
        this.questions.set(e.key, e);
        break;
      case 'answer':
        this.answers.set(e.key, e);
        this.questions.delete(e.key);
        break;
      case 'status':
        this.status = e;
        break;
    }
  }
}
export function createExpeditions(
  d: CallDeps & {
    root: string;
    gate: ExecutionGate;
    wake(id: string, buddyId: string, question: string, folder: string, key: string): Promise<void>;
  }
) {
  const runs = new Map<string, Run>();
  const slots = new Map<string, Set<Promise<unknown>>>();
  async function admitted<T>(
    keys: string[],
    contract: Contract,
    run: () => Promise<T>
  ): Promise<T> {
    const pools = [...new Set(keys)].map((key) => {
      const pool = slots.get(key) ?? new Set<Promise<unknown>>();
      slots.set(key, pool);
      return { pool, limit: contract.pools[key] ?? 1 };
    });
    while (pools.some(({ pool, limit }) => pool.size >= limit))
      await Promise.race(pools.flatMap(({ pool }) => [...pool].map((p) => p.catch(() => {}))));
    const work = Promise.resolve().then(run);
    for (const { pool } of pools) pool.add(work);
    try {
      return await work;
    } finally {
      for (const { pool } of pools) pool.delete(work);
    }
  }
  const capOf = (c: Call, contract: Contract) =>
    c.usd +
    (c.t === 'agent' && c.judge && 'review' in c.judge
      ? (contract.doneReview ?? defaultCap(contract)).usd
      : 0);
  const allowed = () => {
    if (d.gate.t === 'disabled') throw Object.assign(new Error(d.gate.reason), { status: 503 });
  };
  const get = (id: string) => {
    const run = runs.get(id);
    if (!run) throw new Error(`No expedition ${id}`);
    return run;
  };
  // Pattern: one-write-path (docs/patterns.md#one-write-path)
  const append = (r: Run, e: Entry) => {
    allowed();
    fs.appendFileSync(path.join(r.folder, 'log.jsonl'), `${JSON.stringify(e)}\n`, { mode: 0o600 });
    r.fold(e);
  };
  const known = (r: Run, call: Call) => r.steps.get(hash(call))?.receipt?.result;
  function view(id: string): ExpeditionView {
    const r = get(id);
    const steps: ExpeditionStep[] = [];
    let spend = [...r.wakes.values()].reduce((a, b) => a + b, 0);
    let reserved = 0;
    for (const [hash, { call, receipt }] of r.steps) {
      if (receipt) spend += receipt.cost;
      else reserved += capOf(call, r.launch.contract);
      if (call.t === 'question') continue;
      const row = (key: string, who: string, value?: Receipt): ExpeditionStep => ({
        key,
        hash,
        who,
        state: value?.result.t ?? 'running',
        cost: value?.cost ?? 0,
        conversationId: value?.conversationId,
        commit: receipt?.commit,
        why: value?.why ?? (value && 'why' in value.result ? value.result.why : undefined),
      });
      steps.push({
        ...row(call.key, call.t === 'agent' ? call.by : call.t, receipt),
        cost: (receipt?.cost ?? 0) - (receipt?.review?.cost ?? 0),
      });
      if (receipt?.review)
        steps.push(row(`${call.key}/review`, receipt.review.who, receipt.review));
    }
    return {
      id,
      workspaceId: r.launch.workspaceId,
      goal: r.launch.contract.goal,
      budget: r.launch.contract.budget,
      status: r.status.status,
      reason: r.status.reason,
      spend,
      reserved,
      steps,
      questions:
        r.status.status === 'stopped'
          ? []
          : [...r.questions.values()].map(({ key, question, kind }) => ({ key, question, kind })),
      versions: r.versions,
    };
  }
  async function question(
    r: Run,
    key: string,
    question: string,
    kind: ExpeditionQuestion['kind']
  ): Promise<unknown> {
    const answered = r.answers.get(key);
    if (answered) return answered.value;
    if (!r.questions.has(key)) append(r, { t: 'question', key, question, kind });
    const waiting = new Promise((resolve) => r.waiters.set(key, resolve));
    if (kind === 'manager') {
      append(r, { t: 'status', status: 'held', reason: question });
      if (!r.wakes.has(key)) {
        const cost = (r.launch.contract.leaderWake ?? defaultCap(r.launch.contract)).usd;
        const v = view(r.id);
        if (v.spend + v.reserved + cost > v.budget.usd) return waiting;
        append(r, { t: 'wake', key, cost });
      }
      await d.wake(r.id, r.launch.contract.leader.slice(6), question, r.folder, key);
    }
    return waiting;
  }
  async function step(r: Run, call: Call): Promise<Receipt> {
    const h = hash(call),
      token = hash([r.id, call.key, h]);
    const saved = r.steps.get(h)?.receipt;
    if (saved) return saved;
    const existing = r.active.get(token);
    if (existing) return existing.done;
    const previousStart = r.steps.has(h);
    const v = view(r.id),
      cap = capOf(call, r.launch.contract);
    if (!Number.isFinite(cap) || cap < 0) throw new Error('Invalid step cap');
    if (!previousStart) {
      if (v.spend + v.reserved + cap > v.budget.usd + 1e-9) {
        const receipt: Receipt = { cost: 0, result: { t: 'refused', reason: 'budget' } };
        append(r, { t: 'start', call: { ...call, usd: 0 }, hash: h });
        append(r, { t: 'result', key: call.key, hash: h, receipt });
        return receipt;
      }
      append(r, { t: 'start', call, hash: h });
    }
    const abort = new AbortController();
    const work = async (): Promise<Receipt> => {
      if (call.t === 'question') {
        const out = await question(r, call.key, call.question, call.kind);
        if (abort.signal.aborted && !r.answers.has(call.key))
          return { cost: 0, result: { t: 'cancelled', partial: { id: token } } };
        return {
          cost: 0,
          result: {
            t: 'passed',
            out,
            ref: { id: token },
          },
        };
      }
      const launch = r.launch;
      if (Date.now() > launch.at + launch.contract.budget.hours * 3600000)
        return { cost: 0, result: { t: 'refused', reason: 'deadline' } };
      return admitted(call.needs, launch.contract, () =>
        execute(
          {
            ...d,
            runTurn: (request) =>
              admitted([request.provider], launch.contract, () => {
                if (abort.signal.aborted) throw new Error('Cancelled before turn admission');
                return d.runTurn(request);
              }),
          },
          call,
          { ...launch, token, folder: r.folder, signal: abort.signal }
        )
      );
    };
    const done = work()
      .catch(
        (error) => ({ cost: cap, result: { t: 'errored', why: String(error) } }) satisfies Receipt
      )
      .then(async (receipt) => {
        append(r, { t: 'result', key: call.key, hash: h, receipt });
        // Owner Stop holds even a .try call; rewrite/manager cancellation has an aborted signal.
        // Guard: expedition-backend owner Stop never starts the next step.
        if (receipt.result.t === 'cancelled' && !abort.signal.aborted) {
          await r.child?.kill();
          void hold(r, `Step ${call.key} cancelled by owner Stop`);
        }
        return receipt;
      })
      .finally(() => r.active.delete(token));
    r.active.set(token, { abort, done });
    return done;
  }
  function evaluate(r: Run) {
    const version = view(r.id).versions.at(-1)!;
    r.child = runPlan(path.join(r.folder, 'plans', `v${version}.expedition.ts`), (m, reply) => {
      if (r.versions.at(-1) !== version || r.status.status === 'stopped') return;
      switch (m.t) {
        case 'contract':
        case 'waiting':
          break;
        case 'call':
          void step(r, m.call).then((r) => reply(r.result));
          break;
        case 'end':
          void finish(r, m.result, version).catch((error) => {
            if (r.versions.at(-1) === version) return hold(r, String(error));
          });
          break;
        case 'error':
          void hold(r, m.why);
          break;
      }
    });
  }
  async function hold(r: Run, why: string) {
    append(r, { t: 'status', status: 'held', reason: why });
    await question(r, `failure/${hash(why)}`, why, 'manager');
  }
  async function finish(
    r: Run,
    result: { out: unknown; ref: { commit?: string } },
    version: number
  ) {
    const current = () => r.versions.at(-1) === version && r.status.status !== 'stopped';
    const c = r.launch.contract;
    for (const [i, done] of c.done.entries()) {
      if ('owner' in done) {
        const accepted = await question(
          r,
          `done/${i}/${hash(result)}`,
          `${done.owner}\nCandidate: ${JSON.stringify(result)}`,
          'confirm'
        );
        if (!current()) return;
        if (!accepted) return hold(r, `Owner declined: ${done.owner}`);
      } else {
        const call: Call = {
          key: `done/${i}`,
          usd: 0,
          minutes: (c.doneReview ?? defaultCap(c)).minutes,
          needs: [],
          inputs: { on: result as never, reads: [result as never] },
          output: null,
          ...('check' in done
            ? ({ t: 'command', command: done.check } as const)
            : ({
                t: 'agent',
                by: done.by,
                brief: `Review and quote the supplied work. ${done.review}`,
                reads: [],
                checkout: false,
                web: false,
                output: (await import('./call')).verdict,
                usd: (c.doneReview ?? defaultCap(c)).usd,
              } as const)),
        };
        if (!current()) return;
        const receipt = await step(r, call);
        if (!current()) return;
        if (
          receipt.result.t !== 'passed' ||
          ('review' in done && (receipt.result.out as { verdict: string }).verdict !== 'yes')
        )
          return hold(r, `Done criterion ${i} failed: ${JSON.stringify(receipt.result)}`);
      }
    }
    append(r, { t: 'status', status: 'met' });
  }
  function install(r: Run, revision: Revision, source: string, approval?: string) {
    if (revision.from !== r.versions.at(-1) || ['met', 'stopped'].includes(r.status.status))
      throw new Error('This revision is stale');
    if (hash(source) !== revision.hash)
      throw new Error('Revision source does not match its approval');
    const version = revision.from + 1;
    fs.writeFileSync(path.join(r.folder, 'plans', `v${version}.expedition.ts`), source);
    const keep = new Set(revision.keep);
    const droppedQuestions = new Set<string>();
    for (const [token, active] of r.active) {
      if (!keep.has(token)) {
        active.abort.abort();
      }
    }
    for (const [h, { call, receipt }] of r.steps)
      if (call.t === 'question' && !receipt && !keep.has(hash([r.id, call.key, h])))
        droppedQuestions.add(call.key);
    const retire = [...r.questions.values()]
      .filter(
        (q) =>
          q.revision ||
          q.kind === 'manager' ||
          q.key.startsWith('done/') ||
          q.key.startsWith('rewrite/') ||
          droppedQuestions.has(q.key)
      )
      .map((q) => q.key);
    // Commit the accepted terms, retired prompts and version together. A crash replays this exact file.
    append(r, { t: 'plan', version, hash: revision.hash, revision, retire, approval });
    void r.child?.kill();
    for (const key of retire) {
      r.waiters.get(key)?.(r.answers.get(key)?.value);
      r.waiters.delete(key);
    }
    evaluate(r);
    return view(r.id);
  }
  return {
    allowed,
    view,
    rows: () => [...runs.keys()].map(view),
    async boot() {
      if (!fs.existsSync(d.root)) return;
      for (const id of fs.readdirSync(d.root)) {
        const folder = path.join(d.root, id);
        const log = fs
          .readFileSync(path.join(folder, 'log.jsonl'), 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line) as Entry);
        const r = new Run(id, folder, log);
        runs.set(id, r);
        if (d.gate.t === 'enabled' && !['met', 'stopped'].includes(r.status.status)) evaluate(r);
      }
    },
    async launch(
      p: Omit<ExpeditionProposal, 'preview'> & { preview?: ExpeditionProposal['preview'] }
    ) {
      const { file, hash: contentHash, workspaceId, source: content } = p;
      allowed();
      const source = content ?? fs.readFileSync(file, 'utf8');
      if (hash(source) !== contentHash) throw new Error('Plan changed; propose again');
      const checked = await gates(file, undefined, content);
      if (content === undefined && fs.readFileSync(file, 'utf8') !== source)
        throw new Error('Plan changed during gates');
      const id = randomUUID(),
        folder = path.join(d.root, id);
      const repo = checked.contract.repo.replace(/^~(?=\/)/, os.homedir());
      const base = p.preview?.start ?? (await resolveBase(repo, checked.contract.base));
      fs.mkdirSync(path.join(folder, 'plans'), { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(folder, 'plan.expedition.ts'), source);
      fs.writeFileSync(path.join(folder, 'plans/v1.expedition.ts'), source);
      const r = new Run(id, folder);
      runs.set(id, r);
      append(r, {
        t: 'launch',
        workspaceId,
        contract: checked.contract,
        base: base.commit,
        baseLine: base.line,
        repo,
        at: Date.now(),
      });
      append(r, { t: 'plan', version: 1, hash: contentHash });
      evaluate(r);
      return view(id);
    },
    answer(id: string, key: string, value: unknown) {
      allowed();
      const r = get(id),
        q = r.questions.get(key);
      if (['met', 'stopped'].includes(r.status.status)) throw new Error('Expedition is finished');
      if (
        !q ||
        q.kind === 'manager' ||
        (q.kind === 'confirm' ? typeof value !== 'boolean' : typeof value !== 'string')
      )
        throw new Error('Invalid or closed owner question');
      if (q.revision && value === true)
        return install(
          r,
          q.revision,
          fs.readFileSync(path.join(r.folder, 'plans', q.revision.hash + '.ts'), 'utf8'),
          key
        );
      append(r, { t: 'answer', key, value });
      r.waiters.get(key)?.(value);
      r.waiters.delete(key);
      return view(id);
    },
    async act(id: string, buddyId: string, action: 'continue' | 'stop' | 'rewrite', why: string) {
      allowed();
      const r = get(id);
      if (r.launch.contract.leader !== `buddy:${buddyId}`)
        throw new Error('Only the manager may act');
      if (['met', 'stopped'].includes(r.status.status)) throw new Error('Expedition is finished');
      if (action === 'rewrite') {
        const from = r.versions.at(-1)!;
        const file = path.join(r.folder, 'plan.expedition.ts'),
          source = fs.readFileSync(file, 'utf8');
        const open = new Set(
          view(id)
            .questions.filter((q) => q.kind === 'manager')
            .map((q) => q.key)
        );
        const checked = await gates(
          file,
          (c) =>
            known(r, c) ??
            (c.t === 'question' && c.kind === 'manager' && open.has(c.key)
              ? { t: 'passed', out: why, ref: { id: hash(c) } }
              : undefined),
          source
        );
        const original = r.launch.contract;
        const next = checked.contract;
        const mutable = new Set<string>(revisable);
        if (
          Object.keys(original)
            .concat(Object.keys(next))
            .some(
              (k) =>
                !mutable.has(k) &&
                hash([original[k as keyof Contract]]) !== hash([next[k as keyof Contract]])
            )
        )
          return {
            issues: [
              'The owner contract changed outside goal, rules, done or autoApply. Keep the original budget, deadline, repository and manager.',
            ],
          };
        if (
          fs.readFileSync(file, 'utf8') !== source ||
          from !== r.versions.at(-1) ||
          ['met', 'stopped'].includes(r.status.status)
        )
          return { issues: ['Plan or run changed during gates'] };
        const extra = checked.preview.costUsd;
        const changed = revisable.filter((k) => hash(original[k]) !== hash(next[k]));
        const revision: Revision = {
          from,
          hash: hash(source),
          why,
          contract: next,
          keep: checked.calls.map((c) => hash([r.id, c.key, hash(c)])),
        };
        if (changed.length || extra > original.autoApply.usd) {
          const key = `rewrite/${from}/${revision.hash}`;
          if (r.answers.get(key)?.value === false)
            return { issues: ['Owner declined this rewrite'] };
          if (!r.questions.has(key)) {
            const v = view(id);
            const differences = changed.map((k) =>
              k === 'goal'
                ? `Revised goal\n${next.goal}`
                : `${k}: ${JSON.stringify(original[k])} → ${JSON.stringify(next[k])}`
            );
            const prompt = [
              `Revise this expedition in place? ${why}`,
              `Next steps: ${checked.calls.map((c) => c.key).join(', ') || 'none'}. Up to $${extra} within the existing $${v.budget.usd} ceiling ($${v.spend} booked, $${v.reserved} reserved).`,
              ...differences,
            ].join('\n');
            fs.writeFileSync(path.join(r.folder, 'plans', revision.hash + '.ts'), source);
            append(r, { t: 'question', key, kind: 'confirm', question: prompt, revision });
          }
          return view(id);
        }
        return install(r, revision, source);
      }
      // Continuing also replays once; keeping the old child could run two plan loops.
      // Guard: expedition-backend manager actions reuse finished keys.
      await r.child?.kill();
      for (const q of view(id).questions.filter((q) => q.kind === 'manager')) {
        append(r, { t: 'answer', key: q.key, value: why });
        r.waiters.get(q.key)?.(why);
        r.waiters.delete(q.key);
      }
      if (action === 'stop') {
        await r.child?.kill();
        for (const a of r.active.values()) a.abort.abort();
        append(r, { t: 'status', status: 'stopped', reason: why });
      } else {
        append(r, { t: 'status', status: 'running', reason: why });
        evaluate(r);
      }
      return view(id);
    },
    async close() {
      for (const r of runs.values()) await r.child?.kill();
    },
  };
}
export type Expeditions = ReturnType<typeof createExpeditions>;
