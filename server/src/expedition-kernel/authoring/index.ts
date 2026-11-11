import type { keyed } from '@unleashd/shared';
import { z } from 'zod';
import { zodToJsonSchema as zodToJsonSchemaTyped } from 'zod-to-json-schema';
import type { ContractInput } from '../contract';

export type { ContractInput } from '../contract';

import type { Authored, CastRow } from '../protocol';
import { declareCast, openSession, phases, session } from './session';

// zod-to-json-schema's signature makes tsc 5.9 instantiate zod's whole type graph for a generic
// schema: typechecking this one file ran out of a 4 GB heap after 42 s (2026-11-10), which crashed
// `pnpm typecheck` for the whole server. The trigger was zod's declarations loaded twice (node10
// resolution read both its .d.cts and .d.ts); TS 7's bundler resolution loads one copy and the typed
// call is cheap again, but with two copies forced back TS 7 still blows up (10.5M instantiations,
// 1.36 GB). The conversion is a runtime walk, so it stays called through an untyped signature.
// Guard: server/test/expedition-kernel-typecheck.test.ts.
const zodToJsonSchema = zodToJsonSchemaTyped as unknown as (schema: unknown) => unknown;

// Expeditions v1: the authoring library, and the authoring API itself: the typecheck gate checks
// plans against this file (gates.ts), and docs/expeditions/keyed/v1/expedition.d.ts only re-exports
// it. A plan imports it as `expedition`; it runs inside the plan's child process (runner.ts) and
// turns every step, ask and review into a message to the host.

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
export const buddy = (id: string): Extract<Who, { t: 'buddy' }> =>
  Object.freeze({ t: 'buddy', id });
/** An anonymous worker. Values pass through verbatim to vendor/agent-cli-tool. */
export const seat = (
  provider: string,
  model: string,
  effort: string
): Extract<Who, { t: 'seat' }> => Object.freeze({ t: 'seat', provider, model, effort });

// ---- judges ----
export type Text<I> = string | ((item: I) => string);
export type Judge<I = never> =
  | { readonly t: 'check'; readonly command: Text<I> }
  | { readonly t: 'review'; readonly rubric: string; readonly by: Who };
/** The host runs the rendered command on the output; exit 0 passes. */
export const check = <I = never>(command: Text<I>): Judge<I> =>
  Object.freeze({ t: 'check', command });
/** Another provider reviews against the inline rubric. */
export const review = (rubric: string, by: Who): Extract<Judge, { t: 'review' }> =>
  Object.freeze({ t: 'review', rubric, by });

// ---- refs ----
export type Ref = { readonly __ref: true };
/** The plan's handle on a stored output: opaque to plan code, a `RefId` on the wire. */
class PlanRef implements Ref {
  readonly __ref = true as const;
  readonly #id: keyed.RefId;
  constructor(id: keyed.RefId) {
    this.#id = id;
    Object.freeze(this);
  }
  get id(): keyed.RefId {
    return this.#id;
  }
}
function refId(ref: Ref): keyed.RefId {
  if (!(ref instanceof PlanRef))
    throw new TypeError('Not a Ref from this plan: refs come only from step results.');
  return ref.id;
}

// ---- results ----
export type Item = { readonly id: string };
export type Report = { readonly summary: string; readonly files: readonly string[] };
/** An output that exists. */
export type Held<Out> = { readonly out: Out; readonly ref: Ref };
export type Result<Out> =
  | ({ readonly t: 'passed' } & Held<Out>)
  | ({ readonly t: 'failed'; readonly why: string } & Held<Out>)
  | { readonly t: 'errored'; readonly why: string }
  | { readonly t: 'cancelled'; readonly partial: Ref }
  | { readonly t: 'refused'; readonly reason: 'budget' | 'deadline' | 'pool' | 'needs-owner' };
export type Readable = Held<unknown> | Ref | string;

/** What a step answers: the JSON Schema the host asks for, and the Zod schema its `out` must pass
 * before plan code sees it. */
class Answer<Out> {
  constructor(
    readonly jsonSchema: unknown,
    readonly schema: z.ZodType<Out, z.ZodTypeDef, unknown>
  ) {}
  static of<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>): Answer<T> {
    return new Answer(zodToJsonSchema(schema), schema);
  }
}

/** Files are validated paths relative to the call's own directory, not stored-output refs.
 * Run 3 returned greeting.mjs: wrapping it as PlanRef invented a ref that never existed. */
