import type { keyed } from '@unleashd/shared';
import { z } from 'zod';
import { zodToJsonSchema as zodToJsonSchemaTyped } from 'zod-to-json-schema';
import { AUTHORING_DEFAULTS, type ContractInput, assertPlainJson } from '../contract';
import { Agent, type Agents, type WhoName, specOf, whoOf } from './who';

export type { ContractInput } from '../contract';

import type { Authored, CastRow } from '../protocol';
import { openSession, phases, session } from './session';

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
// turns every step, ask and checkin into a message to the host.

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
const reportSchema = z.object({ summary: z.string(), files: z.array(z.string().min(1)) }).strict();
const REPORT: Answer<Report> = Answer.of(reportSchema);
/** A command's default answer: stdout is not read as JSON (`output: null` on the wire). */
const tailSchema = z
  .object({ tail: z.string() })
  .strict()
  .transform(({ tail }) => ({ summary: tail, files: [] as string[] }));
const TAIL: Answer<Report> = new Answer(null, tailSchema);

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

// ---- plain definitions ----
type Text<I> = string | ((item: I) => string);
type Judge<I> = { check: Text<I> } | { review: string; by: string };
type AgentDefinition<I> = {
  by: string;
  brief: Text<I>;
  item?: z.ZodTypeAny;
  returns?: z.ZodTypeAny;
  reads?: string | readonly string[];
  web?: boolean;
  checkout?: boolean;
  needs?: readonly string[];
  judge?: Judge<I>;
  usd?: number;
  minutes?: number;
};
type CommandDefinition<I> = {
  needs?: readonly string[];
  run: Text<I>;
  minutes?: number;
  returns?: z.ZodTypeAny;
  item?: z.ZodTypeAny;
};
type Definition = AgentDefinition<never> | CommandDefinition<never>;
type ItemAgent<I extends z.ZodType<Item>, O extends z.ZodTypeAny> = Omit<
  AgentDefinition<z.output<I>>,
  'item' | 'returns'
> & { item: I; returns?: O };
type ItemCommand<I extends z.ZodType<Item>, O extends z.ZodTypeAny> = Omit<
  CommandDefinition<z.output<I>>,
  'item' | 'returns'
> & { item: I; returns?: O };
/** Only needed for sibling-schema callback inference; it adds no runtime behaviour. */
type NamedItemAgent<I extends z.ZodType<Item>, O extends z.ZodTypeAny, B extends string> = Omit<
  ItemAgent<I, O>,
  'by'
> & { by: B };
export function step<I extends z.ZodType<Item>, O extends z.ZodTypeAny, const B extends string>(
  definition: NamedItemAgent<I, O, B> & { returns: O }
): NamedItemAgent<I, O, B>;
export function step<I extends z.ZodType<Item>, const B extends string>(
  definition: NamedItemAgent<I, typeof reportSchema, B> & { returns?: never }
): NamedItemAgent<I, typeof reportSchema, B>;
export function step<I extends z.ZodType<Item>, O extends z.ZodTypeAny>(
  definition: ItemCommand<I, O> & { returns: O }
): ItemCommand<I, O>;
export function step<I extends z.ZodType<Item>>(
  definition: ItemCommand<I, typeof tailSchema> & { returns?: never }
): ItemCommand<I, typeof tailSchema>;
export function step(definition: unknown): unknown {
  return definition;
}

type StepInput = {
  id?: string | number;
  reads?: readonly Readable[];
  continues?: Held<unknown>;
  on?: Held<unknown>;
};
type Out<D> = D extends { returns?: infer O extends z.ZodTypeAny } ? z.output<O> : Report;
type Arguments<D> = D extends { item: infer I extends z.ZodTypeAny }
  ? [item: z.output<I>, input?: StepInput]
  : [input?: StepInput];
type Step<D> = ((...args: Arguments<D>) => Promise<Extract<Result<Out<D>>, { t: 'passed' }>>) & {
  try: (...args: Arguments<D>) => Promise<Result<Out<D>>>;
};
type Made<S> = { [K in keyof S]: Step<S[K]> };
type CheckedNames<S, A> = {
  [K in keyof S]: S[K] extends { by: unknown } ? { by: WhoName<A> } : unknown;
};

