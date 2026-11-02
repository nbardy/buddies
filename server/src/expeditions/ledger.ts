import type {
  Acceptance,
  Charter,
  CheckResult,
  Claim,
  CommandCheck,
  Feedback,
  ManagerAction,
  Origin,
  QuestionScope,
  WorkResult,
} from './charter';
import { doneChecks } from './charter';

// Pattern: pure-core (docs/patterns.md#pure-core)
// Pattern: persisted-state-machine (docs/patterns.md#persisted-state-machine)
// An expedition's ONE persisted state is its append-only ledger. `fold` derives everything else;
// decide.ts turns a state into the intent entries to append next; effects.ts names the idempotent
// writes those intents license. The host appends intents BEFORE running effects, so a crash at
// any point resumes from a ledger that explains it (expeditions/design.md).

export type WorkSpec = { kind: 'work'; questionId: string; brief: string; seat: number };
export type CheckSpec = {
  kind: 'check';
  questionId: string;
  claimAttemptId: string;
  goal: boolean;
  /** Checks planned together share a panel; the panel's majority is the verdict. */
  panelId: string;
  seat: number;
};
export type ManagerSpec = { kind: 'manager' };
/** The attempts that run in a worktree of their own (design.md R1): every one but a manager. */
export type WorkerSpec = WorkSpec | CheckSpec;
export type AttemptSpec = ManagerSpec | WorkerSpec;

/** How an attempt ended by itself. `malformed` and `failed` are data, never silently dropped. */
export type EndOutcome =
  | { t: 'manager'; actions: ManagerAction[] }
  | { t: 'work'; result: WorkResult }
  | { t: 'check'; result: CheckResult }
  | { t: 'malformed'; error: string; raw: string }
  | { t: 'failed'; status: 'failed' | 'cancelled' }
  /** The host asked its runs to stop (owner stop, deadline) and they did not end within the grace
   * (host.ts CANCEL_GRACE_MS): the attempt is ended by the host so its tree can be released. */
  | { t: 'abandoned'; reason: string }
  /** The server restarted while it was live (host.ts interruptBootLive): its crew runs `runIds`
   * were cancelled at boot, so a crew turn never resumes on the harness of the backend that
   * started it. Regression: owner 2026-11-03: crews restart on new sessions. Shown to the
   * manager like `failed`; a work or check attempt is replanned once under a new id
   * (`attempt_retry_planned`), a manager is replanned through managerDue. Never budgeted. */
  | { t: 'interrupted'; cause: 'server_restart'; runIds: string[] };

/** An attempt ended by a server restart, alone or under the unreported commits it left. */
export function interruptedEnd(o: Outcome): boolean {
  switch (o.t) {
    case 'interrupted':
      return true;
    case 'unreported_commits':
      return o.ended.t === 'interrupted';
    case 'manager':
    case 'work':
    case 'check':
    case 'malformed':
    case 'failed':
    case 'abandoned':
      return false;
  }
}

/**
 * What an ended attempt produced. `unreported_commits`: a work attempt that ended with anything
 * but a code claim (`ended`: a finding, blocked, malformed, failed, cancelled or abandoned) while
 * its attempt branch holds commits beyond its base (`shas`, oldest first); the manager may claim
 * them (`claim` action, design.md R11). 2026-11-01 incident: w64130b committed its verifier and
 * answered without the json block, and w475a3b committed ACCEPTANCE_ROUTE.md and answered a
 * `finding`; both commits were left on kept branches nothing could integrate.
 */
export type Outcome = EndOutcome | { t: 'unreported_commits'; shas: string[]; ended: EndOutcome };

/** What an outcome claims: a code claim and its candidate commit, a claim about something other
 * than code, or no claim at all (a finding, a check, a failure...). */
export type ClaimState =
  | { t: 'commit'; claim: Claim; sha: string }
  | { t: 'no_code'; claim: Claim }
  | { t: 'none' };

export function claimState(o: Outcome): ClaimState {
  switch (o.t) {
    case 'work':
      return workClaim(o.result);
    case 'manager':
    case 'check':
    case 'malformed':
    case 'failed':
    case 'abandoned':
    case 'interrupted':
    case 'unreported_commits':
      return { t: 'none' };
  }
}

function workClaim(r: WorkResult): ClaimState {
  switch (r.result) {
    case 'claim':
      return r.change.t === 'commit'
        ? { t: 'commit', claim: r, sha: r.change.sha }
        : { t: 'no_code', claim: r };
    case 'finding':
    case 'blocked':
      return { t: 'none' };
  }
}

/** Which request of an attempt is out: its brief, or the one repair request a malformed answer
 * gets (design.md R11: one format repair turn on the same seat before the answer is final). */
export type Round = 'brief' | 'repair';

/**
 * A question's acceptance (charter.ts Acceptance, declared by the manager) as the fold knows it:
 * `rev` counts its declarations (0 when the
 * question was added, +1 per `acceptance_set`), and `trustedSha` is the expedition branch head
 * (headOf) when it was declared. A candidate validation is judged only under the revision it was
 * planned for (a changed acceptance plans a new one), and the validator files its command names
 * are trusted at `trustedSha`: a candidate that changed them is refused (pins.ts).
 */
export interface DeclaredAcceptance {
  rule: Acceptance;
  rev: number;
  trustedSha: string;
}

/** A manager's claim for an attempt's unreported commits, until the host checks the branch. */
export type Adoption =
  | { t: 'pending'; claim: Claim }
  | { t: 'adopted' }
  | { t: 'refused'; reason: string };

/**
 * What an ended attempt cost (design.md R6), read once its Buddy run(s) settled (host meter.ts).
 * `measured`: the provider-counted tokens of every session the attempt's run conversations bound,
 * retries included. No USD: only an estimate could price them, and nothing here is estimated.
 * `unmeasured`: why no count exists (a provider that records none, a run that never executed).
 */
export type AttemptCost =
  | {
      t: 'measured';
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
    }
  | { t: 'unmeasured'; reason: string };

