/**
 * The authoring API for an expedition plan (docs/expeditions/keyed/DESIGN.md).
 *
 * Design only: these are declarations with no implementation. They exist so the example plans in
 * ../examples typecheck, and so the surface is exact.
 *
 * This file is the AUTHORING layer. Its option objects have optional fields for ergonomics; the
 * host canonicalises every call into a full `Call` with no optional fields (DESIGN.md §4) before
 * anything is logged or run.
 */
import type { z } from 'zod';

// ---------------------------------------------------------------------------------------------
// Small values
// ---------------------------------------------------------------------------------------------

export type Usd = number & { readonly __usd: true };
export declare function usd(n: number): Usd;

export type Sha = string & { readonly __sha: true };
/** The address of a stored output. Only the host makes one. */
export type Ref = { readonly __ref: true };

/** Who does a call: a named Buddy (its role and memory come with it) or an anonymous seat. */
export type Who =
  | { readonly t: 'buddy'; readonly id: string }
  | {
      readonly t: 'seat';
      readonly provider: string;
      readonly model: string;
      readonly effort: string;
    };
export declare function buddy(id: string): Who;
/** Values pass through verbatim to vendor/agent-cli-tool. */
export declare function seat(provider: string, model: string, effort: string): Who;

// ---------------------------------------------------------------------------------------------
// Judges: declared with the step, before any work runs
// ---------------------------------------------------------------------------------------------

export interface CheckJudge {
  readonly t: 'check';
  readonly command: string;
  readonly protect: readonly string[];
  readonly pools: readonly string[];
  /** Pools the check reserves while it runs (a GPU, a counted evaluation, Modal spend). */
  needs(...pools: string[]): CheckJudge;
}
export type Judge =
  | CheckJudge
  | { readonly t: 'review'; readonly rubric: string; readonly by: Who };
/** A command the host runs on the step's output; exit 0 passes. `{{slots}}` are filled from the
 * call's `item`. `protect` paths are restored from the launch base first, so the work cannot edit
 * its own grader. */
export declare function check(command: string, ...protect: string[]): CheckJudge;
/** A review by another seat against a rubric brief (`briefs/<rubric>.md`). The dry run refuses a
 * reviewer on the producer's provider. */
export declare function review(rubric: string, by: Who): Judge;

// ---------------------------------------------------------------------------------------------
// The cast table: every step that can run, declared once
// ---------------------------------------------------------------------------------------------

export type Judging = 'judged' | 'unjudged';
export type Item = { readonly id: string };

/** The standard output of every agent step. A custom schema is needed only where the plan itself
 * reads a field. */
export type Report = {
  readonly summary: string;
  readonly claims: readonly Claim[];
  readonly files: readonly Ref[];
};
export type Claim = {
  readonly text: string;
  readonly level: 'verified' | 'claimed' | 'speculation';
  readonly refs: readonly Ref[];
};

/** Where a step works. `fence` lists the only paths it may change. */
export type Tree =
  | { readonly t: 'none' }
  | { readonly t: 'checkout'; readonly fence: readonly string[] };
export declare function checkout(...fence: string[]): Tree;

/** One row of the cast table. Each refinement returns a new spec. */
export interface Spec<Out, J extends Judging> {
  /** The plan reads typed fields of this step's answer. */
  returns<T>(schema: z.ZodType<T>): Spec<T, J>;
  /** The step answers with a list the plan fans out over. */
  lists<T extends Item>(schema: z.ZodType<T>): Spec<T[], J>;
  judged(judge: Judge): Spec<Out, 'judged'>;
  /** Work in a checkout of the repo (default: no tree at all). */
  in(tree: Tree): Spec<Out, J>;
  /** Repo paths the step may read without a checkout. */
  reads(...paths: string[]): Spec<Out, J>;
  /** Pools from the contract that every call of this step reserves. */
  needs(...pools: string[]): Spec<Out, J>;
  /** Grant web access. */
  web(): Spec<Out, J>;
  /** Paths restored from the launch base before a command step runs. */
  protect(...paths: string[]): Spec<Out, J>;
}