// Pattern: parse-dont-validate (docs/patterns.md#parse-dont-validate)
// Parse the entire table before running the plan, including steps behind awaits. No config is
// silently discarded: strict schemas refuse misspelled keys and incompatible step variants.
const text = z.union([z.string().min(1), z.function()]);
const schema = z.custom<z.ZodTypeAny>((v) => v instanceof z.ZodType, 'Expected a Zod schema');
const judge = z.union([
  z.object({ check: text }).strict(),
  z.object({ review: z.string().min(1), by: z.string().min(1) }).strict(),
]);
const common = {
  item: schema.optional(),
  returns: schema.optional(),
  minutes: z.number().positive().optional(),
};
const definition = z.union([
  z
    .object({
      ...common,
      by: z.string().min(1),
      brief: text,
      reads: z.union([z.string(), z.array(z.string())]).optional(),
      web: z.boolean().optional(),
      checkout: z.boolean().optional(),
      needs: z.array(z.string()).optional(),
      judge: judge.optional(),
      usd: z.number().positive().optional(),
    })
    .strict(),
  z.object({ ...common, run: text, needs: z.array(z.string()).optional() }).strict(),
]);
type Parsed = z.infer<typeof definition>;
type InternalInput = StepInput & { item?: Item };
type Compiled = {
  answer: Answer<unknown>;
  item: z.ZodTypeAny | undefined;
  row: CastRow;
  author: (key: keyed.Key, input: InternalInput) => Authored;
};
function render(value: unknown, item: unknown): string {
  const rendered = typeof value === 'function' ? value(item) : value;
  if (typeof rendered !== 'string' || rendered.trim() === '')
    throw new TypeError('A brief or command must render non-empty text.');
  return rendered;
}
function inputOf(readable: Readable): keyed.Input {
  if (typeof readable === 'string') return { t: 'text', text: readable };
  if (readable instanceof PlanRef) return { t: 'ref', ref: readable.id };
  return { t: 'ref', ref: refId((readable as Held<unknown>).ref) };
}
function baseOf(input: StepInput): keyed.Base {
  return input.on ? { t: 'ref', ref: refId(input.on.ref) } : { t: 'launch' };
}
function phasePrefix(): string {
  const path = phases.getStore();
  if (!path) throw new Error('Steps, asks and checkins run only inside expedition(...).');
  return path.map((name) => `${name}/`).join('');
}
function stepKey(name: string, input: InternalInput): keyed.Key {
  const id = input.id ?? input.item?.id;
  return `${phasePrefix()}${name}${id === undefined || id === 'none' ? '' : `/${id}`}`;
}
type Limit = keyed.PreviewDefaults['call']['usd'];
function cap(
  field: 'usd' | 'minutes',
  d: { usd?: number; minutes?: number },
  agent: Agent | undefined,
  contract: ContractInput
): Limit {
  if (d[field] !== undefined) return { t: 'step', value: d[field] };
  if (typeof agent === 'object' && agent[field] !== undefined)
    return { t: 'agent', value: agent[field] };
  if (contract.call?.[field] !== undefined) return { t: 'contract', value: contract.call[field] };
  return { t: 'defaulted', value: AUTHORING_DEFAULTS.call[field] };
}
type CompileContext = { name: string; agents: Agents; contract: ContractInput };
/** Pattern: sum-types (docs/patterns.md#sum-types)
 * Classify the judge once; calls only render its item-dependent command, never reparse its kind.
 */
