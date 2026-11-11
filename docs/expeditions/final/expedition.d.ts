/**
 * Expeditions as durable, multi-harness scripts: the script API.
 *
 * One file per expedition: `export default expedition({ ...charter, run })`.
 * The charter is data (checked and shown before launch). `run` is the plan, written as an
 * ordinary async function, Workflow-style. The host runs it server-side, journals every
 * call, and replays the journal after a restart (calls that finished return their recorded
 * result). Limits live inside the primitives, so no script can go around them.
 *
 * Design: ./README.md. Host model: ../../specs/expedition-host.qnt.
 *
 * Rules a script follows (the host enforces the first two):
 * - Deterministic: no Date.now(), Math.random(), fs or network. Use x.now() and calls.
 * - Normal outcomes never throw: every call resolves to a sum type. Switch on `kind`.
 * - Plan changes are data (a Decision), not generated code.
 */
import type { z } from 'zod';

// ───────────────────────────── Seats and pools ─────────────────────────────

/** Same identities as shared/src/provider-catalog.ts. Model and effort pass through verbatim. */
export type Provider = 'claude' | 'codex' | 'opencode' | 'gemini' | 'cursor' | 'muse' | 'pi';

export interface Seat {
  provider: Provider;
  /** Provider-native model id, validated against the provider catalog at launch. */
  model: string;
  /** Provider-native effort value, passed through verbatim (docs/pass-through-pattern.md). */
  effort: string;
}

/** A pool is a capped resource. A call reserves one slot in each pool it names, all or none. */
export type Pool =
  | { kind: 'agent'; seat: Seat; slots: number }
  /** Local commands. `lock` names a machine-wide lock shared with other expeditions. */
  | { kind: 'local'; slots: number; lock: string | null }
  /** Remote GPU through the repo's Modal launcher. Scale-to-zero is the only mode. */
  | { kind: 'modal'; gpu: string; slots: number; usdPerHour: number }
  | { kind: 'ssh'; hosts: string[]; slotsPerHost: number };

export type PoolMap = Record<string, Pool>;
export type AgentPool<P extends PoolMap> = {
  [K in keyof P]: P[K] extends { kind: 'agent' } ? K : never;
}[keyof P] &
  string;
export type RunPool<P extends PoolMap> = {
  [K in keyof P]: P[K] extends { kind: 'agent' } ? never : K;
}[keyof P] &
  string;

// ───────────────────────────── Charter and objective ─────────────────────────────

/**
 * Met means every criterion passes on the same commit (host function `objectiveMet`).
 * A criterion is a judge; it never belongs to the producer's seat.
 */
export type Criterion<P extends PoolMap> =
  | { kind: 'check'; id: string; run: string; pool: RunPool<P> }
  /** A number read from a command's JSON report, compared with a frozen bound. */
  | {
      kind: 'metric';
      id: string;
      run: string;
      pool: RunPool<P>;
      field: string;
      op: '<=' | '>=';
      bound: number;
    }
  /** An LLM judge on a seat whose provider differs from every producer of the judged work. */
  | { kind: 'judged'; id: string; rubric: string; judge: AgentPool<P>; pass: number }
  | { kind: 'owner'; id: string; ask: string };

export interface Objective<P extends PoolMap> {
  criteria: Criterion<P>[];
}

/**
 * How the objective may change. clarify/tighten: the leader may apply it. weaken/redirect:
 * it becomes an owner ask, and is applied only to the exact version the owner saw.
 */
export type ObjectiveRevision<P extends PoolMap> =
  | { kind: 'clarify'; criterionId: string; text: string }
  | { kind: 'tighten'; criterion: Criterion<P> }
  | { kind: 'weaken'; criterionId: string; replacement: Criterion<P>; reason: string }
  | { kind: 'redirect'; objective: Objective<P>; reason: string };

export interface Charter<P extends PoolMap> {
  name: string;
  /** The owner's words, verbatim. Never edited by anyone, including the owner (relaunch). */
  userGoal: string;
  /** Version 0, signed by the owner at launch. */
  objective: Objective<P>;
  /** Target checkout. Work happens in worktrees cut from origin's default branch. */
  repo: { path: string };
  /** Hard limits. The deadline ends new work; judgment and owner answers continue after it. */
  budget: { usd: number; hours: number };
  pools: P;
  /** Owner rules carried verbatim into every brief (spend holds, tolerances, scope pins). */
  rules: string[];
}

// ───────────────────────────── Calls ─────────────────────────────

export type Usage = {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  usd: number;
};

/** Why the host ended a call. `reservation`: it hit its own budget slice. */
export type StopReason = 'reservation' | 'deadline' | 'cancelled' | 'harness-error';

export type AgentResult<T> =
  | { kind: 'ok'; value: T; usage: Usage; sessionId: string }
  /** The schema-forced report tool was not called, or failed validation twice. */
  | { kind: 'malformed'; raw: string; usage: Usage }
  | { kind: 'stopped'; reason: StopReason; usage: Usage };