/** Where owner feedback came from: the `expedition` tool's steer, or an owner message in the
 * expedition chat (the owner↔crew DM). A chat message carries its post id and ordered id, so the
 * host records each one once and reads only newer ones (host.ts observeChat). */
export type FeedbackVia = { t: 'tool' } | { t: 'chat'; postId: string; ord: string };

/** The newest owner chat message already recorded as feedback. */
export type ChatCursor = { t: 'start' } | { t: 'after'; ord: string };

/** `setup_failed`: the expedition's integration worktree could not be made (design.md R3).
 * `decisions_spent`: the manager-decision cap (queries.ts managerCap) ran out (design.md R9). */
export type FinishReason =
  | 'done'
  | 'attempts_spent'
  | 'decisions_spent'
  | 'deadline'
  | 'owner_stop'
  | 'setup_failed';

/** The workspace repository, resolved by the launch preflight; `branch` is `expedition/<id>`. */
export interface Repo {
  root: string;
  baseSha: string;
  branch: string;
}

/** Where a branch tree's worktree is (design.md R1): a work attempt's starts at the expedition
 * branch head, a check's at the commit its claim names, the integration tree at the launch base. */
export interface WorktreeAt {
  path: string;
  branch: string;
  baseSha: string;
}

/** How a worktree ended: removed (its branch too when it had no commits), kept for its commits,
 * absent (Cambium has no such workspace and nothing of it is left: never made, or a replayed
 * removal), or left in place because removal was refused (uncommitted changes are never forced
 * away) or a partial create left a branch or directory Cambium could not roll back. */
export type Release =
  | { t: 'removed'; branchDeleted: boolean }
  | { t: 'kept'; commits: number }
  | { t: 'absent' }
  | { t: 'left'; reason: string };

/** `failed`: the tree could not be made (an attempt is dropped, never briefed; the integration
 * or manager tree finishes the expedition `setup_failed`; a validation fails). */
export type TreeStatus =
  | { t: 'creating' }
  | { t: 'ready' }
  | { t: 'failed'; reason: string }
  | Release;

/**
 * Every tree an expedition makes, one model (audit S4): the integration tree its merges land in
 * (design.md R3), the manager's detached read-only tree (R11), a worker attempt's (R1), and one
 * run of a validation (R2). A validation whose check job died with a host process restarts in a
 * NEW tree (`restart` + 1), never the one an orphaned check may still be writing into.
 */
export type TreeId =
  | { t: 'integration' }
  | { t: 'manager' }
  | { t: 'attempt'; attemptId: string }
  | { t: 'validation'; validationId: string; restart: number };

export const INTEGRATION_TREE = { t: 'integration' } as const satisfies TreeId;
export const MANAGER_TREE = { t: 'manager' } as const satisfies TreeId;

/** A tree's key in `State.trees`, its salvage ref and its harvest folder (host.ts keepOf). Ids
 * are `<prefix><hex>`, so no attempt or validation key is `integration` or `manager`. */
export function treeKey(id: TreeId): string {
  switch (id.t) {
    case 'integration':
    case 'manager':
      return id.t;
    case 'attempt':
      return id.attemptId;
    case 'validation':
      return id.restart === 0 ? id.validationId : `${id.validationId}-r${id.restart}`;
  }
}

/** One handler per tree kind; `byTree` only selects it. */
export type ByTree<A extends unknown[], R> = {
  [K in TreeId['t']]: (id: Extract<TreeId, { t: K }>, ...args: A) => R;
};
export const byTree = <A extends unknown[], R>(table: ByTree<A, R>, id: TreeId, ...args: A): R =>
  (table[id.t] as (id: TreeId, ...args: A) => R)(id, ...args);

/** `ephemeral`: a worker's or a validation's scratch tree, disposable by cleanup tools. `owned`:
 * the expedition's integration tree, which holds its branch checked out for the whole run. */
export type Lifetime = 'ephemeral' | 'owned';

/** Where a tree is, recorded before it is made (the create replays from it): a Cambium workspace
 * on its own branch, or the manager's plain detached worktree (no branch: it never commits). */
export type Place =
  | ({ t: 'workspace'; name: string; lifetime: Lifetime } & WorktreeAt)
  | { t: 'detached'; path: string };

export interface Tree {
  id: TreeId;
  place: Place;
  status: TreeStatus;
  /** What its releases kept (release.ts): salvage refs, harvested output. */
  preserved: Preserved[];
}

/** A branch tree (every tree but the manager's) as one flat record with its status. */
export type Workspace = Extract<Place, { t: 'workspace' }> & {
  status: TreeStatus;
  preserved: Preserved[];
};

// ---------- Validations (design.md R2) ----------

/** What a validation runs the charter's command checks against: a claim's immutable candidate
 * commit, or the expedition branch head when the manager asks done (resolved by the host). */
export type ValidationTarget =
  | { t: 'candidate'; claimAttemptId: string; sha: string }
  | { t: 'head' };

/** A repository file a check's argv named, hashed at the candidate commit (pins.ts). */
export interface SourcePin {
  path: string;
  sha256: string;
}

/** The pinned files re-read after the run: unchanged, changed by the run (the outcome is then an
 * error), or never pinned (no tree, or the tree did not match the commit). */
export type PinCheck =
  | { t: 'held' }
  | { t: 'changed'; paths: string[] }
  | { t: 'unpinned'; reason: string };

/** The typed record of one host-run check (ported from oompa's `oompa.task-validation/v1`). */
export interface ValidationReport {
  t: 'expedition.validation/v1';
  targetSha: string;
  pins: SourcePin[];
  pinCheck: PinCheck;
}

/** What a tree's release kept before removing it (release.ts): commits pinned at a salvage ref,
 * ignored run output copied into the expedition's folder. */
export type Preserved =
  | { t: 'salvaged'; ref: string; sha: string }
  | { t: 'harvested'; dir: string; files: number; bytes: number };

/** One command check's result. The output tail is bounded (command.ts TAIL_CHARS). */
export type CheckOutcome =
  | { t: 'passed' }
  | { t: 'failed'; exitCode: number; tail: string }
  | { t: 'timed_out'; tail: string }
  | { t: 'error'; message: string };