function compileJudge(
  j: Extract<Parsed, { by: string }>['judge'],
  c: CompileContext
): { cast: keyed.Judge; render: (item: unknown) => keyed.Judge } {
  if (j === undefined) {
    const cast: keyed.Judge = { t: 'none' };
    return { cast, render: () => cast };
  }
  if ('check' in j)
    return {
      cast: { t: 'check', command: typeof j.check === 'string' ? j.check : '<item-dependent>' },
      render: (item) => ({ t: 'check', command: render(j.check, item) }),
    };
  const cast: keyed.Judge = {
    t: 'review',
    rubric: j.review,
    by: whoOf(specOf(j.by, c.agents, `${c.name}.judge`), `${c.name}.judge`),
  };
  return { cast, render: () => cast };
}
function compileAgent(d: Extract<Parsed, { by: string }>, c: CompileContext): Compiled {
  const by = whoOf(specOf(d.by, c.agents, c.name), c.name);
  const agent = Object.hasOwn(c.agents, d.by) ? c.agents[d.by] : undefined;
  const usd = cap('usd', d, agent, c.contract),
    minutes = cap('minutes', d, agent, c.contract);
  const judged = compileJudge(d.judge, c);
  const row: Extract<CastRow, { t: 'agent' }> = {
    t: 'agent',
    step: c.name,
    by,
    tree: d.checkout ? 'checkout' : 'none',
    grant: {
      reads: typeof d.reads === 'string' ? [d.reads] : (d.reads ?? []),
      web: d.web ?? false,
    },
    judge: judged.cast,
    hasBrief: true,
    needs: d.needs ?? [],
    caps: { usd, minutes },
  };
  const answer = d.returns ? Answer.of(d.returns) : REPORT;
  return {
    item: d.item,
    answer,
    row,
    author: (key, input) => ({
      t: 'agent',
      key,
      step: c.name,
      by,
      brief: render(d.brief, input.item),
      inputs: (input.reads ?? []).map(inputOf),
      output: answer.jsonSchema,
      tree: row.tree,
      base: baseOf(input),
      grant: row.grant,
      context: input.continues ? { t: 'continue', of: refId(input.continues.ref) } : { t: 'cold' },
      needs: row.needs,
      max: { usd: usd.value, minutes: minutes.value },
      judge: judged.render(input.item),
    }),
  };
}
function compileCommand(d: Extract<Parsed, { run: unknown }>, c: CompileContext): Compiled {
  const minutes = cap('minutes', d, undefined, c.contract);
  const answer = d.returns ? Answer.of(d.returns) : TAIL;
  return {
    item: d.item,
    answer,
    row: { t: 'command', step: c.name, caps: { minutes } },
    author: (key, input) => {
      if (input.reads || input.continues)
        throw new TypeError(
          `Command step ${c.name} takes no reads or continues: a command reads only its checkout.`
        );
      return {
        t: 'command',
        key,
        step: c.name,
        command: render(d.run, input.item),
        on: baseOf(input),
        output: answer.jsonSchema,
        needs: d.needs ?? [],
        maxMinutes: minutes.value,
      };
    },
  };
}
/** Boundary classification into one handler per variant; handlers do not rediscover step kind. */
function compile(raw: unknown, c: CompileContext): Compiled {
  const parsed = definition.safeParse(raw);
  if (!parsed.success) throw new TypeError(`Step ${c.name}: ${parsed.error.message}`);
  const d = parsed.data;
  const callbacks =
    'by' in d ? [d.brief, ...(d.judge && 'check' in d.judge ? [d.judge.check] : [])] : [d.run];
  if (!d.item && callbacks.some((v) => typeof v === 'function'))
    throw new TypeError(`Step ${c.name}: item schema is required for an item callback.`);
  if (d.item) {
    const json = zodToJsonSchema(d.item) as {
      type?: string;
      properties?: Record<string, { type?: string }>;
      required?: string[];
    };
    if (
      json.type !== 'object' ||
      json.properties?.id?.type !== 'string' ||
      !json.required?.includes('id')
    )
      throw new TypeError(`Step ${c.name}: item schema must require a string id.`);
  }
  return 'by' in d ? compileAgent(d, c) : compileCommand(d, c);
}
const callOptions = z
  .object({
    id: z.union([z.string(), z.number()]).optional(),
    reads: z.array(z.unknown()).optional(),
    continues: z.unknown().optional(),
    on: z.unknown().optional(),
  })
  .strict();