const REPORT: Answer<Report> = Answer.of(
  z.object({ summary: z.string(), files: z.array(z.string().min(1)) }).strict()
);
/** A command's default answer: stdout is not read as JSON (`output: null` on the wire). */
const TAIL: Answer<{ readonly tail: string }> = new Answer(
  null,
  z.object({ tail: z.string() }).strict()
);

/** Outcome → Result, with `out` checked against the step's schema. An answer that does not parse is
 * `errored`: plan code never sees an unvalidated value, and never a ZodError. */
function resultOf<Out>(answer: Answer<Out>, key: keyed.Key, outcome: keyed.Outcome): Result<Out> {
  switch (outcome.t) {
    case 'passed':
      return heldOf(answer, key, outcome.out, outcome.ref, (held) => ({ t: 'passed', ...held }));
    case 'failed':
      return heldOf(answer, key, outcome.out, outcome.ref, (held) => ({
        t: 'failed',
        why: outcome.why,
        ...held,
      }));
    case 'errored':
      return { t: 'errored', why: outcome.why };
    case 'cancelled':
      return { t: 'cancelled', partial: new PlanRef(outcome.partial) };
    case 'refused':
      return { t: 'refused', reason: outcome.reason };
  }
}
function heldOf<Out>(
  answer: Answer<Out>,
  key: keyed.Key,
  out: unknown,
  ref: keyed.RefId,
  wrap: (held: Held<Out>) => Result<Out>
): Result<Out> {
  const parsed = answer.schema.safeParse(out);
  if (!parsed.success)
    return {
      t: 'errored',
      why: `The answer of ${key} does not match its schema: ${parsed.error.message}`,
    };
  return wrap({ out: parsed.data, ref: new PlanRef(ref) });
}

// ---- the cast table ----
/** One row of the cast table. Each refinement returns a new spec. */
export interface Spec<Out, I = never> {
  readonly __types?: { out: Out; item: I };
  brief(text: string): Spec<Out>;
  brief<T extends object>(text: (item: T) => string): Spec<Out, T>;
  returns<T>(schema: z.ZodType<T>): Spec<T, I>;
  lists<T extends Item>(schema: z.ZodType<T>): Spec<T[], I>;
  judged(judge: Judge<I>): Spec<Out, I>;
  checkout(): Spec<Out, I>;
  reads(...paths: string[]): Spec<Out, I>;
  web(): Spec<Out, I>;
  needs(...pools: string[]): Spec<Out, I>;
}

export type StepInput = {
  id?: string | number;
  item?: object;
  reads?: readonly Readable[];
  continues?: Held<unknown>;
  on?: Held<unknown>;
};

/** A spec the library made (`role` or `command`): it knows how to author its call. */
abstract class StepSpec<Out, I = never> implements Spec<Out, I> {
  declare readonly __types?: { out: Out; item: I };
  abstract brief(text: string): Spec<Out>;
  abstract brief<T extends object>(text: (item: T) => string): Spec<Out, T>;
  abstract readonly answer: Answer<Out>;
  abstract author(step: string, key: keyed.Key, input: StepInput): Authored;
  /** Its row of the cast table: what every call of the step will be. */
  abstract castRow(step: string): CastRow;
  abstract returns<T>(schema: z.ZodType<T>): Spec<T, I>;
  abstract judged(judge: Judge<I>): Spec<Out, I>;
  abstract checkout(): Spec<Out, I>;
  abstract reads(...paths: string[]): Spec<Out, I>;
  abstract web(): Spec<Out, I>;
  abstract needs(...pools: string[]): Spec<Out, I>;
  lists<T extends Item>(schema: z.ZodType<T>): Spec<T[], I> {
    return this.returns(z.array(schema));
  }
}

type AgentFields<Out, I> = {
  readonly brief?: Text<I>;
  readonly by: Who;
  readonly max: { readonly usd: number; readonly minutes: number };
  readonly answer: Answer<Out>;
  readonly judge: Judge<I> | { readonly t: 'none' };
  readonly tree: 'none' | 'checkout';
  readonly grantReads: readonly string[];
  readonly web: boolean;
  readonly needs: readonly string[];
};