export interface CheckRun {
  /** The check's `index` in its validation's `checks`. */
  checkIndex: number;
  outcome: CheckOutcome;
  report: ValidationReport;
}

/** One host-run command a validation runs, frozen when it is planned (R11): the question's
 * `command` acceptance for a candidate (index 0), the charter's command checks for the head
 * (their index in `charter.done.checks`). */
export interface ValidationCheck {
  index: number;
  argv: string[];
  timeoutSeconds: number;
}

/** What a validation answers for (derived when it is planned): the charter's done checks at the
 * head, or one revision of a question's acceptance for a candidate (design.md R11). */
export type ValidationBasis =
  | { t: 'done' }
  | { t: 'acceptance'; questionId: string; rev: number; trustedSha: string };

export interface Validation {
  id: string;
  target: ValidationTarget;
  basis: ValidationBasis;
  checks: ValidationCheck[];
  /** Its trees' keys, oldest first: the last is the one its checks run in. */
  trees: string[];
  /** `running`: a host process started its check job in its current tree (`validation_running`).
   * A process that finds `running` without having started the job itself knows the job died with
   * an earlier process (audit 2026-11-01 #10). */
  job: { t: 'idle' } | { t: 'running' };
  runs: CheckRun[];
  /** `failed`: the host could not run its checks at all (a terminal `validation_failed`). */
  failure: { t: 'none' } | { t: 'failed'; reason: string };
}

// ---------- Integration (design.md R3) ----------

/** Why a candidate was not merged; every refusal names its phase. `merge`: git reported
 * conflicts in `paths` (the merge was aborted); `git`: git refused for another reason (aborted
 * too); `tree`: the integration worktree was not clean on its branch, so nothing was attempted. */
export type IntegrationRefusal =
  | { phase: 'merge'; paths: string[] }
  | { phase: 'git'; reason: string }
  | { phase: 'tree'; reason: string };

export type IntegrationStatus =
  | { t: 'pending' }
  | { t: 'integrated'; mergeSha: string }
  | { t: 'refused'; refusal: IntegrationRefusal };

/** One candidate commit to merge into the expedition branch, in the order the manager asked. */
export interface Integration {
  id: string;
  claimAttemptId: string;
  sha: string;
  status: IntegrationStatus;
}

// ---------- Retirement ----------

/**
 * Where an expedition is in its retirement (plan A6): `active` until the owner asks; `retiring`
 * while its trees, refs, chats and crew are put away (`refused` names each step the host would
 * not take, cleared by the owner's next request); `retired` once it is frozen as a snapshot
 * (retired.ts), never folded again.
 */
export type Retirement =
  | { t: 'active' }
  | { t: 'retiring'; at: string; by: string; refused: { branch: string; reason: string }[] }
  | { t: 'retired'; at: string };

/** The chats a retirement archives: the owner↔crew chat and the crew's note-to-self DM, which
 * holds the attempt requests. Never a DM the crew has with another Buddy. */
export type RetireChat = 'crew_chat' | 'attempts';

/** What a retirement has put away so far (each step recorded once, in order). */
export interface Archive {
  /** Each ref archived as a tag on origin, then deleted locally. */
  tags: { branch: string; sha: string; tag: string }[];
  /** `archived`: every expedition ref was archived (git.ts expeditionRefs listed none left). */
  branches: { t: 'pending' } | { t: 'archived' };
  chats: RetireChat[];
  crew: { t: 'active' } | { t: 'archived' };
}

// ---------- Ledger ----------

