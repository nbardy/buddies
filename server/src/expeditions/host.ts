import fsp from 'node:fs/promises';
import type { Actor, BuddiesCore, ChannelRef, Run } from '@unleashd/buddies-core';
import {
  ALLOWED,
  type Act,
  type Attempt,
  type BuddyContext,
  type Charter,
  type Done,
  type Expedition,
  type ExpeditionRow,
  type FinishReason,
  type Origin,
  type Provider,
  type State,
  type Tree,
  type TurnEnd,
  type Verdict,
  counted,
  stateLabel,
} from '@unleashd/shared';
import { type TurnDirectory, WORKSPACE_DIRECTORY } from '../buddies/briefing';
import { OWNER, buddyActor } from '../buddies/core';
import { type BuddyEvents, announcePost } from '../buddies/events';
import type { ExecutionGate } from '../buddies/execution-gate';
import { checkedRunConfig } from '../buddies/worker-config';
import { labelled } from '../observability/event-loop-stall';
import * as brief from './brief';
import { type Released, add, release, tip } from './cambium';
import { preflight, runChecks } from './checks';
import { type Launched, type Loaded, loadAll, newId, paths, save, withAttempt } from './record';
import { RETIRE } from './retire';

// The expedition host (docs/expeditions-lean-design.md §3.5): one serialized `step` per record,
// thin dispatch tables per state, verdict mode and act, and one host-wide check queue.

export type Acted =
  | { t: 'ok'; x: Expedition }
  | { t: 'refused'; reasons: string[] }
  | { t: 'missing' };
export type DraftInput = {
  charter: Charter;
  origin: Origin;
  launcherId: string;
  workspaceId: string;
};
export type ExpeditionHost = ReturnType<typeof createExpeditionHost>;
export interface ExpeditionHostOptions {
  core: BuddiesCore;
  events: BuddyEvents;
  root: string;
  gate: ExecutionGate;
  installed: (provider: Provider) => boolean;
  onBuddyArchived: (buddyId: string) => void;
  onChannelArchived: (channelId: string) => void;
  now?: () => Date;
}

const SETTLED = new Set<Run['status']>(['complete', 'failed', 'cancelled']);
const BUSY = ['starting', 'running', 'judging'];
const HOUR = 3_600_000;
const TREE_OF: { [K in Released['t']]: (r: Extract<Released, { t: K }>) => Tree } = {
  removed: (r) => ({ t: 'released', salvageRef: r.salvageRef }),
  absent: () => ({ t: 'absent' }),
  refused: (r) => ({ t: 'left', reason: `${r.reason}: ${r.detail}` }),
  failed: (r) => ({ t: 'left', reason: r.message }),
};
const SETTLE_INTO: Record<Launched['state']['t'], (end: TurnEnd) => Attempt['phase']> = {
  running: (end) => ({ t: 'judging', end }),
  paused: (end) => ({ t: 'judging', end }),
  finished: (end) => ({ t: 'judged', end, verdict: { t: 'skipped' } }),
};
const crewIdOf = (x: Expedition) => ('launch' in x.state ? x.state.launch.crewBuddyId : null);
const postIdOf = (r: Run) => (r.input.kind === 'post' ? r.input.postId : null);
const isPass = (a: Attempt) =>
  a.phase.t === 'judged' && a.phase.verdict.t !== 'skipped' && a.phase.verdict.pass;
const note = (text: string): Act => ({ do: 'note', text: text.trim().slice(0, 2000) });