class AgentSpec<Out, I = never> extends StepSpec<Out, I> {
  readonly answer: Answer<Out>;
  constructor(private readonly f: AgentFields<Out, I>) {
    super();
    this.answer = f.answer;
    Object.freeze(this);
  }
  private with<O>(change: Partial<AgentFields<O, I>> & { answer: Answer<O> }): AgentSpec<O, I> {
    return new AgentSpec<O, I>({ ...this.f, ...change });
  }
  brief(text: string): Spec<Out>;
  brief<T extends object>(text: (item: T) => string): Spec<Out, T>;
  brief<T extends object>(text: string | ((item: T) => string)): Spec<Out, T> {
    return new AgentSpec<Out, T>({ ...this.f, brief: text, judge: this.f.judge as Judge<T> });
  }
  returns<T>(schema: z.ZodType<T>): Spec<T, I> {
    return this.with({ answer: Answer.of(schema) });
  }
  judged(judge: Judge<I>): Spec<Out, I> {
    return this.with({ answer: this.answer, judge });
  }
  checkout(): Spec<Out, I> {
    return this.with({ answer: this.answer, tree: 'checkout' });
  }
  reads(...paths: string[]): Spec<Out, I> {
    return this.with({ answer: this.answer, grantReads: [...this.f.grantReads, ...paths] });
  }
  web(): Spec<Out, I> {
    return this.with({ answer: this.answer, web: true });
  }
  needs(...pools: string[]): Spec<Out, I> {
    return this.with({ answer: this.answer, needs: [...this.f.needs, ...pools] });
  }
  castRow(step: string): CastRow {
    return {
      t: 'agent',
      step,
      by: this.f.by,
      tree: this.f.tree,
      grant: { reads: [...this.f.grantReads], web: this.f.web },
      judge: castJudge(this.f.judge),
      hasBrief: this.f.brief !== undefined,
      needs: [...this.f.needs],
    };
  }
  author(step: string, key: keyed.Key, input: StepInput): Authored {
    return {
      t: 'agent',
      key,
      step,
      brief:
        this.f.brief === undefined
          ? session().fail(`Agent step ${step} has no .brief(...).`)
          : render(this.f.brief, input),
      by: this.f.by,
      inputs: (input.reads ?? []).map(inputOf),
      output: this.answer.jsonSchema,
      tree: this.f.tree,
      base: baseOf(input),
      grant: { reads: [...this.f.grantReads], web: this.f.web },
      context: input.continues ? { t: 'continue', of: refId(input.continues.ref) } : { t: 'cold' },
      needs: [...this.f.needs],
      max: { usd: this.f.max.usd, minutes: this.f.max.minutes },
      judge: renderedJudge(this.f.judge, input),
    };
  }
}

type CommandFields<Out, I> = {
  readonly command: Text<I>;
  readonly minutes: number;
  readonly answer: Answer<Out>;
  readonly needs: readonly string[];
};

/** A host-run command. The wire has no judge, tree, grant or context for a command, so those
 * refinements are authoring errors here rather than settings the host would silently drop. */
class CommandSpec<Out, I = never> extends StepSpec<Out, I> {
  readonly answer: Answer<Out>;
  constructor(private readonly f: CommandFields<Out, I>) {
    super();
    this.answer = f.answer;
    Object.freeze(this);
  }
  brief(text: string): Spec<Out>;
  brief<T extends object>(text: (item: T) => string): Spec<Out, T>;
  brief(): never {
    return unsupported('brief()');
  }
  returns<T>(schema: z.ZodType<T>): Spec<T, I> {
    return new CommandSpec<T, I>({ ...this.f, answer: Answer.of(schema) });
  }
  needs(...pools: string[]): Spec<Out, I> {
    return new CommandSpec<Out, I>({ ...this.f, needs: [...this.f.needs, ...pools] });
  }
  judged(): Spec<Out, I> {
    return unsupported('judged()');
  }
  checkout(): Spec<Out, I> {
    return unsupported('checkout()');
  }
  reads(): Spec<Out, I> {
    return unsupported('reads()');
  }
  web(): Spec<Out, I> {
    return unsupported('web()');
  }
  castRow(step: string): CastRow {
    return { t: 'command', step };
  }
  author(step: string, key: keyed.Key, input: StepInput): Authored {
    if (input.reads || input.continues)
      throw new TypeError(
        `Command step ${step} takes no \`reads\` or \`continues\`: a command reads only its checkout.`
      );
    return {
      t: 'command',
      key,
      step,
      command: render(this.f.command, input),
      on: baseOf(input),
      output: this.answer.jsonSchema,
      needs: [...this.f.needs],
      maxMinutes: this.f.minutes,
    };
  }
}
function unsupported(refinement: string): never {
  throw new TypeError(
    `A command step does not take ${refinement}: its exit code is its judge, and it runs on its own checkout.`
  );
}