export type Entry =
  | {
      t: 'launched';
      at: string;
      id: string;
      /** Idempotency: one launch per (conversation, name); a retried tool call returns it. */
      key: string;
      charter: Charter;
      origin: Origin;
      launcherId: string;
      workspaceId: string;
      repo: Repo;
    }
  /** Host intent, before the tree is made: a crash leaves a name and path the replay adopts. The
   * integration tree's is written with `launched`, in the launch batch. */
  | { t: 'tree_planned'; at: string; tree: TreeId; place: Place }
  | { t: 'tree_ready'; at: string; tree: TreeId }
  /** It could not be made (git.ts rolled back what it could). */
  | { t: 'tree_failed'; at: string; tree: TreeId; reason: string }
  /** Removed, kept or left (release.ts), with what the release preserved first. The integration
   * tree's branch always stays (it is what the owner merges). */
  | { t: 'tree_released'; at: string; tree: TreeId; release: Release; preserved: Preserved[] }
  /** Decide's intent, before the merge: integrate this claim's validated commit. */
  | {
      t: 'integration_planned';
      at: string;
      integrationId: string;
      claimAttemptId: string;
      sha: string;
    }
  | { t: 'integrated'; at: string; integrationId: string; sha: string; mergeSha: string }
  | {
      t: 'integration_refused';
      at: string;
      integrationId: string;
      sha: string;
      refusal: IntegrationRefusal;
    }
  /** Decide's intent: validate a target (a claim's commit as soon as it ends; the head at done). */
  | {
      t: 'validation_planned';
      at: string;
      validationId: string;
      target: ValidationTarget;
      checks: ValidationCheck[];
    }
  /** The host could not run the checks at all (the job threw): terminal, never re-run (audit #5:
   * a rejected job was re-run on every tick, a hot loop). */
  | { t: 'validation_failed'; at: string; validationId: string; reason: string }
  /** One command check ran (host only; never an agent's report). */
  | {
      t: 'validation';
      at: string;
      validationId: string;
      targetSha: string;
      checkIndex: number;
      outcome: CheckOutcome;
      report: ValidationReport;
    }
  /** Intent, before the host starts the check job in this process (audit #10). A job that died
   * with an earlier process has its tree released; the unrecorded checks run again in a fresh
   * tree at the same immutable sha. */
  | { t: 'validation_running'; at: string; validationId: string }
  /** The host asked an attempt's live runs to stop (owner stop or deadline, audit #2). */
  | { t: 'attempt_cancel_requested'; at: string; attemptId: string; runIds: string[] }
  /** A manager's done awaiting the head validation (written with its `validation_planned`). */
  | { t: 'done_requested'; at: string; validationId: string; summary: string }
  /** The head validation (or the goal panel) did not hold: the manager is shown why. */
  | { t: 'done_refused'; at: string; reason: string }
  /** The crew Buddy and the owner↔crew DM: the expedition's chat, where every update lands. */
  | { t: 'crew_ready'; at: string; buddyId: string; chatChannelId: string }
  /** The one clickable badge post in the chat the launch came from. */
  | { t: 'badge_posted'; at: string; postId: string }
  /** A manager's reflection (its `note` action), kept for the page and the chat. */
  | { t: 'reflection'; at: string; text: string }
  | { t: 'attempt_planned'; at: string; attemptId: string; spec: AttemptSpec }
  /** Decide's replan of a worker attempt a server restart interrupted: the same spec under a new
   * attempt id, planned once per interrupted attempt (`retries`). */
  | {
      t: 'attempt_retry_planned';
      at: string;
      attemptId: string;
      retryOf: string;
      spec: WorkSpec | CheckSpec;
    }
  /** The exact brief, written before the request post so a replay sends identical bytes. */
  | { t: 'attempt_posting'; at: string; attemptId: string; body: string }
  | { t: 'attempt_posted'; at: string; attemptId: string; requestId: string }
  /** The one repair request a malformed answer gets (R11), recorded before it is posted. */
  | { t: 'attempt_repair_posting'; at: string; attemptId: string; error: string; body: string }
  /** A manager's claim of an attempt's unreported commits, before the host checks the branch. */
  | { t: 'claim_planned'; at: string; attemptId: string; claim: Claim }
  /** The branch holds the claimed commit inside custody: the attempt's outcome is now the claim. */
  | { t: 'claim_adopted'; at: string; attemptId: string }
  | { t: 'claim_refused'; at: string; attemptId: string; reason: string }
  /** Ticks kept failing (audit #1): recorded once per backoff step, with the last reason. */
  | { t: 'tick_failed'; at: string; failures: number; reason: string }
  | { t: 'attempt_ended'; at: string; attemptId: string; outcome: Outcome }
  /** Its settled run's measured cost, or why there is none (never an estimate). */
  | { t: 'attempt_metered'; at: string; attemptId: string; cost: AttemptCost }
  | {
      t: 'question_added';
      at: string;
      questionId: string;
      title: string;
      detail: string;
      scope: QuestionScope;
      /** File custody: normalized repo-relative prefixes (charter.ts CustodyPath). */
      paths: string[];
      /** Question ids whose verified close this question's work waits for (design.md R5). */
      after: string[];
      acceptance: Acceptance;
    }
  | { t: 'acceptance_set'; at: string; questionId: string; acceptance: Acceptance }
  | {
      t: 'question_closed';
      at: string;
      questionId: string;
      status: 'verified' | 'dead';
      why: string;
    }
  | { t: 'manager_applied'; at: string; attemptId: string }
  | { t: 'rejected'; at: string; action: ManagerAction; reason: string }
  | { t: 'feedback'; at: string; from: string; via: FeedbackVia; feedback: Feedback }
  | { t: 'needs_owner'; at: string; question: string }
  | { t: 'status'; at: string; seq: number; text: string }
  | { t: 'status_posted'; at: string; seq: number; postId: string }
  | { t: 'finished'; at: string; reason: FinishReason; summary: string }
  /** The owner asked to retire it (plan A6). `stop`: the owner's stop was recorded with it (the
   * expedition was still open), so owner_stop finishes it before anything is put away. A second
   * request while retiring clears the refusals, so the steps run again (retire is idempotent). */
  | { t: 'retire_requested'; at: string; by: string; stop: boolean }
  /** `branch` (a full ref name) is archived at `tag` on origin, and deleted locally. */
  | { t: 'branch_archived'; at: string; branch: string; sha: string; tag: string }
  /** A step retire would not take: a ref origin does not hold, or a tree it could not remove
   * (`branch` names its branch). Retirement waits here until the owner asks again. */
  | { t: 'archive_refused'; at: string; branch: string; reason: string }
  /** No expedition ref is left in the owner's repository but as a tag on origin. */
  | { t: 'branches_archived'; at: string }
  | { t: 'chat_archived'; at: string; chat: RetireChat; channelId: string }
  | { t: 'crew_archived'; at: string; buddyId: string }
  /** The last ledger line: the expedition is frozen (retired.ts) and its folder moved away. */
  | { t: 'retired'; at: string };

// ---------- Derived state ----------

export type AttemptPhase =
  | { t: 'planned' }
  /** A worker attempt whose tree intent is recorded: it holds a slot and its custody. */
  | { t: 'admitted' }
  /** Never started: its tree could not be made (`tree_failed`). */
  | { t: 'dropped'; reason: string }
  | { t: 'posting'; body: string; round: Round }
  | { t: 'posted'; requestId: string; round: Round }
  | { t: 'ended'; requestId: string; outcome: Outcome; endedAt: string };

export interface Attempt<S extends AttemptSpec = AttemptSpec> {
  id: string;
  spec: S;
  phase: AttemptPhase;
  /** When it was planned: managers and workers are listed together in this order. */
  plannedAt: string;
}

export interface Question {
  id: string;
  title: string;
  detail: string;
  scope: QuestionScope;
  paths: string[];
  /** Dependencies: work on this question is admitted only once each is closed verified. */
  after: string[];
  acceptance: DeclaredAcceptance;
  status: 'open' | 'verified' | 'dead';
}

export type Run =
  | { t: 'running' }
  | { t: 'paused' }
  | { t: 'waiting_owner'; question: string }
  // `at`: when it finished. The page shows how long it took (not time left), and it stops the
  // badge's clock: a finished expedition read "finished · 10m" two minutes after it ended (live
  // e2e 2026-11-01) and kept growing for as long as it was listed.
  | { t: 'finished'; at: string; reason: FinishReason; summary: string };

