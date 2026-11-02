import path from 'node:path';
import type { BuddiesCore } from '@unleashd/buddies-core';
import { OWNER, buddyActor } from '../buddies/core';
import type { BuddyEvents } from '../buddies/events';
import { CREW_ROLE, briefOf, statusText } from './briefs';
import { killCheck, pidfileOf, runCommand } from './command';
import { placementOf } from './drafts';
import {
  archiveBranch,
  branchHead,
  claimHeld,
  ensureDetachedTree,
  ensureWorktree,
  expeditionRefs,
  mergeCandidate,
  syncDetachedTree,
} from './git';
import { type MeterPorts, RUN_SCAN_LIMIT, SETTLED, meterRequest } from './meter';
import {
  type Attempt,
  type ByTree,
  type CheckOutcome,
  type ClaimChange,
  type Effect,
  type Entry,
  INTEGRATION_TREE,
  type Place,
  type ReleaseStage,
  type RetireChat,
  type Round,
  type State,
  type TreeId,
  type ValidationBasis,
  type ValidationReport,
  type ValidationTarget,
  attemptOf,
  badge,
  byTree,
  claimAt,
  claimOf,
  configOf,
  currentTree,
  custodyOf,
  goalSummary,
  headOf,
  integrationOf,
  managerDirectory,
  requestsOf,
  seatRunConfig,
  treeKey,
  treeOf,
  validationOf,
  workspaceOf,
  worktreeOf,
} from './model';
import { pinSources, pinnedOutcome, report, verifyPins } from './pins';
import {
  type Keep,
  type ReleasePolicy,
  type Released,
  discardWorktree,
  releaseDetachedTree,
  releaseIntegrationTree,
  releaseWorktree,
} from './release';
import { snapshotOf } from './retired';
import type { ExpeditionStore } from './store';

// Running effects (plan.ts names them): one handler per effect kind, each returning the entries
// its result writes. Validation check jobs run here too, outside the tick chain.
// Pattern: idempotency-keys (docs/patterns.md#idempotency-keys) — every crate write carries a key
// derived from the expedition and attempt/status id, so replaying an effect after a crash is a no-op.