export type CheckResult =
  | { kind: 'pass'; report: unknown; seconds: number; usd: number }
  | { kind: 'fail'; exitCode: number; tail: string; seconds: number; usd: number }
  | { kind: 'stopped'; reason: StopReason };

export type OwnerAnswer<T> =
  | { kind: 'answered'; value: T }
  /** The owner chose not to answer, or the expedition ended first. Never a silent yes. */
  | { kind: 'unanswered' };

/** A running call. Awaiting it gives its result. The handle is the inner loop's lever. */
export interface Call<R> extends PromiseLike<R> {
  readonly id: string;
  /** Mid-turn steering through the harness (server/src/buddies/harness-steering.ts). */
  steer(message: string): void;
  cancel(reason: string): void;
}

/** What an agent may read and write. Blind work reads only `reads`. */
export type Workspace =
  | { kind: 'worktree'; base: 'origin-default' | { sha: string }; fence: string[] }
  | { kind: 'read-only'; paths: string[] }
  | { kind: 'blind'; reads: string[]; network: false };

export interface AgentSpec<P extends PoolMap, T> {
  /** Stable journal key. Defaults to position in the script, which edits can shift. */
  key: string;
  pool: AgentPool<P>;
  /** Extra non-agent pools held for the whole turn (an agent that runs a GPU loop itself). Absent: none. */
  alsoHolds?: RunPool<P>[];
  prompt: string;
  /** Notebook rows to put in the brief, by query. Charter rules are always included. Absent: none. */
  context?: NotebookQuery[];
  output: z.ZodType<T>;
  workspace: Workspace;
  /** This call's budget slice. The host stops the turn at it (reason `reservation`). */
  usd: number;
  /** Fork a warm session (prefix cache reuse) from an earlier call's sessionId. Absent: cold start. */
  warm?: { from: string };
}

export interface CheckSpec<P extends PoolMap> {
  key: string;
  pool: RunPool<P>;
  run: string;
  /** Commit to check out first. Checks never read a dirty tree. */
  at: { sha: string } | 'origin-default';
  /** Hard wall clock for this check. */
  seconds: number;
}

export interface OwnerAsk<T> {
  key: string;
  question: string;
  answer: z.ZodType<T>;
}

// ───────────────────────────── Notebook (the one shared store) ─────────────────────────────

export type Claim = 'verified' | 'claimed' | 'speculation';

/** Rows are appended, never edited. A later row may supersede an earlier one by id. */
export type NotebookRow =
  | { kind: 'note'; id: string; text: string; claim: Claim; sources: string[] }
  | {
      kind: 'idea';
      id: string;
      family: string;
      hypothesis: string;
      prediction: string;
      by: string;
    }
  | {
      kind: 'result';
      id: string;
      ideaId: string;
      sha: string;
      verdict: 'keep' | 'reject' | 'unjudged';
      evidence: string;
    }
  | { kind: 'source'; id: string; url: string; status: 'fetched' | 'missing' | 'login-blocked' }
  | { kind: 'owner'; id: string; text: string }
  | { kind: 'supersede'; id: string; replaces: string; reason: string };

export type NotebookQuery =
  | { kind: 'all'; rowKind: NotebookRow['kind'] }
  | { kind: 'family'; family: string }
  | { kind: 'latest'; rowKind: NotebookRow['kind']; n: number }
  | { kind: 'ids'; ids: string[] };

export interface Notebook {
  /** Rows are written through the host, so a family is assigned by a judge, not the proposer. */
  add(rows: NotebookRow[]): Promise<void>;
  read(q: NotebookQuery): Promise<NotebookRow[]>;
}

// ───────────────────────────── Width and search ─────────────────────────────

/**
 * How trustworthy the verifier is. The host caps samples of one claim at W[gauge]
 * (16 / 4 / 1) and narrows when measured first-try success is high or verified results per
 * dollar stop improving (research/scaling.md §4 rules 5–7).
 */
export type Gauge = 'machine' | 'review' | 'owner';

export interface SampleSpec<P extends PoolMap, T> {
  key: string;
  family: string;
  gauge: Gauge;
  /** Requested width. The host may grant less; the granted width is in the result. */
  want: number;
  make: (i: number) => Omit<AgentSpec<P, T>, 'key'>;
  verify: (value: T, i: number) => CheckSpec<P> | AgentSpec<P, { pass: boolean; why: string }>;
}

export type SampleResult<T> = {
  granted: number;
  /** Why the host granted less than `want`, if it did. */
  narrowedBy: 'none' | 'gauge-cap' | 'ceiling' | 'no-improvement' | 'pool' | 'budget';
  kept: { value: T; i: number }[];
  rejected: { i: number; why: string }[];
};

// ───────────────────────────── Reflection (the two loops) ─────────────────────────────

/** A prediction the host grades at the next reflection: a criterion or a notebook count. */
export type Prediction =
  | { kind: 'criterion-passes'; criterionId: string }
  | { kind: 'metric-moves'; criterionId: string; to: number }
  | { kind: 'kept-at-least'; family: string; n: number };

