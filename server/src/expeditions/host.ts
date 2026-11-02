import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { BuddiesCore } from '@unleashd/buddies-core';
import {
  type BuddyContext,
  type ExpeditionRetiredView,
  type ExpeditionSummary,
  type ExpeditionView,
  type Provider,
  ProviderSchema,
} from '@unleashd/shared';
import { type TurnDirectory, WORKSPACE_DIRECTORY } from '../buddies/briefing';
import { OWNER, buddyActor } from '../buddies/core';
import type { BuddyEvents } from '../buddies/events';
import type { ExecutionGate } from '../buddies/execution-gate';
import { DEFAULT_CWD, checkedRunConfig } from '../buddies/worker-config';
import { labelled } from '../observability/event-loop-stall';
import { CREW_ROLE, briefOf, chatFeedback, parseOutcome, repairBrief, statusText } from './briefs';
import { killCheck, pidfileOf, runCommand } from './command';
import { type DraftInput, type LaunchOutcome, createDraftStore, placementOf } from './drafts';
import {
  archiveBranch,
  attemptCommits,
  branchHead,
  claimHeld,
  ensureDetachedTree,
  ensureWorktree,
  expeditionRefs,
  mergeCandidate,
  preflight,
  syncDetachedTree,
} from './git';
import { type MeterPorts, RUN_SCAN_LIMIT, SETTLED, meterRequest } from './meter';
import {
  type Attempt,
  type AttemptPhase,
  type Charter,
  type CheckOutcome,
  type ClaimChange,
  type Clock,
  type Effect,
  type EndOutcome,
  type Entry,
  type Feedback,
  type Origin,
  type Outcome,
  type Release,
  type RetireChat,
  type RetireTree,
  type State,
  type ValidationBasis,
  type ValidationReport,
  type ValidationTarget,
  type WorkerSpec,
  apply,
  attemptOf,
  badge,
  charterIssues,
  claimAt,
  claimOf,
  commandChecks,
  configOf,
  custodyOf,
  decide,
  fold,
  goalSummary,
  headOf,
  integrationOf,
  launchNews,
  live,
  pendingEffects,
  startedOf,
  validationOf,
  validationTreeId,
  worktreeName,
  worktreeOf,
} from './model';
import { pinSources, pinnedOutcome, report, verifyPins } from './pins';
import {
  type Keep,
  type Released,
  discardWorktree,
  releaseDetachedTree,
  releaseIntegrationTree,
  releaseWorktree,
} from './release';
import {
  RETIRED_DIR,
  type RetiredSnapshot,
  fileRetired,
  readRetired,
  retiredView,
  snapshotOf,
} from './retired';
import { appendBatch, createLedger, readLedgerFile } from './store';
import { expeditionSummary, expeditionView } from './view';

// Pattern: wake-on-write (docs/patterns.md#wake-on-write) — ticks on the Buddy change bus
// (debounced) plus one slow backstop; no per-expedition timers.
// Pattern: idempotency-keys (docs/patterns.md#idempotency-keys) — every crate write carries a key
// derived from the expedition and attempt/status id, so replaying an effect after a crash is a no-op.

const BACKSTOP_MS = 60_000;
/** Chat posts read per page when looking for new owner messages. */
const CHAT_PAGE = 50;
const DEBOUNCE_MS = 1_500;
/** Ticks re-run decide after effects (crew created → first manager); bounded per tick. */
const ROUNDS_PER_TICK = 4;
/**
 * Failed ticks in a row before the host records `tick_failed` and backs off (audit 2026-11-01
 * #1): the backoff doubles from BACKOFF_BASE_MS up to BACKOFF_MAX_MS, so a persistent failure
 * costs a bounded number of attempts and log lines, never a hot loop. An owner steer retries at
 * once.
 */
const TICK_FAILURE_LIMIT = 3;
const BACKOFF_BASE_MS = 60_000;
const BACKOFF_MAX_MS = 30 * 60_000;
/** After the host asks a finished expedition's live attempt to stop (audit #2), how long its runs
 * may take to end before the host ends the attempt `abandoned` and releases its tree. */
export const CANCEL_GRACE_MS = 5 * 60_000;

export interface LaunchInput {
  key: string;
  charter: Charter;
  origin: Origin;
  launcherId: string;
  workspaceId: string;
}

export interface ExpeditionHostOptions {
  core: BuddiesCore;
  events: BuddyEvents;
  root: string;
  gate: ExecutionGate;
  /** Where attempt cost is read from (meter.ts): conversation records and the transcript store. */
  meter: MeterPorts;
  /** Whether a provider's harness binary is on the PATH the runner spawns with (server: the
   * installed-agent PATH walk). A seat on a missing harness is a launch issue, never a spawn
   * ENOENT mid-expedition. */
  installed: (provider: Provider) => boolean;
  /** A retirement archived the crew Buddy (server.ts: the same as the owner's Archive, which
   * stops its conversations). */
  onBuddyArchived: (buddyId: string) => void;
  /** A retirement archived one of the crew's chats (server.ts: refreshes channel views). */
  onChannelArchived: (channelId: string) => void;
  now?: () => Date;
}

export type ExpeditionHost = ReturnType<typeof createExpeditionHost>;

/** The chain launches run on (never an expedition id: those are `<slug>-<hex>`). */
const LAUNCH_CHAIN = 'launch:';

/** A host whose gate is disabled (a copied store) never runs an expedition, so it refuses one. */
function gateIssues(gate: ExecutionGate): string[] {
  switch (gate.t) {
    case 'enabled':
      return [];
    case 'disabled':
      return [`expeditions do not run on this server: ${gate.reason}`];
  }
}

/**
 * Each crew seat checked against the provider catalog (worker-config.ts) and against this host's
 * installed harnesses: one issue per seat. 2026-11-02 visual pass: on a host without codex the
 * default crew (codex work and check seats) drafted with no issue and launched; the manager then
 * planned "send the retry to seat 1 (codex)", and a claude claim's independent check could only
 * run on codex, a spawn that cannot start.
 */
function seatIssues(charter: Charter, installed: (provider: Provider) => boolean): string[] {
  const { crew } = charter;
  const seats = [
    { where: 'manager', seat: crew.manager },
    ...crew.work.map((seat, i) => ({ where: `work seat ${i}`, seat })),
    ...crew.check.map((seat, i) => ({ where: `check seat ${i}`, seat })),
  ];
  return seats.flatMap(({ where, seat }) => {
    try {
      checkedRunConfig(seat);
    } catch (error) {
      return [(error as Error).message];
    }
    const provider = ProviderSchema.parse(seat.provider);
    return installed(provider)
      ? []
      : [`${where}: ${provider} is not installed on this host; name a crew without it`];
  });
}

/** What the host knows of an expedition id: a ledger it folds, one it set aside because it does
 * not fold (named, with the reason; the other expeditions keep running), a retired snapshot
 * (retired.ts: never folded), or none. */
export type Lookup =
  | { t: 'present' }
  | { t: 'quarantined'; reason: string }
  | { t: 'retired' }
  | { t: 'missing' };

/** How the owner asks to retire: a finished expedition, or an open one stopped first. */
export type RetireMode = 'retire' | 'stop_and_retire';

/** What a retire request did (routes.ts answers each). `retiring`: recorded, the steps run in
 * the background (a request while retiring asks the refused steps again). */
export type Retire =
  | { t: 'retiring' }
  | { t: 'not_finished' }
  | { t: 'already_retired' }
  | { t: 'missing' }
  | { t: 'quarantined'; reason: string }
  | { t: 'disabled'; reason: string };

/** A launch with this (conversation, name) key is still open: the retried call gets it back. */
export type Launched = { t: 'launched'; state: State } | { t: 'already_running'; state: State };

/** A launch the preflight refused (design.md R4), with every reason; nothing was written. */
export class LaunchRefused extends Error {
  constructor(readonly reasons: string[]) {
    super(`Expedition launch refused: ${reasons.join('; ')}.`);
  }
}

/** One tick's end: settled, or some observation or effect could not be made (typed data, audit
 * #1: an observe error used to throw before decide, so a stop or the deadline never landed). */
type TickResult = { t: 'ok' } | { t: 'part_failed'; reasons: string[] };

/** What observation produced: the entries, and why any part of it could not be read. */
interface Observed {
  entries: Entry[];
  failures: string[];
}