/** An agent step; each named step supplies its prompt with .brief(...). */
export function role(r: { by: Who; usd: number; minutes: number }): Spec<Report> {
  return new AgentSpec({
    by: r.by,
    max: { usd: r.usd, minutes: r.minutes },
    answer: REPORT,
    judge: { t: 'none' },
    tree: 'none',
    grantReads: [],
    web: false,
    needs: [],
  });
}
/** A host-run command step. Exit 0 passes; with `.returns(schema)` stdout is parsed as JSON. */
export function command(cmd: string, limits: { minutes: number }): Spec<{ readonly tail: string }>;
export function command<I extends object>(
  cmd: (item: I) => string,
  limits: { minutes: number }
): Spec<{ readonly tail: string }, I>;
export function command<I = never>(
  cmd: Text<I>,
  limits: { minutes: number }
): Spec<{ readonly tail: string }, I> {
  return new CommandSpec({ command: cmd, minutes: limits.minutes, answer: TAIL, needs: [] });
}

// ---- calls ----
function render<I>(text: Text<I>, input: StepInput): string {
  const rendered = typeof text === 'string' ? text : text(input.item as I);
  if (typeof rendered !== 'string' || rendered.trim() === '')
    throw new TypeError('A brief or command must render non-empty text.');
  return rendered;
}
function renderedJudge<I>(j: Judge<I> | { readonly t: 'none' }, input: StepInput): keyed.Judge {
  return j.t === 'check' ? { t: 'check', command: render(j.command, input) } : j;
}
function castJudge<I>(j: Judge<I> | { readonly t: 'none' }): keyed.Judge {
  return j.t === 'check'
    ? { t: 'check', command: typeof j.command === 'string' ? j.command : '<item-dependent>' }
    : j;
}
function baseOf(input: StepInput): keyed.Base {
  return input.on ? { t: 'ref', ref: refId(input.on.ref) } : { t: 'launch' };
}
function inputOf(readable: Readable): keyed.Input {
  if (typeof readable === 'string') return { t: 'text', text: readable };
  if (readable instanceof PlanRef) return { t: 'ref', ref: readable.id };
  return { t: 'ref', ref: refId((readable as Held<unknown>).ref) };
}

/** `input.id`, else `item.id` when it is a string or number, else none: the step name alone. */
function idOf(input: StepInput): string | number | 'none' {
  if (input.id !== undefined) return input.id;
  const itemId: unknown = (input.item as { id?: unknown } | undefined)?.id;
  return typeof itemId === 'string' || typeof itemId === 'number' ? itemId : 'none';
}
function phasePrefix(): string {
  const path = phases.getStore();
  if (!path) throw new Error('Steps, asks and reviews run only inside expedition(...).');
  return path.map((name) => `${name}/`).join('');
}
function stepKey(step: string, input: StepInput): keyed.Key {
  const id = idOf(input);
  return `${phasePrefix()}${step}${id === 'none' ? '' : `/${id}`}`;
}

type CallInput<I> = Omit<StepInput, 'item'> &
  ([I] extends [never] ? { item?: never } : { item: I });
export type Step<Out, I = never> = [I] extends [never]
  ? (input?: CallInput<I>) => Promise<Result<Out>>
  : (input: CallInput<I>) => Promise<Result<Out>>;
type SpecTypes = { readonly __types?: { out: unknown; item: unknown } };
type Made<T extends Record<string, SpecTypes>> = {
  [K in keyof T]: T[K] extends { readonly __types?: { out: infer O; item: infer I } }
    ? Step<O, I>
    : never;
};
/** Property names are the durable step names. The brief/command's item type reaches its call. */
export function steps<T extends Record<string, SpecTypes>>(table: T): Made<T> {
  const made = Object.entries(table).map(([name, spec]) => {
    if (!(spec instanceof StepSpec))
      throw new TypeError(`Step ${name} is not a role(...) or command(...) spec.`);
    return [name, spec] as const;
  });
  declareCast(made.map(([name, spec]) => spec.castRow(name)));
  return Object.freeze(
    Object.fromEntries(made.map(([name, spec]) => [name, stepOf(name, spec)]))
  ) as Made<T>;
}
function stepOf<Out, I>(
  name: string,
  spec: StepSpec<Out, I>
): (input?: StepInput) => Promise<Result<Out>> {
  return async (input = {}) => {
    const s = session();
    const key = s.claim(stepKey(name, input));
    const outcome = await s.call(spec.author(name, key, input));
    return resultOf(spec.answer, key, outcome);
  };
}

