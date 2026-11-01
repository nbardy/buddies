import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { BuddiesCore } from '@unleashd/buddies-core';
import type { BuddyContext, ExpeditionSummary, ExpeditionView } from '@unleashd/shared';
import { type TurnDirectory, WORKSPACE_DIRECTORY } from '../buddies/briefing';
import { OWNER, buddyActor } from '../buddies/core';
import type { BuddyEvents } from '../buddies/events';
import type { ExecutionGate } from '../buddies/execution-gate';
import { checkedRunConfig } from '../buddies/worker-config';
import { labelled } from '../observability/event-loop-stall';
import { CREW_ROLE, briefOf, chatFeedback, parseOutcome, statusText } from './briefs';
import { runCommand } from './command';
import { type DraftInput, type LaunchOutcome, createDraftStore, placementOf } from './drafts';
import {
  branchHead,
  claimHeld,
  discardWorktree,
  ensureWorktree,
  mergeCandidate,
  preflight,
  releaseIntegrationTree,
  releaseWorktree,
} from './git';
import { type MeterPorts, meterRequest } from './meter';
import {
  type Attempt,
  type Charter,
  type ClaimChange,
  type Clock,
  type Effect,
  type Entry,
  type Feedback,
  type Origin,
  type Outcome,
  type State,
  type ValidationTarget,
  type WorkerSpec,
  attemptOf,
  badge,
  charterIssues,
  claimAt,
  claimOf,
  commandChecks,
  configOf,
  costTotals,
  custodyOf,
  decide,
  fold,
  goalSummary,
  integrationOf,
  launchNews,
  live,
  managerDirectory,
  pendingEffects,
  startedOf,
  validationOf,
  worktreeName,
  worktreeOf,
} from './model';
import { countsOf, expeditionView } from './view';

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

/** Each crew seat checked against the provider catalog (worker-config.ts): one issue per seat. */
function seatIssues(charter: Charter): string[] {
  const { crew } = charter;
  return [crew.manager, ...crew.work, ...crew.check].flatMap((seat) => {
    try {
      checkedRunConfig(seat);
      return [];
    } catch (error) {
      return [(error as Error).message];
    }
  });
}

/** What the host knows of an expedition id: a ledger it folds, one it set aside because it does
 * not fold (named, with the reason; the other expeditions keep running), or none. */
export type Lookup = { t: 'present' } | { t: 'quarantined'; reason: string } | { t: 'missing' };

/** A launch with this (conversation, name) key is still open: the retried call gets it back. */
export type Launched = { t: 'launched'; state: State } | { t: 'already_running'; state: State };

/**
 * One ledger line is one append: the batch of entries written together (a decide batch with its
 * `manager_applied`, an intent, an effect's result). A crash during `appendFile` leaves at most a
 * torn LAST line, which is a batch that never landed: boot cuts it off (its effect had not run,
 * or replays idempotently), so a batch is applied whole or not at all.
 */
type LedgerFile = { t: 'read'; entries: Entry[]; torn: number } | { t: 'corrupt'; reason: string };

function readLedgerFile(file: string): LedgerFile {
  // Sync fs at boot only (createExpeditionHost runs once, before any tick).
  const bytes = fs.readFileSync(file);
  const end = bytes.lastIndexOf(0x0a) + 1;
  const torn = bytes.length - end;
  if (torn > 0) fs.truncateSync(file, end);
  const lines = bytes.subarray(0, end).toString('utf8').split('\n').filter(Boolean);
  try {
    return { t: 'read', entries: lines.flatMap((line) => JSON.parse(line) as Entry[]), torn };
  } catch (error) {
    return { t: 'corrupt', reason: `unreadable line: ${(error as Error).message}` };
  }
}

/** A launch the preflight refused (design.md R4), with every reason; nothing was written. */
export class LaunchRefused extends Error {
  constructor(readonly reasons: string[]) {
    super(`Expedition launch refused: ${reasons.join('; ')}.`);
  }
}