/** A chat status post: written to the ledger first, then posted. */
export interface Status {
  seq: number;
  text: string;
  post: { t: 'pending' } | { t: 'posted'; postId: string };
}

export interface State {
  id: string;
  /** The launch idempotency key (see the `launched` entry). */
  key: string;
  charter: Charter;
  origin: Origin;
  launcherId: string;
  workspaceId: string;
  repo: Repo;
  /** Every tree the host planned, by treeKey (the integration tree's from launch). */
  trees: Record<string, Tree>;
  /** Candidate merges into `repo.branch`, in plan order (run one at a time). */
  integrations: Integration[];
  /** Host-run command-check validations, in plan order (run one at a time). */
  validations: Validation[];
  /** A manager's done waits on its head validation; `finished` or `done_refused` settles it. */
  doneRequest: { t: 'none' } | { t: 'validating'; validationId: string; summary: string };
  launchedAt: string;
  crew: { t: 'pending' } | { t: 'ready'; buddyId: string; chatChannelId: string };
  badgePost: { t: 'pending' } | { t: 'posted'; postId: string };
  reflections: { at: string; text: string }[];
  /** Each attempt's exact instructions, by attempt id (absent until briefed). */
  briefs: Record<string, string>;
  /** Each repaired attempt's repair request body, by attempt id (R11). */
  repairs: Record<string, string>;
  /** Every request id an attempt posted (its brief, then a repair), by attempt id: metering
   * counts them all. */
  requests: Record<string, string[]>;
  /** Manager claims of unreported commits, by attempt id (R11). */
  adoptions: Record<string, Adoption>;
  /** Hours the owner added to the deadline (`extend` feedback). */
  extendedHours: number;
  /** The last recorded run of failed ticks (audit #1), for the page and status. */
  tickFailure: { t: 'none' } | { t: 'failing'; at: string; failures: number; reason: string };
  /** Each ended attempt's cost, by attempt id (absent until its run settled and was metered). */
  costs: Record<string, AttemptCost>;
  /** Live attempts the host asked to stop, by attempt id, with when (audit #2). */
  cancels: Record<string, { at: string; runIds: string[] }>;
  /** Notable entries since the last chat status post. */
  news: Entry[];
  /** Manager decisions, in plan order. */
  managers: Attempt<ManagerSpec>[];
  /** Work and check attempts, in plan order. */
  workers: Attempt<WorkerSpec>[];
  questions: Question[];
  lessons: string[];
  chatCursor: ChatCursor;
  /** Ledger entries a manager has not yet been shown (results, feedback, rejections). */
  unseen: Entry[];
  /** What each manager attempt is shown: the unseen entries at the moment it was planned. */
  shown: Record<string, Entry[]>;
  run: Run;
  statuses: Status[];
  /** Manager attempts whose actions were applied (`manager_applied` entries). */
  appliedManagers: Set<string>;
  /** Each interrupted worker attempt's replan, by the interrupted attempt's id. */
  retries: Record<string, string>;
  retirement: Retirement;
  archive: Archive;
  /** Entries applied since launch. `apply` is the only writer of a State, so this stamps every
   * change: queries.ts `derive` caches its views per revision (the state mutates in place). */
  revision: number;
}

/** The charter's command checks as a head validation runs them (their charter index). */
export const doneValidationChecks = (c: Charter): ValidationCheck[] =>
  commandChecks(c).map(({ index, check }) => ({
    index,
    argv: check.argv,
    timeoutSeconds: check.timeoutSeconds,
  }));

export function fold(entries: readonly Entry[]): State {
  const [first, ...rest] = entries;
  if (!first || first.t !== 'launched') throw new Error('ledger must start with launched');
  const state: State = {
    id: first.id,
    key: first.key,
    charter: first.charter,
    origin: first.origin,
    launcherId: first.launcherId,
    workspaceId: first.workspaceId,
    repo: first.repo,
    trees: {},
    integrations: [],
    validations: [],
    doneRequest: { t: 'none' },
    launchedAt: first.at,
    crew: { t: 'pending' },
    badgePost: { t: 'pending' },
    reflections: [],
    briefs: {},
    repairs: {},
    requests: {},
    adoptions: {},
    extendedHours: 0,
    tickFailure: { t: 'none' },
    costs: {},
    cancels: {},
    news: [],
    managers: [],
    workers: [],
    questions: [],
    lessons: [],
    chatCursor: { t: 'start' },
    unseen: [],
    shown: {},
    run: { t: 'running' },
    statuses: [],
    appliedManagers: new Set(),
    retries: {},
    retirement: { t: 'active' },
    archive: { tags: [], branches: { t: 'pending' }, chats: [], crew: { t: 'active' } },
    revision: 0,
  };
  for (const entry of rest) apply(state, entry);
  return state;
}

// Pattern: table-driven (docs/patterns.md#table-driven) — one exhaustive handler per entry kind.
const NEWS: ReadonlySet<Entry['t']> = new Set([
  'attempt_planned',
  'attempt_retry_planned',
  'attempt_posted',
  'attempt_ended',
  'question_added',
  'question_closed',
  'rejected',
  'reflection',
  'feedback',
  'needs_owner',
  'validation',
  'done_requested',
  'done_refused',
  'integrated',
  'integration_refused',
  'validation_failed',
  'claim_adopted',
  'claim_refused',
  'tick_failed',
  'finished',
] satisfies Entry['t'][]);

