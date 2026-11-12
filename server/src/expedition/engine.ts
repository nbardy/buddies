import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ExpeditionQuestion, ExpeditionView } from '@unleashd/shared';
import type { ExecutionGate } from '../buddies/execution-gate';
import type { RunTurnOutcome } from '../turns/run-turn';
import type { Call } from './author';
import { type CallDeps, type Receipt, execute } from './call';
import { git } from './cambium';
import { runPlan } from './child';
import { type Contract, defaultCap, gates } from './gates';

export const hash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
type Entry =
  | { t: 'launch'; workspaceId: string; contract: Contract; repo: string; base: string; at: number }
  | { t: 'plan'; version: number; hash: string }
  | { t: 'start'; call: Call; hash: string }
  | { t: 'result'; key: string; hash: string; receipt: Receipt }
  | { t: 'wake'; key: string; cost: number }
  | ({ t: 'question' } & ExpeditionQuestion)
  | { t: 'answer'; key: string; value: unknown }
  | { t: 'status'; status: ExpeditionView['status']; reason?: string };
type Run = {
  id: string;
  folder: string;
  log: Entry[];
  active: Map<string, { abort: AbortController; done: Promise<Receipt> }>;
  waiters: Map<string, (v: unknown) => void>;
  child?: ReturnType<typeof runPlan>;
};
export function createExpeditions(
  d: CallDeps & {
    root: string;
    gate: ExecutionGate;
    wake(id: string, buddyId: string, question: string, folder: string, key: string): Promise<void>;
  }
) {
  const runs = new Map<string, Run>();
  const slots = new Map<string, Set<Promise<RunTurnOutcome>>>();
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
    r.log.push(e);
  };
  const launchOf = (r: Run) => r.log[0] as Extract<Entry, { t: 'launch' }>;
  const answerOf = (r: Run, key: string) =>
    r.log.find((e) => e.t === 'answer' && e.key === key) as
      | Extract<Entry, { t: 'answer' }>
      | undefined;
  const known = (r: Run, call: Call) =>
    (
      r.log.find((e) => e.t === 'result' && e.key === call.key && e.hash === hash(call)) as
        | Extract<Entry, { t: 'result' }>
        | undefined
    )?.receipt.result;
  const status = (r: Run) =>
    (
      [...r.log].reverse().find((e) => e.t === 'status') as
        | Extract<Entry, { t: 'status' }>
        | undefined
    )?.status ?? 'running';
  function view(id: string): ExpeditionView {
    const r = get(id),
      launch = launchOf(r);
    const started = new Map<string, Call>(),
      settled = new Map<string, Receipt>();
    let wakes = 0;
    const questions = new Map<string, ExpeditionQuestion>();
    for (const e of r.log) {
      if (e.t === 'start') started.set(e.hash, e.call);
      if (e.t === 'result') settled.set(e.hash, e.receipt);
      if (e.t === 'wake') wakes += e.cost;
      if (e.t === 'question') questions.set(e.key, e);
      if (e.t === 'answer') questions.delete(e.key);
    }
    const latest = [...r.log].reverse().find((e) => e.t === 'status') as
      | Extract<Entry, { t: 'status' }>
      | undefined;
    return {
      id,
      workspaceId: launch.workspaceId,
      goal: launch.contract.goal,
      budget: launch.contract.budget,
      status: status(r),
      spend: wakes + [...settled.values()].reduce((n, r) => n + r.cost, 0),
      reserved: [...started].reduce(
        (n, [h, c]) => n + (settled.has(h) ? 0 : capOf(c, launch.contract)),
        0
      ),
      questions: [...questions.values()],
      versions: r.log.flatMap((e) => (e.t === 'plan' ? [e.version] : [])),
      reason: latest?.reason,
      steps: r.log.flatMap((e) => {
        if (e.t !== 'start') return [];
        const result = r.log.find(
          (x) => x.t === 'result' && x.key === e.call.key && x.hash === e.hash
        ) as Extract<Entry, { t: 'result' }> | undefined;
        const receipt = result?.receipt;
        return [
          {
            key: e.call.key,
            hash: e.hash,
            who: e.call.t === 'agent' ? e.call.by : e.call.t,
            state: receipt?.result.t ?? 'running',
            cost: receipt?.cost ?? 0,
            conversationId: receipt?.conversationId,
            commit: receipt?.commit,
            why:
              receipt?.why ?? (receipt && 'why' in receipt.result ? receipt.result.why : undefined),
          },
        ];
      }),
    };
  }
  async function question(
    r: Run,
    key: string,
    question: string,
    kind: ExpeditionQuestion['kind']
  ): Promise<unknown> {
    const answered = answerOf(r, key);
    if (answered) return answered.value;
    if (!r.log.some((e) => e.t === 'question' && e.key === key))
      append(r, { t: 'question', key, question, kind });
    const waiting = new Promise((resolve) => r.waiters.set(key, resolve));
    if (kind === 'manager') {
      append(r, { t: 'status', status: 'held', reason: question });
      if (!r.log.some((e) => e.t === 'wake' && e.key === key)) {
        const cost = (launchOf(r).contract.leaderWake ?? defaultCap(launchOf(r).contract)).usd;
        const v = view(r.id);
        if (v.spend + v.reserved + cost > v.budget.usd) return waiting;
        append(r, { t: 'wake', key, cost });
      }
      await d.wake(r.id, launchOf(r).contract.leader.slice(6), question, r.folder, key);
    }
    return waiting;
  }
  async function step(r: Run, call: Call): Promise<Receipt> {
    const h = hash(call),
      token = hash([r.id, call.key, h]);
    const saved = r.log.find((e) => e.t === 'result' && e.key === call.key && e.hash === h) as
      | Extract<Entry, { t: 'result' }>
      | undefined;
    if (saved) return saved.receipt;
    const existing = r.active.get(token);
    if (existing) return existing.done;
    const previousStart = r.log.some((e) => e.t === 'start' && e.hash === h);
    const v = view(r.id),
      cap = capOf(call, launchOf(r).contract);
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
      if (call.t === 'question')
        return {
          cost: 0,
          result: {
            t: 'passed',
            out: await question(r, call.key, call.question, call.kind),
            ref: { id: token },
          },
        };
      const launch = launchOf(r);
      if (Date.now() > launch.at + launch.contract.budget.hours * 3600000)
        return { cost: 0, result: { t: 'refused', reason: 'deadline' } };
      return execute(
        {
          ...d,
          runTurn: async (request) => {
            const pool = slots.get(request.provider) ?? new Set<Promise<RunTurnOutcome>>();
            slots.set(request.provider, pool);
            while (pool.size >= (launch.contract.pools[request.provider] ?? 1))
              await Promise.race(pool);
            if (abort.signal.aborted) throw new Error('Cancelled before turn admission');
            const running = d.runTurn(request);
            pool.add(running);
            try {
              return await running;
            } finally {
              pool.delete(running);
            }
          },
        },
        call,
        {
          ...launch,
          token,
          folder: r.folder,
          signal: abort.signal,
        }
      );
    };
    const done = work()
      .catch(
        (error) => ({ cost: cap, result: { t: 'errored', why: String(error) } }) satisfies Receipt
      )
      .then((receipt) => {
        append(r, { t: 'result', key: call.key, hash: h, receipt });
        return receipt;
      })
      .finally(() => r.active.delete(token));
    r.active.set(token, { abort, done });
    return done;
  }
  function evaluate(r: Run) {
    const version = view(r.id).versions.at(-1)!;
    r.child = runPlan(path.join(r.folder, 'plans', `v${version}.expedition.ts`), (m, reply) => {
      switch (m.t) {
        case 'contract':
        case 'waiting':
          break;
        case 'call':
          void step(r, m.call).then((r) => reply(r.result));
          break;
        case 'end':
          void finish(r, m.result).catch((error) => hold(r, String(error)));
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
  async function finish(r: Run, result: { out: unknown; ref: { commit?: string } }) {
    const c = launchOf(r).contract;
    for (const [i, done] of c.done.entries()) {
      if ('owner' in done) {
        if (!(await question(r, `done/${i}`, done.owner, 'confirm')))
          return hold(r, `Owner declined: ${done.owner}`);
      } else {
        const call: Call = {
          key: `done/${i}`,
          usd: 0,
          minutes: c.doneReview?.minutes ?? 5,
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
                usd: c.doneReview?.usd ?? 0.3,
              } as const)),
        };
        const receipt = await step(r, call);
        if (
          receipt.result.t !== 'passed' ||
          ('review' in done && (receipt.result.out as { verdict: string }).verdict !== 'yes')
        )
          return hold(r, `Done criterion ${i} failed: ${JSON.stringify(receipt.result)}`);
      }
    }
    append(r, { t: 'status', status: 'met' });
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
        const r: Run = { id, folder, log, active: new Map(), waiters: new Map() };
        runs.set(id, r);
        if (d.gate.t === 'enabled' && !['met', 'stopped'].includes(status(r))) evaluate(r);
      }
    },
    async launch(file: string, contentHash: string, workspaceId: string) {
      allowed();
      const source = fs.readFileSync(file, 'utf8');
      if (hash(source) !== contentHash) throw new Error('Plan changed; propose again');
      const checked = await gates(file);
      if (fs.readFileSync(file, 'utf8') !== source) throw new Error('Plan changed during gates');
      const id = randomUUID(),
        folder = path.join(d.root, id);
      const repo = checked.contract.repo.replace(/^~(?=\/)/, os.homedir());
      const base = await git(repo, ['rev-parse', 'HEAD']);
      fs.mkdirSync(path.join(folder, 'plans'), { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(folder, 'plan.expedition.ts'), source);
      fs.writeFileSync(path.join(folder, 'plans/v1.expedition.ts'), source);
      const r: Run = { id, folder, log: [], active: new Map(), waiters: new Map() };
      runs.set(id, r);
      append(r, {
        t: 'launch',
        workspaceId,
        contract: checked.contract,
        base,
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
        q = view(id).questions.find((q) => q.key === key);
      if (
        !q ||
        q.kind === 'manager' ||
        (q.kind === 'confirm' ? typeof value !== 'boolean' : typeof value !== 'string')
      )
        throw new Error('Invalid or closed owner question');
      append(r, { t: 'answer', key, value });
      r.waiters.get(key)?.(value);
      r.waiters.delete(key);
      return view(id);
    },
    async act(id: string, buddyId: string, action: 'continue' | 'stop' | 'rewrite', why: string) {
      allowed();
      const r = get(id);
      const previous = status(r);
      if (launchOf(r).contract.leader !== `buddy:${buddyId}`)
        throw new Error('Only the manager may act');
      if (['met', 'stopped'].includes(status(r))) throw new Error('Expedition is finished');
      if (action === 'rewrite') {
        const file = path.join(r.folder, 'plan.expedition.ts'),
          source = fs.readFileSync(file, 'utf8');
        const checked = await gates(file, (c) => known(r, c));
        if (hash(checked.contract) !== hash(launchOf(r).contract))
          return { issues: ['The owner contract changed'] };
        if (fs.readFileSync(file, 'utf8') !== source)
          return { issues: ['The plan changed during gates'] };
        const extra = checked.preview.costUsd;
        if (
          extra > checked.contract.autoApply.usd &&
          !(await question(
            r,
            `rewrite/${hash(source)}`,
            `Apply this rewrite with up to $${extra} additional first-wave cost?`,
            'confirm'
          ))
        )
          return { issues: ['Owner declined extra cost'] };
        await r.child?.kill();
        const retained = new Set(checked.calls.map((c) => hash([r.id, c.key, hash(c)])));
        for (const [key, active] of r.active) if (!retained.has(key)) active.abort.abort();
        const version = view(id).versions.length + 1;
        fs.writeFileSync(path.join(r.folder, 'plans', `v${version}.expedition.ts`), source);
        append(r, { t: 'plan', version, hash: hash(source) });
      }
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
        if (action === 'rewrite' || (previous === 'held' && !r.waiters.size)) evaluate(r);
      }
      return view(id);
    },
    async close() {
      for (const r of runs.values()) await r.child?.kill();
    },
  };
}
export type Expeditions = ReturnType<typeof createExpeditions>;