export function createExpeditionHost(options: ExpeditionHostOptions) {
  const { core, events, root, gate, meter } = options;
  const now = () => (options.now ?? (() => new Date()))().toISOString();
  const ledgers = new Map<string, Entry[]>();
  /** Ledgers that do not fold, with why. Set aside, never deleted: the file stays for the owner. */
  const quarantined = new Map<string, string>();
  const quarantine = (id: string, reason: string) => {
    console.warn(`[expeditions] ${id} quarantined: ${reason}`);
    ledgers.delete(id);
    quarantined.set(id, reason);
  };
  const chains = new Map<string, Promise<void>>();
  /** Validation check jobs running in this process, by `<expedition>/<validation>`. They run
   * outside the tick chain (a check may take hours; a steer must not wait on it) and append each
   * result through the chain. In-memory only: after a restart the ledger's unrecorded checks are
   * the work, and `run_validation` resumes them. */
  const jobs = new Map<string, Promise<void>>();
  const jobKey = (id: string, validationId: string) => `${id}/${validationId}`;
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });

  const fileOf = (id: string) => path.join(root, id, 'ledger.jsonl');
  /** One line per batch (see readLedgerFile): a batch lands whole or, torn, not at all. */
  const line = (entries: Entry[]) => `${JSON.stringify(entries)}\n`;
  async function append(id: string, entries: Entry[]): Promise<void> {
    if (entries.length === 0) return;
    const ledger = ledgers.get(id);
    if (!ledger) throw new Error(`unknown expedition ${id}`);
    await fsp.appendFile(fileOf(id), line(entries), { mode: 0o600 });
    ledger.push(...entries);
  }
  const stateOf = (id: string): State => {
    const ledger = ledgers.get(id);
    if (!ledger) {
      const reason = quarantined.get(id);
      throw new Error(
        reason ? `expedition ${id} is quarantined: ${reason}` : `unknown expedition ${id}`
      );
    }
    return fold(ledger);
  };
  /** The state, or none when the ledger no longer folds (a broken invariant): quarantined. */
  function foldOrQuarantine(id: string): State | undefined {
    try {
      return stateOf(id);
    } catch (error) {
      quarantine(id, `does not fold: ${(error as Error).message}`);
      return undefined;
    }
  }

  // Boot: read every ledger once; ticks resume what they explain. A ledger that cannot be read
  // or folded is quarantined, so one bad file never stops the server or the other expeditions.
  for (const id of fs.readdirSync(root)) {
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
        ledgers.set(id, read.entries);
        foldOrQuarantine(id);
    }
  }

  const clock = (): Clock => ({
    now: now(),
    nextId: (prefix) => `${prefix}${randomUUID().slice(0, 6)}`,
  });

  // ---------- Observation: settled requests become attempt_ended ----------

  async function observe(s: State): Promise<Entry[]> {
    const out: Entry[] = [...(await observeChat(s))];
    for (const attempt of s.attempts) {
      if (attempt.phase.t !== 'posted') continue;
      const request = await core.getPost(OWNER, attempt.phase.requestId);
      switch (request.request.state) {
        case 'awaiting':
        case 'none':
          continue;
        case 'answered': {
          const answer = await core.getPost(OWNER, request.request.answerId);
          out.push({
            t: 'attempt_ended',
            at: now(),
            attemptId: attempt.id,
            outcome: await heldOutcome(
              s,
              attempt.id,
              answer.body,
              parseOutcome(attempt.spec.kind, answer.body)
            ),
          });
          continue;
        }
        case 'failed':
        case 'cancelled':
          out.push({
            t: 'attempt_ended',
            at: now(),
            attemptId: attempt.id,
            outcome: { t: 'failed', status: request.request.state },
          });
          continue;
      }
    }
    return out;
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
    outcome: Outcome
  ): Promise<Outcome> {
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

  // ---------- Effects ----------

  async function run(s: State, effect: Effect): Promise<Entry[]> {
    switch (effect.t) {
      case 'create_integration_tree':
        return createIntegrationTree(s);
      case 'integrate':
        return integrate(s, effect.integrationId);
      case 'release_integration_tree': {
        const release = await releaseIntegrationTree(s.repo.root, s.integrationTree.name);
        return [{ t: 'integration_tree_released', at: now(), release }];
      }
      case 'admit': {
        // Intent first: the slot, custody and Cambium name are on disk before `cambium add` runs.
        const { attempt } = effect;
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
      case 'create_worktree':
        return createWorktree(s, effect.attemptId);
      case 'release_worktree': {
        const tree = worktreeOf(s, effect.attemptId);
        const release = await releaseWorktree(
          s.repo.root,
          tree.name,
          tree,
          effect.keepCommits,
          s.repo.branch
        );
        return [{ t: 'worktree_released', at: now(), attemptId: effect.attemptId, release }];
      }
      case 'start_validation': {
        // Intent first: the resolved sha and the tree's name are on disk before `cambium add`.
        const v = validationOf(s, effect.validationId);
        await append(s.id, [
          {
            t: 'validation_started',
            at: now(),
            validationId: v.id,
            name: worktreeName(s.id, v.id),
            path: path.join(root, s.id, 'validations', v.id),
            branch: `exp/${s.id}/${v.id}`,
            baseSha: await validationSha(s, v.target),
          },
        ]);
        return createValidationTree(stateOf(s.id), v.id);
      }
      case 'create_validation_tree':
        return createValidationTree(s, effect.validationId);
      case 'run_validation': {
        const key = jobKey(s.id, effect.validationId);
        if (jobs.has(key)) return [];
        const job = runChecks(s.id, effect.validationId)
          .catch((error) => console.warn(`[expeditions] validation ${key} failed:`, error))
          .finally(() => {
            jobs.delete(key);
            void tick(s.id);
          });
        jobs.set(key, job);
        return [];
      }
      case 'release_validation': {
        // Never pull a tree from under this host's own running check.
        if (jobs.has(jobKey(s.id, effect.validationId))) return [];
        const { tree } = startedOf(s, effect.validationId);
        const release = await discardWorktree(s.repo.root, tree.name, tree);
        return [
          { t: 'validation_released', at: now(), validationId: effect.validationId, release },
        ];
      }
      case 'create_crew': {
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
      case 'brief_attempt': {
        const body = briefOf(s, effect.attempt);
        await append(s.id, [
          { t: 'attempt_posting', at: now(), attemptId: effect.attempt.id, body },
        ]);
        return postAttempt(s, effect.attempt.id, body);
      }
      case 'post_attempt':
        return postAttempt(s, effect.attemptId, effect.body);
      case 'meter_attempt':
        return meterAttempt(s, effect.attemptId, effect.requestId);
      case 'post_status': {
        if (s.crew.t !== 'ready') throw new Error('status posted before the crew exists');
        // Crew-authored in its own DM with the owner: wakes nobody, reads as the expedition.
        const write = await core.post(
          buddyActor(s.crew.buddyId),
          { kind: 'id', id: s.crew.chatChannelId },
          {
            kind: 'inform',
            body: effect.text,
            purpose: 'expedition_status',
            evidence: [`expedition:${s.id}`],
            mentions: [],
            broadcast: false,
            key: `exp:${s.id}:status:${effect.seq}`,
          }
        );
        return [{ t: 'status_posted', at: now(), seq: effect.seq, postId: write.post.id }];
      }
      case 'post_badge': {
        // The clickable badge in the chat the launch came from; the client renders posts with
        // this purpose as a live card that opens /expeditions/<id>.
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
    }
  }

  /** A read, not a write: nothing is recorded while the attempt's run is still settling. */
  async function meterAttempt(s: State, attemptId: string, requestId: string): Promise<Entry[]> {
    if (s.crew.t !== 'ready') throw new Error('attempt metered before the crew exists');
    const nowMs = Date.parse(now());
    const metering = await meterRequest(core, meter, s.crew.buddyId, requestId, nowMs);
    switch (metering.t) {
      case 'settling':
        return [];
      case 'metered':
        return [{ t: 'attempt_metered', at: now(), attemptId, cost: metering.cost }];
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
   * made before a crash, so the replay records that merge instead of merging twice. */
  async function integrate(s: State, integrationId: string): Promise<Entry[]> {
    const integration = integrationOf(s, integrationId);
    const claim = claimAt(s, integration.claimAttemptId).statement.split('\n')[0].slice(0, 200);
    const message = `Integrate ${integration.claimAttemptId} (expedition ${s.id}): ${claim}`;
    const merged = await mergeCandidate(s.integrationTree, integration.sha, message);
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
          ...commandChecks(s.charter).map(
            ({ index }): Entry => ({
              t: 'validation',
              at: now(),
              validationId,
              targetSha,
              checkIndex: index,
              outcome: { t: 'error', message: `no validation worktree: ${made.reason}` },
            })
          ),
        ];
    }
  }

  /**
   * Runs the validation's unrecorded command checks one by one in its tree, appending each result
   * through the expedition's chain. Each check re-reads the ledger: a finished or paused
   * expedition stops here (a resume continues from the first unrecorded check). Only between
   * checks: a check already running is not interrupted by pause or finish; it runs to its end or
   * its timeout (up to charter's timeoutSeconds), its result is recorded, and only then is the
   * tree released (`release_validation` waits for the job).
   */
  async function runChecks(id: string, validationId: string): Promise<void> {
    for (;;) {
      const s = stateOf(id);
      if (s.run.t === 'finished' || s.run.t === 'paused') return;
      const v = validationOf(s, validationId);
      const done = new Set(v.runs.map((r) => r.checkIndex));
      const next = commandChecks(s.charter).find((c) => !done.has(c.index));
      if (!next) return;
      const { tree, targetSha } = startedOf(s, validationId);
      const outcome = await runCommand(next.check, tree.path);
      await serialized(id, () =>
        append(id, [
          { t: 'validation', at: now(), validationId, targetSha, checkIndex: next.index, outcome },
        ])
      );
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

  async function postAttempt(s: State, attemptId: string, body: string): Promise<Entry[]> {
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
        runConfig: configOf(s.charter, attempt.spec),
        broadcast: false,
        key: `exp:${s.id}:attempt:${attemptId}`,
      }
    );
    return [{ t: 'attempt_posted', at: now(), attemptId, requestId: write.post.id }];
  }

  /** Where an attempt's run starts (design.md R9): a worker in its own worktree, a manager in
   * the read-only integration tree (or the repository root before it exists; its brief says
   * read only). */
  function attemptDirectory(s: State, attempt: Attempt, runId: string): TurnDirectory {
    switch (attempt.spec.kind) {
      case 'work':
      case 'check':
        return { t: 'attempt', runId, path: worktreeOf(s, attempt.id).path };
      case 'manager':
        return { t: 'attempt', runId, path: managerDirectory(s) };
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

  /** The live attempt whose request a run answers, matched by its exact brief bytes, which the
   * ledger holds before the post exists (a run can be claimed before `attempt_posted` is
   * appended). Only posting/posted attempts: a boot warm of an old conversation's ended run must
   * not route (and cache) by run id (2026-11-01 review: it leaked a per-run briefing). */
  async function attemptOfRun(s: State, runId: string): Promise<Attempt | undefined> {
    const run = await core.getRun(runId);
    if (run.input.kind !== 'post') return undefined;
    const body = (await core.getPost(OWNER, run.input.postId)).body;
    return s.attempts.find(
      (a) => (a.phase.t === 'posting' || a.phase.t === 'posted') && s.briefs[a.id] === body
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

  /** The expedition a Buddy crews. Reads the `crew_ready` entry, not a fold: this runs on every
   * Buddy turn's warm (2026-11-01 review: folding every ledger per turn). */
  function crewOf(buddyId: string): string | undefined {
    return [...ledgers].find(([, entries]) =>
      entries.some((e) => e.t === 'crew_ready' && e.buddyId === buddyId)
    )?.[0];
  }

  // ---------- Tick ----------

  async function tickOnce(id: string): Promise<void> {
    let wrote = false;
    for (let round = 0; round < ROUNDS_PER_TICK; round += 1) {
      const before = ledgers.get(id)?.length ?? 0;
      await append(id, await observe(stateOf(id)));
      await append(id, decide(stateOf(id), clock()));
      for (const effect of pendingEffects(stateOf(id))) {
        // Each effect reads the state its predecessor left (a brief sees earlier postings).
        await append(id, await run(stateOf(id), effect));
      }
      // A round that wrote nothing is settled (a running check job's effect writes nothing), so
      // the tick neither spins nor emits a change that would wake itself again.
      if ((ledgers.get(id)?.length ?? 0) === before) break;
      wrote = true;
    }
    if (wrote) events.emit({ kind: 'changed' });
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

  /** Serialized per expedition; a failed tick is logged and retried by the next wake. */
  function tick(id: string): Promise<void> {
    return serialized(id, () => tickOnce(id)).catch((error) =>
      console.warn(`[expeditions] tick ${id} failed:`, error)
    );
  }

  // A finished expedition stays active while it owes effects (its last status, worktree removal)
  // or has live attempts: their ends are still observed, and only then are their trees released.
  // A ledger that stops folding is quarantined here, so it never stops the others' ticks.
  const active = () =>
    [...ledgers.keys()].filter((id) => {
      const s = foldOrQuarantine(id);
      return !!s && (s.run.t !== 'finished' || live(s).length > 0 || pendingEffects(s).length > 0);
    });
  const tickAll = () => Promise.all(active().map(tick)).then(() => undefined);

  let debounce: NodeJS.Timeout | null = null;
  const wake = labelled('timer expeditions-wake', () => {
    debounce = null;
    void tickAll();
  });
  // A disabled gate (a copied store, execution-gate.ts) never ticks; launch and steer refuse.
  const enabled = gate.t === 'enabled';
  const unsubscribe = enabled
    ? events.on((event) => {
        if (event.kind !== 'changed' && event.kind !== 'posted') return;
        if (debounce || active().length === 0) return;
        debounce = setTimeout(wake, DEBOUNCE_MS);
        debounce.unref();
      })
    : () => undefined;
  const backstop = enabled
    ? setInterval(
        labelled('timer expeditions-backstop', () => void tickAll()),
        BACKSTOP_MS
      )
    : null;
  backstop?.unref();
  if (enabled) void tickAll();

  /**
   * Every reason a launch of this charter is refused, in one list (draft and launch share it):
   * execution disabled on this host, the R4 preflight, the charter's own refusals and each crew
   * seat against the provider catalog. Reads only.
   */
  async function preflightOf(workspaceId: string, charter: Charter) {
    const issues = [...gateIssues(gate), ...charterIssues(charter), ...seatIssues(charter)];
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
    const prior = [...ledgers.keys()]
      .map(stateOf)
      .find((s) => s.key === input.key && s.run.t !== 'finished');
    if (prior) return { t: 'already_running', state: prior };
    const checked = await preflightOf(input.workspaceId, input.charter);
    if (checked.t === 'refused') throw new LaunchRefused(checked.reasons);
    const id = `${input.charter.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 24)}-${randomUUID().slice(0, 6)}`;
    await fsp.mkdir(path.join(root, id), { recursive: true, mode: 0o700 });
    const repo = { root: checked.root, baseSha: checked.baseSha, branch: `expedition/${id}` };
    // The integration tree is named here, in the launch entry: its create replays from it.
    const integrationTree = {
      name: worktreeName(id, 'integration'),
      path: path.join(root, id, 'integration'),
    };
    // One batch: `launched` and the launch status (the badge in the thread from the first
    // second). The ledger joins the map only once that line is on disk, so every ledger in the
    // map folds and no tick ever meets a half-written launch.
    const first: Entry[] = [
      { t: 'launched', at: now(), id, ...input, repo, integrationTree },
      {
        t: 'status',
        at: now(),
        seq: 0,
        text: launchNews(input.charter),
      },
    ];
    await fsp.appendFile(fileOf(id), line(first), { mode: 0o600 });
    ledgers.set(id, first);
    await tick(id);
    return { t: 'launched', state: stateOf(id) };
  }

  /** What a launch of this charter would refuse, without writing anything (the `draft`). */
  async function issues(workspaceId: string, charter: Charter): Promise<string[]> {
    const checked = await preflightOf(workspaceId, charter);
    return checked.t === 'refused' ? checked.reasons : [];
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
    // Each ledger's first entry is its `launched` (launchOnce writes it in the first batch).
    launches: () =>
      [...ledgers].flatMap(([id, [first]]) =>
        first?.t === 'launched' ? [{ key: first.key, id, at: first.at }] : []
      ),
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
      await tick(id);
      return stateOf(id);
    },
    lookup(id: string): Lookup {
      const reason = quarantined.get(id);
      if (reason) return { t: 'quarantined', reason };
      return ledgers.has(id) ? { t: 'present' } : { t: 'missing' };
    },
    view(id: string): ExpeditionView {
      const s = stateOf(id);
      return expeditionView(s, badge(s, now()), now());
    },
    status(id: string): string {
      const s = stateOf(id);
      return statusText(s, badge(s, now()));
    },
    list(workspaceId: string): { id: string; badge: string }[] {
      return [...ledgers.keys()]
        .map(stateOf)
        .filter((s) => s.workspaceId === workspaceId)
        .map((s) => ({ id: s.id, badge: badge(s, now()) }));
    },
    /** Every foldable expedition, newest launch first (quarantined ledgers are not in `ledgers`). */
    summaries(): ExpeditionSummary[] {
      return [...ledgers.keys()]
        .map(stateOf)
        .sort((a, b) => b.launchedAt.localeCompare(a.launchedAt))
        .map((s) => ({
          id: s.id,
          name: s.charter.name,
          run: s.run,
          workspaceId: s.workspaceId,
          launchedAt: s.launchedAt,
          counts: countsOf(s),
          cost: costTotals(s),
        }));
    },
    /** The expedition a crew Buddy belongs to, so a mentioned crew can answer about itself. */
    ofCrew: crewOf,
    /** Every crew Buddy (the client keeps them off the Buddies roster). */
    crews: (): string[] =>
      [...ledgers.values()].flatMap((entries) =>
        entries.flatMap((e) => (e.t === 'crew_ready' ? [e.buddyId] : []))
      ),
    turnDirectory,
    workspaceOf: (id: string) => stateOf(id).workspaceId,
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
      unsubscribe();
      if (backstop) clearInterval(backstop);
      if (debounce) clearTimeout(debounce);
    },
  };
}