/** An agent step: who does it and its limits per call. Its brief is `briefs/<step name>.md`. */
export declare function role(r: { by: Who; max: Usd; minutes: number }): Spec<Report, 'unjudged'>;

/** A host-run command step (no agent). Exit 0 passes, so its result is already judged.
 * `{{slots}}` in the command are filled from the call's `item`. With `.returns(schema)`, stdout is
 * parsed as JSON. */
export declare function command(
  cmd: string,
  limits: { minutes: number }
): Spec<CommandReport, 'judged'>;
export type CommandReport = { readonly exit: 0; readonly tail: string };

export type StepInput = {
  /** Distinguishes repeated calls of one step (a round number, a candidate name). */
  id?: string | number;
  /** Fills `{{slots}}` in the brief or command. */
  item?: object;
  /** Everything the call may read beyond its step's grant. Nothing else is shared. */
  reads?: readonly Readable[];
  /** Continue that call's conversation instead of starting cold. */
  continues?: Held<unknown>;
  /** The commit a checkout or command starts from. Default: the expedition's tip, which is the
   * launch base until something lands and the latest landed commit after that. */
  on?: Held<unknown>;
  /** Narrows the step's fence for this call. It can only narrow, never widen. */
  fence?: readonly string[];
  /** The idea this call tests. The dry run refuses an idea whose family is already rejected. When
   * the call is judged, the host writes the learning row itself: passed is `keep`, failed is
   * `reject`. */
  tests?: Idea;
};

export type Step<Out, J extends Judging> = (input?: StepInput) => Promise<Result<Out, J>>;

/** Declare the cast. Property names are the step names: they appear once, as identifiers, and are
 * the durable names in the log. Every agent step needs `briefs/<name>.md` (checked at dry run). */
export declare function steps<T extends Record<string, Spec<any, any>>>(
  table: T
): { [K in keyof T]: T[K] extends Spec<infer Out, infer J> ? Step<Out, J> : never };

// ---------------------------------------------------------------------------------------------
// Results: a sum with no shortcut to the value
// ---------------------------------------------------------------------------------------------

declare const verifiedBrand: unique symbol;
declare const claimedBrand: unique symbol;

export type Code = { readonly t: 'none' } | { readonly t: 'commit'; readonly sha: Sha };

/** An output that exists: its typed answer, its standard report, where it is stored. */
export interface Held<Out> {
  readonly out: Out;
  readonly report: Report;
  readonly ref: Ref;
  readonly code: Code;
}
/** Passed a judge. Only the host makes one. `land` accepts nothing else. */
export interface Verified<Out> extends Held<Out> {
  readonly [verifiedBrand]: true;
}
/** Ran, but nothing independent has confirmed it. */
export interface Claimed<Out> extends Held<Out> {
  readonly [claimedBrand]: true;
}
export type Value<Out, J extends Judging> = J extends 'judged' ? Verified<Out> : Claimed<Out>;

export type Refusal =
  | 'budget'
  | 'deadline'
  | 'pool'
  | 'needs-owner'
  | 'pilot-failed'
  | 'already-rejected';

export type Result<Out, J extends Judging> =
  | { readonly t: 'passed'; readonly value: Value<Out, J> }
  /** It ran and its judge said no. The output still exists, as a claim. */
  | { readonly t: 'failed'; readonly claim: Claimed<Out>; readonly why: string }
  /** The turn failed. No output exists, and nothing was judged. */
  | { readonly t: 'errored'; readonly why: string }
  | { readonly t: 'cancelled'; readonly partial: Ref }
  | { readonly t: 'refused'; readonly reason: Refusal };

/** A plain string is readable too: an owner's answer, a ruling, a note from the plan. */
export type Readable = Held<unknown> | Result<any, any> | Ref | readonly Learning[] | string;