/** A tick's failure streak, and until when ticks wait (`until`, host-clock ms). */
interface Streak {
  failures: number;
  until: number;
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function createExpeditionHost(options: ExpeditionHostOptions) {
  const { core, events, root, gate, meter, installed, onBuddyArchived, onChannelArchived } =
    options;
  const now = () => (options.now ?? (() => new Date()))().toISOString();
  /**
   * Each expedition's folded state, kept current by applying every appended batch (audit
   * 2026-11-01 #8: every event re-folded every ledger from its first entry). Readers get the
   * live object; decide mutates, so it gets a clone (`forDecide`). `counts` is each ledger's
   * entry count: a tick compares it to tell whether a round wrote anything.
   */
  const states = new Map<string, State>();
  const counts = new Map<string, number>();
  /** Ledgers that do not fold, with why. Set aside, never deleted: the file stays for the owner. */
  const quarantined = new Map<string, string>();
  const quarantine = (id: string, reason: string) => {
    console.warn(`[expeditions] ${id} quarantined: ${reason}`);
    states.delete(id);
    counts.delete(id);
    quarantined.set(id, reason);
  };
  const chains = new Map<string, Promise<void>>();
  const streaks = new Map<string, Streak>();
  /** Validation check jobs running in this process, by `<expedition>/<validation>`. They run
   * outside the tick chain (a check may take hours; a steer must not wait on it) and append each
   * result through the chain. In-memory only: after a restart the ledger's unrecorded checks are
   * the work, and `run_validation` resumes them. */
  const jobs = new Map<string, Promise<void>>();
  const jobKey = (id: string, validationId: string) => `${id}/${validationId}`;
  /** Check jobs this process started (running or since ended): a `running` job not here died
   * with an earlier process (runValidation). */
  const ranHere = new Set<string>();
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });

  const fileOf = (id: string) => path.join(root, id, 'ledger.jsonl');
  /** Durable first (store.ts appendBatch), then applied to the cached state. An entry that no
   * longer applies is a broken invariant: the expedition is quarantined, the others go on. */
  async function append(id: string, entries: Entry[]): Promise<void> {
    if (entries.length === 0) return;
    const state = stateOf(id);
    await appendBatch(fileOf(id), entries);
    counts.set(id, (counts.get(id) ?? 0) + entries.length);
    try {
      for (const entry of entries) apply(state, entry);
    } catch (error) {
      quarantine(id, `does not fold: ${errorText(error)}`);
      throw error;
    }
  }
  const stateOf = (id: string): State => {
    const state = states.get(id);
    if (state) return state;
    const reason = quarantined.get(id);
    throw new Error(
      reason ? `expedition ${id} is quarantined: ${reason}` : `unknown expedition ${id}`
    );
  };
  /** decide applies its own intents as it writes them, so it works on a copy: the cache is
   * applied once, by `append`. */
  const forDecide = (id: string): State => structuredClone(stateOf(id));

  /** Retired expeditions, by id: frozen snapshots, never folded (retired.ts). */
  const retired = new Map<string, RetiredSnapshot>();
  for (const [id, read] of readRetired(root))
    switch (read.t) {
      case 'read':
        retired.set(id, read.snapshot);
        break;
      case 'corrupt':
        quarantine(id, read.reason);
    }

  // Boot: read every ledger once; ticks resume what they explain. A ledger that cannot be read
  // or folded is quarantined, so one bad file never stops the server or the other expeditions.
  // `.retired` holds retired folders: never folded again.
  for (const id of fs.readdirSync(root)) {
    if (id === RETIRED_DIR) continue;
    const file = path.join(root, id, 'ledger.jsonl');
    if (!fs.existsSync(file)) continue;
    const read = readLedgerFile(file);
    switch (read.t) {
      case 'corrupt':
        quarantine(id, read.reason);
        continue;
      case 'read':
        if (read.torn > 0)
          console.warn(`[expeditions] ${id}: dropped a torn last append (${read.torn} bytes)`);
        try {
          states.set(id, fold(read.entries));
          counts.set(id, read.entries.length);
        } catch (error) {
          quarantine(id, `does not fold: ${errorText(error)}`);
        }
    }
  }

  const clock = (): Clock => ({
    now: now(),
    nextId: (prefix) => `${prefix}${randomUUID().slice(0, 6)}`,
  });

  // ---------- Observation: settled requests become attempt_ended ----------

  /** Every part observed on its own: one request (or the chat) that cannot be read is a typed
   * failure, and the rest is still recorded and decided on. */
  async function observe(s: State): Promise<Observed> {
    const parts: [string, () => Promise<Entry[]>][] = [
      ['the expedition chat', () => observeChat(s)],
      ...s.attempts.flatMap((attempt): [string, () => Promise<Entry[]>][] =>
        attempt.phase.t === 'posted'
          ? [[`attempt ${attempt.id}`, () => observeAttempt(s, attempt)]]
          : []
      ),
    ];
    const observed: Observed = { entries: [], failures: [] };
    for (const [what, read] of parts) {
      const part = await observing(what, read);
      switch (part.t) {
        case 'ok':
          observed.entries.push(...part.entries);
          break;
        case 'failed':
          observed.failures.push(part.reason);
      }
    }
    return observed;
  }

  async function observing(
    what: string,
    read: () => Promise<Entry[]>
  ): Promise<{ t: 'ok'; entries: Entry[] } | { t: 'failed'; reason: string }> {
    try {
      return { t: 'ok', entries: await read() };
    } catch (error) {
      return { t: 'failed', reason: `${what}: ${errorText(error)}` };
    }
  }

  async function observeAttempt(s: State, attempt: Attempt): Promise<Entry[]> {
    const phase = postedPhase(attempt);
    const request = await core.getPost(OWNER, phase.requestId);
    switch (request.request.state) {
      case 'awaiting':
      case 'none':
        return abandonedAfterGrace(s, attempt);
      case 'answered': {
        const answer = await core.getPost(OWNER, request.request.answerId);
        return answered(s, attempt, phase, answer.body);
      }
      case 'failed':
      case 'cancelled':
        return [await ended(s, attempt, { t: 'failed', status: request.request.state })];
    }
  }

  /** Every attempt end goes through here, so no end of a work attempt drops its commits. */
  async function ended(s: State, attempt: Attempt, outcome: EndOutcome): Promise<Entry> {
    return {
      t: 'attempt_ended',
      at: now(),
      attemptId: attempt.id,
      outcome: await unreported(s, attempt, outcome),
    };
  }

  /** A cancelled attempt whose runs did not end within the grace is ended by the host (audit #2):
   * a run that ignores its stop must not hold a tree and a slot forever. */
  async function abandonedAfterGrace(s: State, attempt: Attempt): Promise<Entry[]> {
    const cancel = s.cancels[attempt.id];
    if (!cancel || Date.parse(now()) - Date.parse(cancel.at) < CANCEL_GRACE_MS) return [];
    const reason = `its runs (${cancel.runIds.join(', ') || 'none found'}) did not end within ${CANCEL_GRACE_MS / 60_000} minutes of the host's stop`;
    return [await ended(s, attempt, { t: 'abandoned', reason })];
  }

  /**
   * An answer. A first answer that does not parse gets ONE repair request on the same seat
   * (design.md R11) instead of ending the attempt, while the expedition runs; any other answer
   * ends it with what it holds. Never on a finished expedition: 2026-11-01 review, an answer that
   * arrived after the owner's stop was repaired, which started a new paid run on the seat that
   * the one-shot cancel (already recorded for the attempt) never stopped.
   */
  async function answered(
    s: State,
    attempt: Attempt,
    phase: Extract<AttemptPhase, { t: 'posted' }>,
    body: string
  ): Promise<Entry[]> {
    const parsed = parseOutcome(attempt.spec.kind, body);
    if (parsed.t === 'malformed' && phase.round === 'brief' && s.run.t !== 'finished')
      return [
        {
          t: 'attempt_repair_posting',
          at: now(),
          attemptId: attempt.id,
          error: parsed.error,
          body: repairBrief(s, attempt, parsed.error, body),
        },
      ];
    return [await ended(s, attempt, await heldOutcome(s, attempt.id, body, parsed))];
  }

  /**
   * A work attempt that ends with anything but a code claim (a finding, blocked, malformed,
   * failed, cancelled, abandoned) while its branch holds commits beyond its base is
   * `unreported_commits`, with the shas, so the manager can claim them (design.md R11).
   * 2026-11-01 incident: w64130b's verifier commit was dropped with its malformed answer, and
   * w475a3b's ACCEPTANCE_ROUTE.md commit with its `finding`.
   */
  async function unreported(s: State, attempt: Attempt, outcome: EndOutcome): Promise<Outcome> {
    if (attempt.spec.kind !== 'work' || reportsCommit(outcome)) return outcome;
    const shas = await attemptCommits(s.repo.root, worktreeOf(s, attempt.id));
    return shas.length === 0 ? outcome : { t: 'unreported_commits', shas, ended: outcome };
  }

  /**
   * The owner's messages in the expedition chat (the owner↔crew DM) since the last one recorded,
   * oldest first, each as a `feedback` entry (briefs.ts chatFeedback): answering "needs you" in
   * the chat resumes the run, and pause/resume/stop work there, without the steer tool. Keyed by
   * the post's ordered id (the ledger's chat cursor), so a replay never records one twice.
   */
  async function observeChat(s: State): Promise<Entry[]> {
    if (s.crew.t !== 'ready' || s.run.t === 'finished') return [];
    const posts = await chatPostsAfter(s.crew.chatChannelId, s.chatCursor);
    return posts
      .filter((p) => p.author.kind === 'owner')
      .map(
        (p): Entry => ({
          t: 'feedback',
          at: now(),
          from: 'owner',
          via: { t: 'chat', postId: p.id, ord: p.ord },
          feedback: chatFeedback(p.body),
        })
      );
  }

  /** The chat's top-level posts newer than the cursor, oldest first (pages newest-first). */
  async function chatPostsAfter(channelId: string, cursor: State['chatCursor']) {
    const newer = (ord: string) => cursor.t === 'start' || ord > cursor.ord;
    const out: Awaited<ReturnType<BuddiesCore['listPosts']>>['posts'] = [];
    let before: { ord: string } | undefined;
    for (;;) {
      const page = await core.listPosts(OWNER, { kind: 'channel', channelId }, before, CHAT_PAGE);
      const fresh = page.posts.filter((p) => newer(p.ord));
      out.push(...fresh);
      if (!page.next || fresh.length < page.posts.length) break;
      before = page.next;
    }
    return out.reverse();
  }

  /**
   * A work claim's `change` is checked against its own attempt branch (git.ts claimHeld); one the
   * branch does not hold is recorded `malformed` with the reason, so the manager sees it and it is
   * never validated, checked or integrated on the claim's word alone. A commit that edits files
   * outside its question's custody is not held either: custody is enforced, not advisory.
   */
  async function heldOutcome(
    s: State,
    attemptId: string,
    body: string,
    outcome: EndOutcome
  ): Promise<EndOutcome> {
    if (outcome.t !== 'work' || outcome.result.result !== 'claim') return outcome;
    const tree = worktreeOf(s, attemptId);
    const custody = custodyOf(s, attemptOf(s, attemptId));
    const held = await claimHeld(s.repo.root, tree, outcome.result.change, custody);
    switch (held.t) {
      case 'held':
        return outcome;
      case 'not_held':
        return { t: 'malformed', error: held.reason, raw: body };
    }
  }

  // ---------- Effects: one handler per effect kind ----------

  // Pattern: table-driven (docs/patterns.md#table-driven) — `run` only selects the handler.
  // Audit 2026-11-01: `run` was one switch doing every effect's work inline.
  type Handlers = {
    [K in Effect['t']]: (s: State, e: Extract<Effect, { t: K }>) => Promise<Entry[]>;
  };
  const handlers: Handlers = {
    create_crew: (s) => createCrew(s),
    create_integration_tree: (s) => createIntegrationTree(s),
    integrate: (s, e) => integrate(s, e.integrationId),
    release_integration_tree: (s) => releaseIntegration(s),
    create_manager_tree: (s) => createManagerTree(s),
    release_manager_tree: (s) => releaseManagerTree(s),
    adopt_claim: (s, e) => adoptClaim(s, e.attemptId),
    admit: (s, e) => admit(s, e.attempt),
    create_worktree: (s, e) => createWorktree(s, e.attemptId),
    release_worktree: (s, e) => releaseAttemptTree(s, e.attemptId, e.keepCommits),
    start_validation: (s, e) => startValidation(s, e.validationId),
    create_validation_tree: (s, e) => createValidationTree(s, e.validationId),
    run_validation: (s, e) => runValidation(s, e.validationId),
    release_validation: (s, e) => releaseValidation(s, e.validationId),
    brief_attempt: (s, e) => briefAttempt(s, e.attempt),
    post_attempt: (s, e) => postAttempt(s, e.attemptId, e.body, e.round),
    meter_attempt: (s, e) => meterAttempt(s, e),
    post_status: (s, e) => postStatus(s, e.seq, e.text),
    post_badge: (s) => postBadge(s),
    cancel_attempt: (s, e) => cancelAttempt(s, e.attemptId),
    retire_tree: (s, e) => retireTree(s, e.tree),
    archive_branches: (s) => archiveBranches(s),
    archive_chats: (s, e) => archiveChats(s, e.chats),
    archive_crew: (s) => archiveCrew(s),
    record_retired: async () => [{ t: 'retired', at: now() }],
    file_retired: (s) => fileAway(s),
  };
  function run<E extends Effect>(s: State, effect: E): Promise<Entry[]> {
    const handler = handlers[effect.t] as (s: State, e: E) => Promise<Entry[]>;
    return handler(s, effect);
  }

  /**
   * Asks every unsettled run of a finished expedition's live attempt to stop, exactly as the
   * owner's Stop does (runner.ts `cancel`: the crate's cancelRun, then the `cancelled` event the
   * runner kills the turn on). 2026-11-01 audit #2: stop and deadline cancelled nothing, so live
   * workers ran on, unbounded, after the expedition finished.
   */
  async function cancelAttempt(s: State, attemptId: string): Promise<Entry[]> {
    if (s.crew.t !== 'ready') throw new Error('attempt cancelled before the crew exists');
    const posts = new Set(s.requests[attemptId]);
    const runs = (
      await core.listRuns({ kind: 'buddy', buddyId: s.crew.buddyId }, RUN_SCAN_LIMIT)
    ).filter((r) => r.input.kind === 'post' && posts.has(r.input.postId) && !SETTLED.has(r.status));
    for (const r of runs) {
      const run = await core.cancelRun(OWNER, r.id);
      events.emit({ kind: 'cancelled', run });
    }
    return [{ t: 'attempt_cancel_requested', at: now(), attemptId, runIds: runs.map((r) => r.id) }];
  }

  /** Where a tree's leftovers go when it is released (release.ts Keep). */
  const keepOf = (s: State, treeOf: string): Keep => ({
    salvageRef: `refs/salvage/expeditions/${s.id}/${treeOf}`,
    harvestDir: path.join(root, s.id, 'harvest', treeOf),
  });
  const preservedEntries = (treeOf: string, released: Released): Entry[] =>
    released.preserved.map((preserved) => ({ t: 'preserved', at: now(), treeOf, preserved }));

  // ---------- Retirement (plan A6): one handler per step ----------

  /** A tree retirement could not remove is a refusal: retirement waits for the owner. */
  const refusedTree = (branch: string, release: Release): Entry[] =>
    release.t === 'left'
      ? [{ t: 'archive_refused', at: now(), branch, reason: `tree left: ${release.reason}` }]
      : [];

  type TreeHandlers = {
    [K in RetireTree['t']]: (s: State, tree: Extract<RetireTree, { t: K }>) => Promise<Entry[]>;
  };
  const retireTrees: TreeHandlers = {
    attempt: async (s, { attemptId }) => {
      const tree = worktreeOf(s, attemptId);
      const released = await releaseWorktree(
        s.repo.root,
        tree,
        false,
        s.repo.branch,
        keepOf(s, attemptId),
        { t: 'retire' }
      );
      return [
        ...preservedEntries(attemptId, released),
        { t: 'worktree_released', at: now(), attemptId, release: released.release },
        ...refusedTree(tree.branch, released.release),
      ];
    },
    validation: async (s, { validationId }) => {
      const { tree } = startedOf(s, validationId);
      const released = await discardWorktree(s.repo.root, tree, keepOf(s, validationId));
      return [
        ...preservedEntries(validationId, released),
        { t: 'validation_released', at: now(), validationId, release: released.release },
        ...refusedTree(tree.branch, released.release),
      ];
    },
    integration: async (s) => {
      const released = await releaseIntegrationTree(
        s.repo.root,
        s.integrationTree,
        keepOf(s, 'integration'),
        { t: 'retire' }
      );
      return [
        ...preservedEntries('integration', released),
        { t: 'integration_tree_released', at: now(), release: released.release },
        ...refusedTree(s.repo.branch, released.release),
      ];
    },
    manager: async (s) => {
      const dir = path.join(root, s.id, 'manager');
      const released = await releaseDetachedTree(s.repo.root, dir, keepOf(s, 'manager'));
      return [
        ...preservedEntries('manager', released),
        { t: 'manager_tree_released', at: now(), release: released.release },
        ...refusedTree(`(manager tree ${dir})`, released.release),
      ];
    },
  };
  function retireTree<T extends RetireTree>(s: State, tree: T): Promise<Entry[]> {
    const handler = retireTrees[tree.t] as (s: State, tree: T) => Promise<Entry[]>;
    return handler(s, tree);
  }

  /**
   * Every expedition ref (attempt branches, the expedition branch, salvage pins; older code's
   * too) archived as `archive/expeditions/<id>/…` on origin and only then deleted (git.ts
   * archiveBranch). A ref origin does not confirm is refused and kept: never deleted while its
   * only copy is local.
   */
  async function archiveBranches(s: State): Promise<Entry[]> {
    const out: Entry[] = [];
    for (const ref of await expeditionRefs(s.repo.root, s.id)) {
      const archived = await archiveBranch(s.repo.root, ref, archiveTag(s.id, ref));
      switch (archived.t) {
        case 'archived':
          out.push({
            t: 'branch_archived',
            at: now(),
            branch: ref,
            sha: archived.sha,
            tag: archived.tag,
          });
          break;
        case 'refused':
          out.push({ t: 'archive_refused', at: now(), branch: ref, reason: archived.reason });
      }
    }
    return out.some((e) => e.t === 'archive_refused')
      ? out
      : [...out, { t: 'branches_archived', at: now() }];
  }

  /** The crew's own chats, by kind: never a DM it has with another Buddy. */
  type ChatOf = (crewId: string, crewChat: string) => Promise<string>;
  const chatOf: Record<RetireChat, ChatOf> = {
    crew_chat: async (_crewId, crewChat) => crewChat,
    // The note-to-self DM the attempts are posted in (postAttempt); opening it is idempotent.
    attempts: async (crewId) =>
      (
        await core.openChannel(buddyActor(crewId), {
          kind: 'direct',
          members: [buddyActor(crewId)],
        })
      ).id,
  };

  /** Before the crew is archived: its own DM is opened as the crew, which must still be active. */
  async function archiveChats(s: State, chats: RetireChat[]): Promise<Entry[]> {
    if (s.crew.t !== 'ready') throw new Error('chats archived before the crew exists');
    const out: Entry[] = [];
    for (const chat of chats) {
      const channelId = await chatOf[chat](s.crew.buddyId, s.crew.chatChannelId);
      await core.setChannelArchived(OWNER, channelId, true, `exp:${s.id}:retire:chat:${chat}`);
      onChannelArchived(channelId);
      out.push({ t: 'chat_archived', at: now(), chat, channelId });
    }
    return out;
  }

  async function archiveCrew(s: State): Promise<Entry[]> {
    if (s.crew.t !== 'ready') throw new Error('crew archived before it exists');
    const buddyId = s.crew.buddyId;
    await core.updateBuddy(OWNER, {
      buddyId,
      changes: { status: 'archived' },
      key: `exp:${s.id}:retire:crew`,
    });
    onBuddyArchived(buddyId);
    return [{ t: 'crew_archived', at: now(), buddyId }];
  }

  /** The ledger's last line is `retired`: frozen, moved, and from now on served as a snapshot. */
  async function fileAway(s: State): Promise<Entry[]> {
    const snapshot = snapshotOf(s, statusText(s, badge(s, now())));
    await fileRetired(root, s.id, snapshot);
    states.delete(s.id);
    counts.delete(s.id);
    streaks.delete(s.id);
    retired.set(s.id, snapshot);
    console.log(`[expeditions] ${s.id} retired`);
    return [];
  }

  async function createCrew(s: State): Promise<Entry[]> {
    const crew = await core.createBuddy(OWNER, {
      workspaceId: s.workspaceId,
      slug: `exp-${s.id}`.toLowerCase(),
      name: `⛺ ${s.charter.name}`,
      role: `${CREW_ROLE} Your expedition id: ${s.id}.`,
      manager: { kind: 'buddy', id: s.launcherId },
      provider: s.charter.crew.manager.provider,
      model: s.charter.crew.manager.model,
      reasoningEffort: s.charter.crew.manager.reasoningEffort,
      key: `exp:${s.id}:crew`,
    });
    // The owner↔crew DM is the expedition's chat (opening it is idempotent).
    const chat = await core.openChannel(OWNER, {
      kind: 'direct',
      members: [OWNER, buddyActor(crew.id)],
    });
    return [{ t: 'crew_ready', at: now(), buddyId: crew.id, chatChannelId: chat.id }];
  }

  async function releaseIntegration(s: State): Promise<Entry[]> {
    const released = await releaseIntegrationTree(
      s.repo.root,
      s.integrationTree,
      keepOf(s, 'integration'),
      { t: 'finish' }
    );
    return [
      ...preservedEntries('integration', released),
      { t: 'integration_tree_released', at: now(), release: released.release },
    ];
  }

  /** The manager's own tree (design.md R11) is a fixed path in the expedition's folder, made at
   * the branch head; an existing registration there is adopted (the replay path). */
  async function createManagerTree(s: State): Promise<Entry[]> {
    const made = await ensureDetachedTree(
      s.repo.root,
      path.join(root, s.id, 'manager'),
      await branchHead(s.repo)
    );
    switch (made.t) {
      case 'ready':
        return [{ t: 'manager_tree_ready', at: now(), path: made.at.path }];
      case 'failed':
        return [{ t: 'manager_tree_failed', at: now(), reason: made.reason }];
    }
  }

  async function releaseManagerTree(s: State): Promise<Entry[]> {
    const released = await releaseDetachedTree(
      s.repo.root,
      path.join(root, s.id, 'manager'),
      keepOf(s, 'manager')
    );
    return [
      ...preservedEntries('manager', released),
      { t: 'manager_tree_released', at: now(), release: released.release },
    ];
  }

  /** A manager's claim of an attempt's unreported commits holds only when the attempt's own
   * branch holds the commit inside its question's custody (git.ts claimHeld), like any claim. */
  async function adoptClaim(s: State, attemptId: string): Promise<Entry[]> {
    const adoption = s.adoptions[attemptId];
    if (adoption?.t !== 'pending') throw new Error(`no pending claim of ${attemptId}`);
    const tree = worktreeOf(s, attemptId);
    const custody = custodyOf(s, attemptOf(s, attemptId));
    const held = await claimHeld(s.repo.root, tree, adoption.claim.change, custody);
    switch (held.t) {
      case 'held':
        return [{ t: 'claim_adopted', at: now(), attemptId }];
      case 'not_held':
        return [{ t: 'claim_refused', at: now(), attemptId, reason: held.reason }];
    }
  }

  /** Intent first: the slot, custody and Cambium name are on disk before `cambium add` runs. */
  async function admit(s: State, attempt: Attempt<WorkerSpec>): Promise<Entry[]> {
    await append(s.id, [
      {
        t: 'worktree_creating',
        at: now(),
        attemptId: attempt.id,
        name: worktreeName(s.id, attempt.id),
        path: path.join(root, s.id, 'worktrees', attempt.id),
        branch: `exp/${s.id}/${attempt.id}`,
        baseSha: await treeBase(s, attempt.spec),
      },
    ]);
    return createWorktree(stateOf(s.id), attempt.id);
  }

  async function releaseAttemptTree(
    s: State,
    attemptId: string,
    keepCommits: boolean
  ): Promise<Entry[]> {
    const tree = worktreeOf(s, attemptId);
    const released = await releaseWorktree(
      s.repo.root,
      tree,
      keepCommits,
      s.repo.branch,
      keepOf(s, attemptId),
      { t: 'finish' }
    );
    return [
      ...preservedEntries(attemptId, released),
      { t: 'worktree_released', at: now(), attemptId, release: released.release },
    ];
  }

  /** Intent first: the resolved sha and the tree's name are on disk before `cambium add`. */
  async function startValidation(s: State, validationId: string): Promise<Entry[]> {
    const v = validationOf(s, validationId);
    const treeId = validationTreeId(v);
    await append(s.id, [
      {
        t: 'validation_started',
        at: now(),
        validationId: v.id,
        name: worktreeName(s.id, treeId),
        path: path.join(root, s.id, 'validations', treeId),
        branch: `exp/${s.id}/${treeId}`,
        baseSha: await validationSha(s, v.target),
      },
    ]);
    return createValidationTree(stateOf(s.id), v.id);
  }

  /**
   * Starts the check job in the background (never twice for one validation), recording
   * `validation_running` first. A job the ledger says is running that this process never started
   * died with an earlier process (audit #10): its tree is discarded and the validation restarts in
   * a fresh tree at the same immutable sha, keeping the checks already recorded. A job that throws
   * records a terminal `validation_failed` (audit #5), so it is never re-run hot.
   */
  async function runValidation(s: State, validationId: string): Promise<Entry[]> {
    const key = jobKey(s.id, validationId);
    if (jobs.has(key)) return [];
    const phase = startedOf(s, validationId);
    if (phase.job.t === 'running' && !ranHere.has(key)) return interrupted(s, validationId);
    ranHere.add(key);
    await append(s.id, [{ t: 'validation_running', at: now(), validationId }]);
    const id = s.id;
    const job = runChecks(id, validationId)
      .catch((error: unknown) => {
        console.warn(`[expeditions] validation ${key} could not run:`, error);
        return serialized(id, () =>
          append(id, [
            { t: 'validation_failed', at: now(), validationId, reason: errorText(error) },
          ])
        );
      })
      .catch((error: unknown) =>
        console.warn(`[expeditions] validation ${key} failure not recorded:`, error)
      )
      .finally(() => {
        jobs.delete(key);
        void tick(id);
      });
    jobs.set(key, job);
    return [];
  }

  /**
   * Why restart rather than adopt (design.md R11): adopting a check across a restart needs a
   * detached wrapper with pid and exit files that outlives the server, and a pid from another
   * boot cannot be trusted. The candidate sha is immutable and its checks are re-runnable by
   * contract, so a fresh run on the same sha is correct at the price of the time it re-spends; a
   * fresh tree (validationTreeId) keeps it from racing an orphan on build outputs, and discarding
   * the old tree pulls the orphan's files away so it fails fast instead of running on unseen.
   */
  async function interrupted(s: State, validationId: string): Promise<Entry[]> {
    const { tree } = startedOf(s, validationId);
    // The orphaned check, while it still runs (its pidfile survives only a crash): killed before
    // its tree is pulled, so the replay never races it.
    const killed = await killCheck(pidfileOf(`${tree.path}.scratch`));
    if (killed.t === 'killed')
      console.log(
        `[expeditions] ${s.id}: killed the orphaned check ${killed.pid} of ${validationId}`
      );
    const released = await discardWorktree(s.repo.root, tree, keepOf(s, validationId));
    return [
      ...preservedEntries(validationId, released),
      { t: 'validation_interrupted', at: now(), validationId, release: released.release },
    ];
  }

  /** Never pull a tree from under this host's own running check. */
  async function releaseValidation(s: State, validationId: string): Promise<Entry[]> {
    if (jobs.has(jobKey(s.id, validationId))) return [];
    const { tree } = startedOf(s, validationId);
    const released = await discardWorktree(s.repo.root, tree, keepOf(s, validationId));
    return [
      ...preservedEntries(validationId, released),
      { t: 'validation_released', at: now(), validationId, release: released.release },
    ];
  }

  /** Build and record the brief, then post it. A manager's tree is moved to the branch head
   * first, so the decision reads what it is told about (R11). */
  async function briefAttempt(s: State, attempt: Attempt): Promise<Entry[]> {
    await syncBeforeBrief(s, attempt);
    const body = briefOf(s, attempt);
    await append(s.id, [{ t: 'attempt_posting', at: now(), attemptId: attempt.id, body }]);
    return postAttempt(s, attempt.id, body, 'brief');
  }

  async function syncBeforeBrief(s: State, attempt: Attempt): Promise<void> {
    switch (attempt.spec.kind) {
      case 'manager':
        if (s.managerTree.t !== 'ready') throw new Error('a manager briefed without its tree');
        await syncDetachedTree(s.managerTree.path, await branchHead(s.repo));
        return;
      case 'work':
      case 'check':
        return;
    }
  }

  async function postStatus(s: State, seq: number, text: string): Promise<Entry[]> {
    if (s.crew.t !== 'ready') throw new Error('status posted before the crew exists');
    // Crew-authored in its own DM with the owner: wakes nobody, reads as the expedition.
    const write = await core.post(
      buddyActor(s.crew.buddyId),
      { kind: 'id', id: s.crew.chatChannelId },
      {
        kind: 'inform',
        body: text,
        purpose: 'expedition_status',
        evidence: [`expedition:${s.id}`],
        mentions: [],
        broadcast: false,
        key: `exp:${s.id}:status:${seq}`,
      }
    );
    return [{ t: 'status_posted', at: now(), seq, postId: write.post.id }];
  }

  /** The clickable badge in the chat the launch came from; the client renders posts with this
   * purpose as a live card that opens /expeditions/<id>. */
  async function postBadge(s: State): Promise<Entry[]> {
    const target = placementOf(s.origin, s.launcherId);
    const write = await core.post(buddyActor(s.launcherId), target.channel, {
      kind: 'inform',
      // Fallback text for readers without the card (a Buddy reading the thread).
      body: `⛺ Expedition launched: ${s.charter.name}. ${goalSummary(s.charter.goal)}`,
      purpose: 'expedition_badge',
      evidence: [`expedition:${s.id}`],
      replyToId: target.replyToId,
      mentions: [],
      broadcast: false,
      key: `exp:${s.id}:badge`,
    });
    return [{ t: 'badge_posted', at: now(), postId: write.post.id }];
  }

  /** A read, not a write: nothing is recorded while the attempt's runs are still settling. */
  async function meterAttempt(
    s: State,
    e: Extract<Effect, { t: 'meter_attempt' }>
  ): Promise<Entry[]> {
    if (s.crew.t !== 'ready') throw new Error('attempt metered before the crew exists');
    const nowMs = Date.parse(now());
    const metering = await meterRequest(
      core,
      meter,
      s.crew.buddyId,
      e.requestIds,
      nowMs,
      Date.parse(e.endedAt)
    );
    switch (metering.t) {
      case 'settling':
        return [];
      case 'metered':
        return [{ t: 'attempt_metered', at: now(), attemptId: e.attemptId, cost: metering.cost }];
    }
  }

  /** `launched` named the tree, so this is the replay path too: an existing workspace by that
   * name is adopted, a partial add rolled back (git.ts ensureWorktree). */
  async function createIntegrationTree(s: State): Promise<Entry[]> {
    const tree = s.integrationTree;
    const made = await ensureWorktree(s.repo.root, tree.name, tree, 'owned');
    switch (made.t) {
      case 'ready':
        return [{ t: 'integration_tree_ready', at: now() }];
      case 'failed':
        return [{ t: 'integration_tree_failed', at: now(), reason: made.reason }];
    }
  }

  /** The `integration_planned` intent is already on disk; mergeCandidate recognises a merge it
   * made before a crash, so the replay records that merge instead of merging twice, and refuses
   * a branch whose head is not the ledger's (`headOf`). */
  async function integrate(s: State, integrationId: string): Promise<Entry[]> {
    const integration = integrationOf(s, integrationId);
    const claim = claimAt(s, integration.claimAttemptId).statement.split('\n')[0].slice(0, 200);
    const message = `Integrate ${integration.claimAttemptId} (expedition ${s.id}): ${claim}`;
    const merged = await mergeCandidate(s.integrationTree, integration.sha, message, headOf(s));
    const ids = { at: now(), integrationId, sha: integration.sha };
    switch (merged.t) {
      case 'integrated':
        return [{ t: 'integrated', ...ids, mergeSha: merged.mergeSha }];
      case 'refused':
        return [{ t: 'integration_refused', ...ids, refusal: merged.refusal }];
    }
  }

  /** Where a worker's tree starts: work at the expedition branch head, a check at its claim's
   * candidate commit (a claim that changed no code is checked at the head). */
  async function treeBase(s: State, spec: WorkerSpec): Promise<string> {
    switch (spec.kind) {
      case 'work':
        return branchHead(s.repo);
      case 'check':
        return changeBase(s, claimOf(s, spec).change);
    }
  }
  async function changeBase(s: State, change: ClaimChange): Promise<string> {
    switch (change.t) {
      case 'commit':
        return change.sha;
      case 'no_code':
        return branchHead(s.repo);
    }
  }

  /** The immutable commit a validation runs on: the claim's, or the head as it is now. */
  async function validationSha(s: State, target: ValidationTarget): Promise<string> {
    switch (target.t) {
      case 'candidate':
        return target.sha;
      case 'head':
        return branchHead(s.repo);
    }
  }

  /** A fresh clean tree at the target; when none can be made, every check is a typed error. */
  async function createValidationTree(s: State, validationId: string): Promise<Entry[]> {
    const { tree, targetSha } = startedOf(s, validationId);
    const made = await ensureWorktree(s.repo.root, tree.name, tree);
    switch (made.t) {
      case 'ready':
        return [{ t: 'validation_tree_ready', at: now(), validationId }];
      case 'failed':
        return [
          { t: 'validation_tree_failed', at: now(), validationId, reason: made.reason },
          ...validationOf(s, validationId).checks.map(
            ({ index }): Entry => ({
              t: 'validation',
              at: now(),
              validationId,
              targetSha,
              checkIndex: index,
              outcome: { t: 'error', message: `no validation worktree: ${made.reason}` },
              report: report(targetSha, [], { t: 'unpinned', reason: 'no validation worktree' }),
            })
          ),
        ];
    }
  }

  /**
   * Runs the validation's unrecorded checks (frozen in its plan: a question's acceptance, or the
   * charter's done commands at the head) one by one in its tree, appending each result through
   * the expedition's chain. Each check re-reads the ledger: a finished or paused expedition stops
   * here (a resume continues from the first unrecorded check). Only between checks: a check
   * already running is not interrupted by pause or finish; it runs to its end or its timeout, its
   * result is recorded, and only then is the tree released (`release_validation` waits for it).
   */
  async function runChecks(id: string, validationId: string): Promise<void> {
    for (;;) {
      const s = stateOf(id);
      if (s.run.t === 'finished' || s.run.t === 'paused') return;
      const v = validationOf(s, validationId);
      const done = new Set(v.runs.map((r) => r.checkIndex));
      const next = v.checks.find((c) => !done.has(c.index));
      if (!next || v.failure.t === 'failed') return;
      const { tree, targetSha } = startedOf(s, validationId);
      const ran = await runPinned(next, tree.path, targetSha, trustedSha(v.basis, targetSha));
      await serialized(id, () =>
        append(id, [
          { t: 'validation', at: now(), validationId, targetSha, checkIndex: next.index, ...ran },
        ])
      );
    }
  }

  /**
   * One check with its validator sources pinned (pins.ts): hashed at the target sha before the
   * run, re-read after it; a changed validator never passes. Its HOME and TMPDIR are a throwaway
   * pair beside the tree (command.ts), removed when the run ends.
   */
  async function runPinned(
    check: { argv: string[]; timeoutSeconds: number },
    treePath: string,
    targetSha: string,
    trusted: string
  ): Promise<{ outcome: CheckOutcome; report: ValidationReport }> {
    const pinned = await pinSources(treePath, targetSha, trusted, check.argv);
    switch (pinned.t) {
      case 'mismatch':
        return {
          outcome: { t: 'error', message: pinned.reason },
          report: report(targetSha, [], { t: 'unpinned', reason: pinned.reason }),
        };
      case 'pinned': {
        const outcome = await runCommand(check, treePath, `${treePath}.scratch`);
        const after = await verifyPins(treePath, pinned.pins);
        return {
          outcome: pinnedOutcome(outcome, after),
          report: report(targetSha, pinned.pins, after),
        };
      }
    }
  }

  async function createWorktree(s: State, attemptId: string): Promise<Entry[]> {
    const tree = worktreeOf(s, attemptId);
    const made = await ensureWorktree(s.repo.root, tree.name, tree);
    switch (made.t) {
      case 'ready':
        return [{ t: 'worktree_ready', at: now(), attemptId, ...made.at }];
      case 'failed':
        return [{ t: 'worktree_failed', at: now(), attemptId, reason: made.reason }];
    }
  }

  /** Posts a recorded brief or repair request, keyed by attempt and round (a replay returns the
   * same post). */
  async function postAttempt(
    s: State,
    attemptId: string,
    body: string,
    round: 'brief' | 'repair'
  ): Promise<Entry[]> {
    if (s.crew.t !== 'ready') throw new Error('attempt posted before the crew exists');
    const attempt = attemptOf(s, attemptId);
    // The crew's note-to-self DM holds the attempts (plumbing), so the owner↔crew chat stays a chat.
    const crew = buddyActor(s.crew.buddyId);
    const write = await core.post(
      crew,
      { kind: 'direct', members: [crew] },
      {
        kind: 'request',
        body,
        purpose: 'expedition_attempt',
        evidence: [`expedition:${s.id}`],
        mentions: [],
        runConfig: { ...configOf(s.charter, attempt.spec), cwd: DEFAULT_CWD },
        broadcast: false,
        key: requestKey(s.id, attemptId, round),
      }
    );
    return [{ t: 'attempt_posted', at: now(), attemptId, requestId: write.post.id }];
  }

  /** Where an attempt's run starts (design.md R9, R11): a worker in its own worktree, a manager
   * in its own detached tree. A manager live before that tree existed (a ledger written before
   * R11) runs in the crew's own directory: never a git checkout of the owner's. */
  function attemptDirectory(s: State, attempt: Attempt, runId: string): Promise<TurnDirectory> {
    switch (attempt.spec.kind) {
      case 'work':
      case 'check':
        return workerTurnDirectory(s, attempt.id, runId);
      case 'manager':
        return managerTurnDirectory(s, runId);
    }
  }

  /** A worker runs in its own worktree while the tree exists. A legacy check repaired after its
   * tree was released (decide.ts repairLegacyChecks) only restates its verdict: it runs in the
   * crew's directory, never in a path that is gone. */
  function workerTurnDirectory(s: State, attemptId: string, runId: string): Promise<TurnDirectory> {
    const tree = worktreeOf(s, attemptId);
    switch (tree.status.t) {
      case 'creating':
      case 'ready':
        return Promise.resolve({ t: 'run', runId, path: tree.path });
      case 'failed':
      case 'kept':
      case 'removed':
      case 'absent':
      case 'left':
        return crewDirectory(s.id);
    }
  }

  function managerTurnDirectory(s: State, runId: string): Promise<TurnDirectory> {
    switch (s.managerTree.t) {
      case 'ready':
        return Promise.resolve({ t: 'run', runId, path: s.managerTree.path });
      case 'missing':
      case 'failed':
      case 'released':
        return crewDirectory(s.id);
    }
  }

  /** A crew's own directory: its expedition's folder in the host store, never a git checkout.
   * 2026-11-01 review: non-attempt crew turns (a mention, the owner's chat, a worker the crew
   * spawned) started in managerDirectory, which is the owner's checkout before setup and after
   * finish, or the integration tree the host merges into; and a seat whose cwd moved between
   * the two could not resume its session. One fixed directory for every such turn. */
  async function crewDirectory(id: string): Promise<TurnDirectory> {
    const dir = path.join(root, id, 'crew');
    await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
    return { t: 'crew', path: dir };
  }

  /** The live attempt whose request a run answers, matched by its exact brief or repair bytes,
   * which the ledger holds before the post exists (a run can be claimed before `attempt_posted`
   * is appended). Only posting/posted attempts: a boot warm of an old conversation's ended run
   * must not route (and cache) by run id (2026-11-01 review: it leaked a per-run briefing). */
  async function attemptOfRun(s: State, runId: string): Promise<Attempt | undefined> {
    const run = await core.getRun(runId);
    if (run.input.kind !== 'post') return undefined;
    const body = (await core.getPost(OWNER, run.input.postId)).body;
    return s.attempts.find(
      (a) =>
        (a.phase.t === 'posting' || a.phase.t === 'posted') &&
        (s.briefs[a.id] === body || s.repairs[a.id] === body)
    );
  }

  /**
   * κ for a Buddy turn's directory: a crew run answering one of its expedition's live attempt
   * requests starts in that attempt's directory; any other crew turn in the crew's own directory;
   * any other Buddy's turn in its workspace root.
   */
  async function turnDirectory(context: BuddyContext): Promise<TurnDirectory> {
    const id = crewOf(context.buddyId);
    if (!id) return WORKSPACE_DIRECTORY;
    const runId = context.coordinationRunId;
    if (!runId) return crewDirectory(id);
    const s = stateOf(id);
    const attempt = await attemptOfRun(s, runId);
    return attempt ? attemptDirectory(s, attempt, runId) : crewDirectory(id);
  }

  /** Every ready crew's Buddy id. */
  const crews = (): string[] =>
    [...states.values()].flatMap((s) => (s.crew.t === 'ready' ? [s.crew.buddyId] : []));

  /** The expedition a Buddy crews (from the cached states: no fold per Buddy turn). */
  function crewOf(buddyId: string): string | undefined {
    return [...states].find(([, s]) => s.crew.t === 'ready' && s.crew.buddyId === buddyId)?.[0];
  }

  // ---------- Tick ----------

  async function tickOnce(id: string): Promise<TickResult> {
    let wrote = false;
    const failures: string[] = [];
    for (let round = 0; round < ROUNDS_PER_TICK; round += 1) {
      // A retirement filed it away (fileAway): nothing of it is left to tick.
      if (!states.has(id)) break;
      const before = counts.get(id) ?? 0;
      const observed = await observe(stateOf(id));
      failures.push(...observed.failures);
      await append(id, observed.entries);
      await append(id, decide(forDecide(id), clock()));
      for (const effect of pendingEffects(stateOf(id))) {
        // Each effect reads the state its predecessor left (a brief sees earlier postings), and
        // runs on its own: one that throws is a typed failure of this tick, never a stop for the
        // effects after it. 2026-11-01 review: a release whose `cambium list` failed kept every
        // later effect, the stop's cancel_attempt included, from running.
        try {
          await append(id, await run(stateOf(id), effect));
        } catch (error) {
          failures.push(`effect ${effect.t}: ${errorText(error)}`);
        }
      }
      // A round that wrote nothing is settled (a running check job's effect writes nothing), so
      // the tick neither spins nor emits a change that would wake itself again.
      if ((counts.get(id) ?? 0) === before) break;
      wrote = true;
    }
    if (wrote) events.emit({ kind: 'changed' });
    // One reason per distinct failure: each round re-observes, and would repeat it.
    const reasons = [...new Set(failures)];
    return reasons.length === 0 ? { t: 'ok' } : { t: 'part_failed', reasons };
  }

  /** Runs `work` on the expedition's chain: after every earlier tick and append, before later ones. */
  function serialized<T>(id: string, work: () => Promise<T>): Promise<T> {
    const next = (chains.get(id) ?? Promise.resolve()).then(work);
    chains.set(
      id,
      next.then(
        () => undefined,
        () => undefined
      )
    );
    return next;
  }

  /**
   * Serialized per expedition. A tick that throws, or whose observation failed, extends the
   * expedition's failure streak; after TICK_FAILURE_LIMIT in a row the host records `tick_failed`
   * and waits a doubling backoff before the next tick (audit #1). A clean tick ends the streak.
   */
  function tick(id: string): Promise<void> {
    const streak = streaks.get(id);
    if (streak && Date.parse(now()) < streak.until) return Promise.resolve();
    return serialized(id, () => tickOnce(id)).then(
      (result) => tickSettled(id, result),
      (error: unknown) => tickFailed(id, [errorText(error)])
    );
  }

  function tickSettled(id: string, result: TickResult): Promise<void> {
    switch (result.t) {
      case 'ok':
        streaks.delete(id);
        return Promise.resolve();
      case 'part_failed':
        return tickFailed(id, result.reasons);
    }
  }

  async function tickFailed(id: string, reasons: string[]): Promise<void> {
    const failures = (streaks.get(id)?.failures ?? 0) + 1;
    const reason = reasons.join('; ');
    console.warn(`[expeditions] tick ${id} failed (${failures} in a row): ${reason}`);
    if (failures < TICK_FAILURE_LIMIT) {
      streaks.set(id, { failures, until: 0 });
      return;
    }
    const backoff = Math.min(
      BACKOFF_BASE_MS * 2 ** (failures - TICK_FAILURE_LIMIT),
      BACKOFF_MAX_MS
    );
    streaks.set(id, { failures, until: Date.parse(now()) + backoff });
    if (!states.has(id)) return;
    await serialized(id, () =>
      append(id, [{ t: 'tick_failed', at: now(), failures, reason: reason.slice(0, 2000) }])
    ).catch((error: unknown) =>
      console.warn(`[expeditions] ${id}: tick_failed not recorded:`, error)
    );
  }

  // A finished expedition stays active while it owes effects (its last status, worktree removal,
  // a bounded metering read) or has live attempts: their ends are still observed, and only then
  // are their trees released. Reads the cached states: no fold per event.
  const active = () =>
    [...states].flatMap(([id, s]) =>
      s.run.t !== 'finished' || live(s).length > 0 || pendingEffects(s).length > 0 ? [id] : []
    );
  const tickAll = () => Promise.all(active().map(tick)).then(() => undefined);

  /** The owner wrote in an expedition's chat: its next tick runs whatever a failing streak's
   * backoff says, as a steer does. 2026-11-01 review: "resume" in the chat (the L3 recovery path)
   * waited out up to 30 minutes of backoff, because only the steer tool cleared the streak. */
  function ownerPosted(channelId: string): void {
    for (const [id, s] of states)
      if (s.crew.t === 'ready' && s.crew.chatChannelId === channelId) streaks.delete(id);
  }

  let debounce: NodeJS.Timeout | null = null;
  const wake = labelled('timer expeditions-wake', () => {
    debounce = null;
    void tickAll();
  });
  /** Wake-on-write and the backstop, started by `start` (after boot adoption), never at
   * construction: a tick before `interruptBootLive` could observe a crew run the restart is
   * about to cancel. Returns how to stop them. */
  function startTicking(): () => void {
    const unsubscribe = events.on((event) => {
      if (event.kind !== 'changed' && event.kind !== 'posted') return;
      if (event.kind === 'posted' && event.post.author.kind === 'owner')
        ownerPosted(event.channel.id);
      if (debounce || active().length === 0) return;
      debounce = setTimeout(wake, DEBOUNCE_MS);
      debounce.unref();
    });
    const backstop = setInterval(
      labelled('timer expeditions-backstop', () => void tickAll()),
      BACKSTOP_MS
    );
    backstop.unref();
    void tickAll();
    return () => {
      unsubscribe();
      clearInterval(backstop);
    };
  }
  // A disabled gate (a copied store, execution-gate.ts) never ticks; launch and steer refuse.
  const TICKING: Record<ExecutionGate['t'], () => () => void> = {
    enabled: startTicking,
    disabled: () => () => undefined,
  };
  type Ticking = { t: 'stopped' } | { t: 'started'; stop: () => void };
  let ticking: Ticking = { t: 'stopped' };
  function start(): void {
    if (ticking.t === 'started') throw new Error('the expedition host is already started');
    ticking = { t: 'started', stop: TICKING[gate.t]() };
  }

  // ---------- Restart: no crew turn outlives the backend that started it ----------

  /**
   * Boot, before execution adoption and before the runner starts (server.ts). Every unsettled
   * run of every ready crew is cancelled, and every attempt still waiting on one ends
   * `interrupted` (decide replans it on a new session). Regression: owner 2026-11-03: crews
   * restart on new sessions. Cancelling is what keeps a crew's run from resuming: adoption
   * refuses the crew's turn (adopt-executions.ts restartOf), and a run left `running` would end
   * `lease_expired`, which decision G (runs.rs `resume`) continues ONCE in the SAME
   * conversation, on the dead backend's session. A cancelled run ends `cancelled`, never resumed.
   * A copied store (gate disabled) runs nothing, so it cancels and writes nothing.
   */
  async function interruptBootLive(): Promise<void> {
    if (gate.t === 'disabled') return;
    for (const [id, s] of [...states])
      if (s.crew.t === 'ready')
        await serialized(id, () => interruptCrew(id)).catch((error: unknown) =>
          console.error(`[expeditions] ${id}: the crew's runs could not be interrupted:`, error)
        );
  }

  async function interruptCrew(id: string): Promise<void> {
    // An attempt whose brief is recorded but not its post is posted first (same key: a post a
    // crash left is found, not made twice), so every live attempt names its request.
    for (const a of stateOf(id).attempts)
      if (a.phase.t === 'posting')
        await append(id, await postAttempt(stateOf(id), a.id, a.phase.body, a.phase.round));
    const s = stateOf(id);
    if (s.crew.t !== 'ready') throw new Error(`expedition ${id} interrupted before its crew`);
    // Before the cancel: an attempt whose request already settled is the observer's, not ours.
    const waiting: Attempt[] = [];
    for (const a of s.attempts) {
      if (a.phase.t !== 'posted') continue;
      const request = await core.getPost(OWNER, a.phase.requestId);
      if (request.request.state === 'awaiting' || request.request.state === 'none') waiting.push(a);
    }
    const unsettled = (
      await core.listRuns({ kind: 'buddy', buddyId: s.crew.buddyId }, RUN_SCAN_LIMIT)
    ).filter((r) => !SETTLED.has(r.status));
    for (const r of unsettled) {
      const run = await core.cancelRun(OWNER, r.id);
      events.emit({ kind: 'cancelled', run });
    }
    for (const a of waiting) {
      const posts = new Set(s.requests[a.id]);
      const runIds = unsettled
        .filter((r) => r.input.kind === 'post' && posts.has(r.input.postId))
        .map((r) => r.id);
      await append(id, [
        await ended(stateOf(id), a, { t: 'interrupted', cause: 'server_restart', runIds }),
      ]);
    }
    if (unsettled.length > 0 || waiting.length > 0)
      console.log(
        `[expeditions] ${id}: restart cancelled ${unsettled.length} crew runs, interrupted ${waiting.length} attempts`
      );
  }

  /**
   * Every reason a launch of this charter is refused, in one list (draft and launch share it):
   * execution disabled on this host, the R4 preflight, the charter's own refusals and each crew
   * seat against the provider catalog. Reads only.
   */
  async function preflightOf(workspaceId: string, charter: Charter) {
    const issues = [
      ...gateIssues(gate),
      ...charterIssues(charter),
      ...seatIssues(charter, installed),
    ];
    const workspace = (await core.listWorkspaces()).find((w) => w.id === workspaceId);
    if (!workspace)
      return { t: 'refused' as const, reasons: [`no workspace ${workspaceId}`, ...issues] };
    const bins = commandChecks(charter).map(({ check }) => check.argv[0]);
    const checked = await preflight(workspace.rootPath, bins);
    switch (checked.t) {
      case 'refused':
        return { t: 'refused' as const, reasons: [...checked.reasons, ...issues] };
      case 'ready':
        return issues.length > 0 ? { t: 'refused' as const, reasons: issues } : checked;
    }
  }

  /**
   * One launch per (conversation, name) while it is open: a retried tool call gets the running
   * expedition back as `already_running`; once that one finished, the same name launches anew.
   */
  async function launchOnce(input: LaunchInput): Promise<Launched> {
    const prior = [...states.values()].find((s) => s.key === input.key && s.run.t !== 'finished');
    if (prior) return { t: 'already_running', state: prior };
    const checked = await preflightOf(input.workspaceId, input.charter);
    if (checked.t === 'refused') throw new LaunchRefused(checked.reasons);
    const id = `${input.charter.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 24)}-${randomUUID().slice(0, 6)}`;
    const repo = { root: checked.root, baseSha: checked.baseSha, branch: `expedition/${id}` };
    // The integration tree is named here, in the launch entry: its create replays from it.
    const integrationTree = {
      name: worktreeName(id, 'integration'),
      path: path.join(root, id, 'integration'),
    };
    // One batch: `launched` and the launch status (the badge in the thread from the first
    // second). The state joins the map only once that line is on disk, so every expedition in
    // the map folds and no tick ever meets a half-written launch.
    const first: Entry[] = [
      { t: 'launched', at: now(), id, ...input, repo, integrationTree },
      { t: 'status', at: now(), seq: 0, text: launchNews(input.charter) },
    ];
    await createLedger(path.join(root, id), fileOf(id), first);
    states.set(id, fold(first));
    counts.set(id, first.length);
    await tick(id);
    return { t: 'launched', state: stateOf(id) };
  }

  /** What a launch of this charter would refuse, without writing anything (the `draft`). */
  async function issues(workspaceId: string, charter: Charter): Promise<string[]> {
    const checked = await preflightOf(workspaceId, charter);
    return checked.t === 'refused' ? checked.reasons : [];
  }
  function lookup(id: string): Lookup {
    const reason = quarantined.get(id);
    if (reason) return { t: 'quarantined', reason };
    // A retired ledger is served live until its folder is moved (fileAway), then as a snapshot.
    if (states.has(id)) return { t: 'present' };
    return retired.has(id) ? { t: 'retired' } : { t: 'missing' };
  }

  /** The entries a retire request records, per mode; `not_finished` when it may not retire. */
  const RETIRE_ENTRIES: Record<RetireMode, (s: State, by: string) => Entry[] | 'not_finished'> = {
    retire: (s, by) =>
      s.run.t === 'finished'
        ? [{ t: 'retire_requested', at: now(), by, stop: false }]
        : 'not_finished',
    // The owner's stop rides with the request, so owner_stop finishes it first (decide.ts).
    stop_and_retire: (s, by) =>
      s.run.t === 'finished'
        ? [{ t: 'retire_requested', at: now(), by, stop: false }]
        : [
            { t: 'retire_requested', at: now(), by, stop: true },
            { t: 'feedback', at: now(), from: by, via: { t: 'tool' }, feedback: { t: 'stop' } },
          ],
  };

  /** Through the expedition's chain, like a steer; the steps then run on its ticks. */
  async function requestRetire(id: string, by: string, mode: RetireMode): Promise<Retire> {
    const s = stateOf(id);
    if (s.retirement.t === 'retired') return { t: 'already_retired' };
    const entries = RETIRE_ENTRIES[mode](s, by);
    if (entries === 'not_finished') return { t: 'not_finished' };
    await append(id, entries);
    return { t: 'retiring' };
  }

  async function retire(id: string, by: string, mode: RetireMode): Promise<Retire> {
    if (gate.t === 'disabled') return { t: 'disabled', reason: gateIssues(gate).join('; ') };
    const found = lookup(id);
    switch (found.t) {
      case 'missing':
      case 'quarantined':
        return found;
      case 'retired':
        return { t: 'already_retired' };
      case 'present': {
        const recorded = await serialized(id, () => requestRetire(id, by, mode));
        // The owner's word runs at once, whatever a failing streak's backoff says; the steps may
        // take minutes (a forced remove), so the request does not wait for them.
        streaks.delete(id);
        void tick(id);
        return recorded;
      }
    }
  }

  /** Serialized: two concurrent launches with one key cannot both pass the lookup. */
  const launch = (input: LaunchInput): Promise<Launched> =>
    serialized(LAUNCH_CHAIN, () => launchOnce(input));
  // Drafts launch through this same path; a refusal is data for the card, not a thrown error.
  const drafts = createDraftStore({
    core,
    events,
    dir: path.join(root, 'drafts'),
    issues,
    now,
    // Every folded expedition carries its launch key and time (fold reads its `launched` entry).
    launches: () => [...states.values()].map((s) => ({ key: s.key, id: s.id, at: s.launchedAt })),
    launch: (input): Promise<LaunchOutcome> =>
      launch(input).catch((error: unknown) => {
        if (error instanceof LaunchRefused) return { t: 'refused', reasons: error.reasons };
        throw error;
      }),
  });

  return {
    issues,
    launch,
    drafts: {
      ...drafts,
      /** A copied store drafts nothing either: the gate refuses before any file is written. */
      draft: async (input: DraftInput) => {
        if (gate.t === 'disabled') throw new Error(gateIssues(gate).join('; '));
        return drafts.draft(input);
      },
    },
    async steer(id: string, from: string, feedback: Feedback): Promise<State> {
      if (gate.t === 'disabled') throw new Error(gateIssues(gate).join('; '));
      stateOf(id);
      // Through the chain: a steer never interleaves its write with a running tick's.
      await serialized(id, () =>
        append(id, [{ t: 'feedback', at: now(), from, via: { t: 'tool' }, feedback }])
      );
      // The owner's word retries at once, whatever a failing streak's backoff says.
      streaks.delete(id);
      await tick(id);
      return stateOf(id);
    },
    lookup,
    retire,
    /** A retired expedition's frozen record (lookup said `retired`). */
    retiredView(id: string): ExpeditionRetiredView {
      const snapshot = retired.get(id);
      if (!snapshot) throw new Error(`expedition ${id} is not retired`);
      return retiredView(snapshot);
    },
    view(id: string): ExpeditionView {
      const s = stateOf(id);
      return expeditionView(s, badge(s, now()), now());
    },
    /** The status report; a retired expedition's is its frozen one. */
    status(id: string): string {
      const frozen = states.has(id) ? undefined : retired.get(id);
      if (frozen) return frozen.report;
      const s = stateOf(id);
      return statusText(s, badge(s, now()));
    },
    /** Only expeditions that fold: a quarantined ledger never fails the listing. */
    list(workspaceId: string): { id: string; badge: string }[] {
      return [...states.values()]
        .filter((s) => s.workspaceId === workspaceId)
        .map((s) => ({ id: s.id, badge: badge(s, now()) }));
    },
    /** Every foldable expedition and every retired one, newest launch first (quarantined
     * ledgers are in neither). */
    summaries(): ExpeditionSummary[] {
      return [
        ...[...states.values()].map(expeditionSummary),
        ...[...retired.values()].filter((r) => !states.has(r.summary.id)).map((r) => r.summary),
      ].sort((a, b) => b.launchedAt.localeCompare(a.launchedAt));
    },
    /** The expedition a crew Buddy belongs to, so a mentioned crew can answer about itself. */
    ofCrew: crewOf,
    /** Every crew Buddy (the client keeps them off the Buddies roster). */
    crews,
    /** policy-port.ts CrewRegistry: adoption, session scope and shutdown ask it. */
    crewBuddyIds: (): ReadonlySet<string> => new Set(crews()),
    interruptBootLive,
    /** Starts ticking (server.ts: after `interruptBootLive` and execution adoption). */
    start,
    turnDirectory,
    workspaceOf: (id: string) =>
      states.get(id)?.workspaceId ??
      retired.get(id)?.summary.workspaceId ??
      stateOf(id).workspaceId,
    /** Tests drive ticks directly. */
    tick,
    /** Tests: resolves once no validation check job runs and the ticks they woke have settled. */
    async drain(): Promise<void> {
      do {
        await Promise.all([...jobs.values()]);
        await Promise.all([...chains.values()]);
      } while (jobs.size > 0);
    },
    close(): void {
      if (ticking.t === 'started') ticking.stop();
      ticking = { t: 'stopped' };
      if (debounce) clearTimeout(debounce);
    },
  };
}