// ---- results ----
/** What a result that did not pass can show for itself. */
function evidenceOf(result: Exclude<Result<unknown>, { t: 'passed' }>): keyed.Input[] {
  switch (result.t) {
    case 'failed':
      return [
        { t: 'ref', ref: refId(result.ref) },
        { t: 'text', text: `failed: ${result.why}` },
      ];
    case 'errored':
      return [{ t: 'text', text: `errored: ${result.why}` }];
    case 'cancelled':
      return [
        { t: 'ref', ref: refId(result.partial) },
        { t: 'text', text: 'cancelled' },
      ];
    case 'refused':
      return [{ t: 'text', text: `refused: ${result.reason}` }];
  }
}
/** The passed result, or end the plan here with a gap: "no result, and this is why". */
export function need<Out>(result: Result<Out>, why: string): Held<Out> {
  if (result.t === 'passed') return result;
  return session().gap(why, evidenceOf(result));
}
/** The results that passed. The rest stay in the log as counted gaps. */
export function passed<Out>(results: readonly Result<Out>[]): Held<Out>[] {
  return results.flatMap((result) => (result.t === 'passed' ? [result] : []));
}
/** One call or trial per item, all at once, in item order. The host's pools do the limiting. */
export function parallel<T extends Item, R>(
  items: readonly T[],
  each: (item: T) => Promise<R>
): Promise<R[]> {
  return Promise.all(items.map((item) => each(item)));
}

// ---- the plan ----
export interface X {
  phase<T>(name: string, body: () => Promise<T>): Promise<T>;
  review(question: string): Promise<void>;
  ask(question: string): Promise<string>;
  confirm(question: string): Promise<boolean>;
}
export interface Plan {
  readonly __plan: true;
}

/** `ask/<slug>`: a question's key is its words, so re-asking the same question reuses its answer. */
function slugOf(question: string): string {
  const slug = question
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/, '');
  if (slug === '')
    throw new TypeError(`The question "${question}" has no letters or digits to key it by.`);
  return slug;
}
/** An owner's answer. An ask that settles any other way leaves the plan without an answer: a gap. */
async function askOwner<T>(
  question: string,
  answer: 'text' | 'confirm',
  schema: z.ZodType<T>
): Promise<T> {
  const s = session();
  const key = s.claim(`${phasePrefix()}ask/${slugOf(question)}`);
  const outcome = await s.call({ t: 'ask', key, question, answer });
  if (outcome.t !== 'passed')
    return s.gap(`The owner's question was not answered: ${question}`, [
      { t: 'text', text: outcome.t },
    ]);
  const parsed = schema.safeParse(outcome.out);
  if (!parsed.success)
    return s.fail(`The answer to ${key} is not a ${answer} answer: ${parsed.error.message}`);
  return parsed.data;
}

const x: X = Object.freeze({
  async phase<T>(name: string, body: () => Promise<T>): Promise<T> {
    const s = session();
    const path = phases.getStore();
    if (!path) throw new Error('x.phase runs only inside expedition(...).');
    s.phase(name, 'open');
    // Closed even when plan code catches what its body threw; after the plan ends, sends drop.
    try {
      return await phases.run([...path, name], body);
    } finally {
      s.phase(name, 'close');
    }
  },
  review: (question: string) => session().review(question),
  ask: (question: string) => askOwner(question, 'text', z.string()),
  confirm: (question: string) => askOwner(question, 'confirm', z.boolean()),
});

/** The child entry (runner-child.mjs) finds the plan's starter under this global symbol, so it
 * runs in the same module instance the plan imported, whatever module format each was loaded as. */
const START = Symbol.for('expedition.start');

/** The plan returns its candidate. The host, never the plan, evaluates the contract's `done`. */
export type ExpeditionConfig = { contract: ContractInput; plan: (x: X) => Promise<Held<unknown>> };
export function expedition(config: ExpeditionConfig): Plan {
  const start = (): void => {
    const s = openSession(config.contract);
    phases
      .run([], async () => {
        const candidate = await config.plan(x);
        return refId(candidate.ref);
      })
      .then(
        (ref) => s.candidate(ref),
        (error: unknown) => s.threw(error)
      );
  };
  return Object.freeze({ __plan: true as const, [START]: start });
}
