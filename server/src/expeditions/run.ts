import path from 'node:path';
import type { BuddiesCore, Run } from '@unleashd/buddies-core';
import { OWNER, buddyActor } from '../buddies/core';
import type { BuddyEvents } from '../buddies/events';
import { CREW_ROLE, briefOf, statusText } from './briefs';
import { killCheck, pidfileOf, runCommand } from './command';
import { placementOf } from './drafts';
import {
  archiveBranch,
  branchHead,
  ensureDetachedTree,
  ensureWorktree,
  expeditionRefs,
  mergeCandidate,
  syncDetachedTree,
} from './git';
import { type MeterPorts, RUN_SCAN_LIMIT, SETTLED, meterRequest } from './meter';
import {
  type ByTree,
  type CheckOutcome,
  type Effect,
  type Entry,
  INTEGRATION_TREE,
  type Lifetime,
  type Place,
  type ReleaseStage,
  type RetireChat,
  type Round,
  type State,
  type TreeId,
  type ValidationReport,
  attemptOf,
  badge,
  byTree,
  claimAt,
  claimOf,
  configOf,
  currentTree,
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
import { errorText, holds } from './observe';
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

// Running effects (plan.ts): one handler per kind, returning the entries its result writes. Every
// crate write is keyed by expedition and attempt/status id (docs/patterns.md#idempotency-keys).

export interface RunPorts {
  core: BuddiesCore;
  events: BuddyEvents;
  root: string;
  meter: MeterPorts;
  now: () => string;
  store: ExpeditionStore;
  onBuddyArchived: (buddyId: string) => void;
  onChannelArchived: (channelId: string) => void;
  /** A check job ended: its expedition ticks again (tick.ts). */
  wake: (id: string) => void;
}

/** A tree's place, named in its `tree_planned` intent so the create replays from it. */
type At = { branch: string; baseSha: string };
const workspace = (root: string, id: string, dir: string, at: At, lifetime: Lifetime): Place => ({
  t: 'workspace',
  name: `exp-${id}-${path.basename(dir)}`,
  path: path.join(root, id, dir),
  ...at,
  lifetime,
});
/** The integration tree holds the expedition branch, made at the launch base. */
export const integrationPlace = (root: string, id: string, repo: State['repo']) =>
  workspace(root, id, 'integration', repo, 'owned');
/** A worker's or a validation's scratch tree, on its own `exp/<id>/<key>` branch. */
const scratchPlace = (root: string, s: State, dir: string, key: string, baseSha: string) =>
  workspace(
    root,
    s.id,
    path.join(dir, key),
    { branch: `exp/${s.id}/${key}`, baseSha },
    'ephemeral'
  );

/** The crew of an expedition past `create_crew` (every effect but that one runs after it). */
function crewOf(s: State, what: string) {
  if (s.crew.t !== 'ready') throw new Error(`${what} before the crew exists`);
  return s.crew;
}

/** A guarded tree's release per stage: running keeps an attempt tree with commits for
 * integration; finish never forces uncommitted work away; retire snapshots it and goes on. */
const STAGES: Record<ReleaseStage, { keepCommits: boolean; policy: ReleasePolicy }> = {
  running: { keepCommits: true, policy: { t: 'finish' } },
  finished: { keepCommits: false, policy: { t: 'finish' } },
  retiring: { keepCommits: false, policy: { t: 'retire' } },
};

export type EffectRunner = ReturnType<typeof createEffectRunner>;

export function createEffectRunner(ports: RunPorts) {
  const { core, events, root, meter, now, store, onBuddyArchived, onChannelArchived, wake } = ports;
  const { append, stateOf, serialized } = store;
  /** Check jobs, outside the tick chain (a check may take hours). In-memory: after a restart the
   * ledger's unrecorded checks are the work, and `run_validation` resumes them. */
  const jobs = new Map<string, Promise<void>>();
  const jobKey = (id: string, validationId: string) => `${id}/${validationId}`;
  /** Jobs this process started: a `running` job not here died with an earlier process. */
  const ranHere = new Set<string>();
  const head = (s: State) => branchHead(s.repo);
  const keepOf = (s: State, tree: TreeId): Keep => ({
    salvageRef: `refs/salvage/expeditions/${s.id}/${treeKey(tree)}`,
    harvestDir: path.join(root, s.id, 'harvest', treeKey(tree)),
  });

  /** Cancels the crew's unsettled runs `keep` selects, as the owner's Stop does (runner.ts). */
  async function cancelRuns(buddyId: string, keep: (r: Run) => boolean): Promise<Run[]> {
    const runs = (await core.listRuns({ kind: 'buddy', buddyId }, RUN_SCAN_LIMIT)).filter(
      (r) => !SETTLED.has(r.status) && keep(r)
    );
    for (const r of runs)
      events.emit({ kind: 'cancelled', run: await core.cancelRun(OWNER, r.id) });
    return runs;
  }

  // Pattern: table-driven (docs/patterns.md#table-driven) — `run` only selects the handler.
  const handlers: {
    [K in Effect['t']]: (s: State, e: Extract<Effect, { t: K }>) => Promise<Entry[]>;
  } = {
    create_crew: async (s) => {
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
      const members = [OWNER, buddyActor(crew.id)];
      const chat = await core.openChannel(OWNER, { kind: 'direct', members });
      return [{ t: 'crew_ready', at: now(), buddyId: crew.id, chatChannelId: chat.id }];
    },

    /** Replay-safe: mergeCandidate recognises its own merge and refuses an unexpected head. */
    integrate: async (s, { integrationId }) => {
      const integration = integrationOf(s, integrationId);
      const claim = claimAt(s, integration.claimAttemptId).statement.split('\n')[0].slice(0, 200);
      const message = `Integrate ${integration.claimAttemptId} (expedition ${s.id}): ${claim}`;
      const tree = workspaceOf(s, INTEGRATION_TREE);
      const merged = await mergeCandidate(tree, integration.sha, message, headOf(s));
      const ids = { at: now(), integrationId, sha: integration.sha };
      return [
        merged.t === 'integrated'
          ? { t: 'integrated', ...ids, mergeSha: merged.mergeSha }
          : { t: 'integration_refused', ...ids, refusal: merged.refusal },
      ];
    },

    /** A manager's claim of unreported commits is checked like any claim (observe.ts holds). */
    adopt_claim: async (s, { attemptId }) => {
      const adoption = s.adoptions[attemptId];
      if (adoption?.t !== 'pending') throw new Error(`no pending claim of ${attemptId}`);
      const held = await holds(s, attemptId, adoption.claim.change);
      return [
        held.t === 'held'
          ? { t: 'claim_adopted', at: now(), attemptId }
          : { t: 'claim_refused', at: now(), attemptId, reason: held.reason },
      ];
    },

    /** Intent first: the place (an attempt's slot and custody) is on disk before anything is made. */
    plan_tree: async (s, { tree }) => {
      const place = await byTree(PLACES, tree, s);
      await append(s.id, [{ t: 'tree_planned', at: now(), tree, place }]);
      return createTree(stateOf(s.id), tree);
    },
    create_tree: (s, { tree }) => createTree(s, tree),

    /** At retirement a tree it could not remove is a refusal: retirement waits for the owner. */
    release_tree: async (s, { tree, stage }) => {
      const released = await byTree(RELEASES, tree, s, stage);
      if (released === 'busy') return [];
      const { release, preserved } = released;
      const entries: Entry[] = [{ t: 'tree_released', at: now(), tree, release, preserved }];
      if (stage === 'retiring' && release.t === 'left') {
        const place = treeOf(s, tree).place;
        const branch = place.t === 'workspace' ? place.branch : `(manager tree ${place.path})`;
        const reason = `tree left: ${release.reason}`;
        entries.push({ t: 'archive_refused', at: now(), branch, reason });
      }
      return entries;
    },

    /** Starts the check job in the background, once. A `running` job this process never started
     * died with an earlier one (audit #10); one that throws is a terminal failure (audit #5). */
    run_validation: async (s, { validationId }) => {
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
          const reason = errorText(error);
          return serialized(id, () =>
            append(id, [{ t: 'validation_failed', at: now(), validationId, reason }])
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
    },

    /** A manager's tree moves to the branch head first: it reads what it is told about (R11). */
    brief_attempt: async (s, { attempt }) => {
      if (attempt.spec.kind === 'manager')
        await syncDetachedTree(managerDirectory(s), await head(s));
      const body = briefOf(s, attempt);
      await append(s.id, [{ t: 'attempt_posting', at: now(), attemptId: attempt.id, body }]);
      return postAttempt(s, attempt.id, body, 'brief');
    },
    post_attempt: (s, e) => postAttempt(s, e.attemptId, e.body, e.round),

    /** A read: nothing is recorded while the attempt's runs are still settling. */
    meter_attempt: async (s, e) => {
      const { buddyId } = crewOf(s, 'attempt metered');
      const [nowMs, endMs] = [Date.parse(now()), Date.parse(e.endedAt)];
      const metering = await meterRequest(core, meter, buddyId, e.requestIds, nowMs, endMs);
      return metering.t === 'metered'
        ? [{ t: 'attempt_metered', at: now(), attemptId: e.attemptId, cost: metering.cost }]
        : [];
    },

    post_status: async (s, { seq, text }) => {
      const crew = crewOf(s, 'status posted');
      // Crew-authored in its own DM with the owner: wakes nobody, reads as the expedition.
      const write = await core.post(
        buddyActor(crew.buddyId),
        { kind: 'id', id: crew.chatChannelId },
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
    },

    /** The badge in the chat the launch came from; the client renders it as a live card. */
    post_badge: async (s) => {
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
    },

    // Audit 2026-11-01 #2: stop and deadline cancelled nothing, so live workers ran on, unbounded.
    cancel_attempt: async (s, { attemptId }) => {
      const posts = new Set(requestsOf(s, attemptId));
      const runs = await cancelRuns(
        crewOf(s, 'attempt cancelled').buddyId,
        (r) => r.input.kind === 'post' && posts.has(r.input.postId)
      );
      return [
        { t: 'attempt_cancel_requested', at: now(), attemptId, runIds: runs.map((r) => r.id) },
      ];
    },

    /** Every expedition ref archived as a tag on origin and only then deleted (git.ts
     * archiveBranch); a ref origin does not confirm is refused and kept. */
    archive_branches: async (s) => {
      const out: Entry[] = [];
      for (const ref of await expeditionRefs(s.repo.root, s.id)) {
        const a = await archiveBranch(s.repo.root, ref, archiveTag(s.id, ref));
        out.push(
          a.t === 'archived'
            ? { t: 'branch_archived', at: now(), branch: ref, sha: a.sha, tag: a.tag }
            : { t: 'archive_refused', at: now(), branch: ref, reason: a.reason }
        );
      }
      return out.some((e) => e.t === 'archive_refused')
        ? out
        : [...out, { t: 'branches_archived', at: now() }];
    },

    /** Before the crew is archived: its own DM is opened as the crew, which must still be active. */
    archive_chats: async (s, { chats }) => {
      const crew = crewOf(s, 'chats archived');
      const out: Entry[] = [];
      for (const chat of chats) {
        const channelId = await CHATS[chat](crew.buddyId, crew.chatChannelId);
        await core.setChannelArchived(OWNER, channelId, true, `exp:${s.id}:retire:chat:${chat}`);
        onChannelArchived(channelId);
        out.push({ t: 'chat_archived', at: now(), chat, channelId });
      }
      return out;
    },

    archive_crew: async (s) => {
      const { buddyId } = crewOf(s, 'crew archived');
      const key = `exp:${s.id}:retire:crew`;
      await core.updateBuddy(OWNER, { buddyId, changes: { status: 'archived' }, key });
      onBuddyArchived(buddyId);
      return [{ t: 'crew_archived', at: now(), buddyId }];
    },

    record_retired: async () => [{ t: 'retired', at: now() }],

    /** The ledger's last line is `retired`: frozen, moved, and from now on served as a snapshot. */
    file_retired: async (s) => {
      await store.file(s.id, snapshotOf(s, statusText(s, badge(s, now()))));
      console.log(`[expeditions] ${s.id} retired`);
      return [];
    },
  };
  const run = <E extends Effect>(s: State, effect: E): Promise<Entry[]> =>
    (handlers[effect.t] as (s: State, e: E) => Promise<Entry[]>)(s, effect);

  /** The crew's own chats, by kind: never a DM it has with another Buddy. */
  const CHATS: Record<RetireChat, (crewId: string, crewChat: string) => Promise<string>> = {
    crew_chat: async (_crewId, crewChat) => crewChat,
    // The note-to-self DM the attempts are posted in (postAttempt); opening it is idempotent.
    attempts: async (crewId) => {
      const crew = buddyActor(crewId);
      return (await core.openChannel(crew, { kind: 'direct', members: [crew] })).id;
    },
  };

  /** Where a tree starts: work at the branch head; a check at its claim's commit (the head for a
   * no-code claim); a validation at its candidate sha or the head as it is now. */
  const PLACES: ByTree<[State], Promise<Place>> = {
    integration: async (_id, s) => integrationPlace(root, s.id, s.repo),
    manager: async (_id, s) => ({ t: 'detached', path: path.join(root, s.id, 'manager') }),
    attempt: async (id, s) => {
      const { spec } = attemptOf(s, id.attemptId);
      if (spec.kind === 'manager') throw new Error(`manager ${id.attemptId} has no attempt tree`);
      const change = spec.kind === 'check' ? claimOf(s, spec).change : { t: 'no_code' as const };
      const base = change.t === 'commit' ? change.sha : await head(s);
      return scratchPlace(root, s, 'worktrees', treeKey(id), base);
    },
    validation: async (id, s) => {
      const target = validationOf(s, id.validationId).target;
      const base = target.t === 'candidate' ? target.sha : await head(s);
      return scratchPlace(root, s, 'validations', treeKey(id), base);
    },
  };

  const RELEASES: ByTree<[State, ReleaseStage], Promise<Released | 'busy'>> = {
    integration: (id, s, stage) =>
      releaseIntegrationTree(s.repo.root, workspaceOf(s, id), keepOf(s, id), STAGES[stage].policy),
    manager: (id, s) => releaseDetachedTree(s.repo.root, treeOf(s, id).place.path, keepOf(s, id)),
    attempt: (id, s, stage) => {
      const { keepCommits, policy } = STAGES[stage];
      const [at, keep] = [workspaceOf(s, id), keepOf(s, id)];
      return releaseWorktree(s.repo.root, at, keepCommits, s.repo.branch, keep, policy);
    },
    // Never pulled from under this host's own running check.
    validation: async (id, s) =>
      jobs.has(jobKey(s.id, id.validationId))
        ? 'busy'
        : discardWorktree(s.repo.root, workspaceOf(s, id), keepOf(s, id)),
  };

  /** Also the replay path (git.ts adopts by name or path); a validation with no tree fails. */
  async function createTree(s: State, tree: TreeId): Promise<Entry[]> {
    const place = treeOf(s, tree).place;
    const made =
      place.t === 'workspace'
        ? await ensureWorktree(s.repo.root, place.name, place, place.lifetime)
        : await ensureDetachedTree(s.repo.root, place.path, await head(s));
    if (made.t === 'ready') return [{ t: 'tree_ready', at: now(), tree }];
    const failed: Entry[] = [{ t: 'tree_failed', at: now(), tree, reason: made.reason }];
    const reason = `no validation worktree: ${made.reason}`;
    if (tree.t === 'validation')
      failed.push({ t: 'validation_failed', at: now(), validationId: tree.validationId, reason });
    return failed;
  }

  /** Restart, not adopt (design.md R11): a pid from another boot cannot be trusted, and checks
   * are re-runnable by contract; a fresh tree keeps the rerun from racing an orphan's outputs. */
  async function interrupted(s: State, validationId: string): Promise<Entry[]> {
    const tree = currentTree(s, validationOf(s, validationId));
    // The orphaned check, while it still runs (its pidfile survives only a crash): killed first.
    const killed = await killCheck(pidfileOf(`${tree.place.path}.scratch`));
    if (killed.t === 'killed')
      console.log(
        `[expeditions] ${s.id}: killed the orphaned check ${killed.pid} of ${validationId}`
      );
    const at = workspaceOf(s, tree.id);
    const released = await discardWorktree(s.repo.root, at, keepOf(s, tree.id));
    return [{ t: 'tree_released', at: now(), tree: tree.id, ...released }];
  }

  /** The validation's unrecorded checks one by one, each result through the chain; a finished or
   * paused expedition stops between checks, never interrupting a running one. */
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
      // Whose validator bytes are trusted (pins.ts): at done the head itself, for a candidate the
      // expedition branch when its question's acceptance was declared.
      const trusted = v.basis.t === 'done' ? targetSha : v.basis.trustedSha;
      const ran = await runPinned(next, tree.path, targetSha, trusted);
      const checkIndex = next.index;
      const entry: Entry = {
        t: 'validation',
        at: now(),
        validationId,
        targetSha,
        checkIndex,
        ...ran,
      };
      await serialized(id, () => append(id, [entry]));
    }
  }

  /** One check, its validator sources pinned (pins.ts): a changed validator never passes. */
  async function runPinned(
    check: { argv: string[]; timeoutSeconds: number },
    treePath: string,
    targetSha: string,
    trusted: string
  ): Promise<{ outcome: CheckOutcome; report: ValidationReport }> {
    const pinned = await pinSources(treePath, targetSha, trusted, check.argv);
    if (pinned.t === 'mismatch')
      return {
        outcome: { t: 'error', message: pinned.reason },
        report: report(targetSha, [], { t: 'unpinned', reason: pinned.reason }),
      };
    const outcome = await runCommand(check, treePath, `${treePath}.scratch`);
    const after = await verifyPins(treePath, pinned.pins);
    return {
      outcome: pinnedOutcome(outcome, after),
      report: report(targetSha, pinned.pins, after),
    };
  }

  /** Posts a recorded request in the crew's note-to-self DM, keyed by attempt and round. */
  async function postAttempt(s: State, attemptId: string, body: string, round: Round) {
    const crew = buddyActor(crewOf(s, 'attempt posted').buddyId);
    const attempt = attemptOf(s, attemptId);
    // A worker runs in its own worktree, a manager in its detached tree (R9, R11).
    const dir =
      attempt.spec.kind === 'manager' ? managerDirectory(s) : worktreeOf(s, attemptId).path;
    const write = await core.post(
      crew,
      { kind: 'direct', members: [crew] },
      {
        kind: 'request',
        body,
        purpose: 'expedition_attempt',
        evidence: [`expedition:${s.id}`],
        mentions: [],
        runConfig: {
          ...seatRunConfig(configOf(s.charter, attempt.spec)),
          cwd: { kind: 'path', path: dir },
        },
        broadcast: false,
        key: `exp:${s.id}:attempt:${attemptId}:${round}`,
      }
    );
    return [{ t: 'attempt_posted', at: now(), attemptId, requestId: write.post.id }] as Entry[];
  }

  return {
    run,
    /** Posts a recorded brief (boot restart posts one a crash left unposted, tick.ts). */
    postAttempt,
    cancelRuns,
    /** Check jobs still running in this process (tests drain them). */
    jobs: (): Promise<void>[] => [...jobs.values()],
  };
}

/** The origin tag an expedition ref is archived at; a ref of no known shape keeps its full name
 * under `other/`, never silently mapped onto another's tag. */
function archiveTag(id: string, ref: string): string {
  const base = `archive/expeditions/${id}`;
  if (ref === `refs/heads/expedition/${id}`) return `${base}/expedition`;
  const prefixes = {
    [`refs/heads/exp/${id}/`]: '',
    [`refs/salvage/expeditions/${id}/`]: 'salvage/',
  };
  for (const [prefix, into] of Object.entries(prefixes))
    if (ref.startsWith(prefix)) return `${base}/${into}${ref.slice(prefix.length)}`;
  return `${base}/other/${ref.replace(/^refs\//, '')}`;
}
