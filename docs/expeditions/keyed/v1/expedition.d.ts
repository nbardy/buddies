/**
 * Expeditions v1: the authoring API (docs/expeditions/keyed/v1/DESIGN.md).
 *
 * Design only: declarations with no implementation, so the example plans typecheck.
 * This is the whole surface. Anything not here is deferred (DESIGN.md §3).
 */
import type { z } from 'zod';

// ---- who ----
export type Who =
  | { readonly t: 'buddy'; readonly id: string }
  | {
      readonly t: 'seat';
      readonly provider: string;
      readonly model: string;
      readonly effort: string;
    };
/** A named Buddy: its role and memory come with it. */
export declare function buddy(id: string): Who;
/** An anonymous worker. Values pass through verbatim to vendor/agent-cli-tool. */
export declare function seat(provider: string, model: string, effort: string): Who;

// ---- judges: declared with the step, before any work runs ----
export type Judge =
  | { readonly t: 'check'; readonly command: string }
  | { readonly t: 'review'; readonly rubric: string; readonly by: Who };
/** The host runs the command on the step's output; exit 0 passes. `{{slots}}` come from the item. */
export declare function check(command: string): Judge;
/** Another seat reviews against `briefs/<rubric>.md`. The dry run refuses the producer's provider. */
export declare function review(rubric: string, by: Who): Judge;

// ---- the cast table ----
export type Item = { readonly id: string };
export type Report = { readonly summary: string; readonly files: readonly Ref[] };
export type Ref = { readonly __ref: true };

/** One row of the cast table. Each refinement returns a new spec. */
export interface Spec<Out> {
  /** The plan reads typed fields of this step's answer. */
  returns<T>(schema: z.ZodType<T>): Spec<T>;
  /** The step answers with a list the plan fans out over. */
  lists<T extends Item>(schema: z.ZodType<T>): Spec<T[]>;
  judged(judge: Judge): Spec<Out>;
  /** Work in a checkout and commit there (default: no tree). Nothing is merged; the owner merges. */
  checkout(): Spec<Out>;
  /** Repo paths the step may read without a checkout. */
  reads(...paths: string[]): Spec<Out>;
  web(): Spec<Out>;
  /** Extra pools each call reserves. An agent call always reserves its provider's pool. */
  needs(...pools: string[]): Spec<Out>;
}
/** An agent step. Its prompt is `briefs/<step name>.md`. */
export declare function role(r: { by: Who; usd: number; minutes: number }): Spec<Report>;
/** A host-run command step. Exit 0 passes; with `.returns(schema)` stdout is parsed as JSON. */
export declare function command(
  cmd: string,
  limits: { minutes: number }
): Spec<{ readonly tail: string }>;

export type StepInput = {
  /** Distinguishes repeated calls of one step. */
  id?: string | number;
  /** Fills `{{slots}}` in the brief or command. */
  item?: object;
  /** Everything the call may read beyond its step's grant. */
  reads?: readonly Readable[];
  /** Continue that call's conversation instead of starting cold. */
  continues?: Held<unknown>;
  /** The commit a checkout or command starts from (default: the launch base). */
  on?: Held<unknown>;
};
export type Step<Out> = (input?: StepInput) => Promise<Result<Out>>;
/** Property names are the step names: written once, as identifiers; the durable names in the log. */
export declare function steps<T extends Record<string, Spec<any>>>(
  table: T
): { [K in keyof T]: T[K] extends Spec<infer Out> ? Step<Out> : never };

// ---- results ----
/** An output that exists. */
export type Held<Out> = { readonly out: Out; readonly ref: Ref };
export type Result<Out> =
  | ({ readonly t: 'passed' } & Held<Out>)
  /** It ran and its judge said no. The output exists. */
  | ({ readonly t: 'failed'; readonly why: string } & Held<Out>)
  /** The turn failed. No output; never judged. */
  | { readonly t: 'errored'; readonly why: string }
  | { readonly t: 'cancelled'; readonly partial: Ref }
  | { readonly t: 'refused'; readonly reason: 'budget' | 'deadline' | 'pool' | 'needs-owner' };
export type Readable = Held<unknown> | Ref | string;

/** The passed result, or end the plan here with a gap: "no result, and this is why". */
export declare function need<Out>(result: Result<Out>, why: string): Held<Out>;
/** The results that passed. The rest stay in the log as counted gaps. */
export declare function passed<Out>(results: readonly Result<Out>[]): Held<Out>[];
/** One call or trial per item, keyed by `item.id`, as wide as the pools allow, in item order. */
export declare function parallel<T extends Item, R>(
  items: readonly T[],
  each: (item: T) => Promise<R>
): Promise<R[]>;

// ---- the plan ----
export interface X {
  /** A named group of calls: a key prefix, and a band in the timeline. */
  phase<T>(name: string, body: () => Promise<T>): Promise<T>;
  /** A reflection point. The leader continues, rewrites the plan (this script is then replaced),
   * or stops the run with a gap. */
  review(question: string): Promise<void>;
  /** An owner check-in. Holds no pool and no budget; answerable after the deadline. */
  ask(question: string): Promise<string>;
  confirm(question: string): Promise<boolean>;
}
export interface Plan {
  readonly __plan: true;
}
/** The plan returns its candidate. The host, never the plan, evaluates the contract's `done`. */
export declare function plan(run: (x: X) => Promise<Held<unknown>>): Plan;