export function createExpeditionHost(o: ExpeditionHostOptions) {
  const { core, events, root, gate } = o;
  const iso = () => (o.now ?? (() => new Date()))().toISOString();
  const records = loadAll(root);
  const chains = new Map<string, Promise<unknown>>();
  const queued = new Set<string>();
  let checkQueue: Promise<void> = Promise.resolve();
  const logError = (e: Error) => console.error(`[expeditions] ${e.message}`);
  const current = (id: string) => (records.get(id) as Extract<Loaded, { t: 'ok' }>).x as Launched;

  function serialized<T>(id: string, work: () => Promise<T>): Promise<T> {
    const next = (chains.get(id) ?? Promise.resolve()).then(work);
    chains.set(
      id,
      next.catch(() => undefined)
    );
    return next;
  }
  /** The one write path. */
  async function commit<X extends Expedition>(x: X): Promise<X> {
    await save(root, x);
    records.set(x.id, { t: 'ok', x });
    events.emit({ kind: 'changed' });
    return x;
  }

  const AFTER_CHAT: { [K in State['t']]: (x: Launched) => Promise<unknown> } = {
    draft: async () => undefined,
    running: (x) => proceed(x),
    paused: (x) => proceed(x),
    finished: (x) => settleAll(x).then(releasePending),
  };
  const STEP: { [K in State['t']]: (x: Expedition) => Promise<unknown> } = {
    draft: async () => undefined,
    running: (x) => readChat(x as Launched).then((y) => AFTER_CHAT[y.state.t](y)),
    paused: (x) => readChat(x as Launched).then((y) => AFTER_CHAT[y.state.t](y)),
    finished: (x) => AFTER_CHAT.finished(x as Launched),
  };
  function step(id: string): Promise<void> {
    return serialized(id, async () => {
      const l = records.get(id);
      if (l?.t === 'ok') await STEP[l.x.state.t](l.x);
    }).catch((e: Error) => console.error(`[expeditions] ${id} step failed: ${e.message}`));
  }
  async function proceed(start: Launched): Promise<void> {
    let x = await settleAll(start);
    for (const a of x.attempts.filter((a) => a.phase.t === 'judging'))
      JUDGE[x.charter.done.t](x, a);
    x = await finishIfDue(x);
    await releasePending(await fill(x));
  }

  /** Owner posts in the crew chat after chatSeenOrd, oldest first. An act the state refuses is
   * kept as a note with its text, so nothing the owner says is silently dropped. */
  async function readChat(start: Launched): Promise<Launched> {
    let x = start;
    const { chatChannelId: channelId, chatSeenOrd } = x.state.launch;
    const fresh: { ord: string; body: string; owner: boolean }[] = [];
    let before: { ord: string } | undefined;
    for (;;) {
      const page = await core.listPosts(OWNER, { kind: 'channel', channelId }, before, 50);
      const newer = page.posts.filter((p) => p.ord > chatSeenOrd);
      fresh.push(...newer.map((p) => ({ ...p, owner: p.author.kind === 'owner' })));
      if (!page.next || newer.length < page.posts.length) break;
      before = page.next;
    }
    if (fresh.length === 0) return x;
    for (const p of fresh.reverse().filter((p) => p.owner)) {
      const said = brief.chatAct(x, p.body);
      const tried = ALLOWED[said.do].includes(x.state.t) ? await apply(x, said, 'owner') : null;
      const done = tried?.t === 'ok' ? tried : await apply(x, note(p.body), 'owner');
      x = (done as Extract<Acted, { t: 'ok' }>).x as Launched;
    }
    const launch = { ...x.state.launch, chatSeenOrd: fresh[fresh.length - 1].ord };
    return commit({ ...x, state: { ...x.state, launch } });
  }

  async function settleAll(start: Launched): Promise<Launched> {
    let x = start;
    for (const a of x.attempts)
      if (a.phase.t === 'running') x = await settle(x, a, a.phase.requestId);
    return x;
  }
  /** A settled request ends the turn: judging, or judged{skipped} once finished. */
  async function settle(x: Launched, a: Attempt, requestId: string): Promise<Launched> {
    const ended = await turnOf(x, requestId);
    if (!ended) return x;
    const sha = await tip(x.state.launch.repoRoot, a.branch);
    const end: TurnEnd = { at: iso(), turn: ended.turn, sha, lesson: brief.lessonOf(ended.body) };
    return commit(withAttempt(x, { ...a, phase: SETTLE_INTO[x.state.t](end) }));
  }
  type Ended = { turn: TurnEnd['turn']; body: string } | null;
  async function turnOf(x: Launched, requestId: string): Promise<Ended> {
    const { request } = await core.getPost(OWNER, requestId);
    switch (request.state) {
      case 'answered':
        return { turn: 'answered', body: (await core.getPost(OWNER, request.answerId)).body };
      case 'failed':
      case 'cancelled':
        return { turn: request.state, body: '' };
      case 'awaiting':
      case 'none': {
        // Cancelling a QUEUED run (finish/stop before the runner claimed it) leaves its request
        // `awaiting` forever (runs.rs cancel_queued closes no request), so a request whose every
        // run has settled is a cancelled turn. Without this the attempt stayed `running` and its
        // tree was never released (found by the pass test: a4 started while a3 was checked).
        const runs = await runsOf(x, (r) => postIdOf(r) === requestId);
        return runs.length > 0 && runs.every((r) => SETTLED.has(r.status))
          ? { turn: 'cancelled', body: '' }
          : null;
      }
    }
  }

  const endOf = (a: Attempt) => (a.phase as Extract<Attempt['phase'], { end: TurnEnd }>).end;
  const JUDGE: Record<Done['t'], (x: Launched, a: Attempt) => void> = {
    checks: (x, a) => enqueueCheck(x, a, (x.charter.done as Extract<Done, { t: 'checks' }>).checks),
    owner: (x, a) => {
      const ask = brief.askVerdictLine(a, endOf(a).sha);
      postStatus(x, `exp:${x.id}:a${a.n}:ask`, ask).catch(logError);
    },
  };
  /** One host-wide queue: checks run one at a time on the shared machine. */
  function enqueueCheck(x: Launched, a: Attempt, checks: string[][]): void {
    const key = `${x.id}/a${a.n}`;
    if (queued.has(key)) return;
    queued.add(key);
    const { repoRoot, baseSha } = x.state.launch;
    const job = { dir: paths(root, x.id).check(a.n), sha: endOf(a).sha, base: baseSha, checks };
    checkQueue = checkQueue
      .then(async () => {
        const runs = await runChecks(repoRoot, job);
        const pass = runs.length === checks.length && runs.every((r) => r.outcome.t === 'passed');
        await serialized(x.id, () => verdictInto(current(x.id), a.n, { t: 'checks', pass, runs }));
      })
      .catch(logError)
      .finally(() => {
        queued.delete(key);
        void step(x.id);
      });
  }

  /** Only an attempt still judging takes a verdict; a stale one is dropped. */
  async function verdictInto(x: Launched, n: number, verdict: Verdict): Promise<Launched> {
    const a = x.attempts[n - 1];
    if (a?.phase.t !== 'judging') return x;
    const judged = { ...a, phase: { t: 'judged' as const, end: a.phase.end, verdict } };
    const next = await commit(withAttempt(x, judged));
    const line = brief.judgedLine(next, judged, a.phase.end.lesson);
    await postStatus(next, `exp:${x.id}:a${n}:judged`, line);
    return next;
  }

  /** running|paused only: a pass, then the deadline, then the spent budget. */
  async function finishIfDue(x: Launched): Promise<Launched> {
    const passed = x.attempts.find(isPass);
    if (passed) return finish(x, { t: 'passed', n: passed.n });
    if (iso() >= x.state.launch.deadline) return finish(x, { t: 'deadline' });
    const busy = x.attempts.some((a) => BUSY.includes(a.phase.t));
    if (counted(x) >= x.charter.maxAttempts && !busy) return finish(x, { t: 'budget' });
    return x;
  }

  async function finish(x: Launched, reason: FinishReason): Promise<Launched> {
    const live = new Set(
      x.attempts.flatMap((a) => (a.phase.t === 'running' ? [a.phase.requestId] : []))
    );
    await cancelRuns(x, (r) => live.has(postIdOf(r) ?? ''));
    const skip = (a: Attempt): Attempt =>
      a.phase.t === 'judging' ? { ...a, phase: SETTLE_INTO.finished(a.phase.end) } : a;
    const state = { t: 'finished' as const, launch: x.state.launch, at: iso(), reason };
    const next = await commit({ ...x, attempts: x.attempts.map(skip), state });
    await postStatus(next, `exp:${x.id}:finished`, brief.finishedLine(next, reason));
    return next;
  }

  /** A judging attempt holds its slot: the next brief should carry its verdict and lesson, and
   * a pass under check must not race a wasted turn (design deviation: §3.5 counted only
   * starting+running, which started a4 while a3's passing checks ran). */
  async function fill(start: Launched): Promise<Launched> {
    let x = start;
    const live = () => x.attempts.filter((a) => BUSY.includes(a.phase.t));
    while (
      x.state.t === 'running' &&
      live().length < x.charter.maxLive &&
      counted(x) < x.charter.maxAttempts &&
      iso() < x.state.launch.deadline
    )
      x = await startAttempt(x);
    return x;
  }

  /** Numbers are never reused. A failed add or post ends the expedition `setup_failed`. */
  async function startAttempt(start: Launched): Promise<Launched> {
    const n = start.attempts.length + 1;
    const planned: Attempt = {
      n,
      workspace: `exp-${start.id}-a${n}`,
      branch: `expedition/${start.id}/a${n}`,
      startedAt: iso(),
      tree: { t: 'planned' },
      phase: { t: 'starting' },
    };
    let x = await commit({ ...start, attempts: [...start.attempts, planned] });
    const { repoRoot, baseSha, crewBuddyId } = x.state.launch;
    const path = paths(root, x.id).tree(n);
    const added = await add(repoRoot, { ...planned, path, baseSha });
    if (added.t === 'failed') return setupFailed(x, planned, added.message);
    const a: Attempt = { ...planned, tree: { t: 'live', path: added.path } };
    x = await commit(withAttempt(x, a));
    const crew = buddyActor(crewBuddyId);
    try {
      const write = await core.post(
        crew,
        { kind: 'direct', members: [crew] },
        {
          kind: 'request',
          body: brief.briefOf(x, x.state.launch, a, added.path),
          purpose: 'expedition_attempt',
          evidence: [`expedition-attempt:${x.id}/${n}`],
          runConfig: checkedRunConfig(x.charter.seat),
          mentions: [],
          broadcast: false,
          key: `exp:${x.id}:a${n}`,
        }
      );
      return commit(withAttempt(x, { ...a, phase: { t: 'running', requestId: write.post.id } }));
    } catch (error) {
      return setupFailed(x, a, (error as Error).message);
    }
  }
  async function setupFailed(x: Launched, a: Attempt, detail: string): Promise<Launched> {
    const interrupted = withAttempt(x, { ...a, phase: { t: 'interrupted', at: iso() } });
    return finish(await commit(interrupted), { t: 'setup_failed', detail });
  }

  async function releaseTree(x: Launched, a: Attempt): Promise<Tree> {
    const ref = `refs/salvage/expeditions/${x.id}/a${a.n}`;
    const r = await release(x.state.launch.repoRoot, a.workspace, ref);
    return (TREE_OF[r.t] as (r: Released) => Tree)(r);
  }
  /** Trees of attempts whose turn is over go back to Cambium, dirty work kept at a salvage ref. */
  async function releasePending(start: Launched): Promise<Launched> {
    let x = start;
    const over = (a: Attempt) => a.phase.t !== 'starting' && a.phase.t !== 'running';
    for (const a of x.attempts.filter((a) => over(a) && ['planned', 'live'].includes(a.tree.t)))
      x = await commit(withAttempt(x, { ...a, tree: await releaseTree(x, a) }));
    return x;
  }

  const runsOf = async (x: Launched, which: (r: Run) => boolean) =>
    (await core.listRuns({ kind: 'buddy', buddyId: x.state.launch.crewBuddyId }, 2000)).filter(
      which
    );
  async function cancelRuns(x: Launched, which: (r: Run) => boolean): Promise<void> {
    for (const r of await runsOf(x, (r) => !SETTLED.has(r.status) && which(r)))
      events.emit({ kind: 'cancelled', run: await core.cancelRun(OWNER, r.id) });
  }

  /** Crew-authored, in the owner↔crew chat; the key makes a repeat a no-op. */
  async function postStatus(x: Launched, key: string, body: string): Promise<void> {
    const { crewBuddyId, chatChannelId } = x.state.launch;
    const place = { channel: { kind: 'id' as const, id: chatChannelId } };
    await inform(buddyActor(crewBuddyId), place, { body, purpose: 'expedition_status', key }, x.id);
  }
  async function inform(
    by: Actor,
    at: Place,
    p: { body: string; purpose: string; key: string },
    id: string
  ) {
    const input = { ...p, kind: 'inform' as const, evidence: [`expedition:${id}`], mentions: [] };
    const write = await core.post(by, at.channel, {
      ...input,
      replyToId: at.replyToId,
      broadcast: false,
    });
    if (write.created) await announcePost({ core, events }, OWNER, write.post);
  }

  type Handler = (x: never, a: never, by: string) => Promise<Acted>;
  const ok = async (x: Expedition): Promise<Acted> => ({ t: 'ok', x: await commit(x) });
  const withLaunch = (x: Launched, change: Partial<Launched['state']['launch']>) =>
    ok({ ...x, state: { ...x.state, launch: { ...x.state.launch, ...change } } });
  const ACTS: {
    [K in Act['do']]: (x: never, a: Extract<Act, { do: K }>, by: string) => Promise<Acted>;
  } = {
    launch: (x: Expedition) => launch(x),
    pause: (x: Launched) => ok({ ...x, state: { t: 'paused', launch: x.state.launch } }),
    resume: (x: Launched) => ok({ ...x, state: { t: 'running', launch: x.state.launch } }),
    stop: async (x: Launched, _a, by) => ({ t: 'ok', x: await finish(x, { t: 'stopped', by }) }),
    extend: (x: Launched, a) => {
      const deadline = Date.parse(x.state.launch.deadline) + a.hours * HOUR;
      return withLaunch(x, { deadline: new Date(deadline).toISOString() });
    },
    note: (x: Launched, a, by) =>
      ok({ ...x, notes: [...x.notes, { at: iso(), by, text: a.text }] }),
    verdict: async (x: Launched, a) => {
      if (x.charter.done.t !== 'owner' || x.attempts[a.n - 1]?.phase.t !== 'judging')
        return { t: 'refused', reasons: [`a${a.n} is not waiting for your verdict`] };
      return { t: 'ok', x: await verdictInto(x, a.n, { t: 'owner', pass: a.pass }) };
    },
    retire: async (x: Expedition) => {
      const retired = await RETIRE[x.state.t as 'draft' | 'finished'](retireDeps, x);
      if (retired.t === 'refused') return retired;
      records.delete(x.id);
      events.emit({ kind: 'changed' });
      return { t: 'ok', x };
    },
  };
  const retireDeps = {
    core,
    root,
    now: iso,
    release: releaseTree,
    commit: (x: Launched) => commit(x),
    onBuddyArchived: o.onBuddyArchived,
    onChannelArchived: o.onChannelArchived,
  };

  async function launch(x: Expedition): Promise<Acted> {
    const pre = await check(x.charter, x.workspaceId);
    if (pre.t === 'refused') {
      await commit({ ...x, state: { t: 'draft', issues: pre.issues } });
      return { t: 'refused', reasons: pre.issues };
    }
    const crew = await core.createBuddy(OWNER, {
      workspaceId: x.workspaceId,
      slug: `exp-${x.id}`,
      name: `⛺ ${x.charter.name}`,
      role: `${brief.CREW_ROLE}\nYour expedition id: ${x.id}.`,
      manager: { kind: 'buddy', id: x.launcherId },
      ...x.charter.seat,
      key: `exp:${x.id}:crew`,
    });
    const members = [OWNER, buddyActor(crew.id)];
    const chat = await core.openChannel(OWNER, { kind: 'direct', members });
    const at = iso();
    const launch = {
      at,
      deadline: new Date(Date.parse(at) + x.charter.hours * HOUR).toISOString(),
      repoRoot: pre.repoRoot,
      baseSha: pre.baseSha,
      crewBuddyId: crew.id,
      chatChannelId: chat.id,
      chatSeenOrd: '',
    };
    return ok({ ...x, state: { t: 'running', launch } });
  }

  /** Inside a record's chain: the caller made the ALLOWED check; no step follows. */
  const apply = (x: Expedition, a: Act, by: string) =>
    (ACTS[a.do] as Handler)(x as never, a as never, by);
  async function act(id: string, a: Act, by: string): Promise<Acted> {
    const acted = await serialized(id, async (): Promise<Acted> => {
      const l = records.get(id);
      if (!l) return { t: 'missing' };
      if (l.t === 'unreadable') return { t: 'refused', reasons: [`unreadable: ${l.reason}`] };
      if (gate.t === 'disabled') return { t: 'refused', reasons: [gate.reason] };
      if (!ALLOWED[a.do].includes(l.x.state.t))
        return { t: 'refused', reasons: [`cannot ${a.do} a ${l.x.state.t} expedition`] };
      return apply(l.x, a, by);
    });
    await step(id);
    return acted;
  }

  const check = async (charter: Charter, workspaceId: string) => {
    const workspace = (await core.listWorkspaces()).find((w) => w.id === workspaceId);
    return preflight({ gate, workspace, charter, installed: o.installed });
  };
  /** Preflight → save → the card, posted by the launcher where it was asked. */
  async function draft(input: DraftInput): Promise<Expedition> {
    const pre = await check(input.charter, input.workspaceId);
    const x = await commit<Expedition>({
      v: 1,
      id: newId(input.charter.name),
      workspaceId: input.workspaceId,
      createdAt: iso(),
      launcherId: input.launcherId,
      origin: input.origin,
      charter: input.charter,
      state: { t: 'draft', issues: pre.t === 'refused' ? pre.issues : [] },
      attempts: [],
      notes: [],
    });
    const launcher = buddyActor(input.launcherId);
    const place = PLACE[input.origin.t](input.origin as never, launcher);
    const card = {
      body: `⛺ Expedition: ${x.charter.name}`,
      purpose: 'expedition',
      key: `exp:${x.id}:card`,
    };
    await inform(launcher, place, card, x.id);
    return x;
  }

  /** Boot, before adoption: starting/running attempts end interrupted (not counted) and the
   * crew's unsettled runs are cancelled; the first step after start() releases their trees. */
  async function interruptBootLive(): Promise<void> {
    if (gate.t === 'disabled') return;
    const live = (a: Attempt) => a.phase.t === 'starting' || a.phase.t === 'running';
    for (const l of records.values()) {
      if (l.t !== 'ok' || !l.x.attempts.some(live)) continue;
      const x = l.x as Launched;
      await cancelRuns(x, () => true);
      const interrupt = (a: Attempt): Attempt =>
        live(a) ? { ...a, phase: { t: 'interrupted', at: iso() } } : a;
      await commit({ ...x, attempts: x.attempts.map(interrupt) });
    }
  }

  function crewOf(buddyId: string): string | undefined {
    for (const l of records.values()) if (l.t === 'ok' && crewIdOf(l.x) === buddyId) return l.x.id;
    return undefined;
  }

  /** A crew run answering one of its attempt requests starts in that attempt's live tree; any
   * other crew turn in the crew's own directory; any other Buddy's in its workspace root. */
  async function turnDirectory(context: BuddyContext): Promise<TurnDirectory> {
    const id = crewOf(context.buddyId);
    if (!id) return WORKSPACE_DIRECTORY;
    const runId = context.coordinationRunId;
    const postId = runId ? postIdOf(await core.getRun(runId)) : null;
    const evidence = postId ? (await core.getPost(OWNER, postId)).evidence : [];
    const tag = evidence.find((e) => e.startsWith(`expedition-attempt:${id}/`));
    const tree = tag ? current(id).attempts[Number(tag.split('/').at(-1)) - 1]?.tree : null;
    if (runId && tree?.t === 'live') return { t: 'attempt', runId, path: tree.path };
    const dir = paths(root, id).crewDir;
    await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
    return { t: 'crew', path: dir };
  }

  const active = (x: Expedition) =>
    x.state.t === 'running' ||
    x.state.t === 'paused' ||
    x.attempts.some((a) => BUSY.includes(a.phase.t) || ['planned', 'live'].includes(a.tree.t));
  const stepAll = () =>
    Promise.all(
      [...records.values()].flatMap((l) => (l.t === 'ok' && active(l.x) ? [step(l.x.id)] : []))
    );
  const stops: (() => void)[] = [];
  function start(): void {
    if (gate.t === 'disabled') return;
    let debounce: NodeJS.Timeout | null = null;
    const wake = labelled('timer expeditions-wake', () => {
      debounce = null;
      void stepAll();
    });
    stops.push(
      events.on((e) => {
        if ((e.kind !== 'changed' && e.kind !== 'posted') || debounce) return;
        debounce = setTimeout(wake, 1500);
        debounce.unref();
      })
    );
    const backstop = setInterval(
      labelled('timer expeditions-backstop', () => void stepAll()),
      60_000
    );
    backstop.unref();
    stops.push(() => clearInterval(backstop));
    stops.push(() => debounce && clearTimeout(debounce));
    void stepAll();
  }

  /** Unreadable rows first, then newest first. */
  function rows(): ExpeditionRow[] {
    const all = [...records.values()];
    const ok = all.flatMap((l) => (l.t === 'ok' ? [l.x] : []));
    return [
      ...all.flatMap((l) => (l.t === 'unreadable' ? [l] : [])),
      ...ok
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map((x) => ({
          t: 'ok' as const,
          id: x.id,
          name: x.charter.name,
          workspaceId: x.workspaceId,
          state: x.state.t,
          label: stateLabel(x),
          needsOwner:
            x.charter.done.t === 'owner' && x.attempts.some((a) => a.phase.t === 'judging'),
          crewBuddyId: crewIdOf(x),
        })),
    ];
  }

  return {
    draft,
    act,
    get: (id: string): Loaded | { t: 'missing' } => records.get(id) ?? { t: 'missing' },
    rows,
    crewOf,
    crewBuddyIds: (): ReadonlySet<string> =>
      new Set(rows().flatMap((r) => (r.t === 'ok' && r.crewBuddyId ? [r.crewBuddyId] : []))),
    turnDirectory,
    interruptBootLive,
    start,
    close: () => stops.splice(0).forEach((stop) => stop()),
    step,
    /** Tests: resolves once no check job runs and the steps they woke have settled. */
    async drain(): Promise<void> {
      do {
        await checkQueue;
        await Promise.all([...chains.values()]);
      } while (queued.size > 0);
    },
  };
}

const PLACE: { [K in Origin['t']]: (o: Extract<Origin, { t: K }>, launcher: Actor) => Place } = {
  thread: (o) => ({ channel: { kind: 'id', id: o.channelId }, replyToId: o.rootId }),
  direct: (_o, launcher) => ({ channel: { kind: 'direct', members: [OWNER, launcher] } }),
};
type Place = { channel: ChannelRef; replyToId?: string };