export interface RunPorts {
  core: BuddiesCore;
  events: BuddyEvents;
  root: string;
  meter: MeterPorts;
  now: () => string;
  store: ExpeditionStore;
  /** A retirement archived the crew Buddy / one of the crew's chats (host options). */
  onBuddyArchived: (buddyId: string) => void;
  onChannelArchived: (channelId: string) => void;
  /** A check job ended: its expedition ticks again (tick.ts). */
  wake: (id: string) => void;
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Where a tree is: a workspace under the expedition's folder on its own branch, or the
 * manager's detached tree. Named in its `tree_planned` intent, so the create replays from it. */
const workspace = (
  root: string,
  id: string,
  dir: string,
  key: string,
  at: { branch: string; baseSha: string },
  lifetime: 'ephemeral' | 'owned'
): Place => ({
  t: 'workspace',
  name: `exp-${id}-${key}`,
  path: path.join(root, id, dir),
  ...at,
  lifetime,
});
/** The integration tree holds the expedition branch, made at the launch base. */
export const integrationPlace = (root: string, id: string, repo: State['repo']) =>
  workspace(root, id, 'integration', 'integration', repo, 'owned');
/** A worker's or a validation's scratch tree, on its own `exp/<id>/<key>` branch. */
const scratchPlace = (root: string, s: State, dir: string, key: string, baseSha: string) =>
  workspace(
    root,
    s.id,
    path.join(dir, key),
    key,
    { branch: `exp/${s.id}/${key}`, baseSha },
    'ephemeral'
  );

export type EffectRunner = ReturnType<typeof createEffectRunner>;

export function createEffectRunner(ports: RunPorts) {
  const { core, events, root, meter, now, store, onBuddyArchived, onChannelArchived, wake } = ports;
  const { append, stateOf, serialized } = store;
  /** Validation check jobs running in this process, by `<expedition>/<validation>`. They run
   * outside the tick chain (a check may take hours; a steer must not wait on it) and append each
   * result through the chain. In-memory only: after a restart the ledger's unrecorded checks are
   * the work, and `run_validation` resumes them. */
  const jobs = new Map<string, Promise<void>>();
  const jobKey = (id: string, validationId: string) => `${id}/${validationId}`;
  /** Check jobs this process started (running or since ended): a `running` job not here died
   * with an earlier process (runValidation). */
  const ranHere = new Set<string>();

  // ---------- Effects: one handler per effect kind ----------

  // Pattern: table-driven (docs/patterns.md#table-driven) — `run` only selects the handler.
  // Audit 2026-11-01: `run` was one switch doing every effect's work inline.
  type Handlers = {
    [K in Effect['t']]: (s: State, e: Extract<Effect, { t: K }>) => Promise<Entry[]>;
  };
  const handlers: Handlers = {
    create_crew: (s) => createCrew(s),
    integrate: (s, e) => integrate(s, e.integrationId),
    adopt_claim: (s, e) => adoptClaim(s, e.attemptId),
    plan_tree: (s, e) => planTree(s, e.tree),
    create_tree: (s, e) => createTree(s, e.tree),
    release_tree: (s, e) => releaseTree(s, e.tree, e.stage),
    run_validation: (s, e) => runValidation(s, e.validationId),
    brief_attempt: (s, e) => briefAttempt(s, e.attempt),
    post_attempt: (s, e) => postAttempt(s, e.attemptId, e.body, e.round),
    meter_attempt: (s, e) => meterAttempt(s, e),
    post_status: (s, e) => postStatus(s, e.seq, e.text),
    post_badge: (s) => postBadge(s),
    cancel_attempt: (s, e) => cancelAttempt(s, e.attemptId),
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
    const posts = new Set(requestsOf(s, attemptId));
    const runs = (
      await core.listRuns({ kind: 'buddy', buddyId: s.crew.buddyId }, RUN_SCAN_LIMIT)
    ).filter((r) => r.input.kind === 'post' && posts.has(r.input.postId) && !SETTLED.has(r.status));
    for (const r of runs) {
      const run = await core.cancelRun(OWNER, r.id);
      events.emit({ kind: 'cancelled', run });
    }
    return [{ t: 'attempt_cancel_requested', at: now(), attemptId, runIds: runs.map((r) => r.id) }];
  }

  // ---------- Trees: one model (ledger.ts TreeId), one handler per tree kind ----------

  const PLACES: ByTree<[State], Promise<Place>> = {
    integration: async (_id, s) => integrationPlace(root, s.id, s.repo),
    manager: async (_id, s) => ({ t: 'detached', path: path.join(root, s.id, 'manager') }),
    attempt: async (id, s) =>
      scratchPlace(
        root,
        s,
        'worktrees',
        treeKey(id),
        await treeBase(s, attemptOf(s, id.attemptId))
      ),
    validation: async (id, s) =>
      scratchPlace(
        root,
        s,
        'validations',
        treeKey(id),
        await validationSha(s, validationOf(s, id.validationId).target)
      ),
  };

  /** Intent first: the tree's place (its slot and custody, for an attempt) is on disk before
   * anything is made. */
  async function planTree(s: State, tree: TreeId): Promise<Entry[]> {
    const place = await byTree(PLACES, tree, s);
    await append(s.id, [{ t: 'tree_planned', at: now(), tree, place }]);
    return createTree(stateOf(s.id), tree);
  }

  /** The replay path too: a workspace by the planned name is adopted, a partial add rolled back
   * (git.ts ensureWorktree); the manager's detached tree is adopted by its path. */
  async function createTree(s: State, tree: TreeId): Promise<Entry[]> {
    const made = await make(s, treeOf(s, tree).place);
    switch (made.t) {
      case 'ready':
        return [{ t: 'tree_ready', at: now(), tree }];
      case 'failed':
        return [
          { t: 'tree_failed', at: now(), tree, reason: made.reason },
          ...failedWith(tree, made.reason),
        ];
    }
  }

  async function make(s: State, place: Place) {
    switch (place.t) {
      case 'workspace':
        return ensureWorktree(s.repo.root, place.name, place, place.lifetime);
      case 'detached':
        return ensureDetachedTree(s.repo.root, place.path, await branchHead(s.repo));
    }
  }

  /** A validation with no tree cannot run its checks at all: a terminal `validation_failed`. */
  function failedWith(tree: TreeId, reason: string): Entry[] {
    switch (tree.t) {
      case 'validation':
        return [
          {
            t: 'validation_failed',
            at: now(),
            validationId: tree.validationId,
            reason: `no validation worktree: ${reason}`,
          },
        ];
      case 'integration':
      case 'manager':
      case 'attempt':
        return [];
    }
  }

  /** Where a tree's leftovers go when it is released (release.ts Keep). */
  const keepOf = (s: State, tree: TreeId): Keep => ({
    salvageRef: `refs/salvage/expeditions/${s.id}/${treeKey(tree)}`,
    harvestDir: path.join(root, s.id, 'harvest', treeKey(tree)),
  });

  /** A guarded tree's release per stage: running keeps an attempt tree with commits for
   * integration; finish never forces uncommitted work away; retire snapshots it and goes on. */
  const STAGES: Record<ReleaseStage, { keepCommits: boolean; policy: ReleasePolicy }> = {
    running: { keepCommits: true, policy: { t: 'finish' } },
    finished: { keepCommits: false, policy: { t: 'finish' } },
    retiring: { keepCommits: false, policy: { t: 'retire' } },
  };
  const RELEASES: ByTree<[State, ReleaseStage], Promise<Released | 'busy'>> = {
    integration: (id, s, stage) =>
      releaseIntegrationTree(s.repo.root, workspaceOf(s, id), keepOf(s, id), STAGES[stage].policy),
    manager: (id, s) => releaseDetachedTree(s.repo.root, treeOf(s, id).place.path, keepOf(s, id)),
    attempt: (id, s, stage) =>
      releaseWorktree(
        s.repo.root,
        workspaceOf(s, id),
        STAGES[stage].keepCommits,
        s.repo.branch,
        keepOf(s, id),
        STAGES[stage].policy
      ),
    // Never pulled from under this host's own running check.
    validation: async (id, s) =>
      jobs.has(jobKey(s.id, id.validationId))
        ? 'busy'
        : discardWorktree(s.repo.root, workspaceOf(s, id), keepOf(s, id)),
  };

  /** How a refusal names a tree: its branch, or the manager's path. */
  function treeLabel(place: Place): string {
    switch (place.t) {
      case 'workspace':
        return place.branch;
      case 'detached':
        return `(manager tree ${place.path})`;
    }
  }

  /** At retirement a tree it could not remove is a refusal: retirement waits for the owner. */
  async function releaseTree(s: State, tree: TreeId, stage: ReleaseStage): Promise<Entry[]> {
    const released = await byTree(RELEASES, tree, s, stage);
    if (released === 'busy') return [];
    const { release, preserved } = released;
    const refused =
      stage === 'retiring' && release.t === 'left'
        ? [
            {
              t: 'archive_refused' as const,
              at: now(),
              branch: treeLabel(treeOf(s, tree).place),
              reason: `tree left: ${release.reason}`,
            },
          ]
        : [];
    return [{ t: 'tree_released', at: now(), tree, release, preserved }, ...refused];
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
    await store.file(s.id, snapshotOf(s, statusText(s, badge(s, now()))));
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
      ...seatRunConfig(s.charter.crew.manager),
      key: `exp:${s.id}:crew`,
    });
    // The owner↔crew DM is the expedition's chat (opening it is idempotent).
    const chat = await core.openChannel(OWNER, {
      kind: 'direct',
      members: [OWNER, buddyActor(crew.id)],
    });
    return [{ t: 'crew_ready', at: now(), buddyId: crew.id, chatChannelId: chat.id }];
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
    if (validationOf(s, validationId).job.t === 'running' && !ranHere.has(key))
      return interrupted(s, validationId);
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
        wake(id);
      });
    jobs.set(key, job);
    return [];
  }

  /**
   * Why restart rather than adopt (design.md R11): adopting a check across a restart needs a
   * detached wrapper with pid and exit files that outlives the server, and a pid from another
   * boot cannot be trusted. The candidate sha is immutable and its checks are re-runnable by
   * contract, so a fresh run on the same sha is correct at the price of the time it re-spends; a
   * fresh tree (the next TreeId restart) keeps it from racing an orphan on build outputs, and
   * releasing the old tree pulls the orphan's files away so it fails fast instead of running on
   * unseen.
   */
  async function interrupted(s: State, validationId: string): Promise<Entry[]> {
    const { id: tree, place } = currentTree(s, validationOf(s, validationId));
    // The orphaned check, while it still runs (its pidfile survives only a crash): killed before
    // its tree is pulled, so the replay never races it.
    const killed = await killCheck(pidfileOf(`${place.path}.scratch`));
    if (killed.t === 'killed')
      console.log(
        `[expeditions] ${s.id}: killed the orphaned check ${killed.pid} of ${validationId}`
      );
    const released = await discardWorktree(s.repo.root, workspaceOf(s, tree), keepOf(s, tree));
    return [{ t: 'tree_released', at: now(), tree, ...released }];
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
        await syncDetachedTree(managerDirectory(s), await branchHead(s.repo));
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

  /** The `integration_planned` intent is already on disk; mergeCandidate recognises a merge it
   * made before a crash, so the replay records that merge instead of merging twice, and refuses
   * a branch whose head is not the ledger's (`headOf`). */
  async function integrate(s: State, integrationId: string): Promise<Entry[]> {
    const integration = integrationOf(s, integrationId);
    const claim = claimAt(s, integration.claimAttemptId).statement.split('\n')[0].slice(0, 200);
    const message = `Integrate ${integration.claimAttemptId} (expedition ${s.id}): ${claim}`;
    const merged = await mergeCandidate(
      workspaceOf(s, INTEGRATION_TREE),
      integration.sha,
      message,
      headOf(s)
    );
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
  async function treeBase(s: State, attempt: Attempt): Promise<string> {
    switch (attempt.spec.kind) {
      case 'work':
        return branchHead(s.repo);
      case 'check':
        return changeBase(s, claimOf(s, attempt.spec).change);
      case 'manager':
        throw new Error(`manager ${attempt.id} has no attempt tree`);
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
      const tree = workspaceOf(s, currentTree(s, v).id);
      const targetSha = tree.baseSha;
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

  /** Posts a recorded brief or repair request, keyed by attempt and round (a replay returns the
   * same post). */
  async function postAttempt(
    s: State,
    attemptId: string,
    body: string,
    round: Round
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
        // The run starts in the attempt's own tree (crate RunConfig.cwd, plan B5): the run
        // carries it, so no turn re-derives it from the ledger.
        runConfig: {
          ...seatRunConfig(configOf(s.charter, attempt.spec)),
          cwd: { kind: 'path', path: attemptDirectory(s, attempt) },
        },
        broadcast: false,
        key: requestKey(s.id, attemptId, round),
      }
    );
    return [{ t: 'attempt_posted', at: now(), attemptId, requestId: write.post.id }];
  }

  /** Where an attempt's run starts (design.md R9, R11): a worker in its own worktree, a manager
   * in its own detached tree. An attempt is briefed only once its tree is ready (plan.ts). */
  function attemptDirectory(s: State, attempt: Attempt): string {
    switch (attempt.spec.kind) {
      case 'work':
      case 'check':
        return worktreeOf(s, attempt.id).path;
      case 'manager':
        return managerDirectory(s);
    }
  }

  return {
    run,
    /** Posts a recorded brief (boot restart posts one a crash left unposted, tick.ts). */
    postAttempt,
    /** Check jobs still running in this process (tests drain them). */
    jobs: (): Promise<void>[] => [...jobs.values()],
  };
}

/** An attempt request's key, one per round, so a replay finds the post it already made. */
const requestKey = (id: string, attemptId: string, round: Round): string =>
  `exp:${id}:attempt:${attemptId}:${round}`;

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
