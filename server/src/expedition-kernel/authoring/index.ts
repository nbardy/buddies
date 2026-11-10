import type { keyed } from '@unleashd/shared';
import { z } from 'zod';
import { zodToJsonSchema as zodToJsonSchemaTyped } from 'zod-to-json-schema';
import type { Authored } from '../protocol';
import { openSession, phases, session } from './session';

// zod-to-json-schema's signature makes tsc 5.9 instantiate zod's whole type graph for a generic
// schema: typechecking this one file ran out of a 4 GB heap after 42 s (2026-11-10), which crashed
// `pnpm typecheck` for the whole server. The conversion is a runtime walk, so it is called through
// an untyped signature. Guard: server/test/expedition-kernel-typecheck.test.ts.
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
export const buddy = (id: string): Who => Object.freeze({ t: 'buddy', id });
/** An anonymous worker. Values pass through verbatim to vendor/agent-cli-tool. */
export const seat = (provider: string, model: string, effort: string): Who =>
  Object.freeze({ t: 'seat', provider, model, effort });

// ---- judges ----
export type Judge =
  | { readonly t: 'check'; readonly command: string }
  | { readonly t: 'review'; readonly rubric: string; readonly by: Who };
/** The host runs the command on the step's output; exit 0 passes. `{{slots}}` come from the item. */
export const check = (command: string): Judge => Object.freeze({ t: 'check', command });
/** Another seat reviews against `briefs/<rubric>.md`. The dry run refuses the producer's provider. */
export const review = (rubric: string, by: Who): Judge =>
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
export type Report = { readonly summary: string; readonly files: readonly Ref[] };
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

