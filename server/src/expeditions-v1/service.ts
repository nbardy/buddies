import type { KeyedAct, keyed } from '@unleashd/shared';
import type { ExecutionGate } from '../buddies/execution-gate';
import type { HostCommands } from '../buddies/routes';
import { expandHome } from '../expedition-kernel/contract';
import type { Expedition, OwnerResult } from '../expedition-kernel/kernel';
import { keyedRowOf, keyedViewOf } from '../expedition-kernel/projection';
import { type Resolved, resolveBase } from './checks';
import { type Digested, digestOf } from './digest';
import type { AskAnswer } from './executor/asks';
import type { KeyedHost, KeyedHostDeps } from './host';
import { aboutIn } from './owner/candidate';
import { keepingPrompts } from './prompt-views';
import {
  isExpeditionId,
  launchedFrom,
  needsOpening,
  recordProposal,
  shelfIds,
  shelved,
} from './shelf';

// The keyed expeditions as the server sees them (CONNECT_PLAN §3, §4, §7; step 6): ONE value the
// routes, boot and shutdown talk to, in one of two modes decided once at composition.
//
//   live       the execution gate is enabled: the keyed host
//              (host.ts) runs, opens every unfinished expedition at boot, launches, takes acts.
//   read-only  anything else: rows and views are folded from the logs on disk (shelf.ts) and
//              nothing is opened for write, posted, started, cancelled or written; every
//              mutation answers `unavailable` with the reason (the routes' 503); `consumes`
//              consumes nothing; boot and shutdown do nothing (no boot phase, no timer, no
//              directory), when execution is disabled.
//
// Pattern: sum types (docs/patterns.md#sum-types): the mode is the type; each mode is one
// implementation of KeyedExpeditions with no "if live" inside it.

export type KeyedMode = keyed.KeyedMode;

const GATE_MODE: {
  readonly [K in ExecutionGate['t']]: (g: Extract<ExecutionGate, { t: K }>) => KeyedMode;
} = {
  enabled: () => ({ t: 'live' }),
  disabled: (g) => ({ t: 'read-only', why: `Buddy execution is disabled: ${g.reason}` }),
};
/** The Buddy execution gate alone decides the mode (owner request, 2026-11-11). */
export function decideKeyedMode(gate: ExecutionGate): KeyedMode {
  return (GATE_MODE[gate.t] as (g: ExecutionGate) => KeyedMode)(gate);
}

/** What a mutation came to; the routes map each to one status (routes.ts). */
export type Mutated =
  | { readonly t: 'ok'; readonly view: keyed.KeyedView }
  /** Read-only mode: the reason (execution disabled). */
  | { readonly t: 'unavailable'; readonly why: string }
  | { readonly t: 'missing'; readonly why: string }
  /** The kernel, the executor or the Owner port said no (finished, nothing pending, …). */
  | { readonly t: 'refused'; readonly why: string }
  /** A launch's gate failed (contract, typecheck, dry run, static, base). */
  | { readonly t: 'rejected'; readonly gate: string; readonly issues: readonly string[] };
export type Previewing =
  | { readonly t: 'previewed'; readonly preview: keyed.KeyedPreview }
  | { readonly t: 'unavailable'; readonly why: string };
/** The gates on a file a Buddy proposes (tool.ts): the clean preview with who does each call. */
export type Proposing =
  | { readonly t: 'clean'; readonly preview: keyed.ProposedPreview }
  | { readonly t: 'rejected'; readonly gate: string; readonly issues: readonly string[] }
  | { readonly t: 'unavailable'; readonly why: string };
export type Viewed =
  | { readonly t: 'ok'; readonly view: keyed.KeyedView }
  | { readonly t: 'missing'; readonly why: string };

/** What a launch demands of the file: nothing (direct HTTP), or the digest a proposal card
 * carries (digest.ts). */
export type Expect = { readonly t: 'any' } | { readonly t: 'digest'; readonly digest: string };

export interface KeyedExpeditions {
  readonly mode: KeyedMode;
  /** Before the server listens: the owner books, so `consumes` is right from the first request. */
  load(time: PhaseTimer): Promise<void>;
  /** After execution adoption, before the Buddy runner starts: observe, then open every
   * unfinished expedition. */
  boot(time: PhaseTimer): Promise<void>;
  rows(): Promise<keyed.KeyedRow[]>;
  view(id: string): Promise<Viewed>;
  act(id: string, act: KeyedAct): Promise<Mutated>;
  answer(id: string, ref: string, answer: AskAnswer): Promise<Mutated>;
  approval(id: string, approve: boolean): Promise<Mutated>;
  preview(file: string): Promise<Previewing>;
  /** `preview` for the Buddy tool's `propose`; writes nothing. */
  propose(file: string): Promise<Proposing>;
  /** Owner HTTP only (§7.2); the base is the repo's launch base rule (`resolveBase`). */
  launch(workspaceId: string, file: string, expect: Expect): Promise<Mutated>;
  /** A proposal card's facts, readable in both modes (writes nothing, runs no gate). */
  proposal(digest: string, file: string): Promise<keyed.KeyedProposalStatus>;
  readonly consumes: HostCommands['consumes'];
  /** Shutdown: detach every kernel, kill every command process group (host.ts `close`). */
  close(): Promise<void>;
}