// ---------------------------------------------------------------------------------------------
// Shared learning
// ---------------------------------------------------------------------------------------------

export type Idea = { readonly family: string; readonly idea: string };
/** One row of the learning log. Workers write rows during a call with the `learn` tool. */
export type Learning = Idea & {
  readonly prediction: string;
  readonly measured: string;
  readonly verdict: 'keep' | 'reject' | 'retune';
  readonly evidence: Ref;
  readonly from: string;
};

// ---------------------------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------------------------

/** A goal: the owner's (the root, `x`) or one the leader added under it mid-run. */
export interface Goal {
  /** A named group of calls serving this goal. Prefixes their keys; a band in the timeline. */
  phase<T>(name: string, body: () => Promise<T>): Promise<T>;
  /** An emergent sub-goal under this one. `done` is fixed here, before work on it starts. */
  goal(name: string, g: { why: string; done: readonly Judge[] }): Goal;
  /** The host evaluates this goal's `done` on the work. Passing a sub-goal never ends the run. */
  met<Out>(work: Held<Out>): Promise<Result<Out, 'judged'>>;
}

export type Landed = { readonly sha: Sha };
export type Gap = {
  readonly t: 'gap';
  readonly why: string;
  readonly evidence: readonly Readable[];
};
/** "No result, and here is why" is a valid outcome. */
export declare function gap(why: string, ...evidence: Readable[]): Gap;

/** What the plan hands back. The host, never the plan, evaluates the contract's `done` on it. */
export type Candidate = Held<unknown> | Gap;

export interface X extends Goal {
  /** A reflection point. The host wakes the leader with the phases since the last review. The
   * leader continues, rewrites the plan (this script is then replaced), or stops the run. */
  review(question: string): Promise<void>;
  /** An owner check-in. Holds no pool and no budget; answerable after the deadline. */
  ask(question: string): Promise<string>;
  ask<T>(question: string, answer: z.ZodType<T>): Promise<T>;
  confirm(question: string): Promise<boolean>;
  /** Merge verified code: one at a time per repo, re-checked on the merged commit, fast-forward
   * only. */
  land(name: string, work: Verified<unknown>): Promise<Result<Landed, 'judged'>>;
  /** Settled rows of the learning log, from this run and earlier runs on the same repo. */
  learnings(filter: 'all' | { family: string }): readonly Learning[];
}

export interface Plan {
  readonly __plan: true;
}
export declare function plan(run: (x: X) => Promise<Candidate>): Plan;

// ---------------------------------------------------------------------------------------------
// Library (plain code over the above; not host features)
// ---------------------------------------------------------------------------------------------

/** One trial per item, keyed by `item.id`. `each` is ordinary code: one call or several, with any
 * per-item `on`, `fence`, `tests` or `reads`. ONE item runs first, to the end. If that trial
 * `errored` or was `refused` (a broken brief, a check that cannot run), the rest return
 * `refused: 'pilot-failed'` and nothing more is spent. A pilot its judge said no to is a real
 * answer, not a broken pipeline: the rest still run. Width is capped
 * by the pools the calls need. Results come back paired with their items, in item order. */
export declare function wide<T extends Item, R extends Result<any, any>>(
  items: readonly T[],
  each: (item: T) => Promise<R>
): Promise<Trial<T, R>[]>;
export type Trial<T, R> = { readonly item: T; readonly result: R };

/** The values of the results that passed. The rest stay in the log as counted gaps. */
export declare function passed<Out, J extends Judging>(
  results: readonly Result<Out, J>[]
): Value<Out, J>[];
export declare function passed<T, Out, J extends Judging>(
  trials: readonly Trial<T, Result<Out, J>>[]
): { readonly item: T; readonly value: Value<Out, J> }[];

/** The `n` highest-scoring values. */
export declare function best<V>(values: readonly V[], score: (v: V) => number, n: number): V[];