/** Folds one entry into the state (decide applies its own intents as it writes them). */
export function apply(s: State, e: Entry): void {
  s.revision += 1;
  if (NEWS.has(e.t)) s.news.push(e);
  switch (e.t) {
    case 'launched':
      throw new Error('launched may only open a ledger');
    case 'tree_planned': {
      const key = treeKey(e.tree);
      if (key in s.trees) throw new Error(`tree ${key} planned twice`);
      s.trees[key] = { id: e.tree, place: e.place, status: { t: 'creating' }, preserved: [] };
      byTree(PLANNED, e.tree, s, key);
      return;
    }
    case 'tree_ready':
      treeOf(s, e.tree).status = { t: 'ready' };
      return;
    case 'tree_failed':
      treeOf(s, e.tree).status = { t: 'failed', reason: e.reason };
      byTree(FAILED, e.tree, s, e);
      return;
    case 'tree_released': {
      const tree = treeOf(s, e.tree);
      tree.status = e.release;
      tree.preserved.push(...e.preserved);
      return;
    }
    case 'integration_planned':
      s.integrations.push({
        id: e.integrationId,
        claimAttemptId: e.claimAttemptId,
        sha: e.sha,
        status: { t: 'pending' },
      });
      return;
    case 'integrated':
      integrationOf(s, e.integrationId).status = { t: 'integrated', mergeSha: e.mergeSha };
      s.unseen.push(e);
      return;
    case 'integration_refused':
      integrationOf(s, e.integrationId).status = { t: 'refused', refusal: e.refusal };
      s.unseen.push(e);
      return;
    case 'validation_planned':
      s.validations.push({
        id: e.validationId,
        target: e.target,
        basis: basisOf(s, e.target),
        checks: e.checks,
        trees: [],
        job: { t: 'idle' },
        runs: [],
        failure: { t: 'none' },
      });
      return;
    case 'validation_failed': {
      const v = validationOf(s, e.validationId);
      v.failure = { t: 'failed', reason: e.reason };
      if (reportsToManager(v.target)) s.unseen.push(e);
      return;
    }
    case 'validation': {
      const v = validationOf(s, e.validationId);
      v.runs.push({ checkIndex: e.checkIndex, outcome: e.outcome, report: e.report });
      // A finished candidate validation is shown to the next manager (it may integrate or retry);
      // a head validation is reported through the done it decides (`finished` / `done_refused`).
      if (validationComplete(v) && reportsToManager(v.target)) s.unseen.push(e);
      return;
    }
    case 'validation_running':
      currentTree(s, validationOf(s, e.validationId));
      validationOf(s, e.validationId).job = { t: 'running' };
      return;
    case 'attempt_cancel_requested':
      s.cancels[e.attemptId] = { at: e.at, runIds: e.runIds };
      return;
    case 'done_requested':
      s.doneRequest = { t: 'validating', validationId: e.validationId, summary: e.summary };
      return;
    case 'done_refused':
      s.doneRequest = { t: 'none' };
      s.unseen.push(e);
      return;
    case 'crew_ready':
      s.crew = { t: 'ready', buddyId: e.buddyId, chatChannelId: e.chatChannelId };
      return;
    case 'badge_posted':
      s.badgePost = { t: 'posted', postId: e.postId };
      return;
    case 'reflection':
      s.reflections.push({ at: e.at, text: e.text });
      return;
    case 'attempt_planned':
      planAttempt(s, e.attemptId, e.spec, e.at);
      return;
    case 'attempt_retry_planned':
      if (attemptOf(s, e.retryOf).phase.t !== 'ended' || e.retryOf in s.retries)
        throw new Error(`attempt ${e.retryOf} retried unended or twice`);
      s.workers.push({ id: e.attemptId, spec: e.spec, phase: { t: 'planned' }, plannedAt: e.at });
      s.retries[e.retryOf] = e.attemptId;
      return;
    case 'attempt_posting':
      attemptOf(s, e.attemptId).phase = { t: 'posting', body: e.body, round: 'brief' };
      s.briefs[e.attemptId] = e.body;
      return;
    case 'attempt_repair_posting': {
      const attempt = attemptOf(s, e.attemptId);
      if (attempt.phase.t !== 'posted' || attempt.phase.round !== 'brief')
        throw new Error(`attempt ${e.attemptId} repaired outside its brief round`);
      attempt.phase = { t: 'posting', body: e.body, round: 'repair' };
      s.repairs[e.attemptId] = e.body;
      return;
    }
    case 'attempt_posted': {
      const attempt = attemptOf(s, e.attemptId);
      if (attempt.phase.t !== 'posting') throw new Error(`attempt ${e.attemptId} posted unbriefed`);
      attempt.phase = { t: 'posted', requestId: e.requestId, round: attempt.phase.round };
      s.requests[e.attemptId] = [...(s.requests[e.attemptId] ?? []), e.requestId];
      return;
    }
    case 'attempt_ended': {
      const attempt = attemptOf(s, e.attemptId);
      if (attempt.phase.t !== 'posted') throw new Error(`attempt ${e.attemptId} ended unposted`);
      attempt.phase = {
        t: 'ended',
        requestId: attempt.phase.requestId,
        outcome: e.outcome,
        endedAt: e.at,
      };
      if (shownOnEnd(attempt.spec, e.outcome)) s.unseen.push(e);
      return;
    }
    case 'claim_planned':
      s.adoptions[e.attemptId] = { t: 'pending', claim: e.claim };
      return;
    case 'claim_adopted': {
      const adoption = s.adoptions[e.attemptId];
      const attempt = attemptOf(s, e.attemptId);
      if (adoption?.t !== 'pending' || attempt.phase.t !== 'ended')
        throw new Error(`claim of ${e.attemptId} adopted unplanned`);
      attempt.phase = { ...attempt.phase, outcome: { t: 'work', result: adoption.claim } };
      s.adoptions[e.attemptId] = { t: 'adopted' };
      s.unseen.push(e);
      return;
    }
    case 'claim_refused':
      s.adoptions[e.attemptId] = { t: 'refused', reason: e.reason };
      s.unseen.push(e);
      return;
    case 'tick_failed':
      s.tickFailure = { t: 'failing', at: e.at, failures: e.failures, reason: e.reason };
      return;
    case 'attempt_metered':
      s.costs[e.attemptId] = e.cost;
      return;
    case 'manager_applied':
      s.appliedManagers.add(e.attemptId);
      return;
    case 'question_added':
      s.questions.push({
        id: e.questionId,
        title: e.title,
        detail: e.detail,
        scope: e.scope,
        paths: e.paths,
        after: e.after,
        acceptance: { rule: e.acceptance, rev: 0, trustedSha: headOf(s) },
        status: 'open',
      });
      // Shown to the next manager: the host assigns question ids, so a turn that only decomposes
      // must be followed by one that can start work on them (never idle, decide.ts).
      s.unseen.push(e);
      return;
    case 'acceptance_set': {
      const question = questionOf(s, e.questionId);
      question.acceptance = {
        rule: e.acceptance,
        rev: question.acceptance.rev + 1,
        trustedSha: headOf(s),
      };
      // Shown to the next manager like question_added: a turn that only fixes an acceptance must
      // be followed by one that acts on it. 2026-11-01 review: a set_acceptance-only decision
      // left nothing unseen, so the run looked quiescent and asked the owner again (the L3 loop).
      s.unseen.push(e);
      return;
    }
    case 'question_closed':
      questionOf(s, e.questionId).status = e.status;
      return;
    case 'rejected':
      s.unseen.push(e);
      return;
    case 'feedback':
      s.chatCursor = cursorAfter(s.chatCursor, e.via);
      applyFeedback(s, e);
      return;
    case 'needs_owner':
      s.run = { t: 'waiting_owner', question: e.question };
      return;
    case 'status':
      s.statuses.push({ seq: e.seq, text: e.text, post: { t: 'pending' } });
      s.news = [];
      return;
    case 'status_posted': {
      const status = s.statuses.find((x) => x.seq === e.seq);
      if (!status) throw new Error(`status ${e.seq} posted before it was written`);
      status.post = { t: 'posted', postId: e.postId };
      return;
    }
    case 'finished':
      s.run = { t: 'finished', at: e.at, reason: e.reason, summary: e.summary };
      s.doneRequest = { t: 'none' };
      return;
    case 'retire_requested':
      if (s.retirement.t === 'retired') throw new Error('retire requested of a retired expedition');
      s.retirement = { t: 'retiring', at: e.at, by: e.by, refused: [] };
      return;
    case 'branch_archived':
      retiringOf(s);
      s.archive.tags.push({ branch: e.branch, sha: e.sha, tag: e.tag });
      return;
    case 'archive_refused':
      retiringOf(s).refused.push({ branch: e.branch, reason: e.reason });
      return;
    case 'branches_archived':
      retiringOf(s);
      s.archive.branches = { t: 'archived' };
      return;
    case 'chat_archived':
      retiringOf(s);
      s.archive.chats.push(e.chat);
      return;
    case 'crew_archived':
      retiringOf(s);
      s.archive.crew = { t: 'archived' };
      return;
    case 'retired':
      retiringOf(s);
      s.retirement = { t: 'retired', at: e.at };
      return;
  }
  // A stored line is parsed unchecked (store.ts), so an entry of no known kind ends up here: a
  // ledger written by an older format (the per-kind tree entries before B5) must not fold with its
  // lines silently skipped, which left no integration tree and failed every tick. It is a corrupt
  // ledger: boot quarantines it, the file stays for the owner.
  const unknown: never = e;
  throw new Error(`unknown ledger entry ${(unknown as { t: string }).t}`);
}