function itemOf(schema: z.ZodTypeAny, raw: unknown, name: string): Item {
  const value: unknown = schema.parse(raw);
  // A Zod transform can remove/change id after its JSON Schema passed the cast gate. Never
  // turn that into a no-id call key. Guard: expedition-kernel-authoring transformed-item test.
  if (
    typeof value !== 'object' ||
    value === null ||
    !('id' in value) ||
    typeof value.id !== 'string'
  )
    throw new TypeError(`Step ${name}: parsed item must have a string id.`);
  return value as Item;
}
function stepOf(name: string, spec: Compiled) {
  const attempt = async (first?: unknown, second?: unknown): Promise<Result<unknown>> => {
    // map passes its index as argument two. Reject it before it can alter a durable key or grants.
    // Guard: expedition-kernel-authoring arity test; use an explicit callback in native array APIs.
    if (
      second !== undefined &&
      (typeof second !== 'object' || second === null || Array.isArray(second))
    )
      throw new TypeError(
        `Step ${name}: second argument must be an options object; write (org) => ${name}(org), not orgs.map(${name}).`
      );
    if (!spec.item && second !== undefined)
      throw new TypeError(`Step ${name} takes one options object.`);
    const options = callOptions.parse(spec.item ? (second ?? {}) : (first ?? {})) as StepInput;
    const input: InternalInput = spec.item
      ? { ...options, item: itemOf(spec.item, first, name) }
      : options;
    const key = session().claim(stepKey(name, input));
    return resultOf(spec.answer, key, await session().call(spec.author(key, input)));
  };
  return Object.assign(
    async (first?: unknown, second?: unknown): Promise<Held<unknown>> => {
      const result = await attempt(first, second);
      if (result.t === 'passed') return result;
      return session().gap(`Step ${name} did not pass: ${failureOf(result)}.`, evidenceOf(result));
    },
    { try: attempt }
  );
}
function failureOf(r: Exclude<Result<unknown>, { t: 'passed' }>): string {
  switch (r.t) {
    case 'failed':
    case 'errored':
      return `${r.t}: ${r.why}`;
    case 'cancelled':
      return 'cancelled';
    case 'refused':
      return `refused: ${r.reason}`;
  }
}

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
// ---- the plan ----
export interface X {
  phase<T>(name: string, body: () => Promise<T>): Promise<T>;
  checkin(question: string): Promise<void>;
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
  checkin: (question: string) => session().review(question),
  ask: (question: string) => askOwner(question, 'text', z.string()),
  confirm: (question: string) => askOwner(question, 'confirm', z.boolean()),
});

/** The child entry and plan import share this symbol across module formats. */
const START = Symbol.for('expedition.start');
export function expedition<
  const S extends Record<string, Definition>,
  const A extends Agents = Record<never, never>,
>(config: {
  contract: ContractInput;
  agents?: A;
  steps: S & CheckedNames<S, A>;
  plan: (steps: Made<S>, x: X) => Promise<Held<unknown>>;
}): Plan {
  const start = (): void => {
    // Send the owner literal first, even if a step later fails boundary parsing.
    const agents = z.record(Agent).parse(config.agents ?? {}) as Agents;
    const raw = config.contract;
    assertPlainJson(raw);
    const contract = {
      ...raw,
      leader: specOf(raw.leader, agents, 'contract.leader'),
      done: raw.done.map((d, i) =>
        'review' in d ? { ...d, by: specOf(d.by, agents, `contract.done/${i}`) } : d
      ),
    };
    const s = openSession(contract);
    phases
      .run([], async () => {
        for (const [name, agent] of Object.entries(agents))
          whoOf(typeof agent === 'string' ? agent : agent.use, `agents.${name}`);
        const compiled = Object.entries(config.steps).map(
          ([name, d]) => [name, compile(d, { name, agents, contract })] as const
        );
        s.cast(compiled.map(([, d]) => d.row));
        const calls = Object.fromEntries(
          compiled.map(([name, d]) => [name, stepOf(name, d)])
        ) as unknown as Made<S>;
        const candidate = await config.plan(calls, x);
        return refId(candidate.ref);
      })
      .then(
        (ref) => s.candidate(ref),
        (error: unknown) => s.threw(error)
      );
  };
  return Object.freeze({ __plan: true as const, [START]: start });
}