/** `timeBootPhaseAsync` (observability/perf.ts): each boot step is a named phase. */
export type PhaseTimer = <T>(phase: string, work: () => Promise<T>) => Promise<T>;

export type KeyedExpeditionsDeps = KeyedHostDeps & {
  /** The launch base of a repo (tests may pin it; the server uses `resolveBase`). */
  readonly baseOf?: (repo: string) => Promise<Resolved>;
};

// The thin dispatcher: the mode picks the implementation, once.
export function createKeyedExpeditions(
  mode: KeyedMode,
  deps: KeyedExpeditionsDeps
): KeyedExpeditions {
  // Each view leaves with its bars' kept prompt files (prompt-views.ts, CONNECT_PLAN §10 F4).
  return keepingPrompts(
    deps.root,
    (MODES[mode.t] as (m: KeyedMode, d: KeyedExpeditionsDeps) => KeyedExpeditions)(mode, deps)
  );
}
const MODES: {
  readonly [K in KeyedMode['t']]: (
    m: Extract<KeyedMode, { t: K }>,
    d: KeyedExpeditionsDeps
  ) => KeyedExpeditions;
} = {
  'read-only': (m, d) => readOnly(m, d.root),
  live: (m, d) => live(m, d),
};

// ---- read-only ----

const NO_APPROVAL: keyed.PendingApproval = { t: 'none' };

async function rowsOnDisk(root: string, skip: ReadonlySet<string>): Promise<keyed.KeyedRow[]> {
  const rows: keyed.KeyedRow[] = [];
  for (const id of await shelfIds(root)) {
    if (skip.has(id)) continue;
    const s = await shelved(root, id);
    if (s.t === 'readable') rows.push(keyedRowOf(s.view.state, NO_APPROVAL));
    else unreadableOnce(s.id, s.why);
  }
  return rows;
}
async function viewOnDisk(root: string, id: string): Promise<Viewed> {
  if (!isExpeditionId(id)) return { t: 'missing', why: `no expedition ${id}` };
  const s = await shelved(root, id);
  return s.t === 'readable'
    ? { t: 'ok', view: keyedViewOf(s.view, NO_APPROVAL, aboutIn(s.view)) }
    : { t: 'missing', why: `expedition ${id} is unreadable: ${s.why}` };
}
/** An unreadable directory is left out of the list (a row has no "unreadable" shape) and said
 * once per reason in the log, not once per 10 s poll. */
const SAID = new Set<string>();
function unreadableOnce(id: string, why: string): void {
  const said = `${id}\n${why}`;
  if (SAID.has(said)) return;
  SAID.add(said);
  console.warn(`[expeditions-v1] ${id} is unreadable and not listed: ${why}`);
}

async function proposalStatus(
  mode: KeyedMode,
  root: string,
  digest: string,
  file: string
): Promise<keyed.KeyedProposalStatus> {
  const now = await digestOf(file);
  return {
    mode,
    launched: await launchedFrom(root, digest),
    file: PROPOSED_FILE[now.t](now as never, digest),
  };
}
const PROPOSED_FILE: {
  readonly [K in Digested['t']]: (
    d: Extract<Digested, { t: K }>,
    digest: string
  ) => keyed.KeyedProposalStatus['file'];
} = {
  digest: (d, digest) =>
    d.digest === digest
      ? { t: 'unchanged' }
      : { t: 'changed', why: 'its file changed after this was proposed' },
  unreadable: (d) => ({ t: 'changed', why: `the file cannot be read: ${d.why}` }),
};
type Checked = { readonly t: 'fine' } | Extract<Mutated, { t: 'refused' }>;
const FINE: Checked = { t: 'fine' };
/** The file must still be the one the owner looked at (`any`: no claim to check). */
const EXPECTED: {
  readonly [K in Expect['t']]: (
    e: Extract<Expect, { t: K }>,
    root: string,
    file: string
  ) => Promise<Checked>;
} = {
  any: async () => FINE,
  digest: async (e, root, file) => {
    const launched = await launchedFrom(root, e.digest);
    if (launched.t === 'yes')
      return { t: 'refused', why: `this proposal was already launched as ${launched.id}` };
    const now = await digestOf(file);
    const same = now.t === 'digest' && now.digest === e.digest;
    return same
      ? FINE
      : {
          t: 'refused',
          why: 'the file changed after it was proposed: ask the Buddy to propose it again',
        };
  },
};