/** A manager is shown what was unseen when it was planned (its brief is built after this). */
function planAttempt(s: State, attemptId: string, spec: AttemptSpec, at: string): void {
  switch (spec.kind) {
    case 'manager':
      s.managers.push({ id: attemptId, spec, phase: { t: 'planned' }, plannedAt: at });
      s.shown[attemptId] = s.unseen;
      s.unseen = [];
      return;
    case 'work':
    case 'check':
      s.workers.push({ id: attemptId, spec, phase: { t: 'planned' }, plannedAt: at });
      return;
  }
}

/** A worker's end is shown to the next manager. A manager's actions are applied, not shown
 * back; its malformed, failed or interrupted end is, so the next manager turn retries instead of
 * the expedition going quiet. */
const MANAGER_END_SHOWN: ReadonlySet<Outcome['t']> = new Set([
  'malformed',
  'failed',
  'interrupted',
]);
function shownOnEnd(spec: AttemptSpec, outcome: Outcome): boolean {
  switch (spec.kind) {
    case 'manager':
      return MANAGER_END_SHOWN.has(outcome.t);
    case 'work':
    case 'check':
      return true;
  }
}

/** What planning a tree does to its owner: an attempt is admitted (it holds a slot and its
 * custody from now on); a validation runs its checks in it, with no job started there yet. */
const PLANNED: ByTree<[State, string], void> = {
  integration: () => undefined,
  manager: () => undefined,
  attempt: ({ attemptId }, s) => {
    attemptOf(s, attemptId).phase = { t: 'admitted' };
  },
  validation: ({ validationId }, s, key) => {
    const v = validationOf(s, validationId);
    v.trees.push(key);
    v.job = { t: 'idle' };
  },
};

/** What a tree that could not be made does to its owner. An attempt is dropped and shown to the
 * next manager (which may plan the work again). The integration or manager tree finishes the
 * expedition (decide.ts setupOf); a validation's failure is recorded with it (`validation_failed`). */
const FAILED: ByTree<[State, Extract<Entry, { t: 'tree_failed' }>], void> = {
  integration: () => undefined,
  manager: () => undefined,
  attempt: ({ attemptId }, s, e) => {
    attemptOf(s, attemptId).phase = { t: 'dropped', reason: e.reason };
    s.unseen.push(e);
  },
  validation: () => undefined,
};

/** A retirement step recorded outside `retiring` is a corrupt ledger. */
function retiringOf(s: State): Extract<Retirement, { t: 'retiring' }> {
  if (s.retirement.t !== 'retiring') throw new Error(`retirement step while ${s.retirement.t}`);
  return s.retirement;
}

function cursorAfter(cursor: ChatCursor, via: FeedbackVia): ChatCursor {
  switch (via.t) {
    case 'tool':
      return cursor;
    case 'chat':
      return { t: 'after', ord: via.ord };
  }
}