/** Attempt request keys: the brief's is unchanged since R1, so a replay of an older ledger finds
 * its earlier post; the repair has its own. */
function requestKey(id: string, attemptId: string, round: 'brief' | 'repair'): string {
  switch (round) {
    case 'brief':
      return `exp:${id}:attempt:${attemptId}`;
    case 'repair':
      return `exp:${id}:attempt:${attemptId}:repair`;
  }
}

/**
 * The origin tag an expedition ref is archived at: `archive/expeditions/<id>/` plus the attempt
 * (or validation) id for `refs/heads/exp/<id>/<x>`, `expedition` for the expedition branch, and
 * `salvage/<tree>` for a salvage pin. Each ref has its own tag, so no tag can be another's prefix
 * directory (attempt ids are never `salvage` or `expedition`). A ref of no known shape keeps its
 * full name under `other/`, never silently mapped onto another's tag.
 */
export function archiveTag(id: string, ref: string): string {
  const base = `archive/expeditions/${id}`;
  const prefixes: [string, string][] = [
    [`refs/heads/exp/${id}/`, ''],
    [`refs/salvage/expeditions/${id}/`, 'salvage/'],
  ];
  if (ref === `refs/heads/expedition/${id}`) return `${base}/expedition`;
  for (const [prefix, into] of prefixes)
    if (ref.startsWith(prefix)) return `${base}/${into}${ref.slice(prefix.length)}`;
  return `${base}/other/${ref.replace(/^refs\//, '')}`;
}

/** A posted attempt's phase (the observer reads only posted attempts). */
function postedPhase(attempt: Attempt): Extract<AttemptPhase, { t: 'posted' }> {
  if (attempt.phase.t !== 'posted') throw new Error(`attempt ${attempt.id} is ${attempt.phase.t}`);
  return attempt.phase;
}

/** The end of a work attempt that reports its commit: a code claim (held or not, its commits are
 * then the claim's business, host.ts heldOutcome). */
function reportsCommit(o: EndOutcome): boolean {
  return o.t === 'work' && o.result.result === 'claim' && o.result.change.t === 'commit';
}

/** Whose validator bytes a validation trusts (pins.ts): for a candidate, the expedition branch
 * when its question's acceptance was declared; at done, the head itself (the owner's branch is
 * the trust root there). */
function trustedSha(basis: ValidationBasis, targetSha: string): string {
  switch (basis.t) {
    case 'done':
      return targetSha;
    case 'acceptance':
      return basis.trustedSha;
  }
}