/** Outer loop. `Plan` is the script's own plan type: plan changes are data. */
export type Decision<Plan, P extends PoolMap> =
  | { kind: 'continue'; predictions: Prediction[] }
  | { kind: 'modify'; plan: Plan; why: string; predictions: Prediction[] }
  /** Structural change. Required after two reflections whose predictions all missed. */
  | { kind: 'restructure'; plan: Plan; why: string; predictions: Prediction[] }
  | { kind: 'revise-objective'; revision: ObjectiveRevision<P> }
  | { kind: 'finish'; report: string };

/** Inner loop: what a watcher may do to a running round. */
export type InnerDecision<P extends PoolMap> =
  | { kind: 'none' }
  | { kind: 'steer'; callId: string; message: string }
  | { kind: 'cancel'; callId: string; reason: string }
  | { kind: 'add'; spec: AgentSpec<P, unknown> }
  | { kind: 'end-round'; why: string };

export type RoundEvent =
  | { kind: 'settled'; callId: string; outcome: 'ok' | 'malformed' | 'stopped' | 'pass' | 'fail' }
  | { kind: 'owner-message'; text: string }
  | { kind: 'budget'; spentFraction: number }
  | { kind: 'slow'; callId: string; wallMultiple: number };

export interface ReflectSpec<Plan, P extends PoolMap> {
  key: string;
  pool: AgentPool<P>;
  plan: Plan;
  planSchema: z.ZodType<Plan>;
  prompt: string;
  context: NotebookQuery[];
}

export interface WatchSpec<P extends PoolMap> {
  pool: AgentPool<P>;
  prompt: string;
  /** Batch events: wake at most once per this many seconds. */
  batchSeconds: number;
}

// ───────────────────────────── The context object ─────────────────────────────

export type FinishResult =
  | { kind: 'met'; sha: string }
  | { kind: 'not-met'; failing: string[] }
  | { kind: 'owner-declined'; why: string };

export interface X<P extends PoolMap> {
  readonly charter: Charter<P>;
  /** Journaled clock: same value on replay. */
  now(): number;
  log(message: string): void;

  agent<T>(spec: AgentSpec<P, T>): Call<AgentResult<T>>;
  check(spec: CheckSpec<P>): Call<CheckResult>;
  /** Durable owner question. Holds no pool slot and does not stop the deadline. */
  ask<T>(spec: OwnerAsk<T>): Call<OwnerAnswer<T>>;

  /** Barrier; never rejects. */
  parallel<R>(thunks: (() => PromiseLike<R>)[]): Promise<R[]>;
  /** Per-item chains, no barrier between stages. */
  pipeline<I, R>(
    items: I[],
    ...stages: ((prev: any, item: I, i: number) => PromiseLike<any>)[]
  ): Promise<R[]>;
  /** Width-capped, verified sampling of one claim. */
  sample<T>(spec: SampleSpec<P, T>): Promise<SampleResult<T>>;

  /**
   * A round: a unit of work the leader reflects on. Events from calls started inside `body`
   * go to the watcher, whose InnerDecisions the host applies.
   */
  round<R>(name: string, body: () => Promise<R>, watch: WatchSpec<P> | 'no-watcher'): Promise<R>;
  /**
   * Outer loop. The host grades the previous Decision's predictions first. After two
   * reflections whose predictions all missed, it refuses `continue` and `modify` and asks again.
   */
  reflect<Plan>(spec: ReflectSpec<Plan, P>): Promise<Decision<Plan, P>>;

  readonly notebook: Notebook;
  readonly objective: {
    current(): Objective<P> & { version: number };
    /** clarify/tighten apply now; weaken/redirect become an owner ask on this exact version. */
    revise(r: ObjectiveRevision<P>): Promise<'applied' | 'owner-declined' | 'unanswered'>;
  };

  /**
   * Serial integration: merge `sha` onto the expedition branch, re-run `recheck` on the merged
   * commit, fast-forward only if it passes. Survives restart and the deadline.
   */
  integrate(spec: {
    key: string;
    sha: string;
    recheck: CheckSpec<P>[];
  }): Promise<
    | { kind: 'integrated'; sha: string }
    | { kind: 'conflict' }
    | { kind: 'recheck-failed'; failing: string[] }
  >;

  budget: {
    spentUsd(): number;
    remainingUsd(): number;
    /** Verified results per dollar for a family, from recorded usage. */
    verifiedPerUsd(family: string): number;
  };

  /**
   * Propose finishing. The host evaluates every objective criterion on `sha`, then asks the
   * owner if any criterion is an owner criterion. Ends the run on `met` or `owner-declined`.
   */
  finish(spec: { sha: string; report: string }): Promise<FinishResult>;
}

export interface ExpeditionFile<P extends PoolMap> extends Charter<P> {
  run(x: X<P>): Promise<void>;
}

/** Identity at runtime; exists so the charter's pool names type-check the whole script. */
export declare function expedition<const P extends PoolMap>(
  file: ExpeditionFile<P>
): ExpeditionFile<P>;