/** An agent's default answer. Files arrive as RefIds and reach plan code as Refs. */
const REPORT: Answer<Report> = new Answer(
  zodToJsonSchema(z.object({ summary: z.string(), files: z.array(z.string()) }).strict()),
  z
    .object({ summary: z.string(), files: z.array(z.string().min(1)) })
    .strict()
    .transform(
      (wire): Report => ({ summary: wire.summary, files: wire.files.map((id) => new PlanRef(id)) })
    )
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
export interface Spec<Out> {
  returns<T>(schema: z.ZodType<T>): Spec<T>;
  lists<T extends Item>(schema: z.ZodType<T>): Spec<T[]>;
  judged(judge: Judge): Spec<Out>;
  checkout(): Spec<Out>;
  reads(...paths: string[]): Spec<Out>;
  web(): Spec<Out>;
  needs(...pools: string[]): Spec<Out>;
}

export type StepInput = {
  id?: string | number;
  item?: object;
  reads?: readonly Readable[];
  continues?: Held<unknown>;
  on?: Held<unknown>;
};

/** A spec the library made (`role` or `command`): it knows how to author its call. */
abstract class StepSpec<Out> implements Spec<Out> {
  abstract readonly answer: Answer<Out>;
  abstract author(step: string, key: keyed.Key, input: StepInput): Authored;
  abstract returns<T>(schema: z.ZodType<T>): Spec<T>;
  abstract judged(judge: Judge): Spec<Out>;
  abstract checkout(): Spec<Out>;
  abstract reads(...paths: string[]): Spec<Out>;
  abstract web(): Spec<Out>;
  abstract needs(...pools: string[]): Spec<Out>;
  lists<T extends Item>(schema: z.ZodType<T>): Spec<T[]> {
    return this.returns(z.array(schema));
  }
}

type AgentFields<Out> = {
  readonly by: Who;
  readonly max: { readonly usd: number; readonly minutes: number };
  readonly answer: Answer<Out>;
  readonly judge: keyed.Judge;
  readonly tree: 'none' | 'checkout';
  readonly grantReads: readonly string[];
  readonly web: boolean;
  readonly needs: readonly string[];
};

class AgentSpec<Out> extends StepSpec<Out> {
  readonly answer: Answer<Out>;
  constructor(private readonly f: AgentFields<Out>) {
    super();
    this.answer = f.answer;
    Object.freeze(this);
  }
  private with<O>(change: Partial<AgentFields<O>> & { answer: Answer<O> }): AgentSpec<O> {
    return new AgentSpec<O>({ ...this.f, ...change });
  }
  returns<T>(schema: z.ZodType<T>): Spec<T> {
    return this.with({ answer: Answer.of(schema) });
  }
  judged(judge: Judge): Spec<Out> {
    return this.with({ answer: this.answer, judge });
  }
  checkout(): Spec<Out> {
    return this.with({ answer: this.answer, tree: 'checkout' });
  }
  reads(...paths: string[]): Spec<Out> {
    return this.with({ answer: this.answer, grantReads: [...this.f.grantReads, ...paths] });
  }
  web(): Spec<Out> {
    return this.with({ answer: this.answer, web: true });
  }
  needs(...pools: string[]): Spec<Out> {
    return this.with({ answer: this.answer, needs: [...this.f.needs, ...pools] });
  }
  author(step: string, key: keyed.Key, input: StepInput): Authored {
    return {
      t: 'agent',
      key,
      step,
      item: itemOf(input),
      by: this.f.by,
      inputs: (input.reads ?? []).map(inputOf),
      output: this.answer.jsonSchema,
      tree: this.f.tree,
      base: baseOf(input),
      grant: { reads: [...this.f.grantReads], web: this.f.web },
      context: input.continues ? { t: 'continue', of: refId(input.continues.ref) } : { t: 'cold' },
      needs: [...this.f.needs],
      max: { usd: this.f.max.usd, minutes: this.f.max.minutes },
      judge: this.f.judge,
    };
  }
}

type CommandFields<Out> = {
  readonly command: string;
  readonly minutes: number;
  readonly answer: Answer<Out>;
  readonly needs: readonly string[];
};

/** A host-run command. The wire has no judge, tree, grant or context for a command, so those
 * refinements are authoring errors here rather than settings the host would silently drop. */
class CommandSpec<Out> extends StepSpec<Out> {
  readonly answer: Answer<Out>;
  constructor(private readonly f: CommandFields<Out>) {
    super();
    this.answer = f.answer;
    Object.freeze(this);
  }
  returns<T>(schema: z.ZodType<T>): Spec<T> {
    return new CommandSpec<T>({ ...this.f, answer: Answer.of(schema) });
  }
  needs(...pools: string[]): Spec<Out> {
    return new CommandSpec<Out>({ ...this.f, needs: [...this.f.needs, ...pools] });
  }
  judged(): Spec<Out> {
    return unsupported('judged()');
  }
  checkout(): Spec<Out> {
    return unsupported('checkout()');
  }
  reads(): Spec<Out> {
    return unsupported('reads()');
  }
  web(): Spec<Out> {
    return unsupported('web()');
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
      command: this.f.command,
      item: itemOf(input),
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

/** An agent step. Its prompt is `briefs/<step name>.md`. */
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
export function command(cmd: string, limits: { minutes: number }): Spec<{ readonly tail: string }> {
  return new CommandSpec({ command: cmd, minutes: limits.minutes, answer: TAIL, needs: [] });
}

// ---- calls ----
function itemOf(input: StepInput): Record<string, unknown> {
  return { ...(input.item ?? {}) };
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
  if (!path) throw new Error('Steps, asks and reviews run only inside plan(...).');
  return path.map((name) => `${name}/`).join('');
}
function stepKey(step: string, input: StepInput): keyed.Key {
  const id = idOf(input);
  return `${phasePrefix()}${step}${id === 'none' ? '' : `/${id}`}`;
}

export type Step<Out> = (input?: StepInput) => Promise<Result<Out>>;
/** Property names are the step names: written once, as identifiers; the durable names in the log. */
export function steps<T extends Record<string, Spec<unknown>>>(
  table: T
): { [K in keyof T]: T[K] extends Spec<infer Out> ? Step<Out> : never } {
  const made = Object.entries(table).map(([name, spec]) => {
    if (!(spec instanceof StepSpec))
      throw new TypeError(`Step ${name} is not a role(...) or command(...) spec.`);
    return [name, stepOf(name, spec)] as const;
  });
  return Object.freeze(Object.fromEntries(made)) as {
    [K in keyof T]: T[K] extends Spec<infer Out> ? Step<Out> : never;
  };
}
function stepOf<Out>(name: string, spec: StepSpec<Out>): Step<Out> {
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
    if (!path) throw new Error('x.phase runs only inside plan(...).');
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
export function plan(run: (x: X) => Promise<Held<unknown>>): Plan {
  const start = (): void => {
    const s = openSession();
    phases
      .run([], async () => {
        const candidate = await run(x);
        return refId(candidate.ref);
      })
      .then(
        (ref) => s.candidate(ref),
        (error: unknown) => s.threw(error)
      );
  };
  return Object.freeze({ __plan: true as const, [START]: start });
}