function readOnly(m: Extract<KeyedMode, { t: 'read-only' }>, root: string): KeyedExpeditions {
  const unavailable = async () => ({ t: 'unavailable', why: m.why }) as const;
  return {
    mode: m,
    load: async () => {},
    boot: async () => {},
    rows: () => rowsOnDisk(root, new Set()),
    view: (id) => viewOnDisk(root, id),
    act: unavailable,
    answer: unavailable,
    approval: unavailable,
    preview: unavailable,
    propose: unavailable,
    launch: unavailable,
    proposal: (digest, file) => proposalStatus(m, root, digest, file),
    consumes: () => false,
    close: async () => {},
  };
}

// ---- live ----

/** An owner act on a kernel (kernel.ts `pause` … `retry`). */
const ACT: {
  readonly [K in KeyedAct['t']]: (
    e: Expedition,
    a: Extract<KeyedAct, { t: K }>
  ) => Promise<OwnerResult>;
} = {
  pause: (e) => e.pause(),
  resume: (e) => e.resume(),
  stop: (e) => e.stop(),
  extend: (e, a) => e.extend(a.hours),
  retry: (e, a) => e.retry(a.key),
};

// An empty normal boot must not pay for the host graph (140–410 ms under tsx).
// Guard: expeditions-v1-server checks empty live boot phases and directory absence.
function live(m: Extract<KeyedMode, { t: 'live' }>, d: KeyedExpeditionsDeps): KeyedExpeditions {
  let current: KeyedExpeditions | undefined;
  let loading: Promise<void> | undefined;
  let starting: Promise<void> | undefined;
  let booted = false;
  const untimed: PhaseTimer = (_phase, work) => work();
  const ready = async (): Promise<KeyedExpeditions> => {
    current ??= activeLive(m, d);
    const host = current;
    loading ??= host.load(untimed);
    await loading;
    if (booted) {
      starting ??= host.boot(untimed);
      await starting;
    }
    return host;
  };
  return {
    mode: m,
    async load(time) {
      await time('expeditions_v1_books', async () => {
        if ((await shelfIds(d.root)).length) await ready();
      });
    },
    async boot(time) {
      booted = true;
      await time('expeditions_v1_open', async () => {
        if (current) await ready();
      });
    },
    rows: () => (current ? current.rows() : rowsOnDisk(d.root, new Set())),
    view: (id) => (current ? current.view(id) : viewOnDisk(d.root, id)),
    act: async (id, act) => (await ready()).act(id, act),
    answer: async (id, ref, answer) => (await ready()).answer(id, ref, answer),
    approval: async (id, approve) => (await ready()).approval(id, approve),
    preview: async (file) => (await ready()).preview(file),
    propose: async (file) => (await ready()).propose(file),
    launch: async (workspaceId, file, expect) => (await ready()).launch(workspaceId, file, expect),
    proposal: (digest, file) => proposalStatus(m, d.root, digest, file),
    consumes: (channelId, body, thread) => current?.consumes(channelId, body, thread) ?? false,
    close: async () => {
      await current?.close();
    },
  };
}