/** A candidate validation answers for its claim's question's acceptance as it stands now. */
function basisOf(s: State, target: ValidationTarget): ValidationBasis {
  switch (target.t) {
    case 'head':
      return { t: 'done' };
    case 'candidate': {
      const claim = workOf(s, target.claimAttemptId);
      const { rev, trustedSha } = questionOf(s, claim.spec.questionId).acceptance;
      return { t: 'acceptance', questionId: claim.spec.questionId, rev, trustedSha };
    }
  }
}

function reportsToManager(target: ValidationTarget): boolean {
  switch (target.t) {
    case 'candidate':
      return true;
    case 'head':
      return false;
  }
}

/** The charter's command checks with their indexes (none for owner judgment). */
export function commandChecks(c: Charter): { index: number; check: CommandCheck }[] {
  return doneChecks(c.done).flatMap((check, index) =>
    check.kind === 'command' ? [{ index, check }] : []
  );
}
/** The charter's judged done items (the goal panel verifies them). */
export function judgedChecks(c: Charter): string[] {
  return doneChecks(c.done).flatMap((check) => (check.kind === 'judged' ? [check.text] : []));
}

/** Every check has a recorded outcome (a failed tree records `error` for each), or the host
 * recorded that it could not run them at all. */
export const validationComplete = (v: Validation) =>
  v.failure.t === 'failed' || v.runs.length >= v.checks.length;
export const validationPassed = (v: Validation) =>
  validationComplete(v) && v.failure.t === 'none' && v.runs.every((r) => r.outcome.t === 'passed');

function applyFeedback(s: State, e: Extract<Entry, { t: 'feedback' }>): void {
  if (s.run.t === 'finished') return;
  switch (e.feedback.t) {
    case 'lesson':
      s.lessons.push(e.feedback.text);
      s.unseen.push(e);
      if (s.run.t === 'waiting_owner') s.run = { t: 'running' };
      return;
    case 'note':
      s.unseen.push(e);
      if (s.run.t === 'waiting_owner') s.run = { t: 'running' };
      return;
    case 'pause':
      s.run = { t: 'paused' };
      return;
    case 'resume':
      // Shown to the next manager, so a resume re-plans (R11, 2026-11-01 incident): without it a
      // resume from "needs you" left nothing unseen, decide found nothing to act on, and the run
      // asked the owner again at once.
      s.unseen.push(e);
      s.run = { t: 'running' };
      return;
    case 'extend':
      s.extendedHours += e.feedback.hours;
      s.unseen.push(e);
      return;
    case 'stop':
      // `finished` is appended by decide, so the stop is recorded with its reason.
      s.unseen.push(e);
      return;
  }
}

export const byId = <T extends { id: string }>(rows: T[], id: string) =>
  rows.find((r) => r.id === id);

/** Every attempt, managers and workers together, in plan order. */
export const allAttempts = (s: State): Attempt[] =>
  [...s.managers, ...s.workers].sort((a, b) => a.plannedAt.localeCompare(b.plannedAt));

/** An attempt the ledger names; a missing one is a corrupt ledger, never a skipped entry. */
export function attemptOf(s: State, id: string): Attempt {
  const attempt = byId<Attempt>(s.workers, id) ?? byId<Attempt>(s.managers, id);
  if (!attempt) throw new Error(`unknown attempt ${id}`);
  return attempt;
}

/** The work attempts (claims are made only by work). */
export const worksOf = (s: State): Attempt<WorkSpec>[] =>
  s.workers.filter((a): a is Attempt<WorkSpec> => a.spec.kind === 'work');
/** A work attempt the ledger names as one (a claim's author); anything else is corrupt. */
export function workOf(s: State, id: string): Attempt<WorkSpec> {
  const attempt = byId(worksOf(s), id);
  if (!attempt) throw new Error(`${id} is not a work attempt`);
  return attempt;
}
/** A tree the ledger planned; a missing one is a corrupt ledger. */
export function treeOf(s: State, id: TreeId): Tree {
  const tree = s.trees[treeKey(id)];
  if (!tree) throw new Error(`no tree ${treeKey(id)}`);
  return tree;
}
/** A planned branch tree, flat (every tree but the manager's is one). */
export function workspaceOf(s: State, id: TreeId): Workspace {
  const { place, status, preserved } = treeOf(s, id);
  if (place.t !== 'workspace') throw new Error(`tree ${treeKey(id)} is ${place.t}`);
  return { ...place, status, preserved };
}
/** The commit a validation runs on, once its first tree is planned (its base). */
export type TargetSha = { t: 'unresolved' } | { t: 'at'; sha: string };
export function targetShaOf(s: State, v: Validation): TargetSha {
  const key = v.trees.at(-1);
  return key === undefined
    ? { t: 'unresolved' }
    : { t: 'at', sha: workspaceOf(s, s.trees[key].id).baseSha };
}
export const worktreeOf = (s: State, attemptId: string): Workspace =>
  workspaceOf(s, { t: 'attempt', attemptId });
/** The tree a validation's checks run in: its newest. */
export function currentTree(s: State, v: Validation): Tree {
  const key = v.trees.at(-1);
  if (key === undefined) throw new Error(`validation ${v.id} has no tree`);
  return s.trees[key];
}
export function validationOf(s: State, id: string): Validation {
  const validation = byId(s.validations, id);
  if (!validation) throw new Error(`unknown validation ${id}`);
  return validation;
}
export function integrationOf(s: State, id: string): Integration {
  const integration = byId(s.integrations, id);
  if (!integration) throw new Error(`unknown integration ${id}`);
  return integration;
}

/** The expedition branch head as the ledger knows it: the newest merge the host made, else the
 * launch base. (The branch is written only by the host's integration worktree.) */
export const headOf = (s: State): string =>
  s.integrations.flatMap((i) => (i.status.t === 'integrated' ? [i.status.mergeSha] : [])).at(-1) ??
  s.repo.baseSha;

export function questionOf(s: State, id: string): Question {
  const question = byId(s.questions, id);
  if (!question) throw new Error(`unknown question ${id}`);
  return question;
}