function activeLive(
  m: Extract<KeyedMode, { t: 'live' }>,
  d: KeyedExpeditionsDeps
): KeyedExpeditions {
  // Loaded here, never at the top: the host's module graph (kernel, plan runner, leader, owner)
  // is loaded only when there are expeditions or an owner requests an operation.
  const { createKeyedHost } = require('./host') as typeof import('./host');
  const { previewView } =
    require('../expedition-kernel/launch') as typeof import('../expedition-kernel/launch');
  const { proposedPreview } = require('./proposal') as typeof import('./proposal');
  const host: KeyedHost = createKeyedHost(d);
  const baseOf = d.baseOf ?? resolveBase;
  const launching = new Set<string>();
  type ExpectedCheck = (e: Expect, root: string, file: string) => Promise<Checked>;
  const viewOf = (id: string): Mutated => {
    const view = host.view(id);
    return view ? { t: 'ok', view } : { t: 'missing', why: `no open expedition ${id}` };
  };
  /** The open kernel, or why there is none (unknown, or on disk but not open: finished). */
  const kernelOf = async (
    id: string
  ): Promise<{ t: 'open'; e: Expedition } | Extract<Mutated, { t: 'missing' | 'refused' }>> => {
    const e = host.get(id);
    if (e) return { t: 'open', e };
    const onDisk = await viewOnDisk(d.root, id);
    return onDisk.t === 'ok'
      ? { t: 'refused', why: `expedition ${id} is not open (it has finished)` }
      : onDisk;
  };
  const afterOwnerAct = (id: string, r: OwnerResult): Mutated =>
    r.t === 'done' ? viewOf(id) : { t: 'refused', why: r.why };

  return {
    mode: m,
    async load(time) {
      const failed = await time('expeditions_v1_books', () => host.load());
      for (const f of failed) console.warn(`[expeditions-v1] owner book unreadable: ${f}`);
    },
    async boot(time) {
      await time('expeditions_v1_open', async () => {
        await host.start();
        const opening = (await shelfIds(d.root)).map(async (id) => {
          const s = await shelved(d.root, id);
          if (s.t === 'unreadable')
            return console.error(`[expeditions-v1] ${id} not opened: unreadable: ${s.why}`);
          if (!needsOpening(s.view.state)) return;
          const opened = await host.open(id).catch((e: Error) => ({
            t: 'failed' as const,
            why: e.message,
          }));
          if (opened.t !== 'opened')
            console.error(`[expeditions-v1] ${id} not opened: ${opened.why}`);
        });
        await Promise.all(opening);
      });
    },
    async rows() {
      const open = host.opened();
      const fromDisk = await rowsOnDisk(d.root, new Set(open.map((e) => e.id)));
      return [...open.map((e) => host.row(e)), ...fromDisk].sort((a, b) =>
        b.id.localeCompare(a.id)
      );
    },
    async view(id) {
      const view = host.view(id);
      return view ? { t: 'ok', view } : viewOnDisk(d.root, id);
    },
    async act(id, act) {
      const k = await kernelOf(id);
      if (k.t !== 'open') return k;
      const r = await (ACT[act.t] as (e: Expedition, a: KeyedAct) => Promise<OwnerResult>)(
        k.e,
        act
      );
      return afterOwnerAct(id, r);
    },
    async answer(id, ref, answer) {
      const k = await kernelOf(id);
      if (k.t !== 'open') return k;
      const r = await host.answerAsk(id, ref, answer);
      return r.t === 'answered' ? viewOf(id) : { t: 'refused', why: r.why };
    },
    async approval(id, approve) {
      const k = await kernelOf(id);
      if (k.t !== 'open') return k;
      const r = await host.answerApproval(id, approve);
      return r.t === 'decided'
        ? viewOf(id)
        : { t: 'refused', why: `no rewrite of ${id} is waiting for approval` };
    },
    async preview(file) {
      return { t: 'previewed', preview: previewView(await host.preview(file)) };
    },
    async propose(file) {
      const p = await host.preview(file);
      return p.t === 'rejected'
        ? { t: 'rejected', gate: p.gate, issues: p.issues }
        : { t: 'clean', preview: proposedPreview(p) };
    },
    async launch(workspaceId, file, expect) {
      const workspaces = await d.core.listWorkspaces();
      if (!workspaces.some((w) => w.id === workspaceId))
        return { t: 'missing', why: `no workspace ${workspaceId}` };
      const unchanged = (): Promise<Checked> =>
        (EXPECTED[expect.t] as ExpectedCheck)(expect, d.root, file);
      // One launch per proposal at a time: a double click must not start two expeditions.
      const claim = expect.t === 'digest' ? expect.digest : null;
      if (claim !== null && launching.has(claim))
        return { t: 'refused', why: 'this proposal is being launched' };
      if (claim !== null) launching.add(claim);
      try {
        const stale = await unchanged();
        if (stale.t === 'refused') return stale;
        const p = await host.preview(file);
        if (p.t === 'rejected') return p;
        // Again: the gates take seconds, and the files are copied after them.
        const staleNow = await unchanged();
        if (staleNow.t === 'refused') return staleNow;
        const base = await baseOf(expandHome(p.contract.repo, d.home));
        if (base.t === 'refused') return { t: 'rejected', gate: 'base', issues: [base.issue] };
        const r = await host.launchClean(p, base.base.sha, { t: 'workspace', id: workspaceId });
        if (r.t !== 'launched') return r.t === 'refused' ? { t: 'unavailable', why: r.why } : r;
        if (claim !== null) await recordProposal(d.root, r.expedition.id, claim);
        return viewOf(r.expedition.id);
      } finally {
        if (claim !== null) launching.delete(claim);
      }
    },
    proposal: (digest, file) => proposalStatus(m, d.root, digest, file),
    consumes: host.consumes,
    close: () => host.close(),
  };
}
