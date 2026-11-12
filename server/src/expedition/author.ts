import process from 'node:process';
import type { ExpeditionRef, ExpeditionResult } from '@unleashd/shared';
import { z } from 'zod';
import { zodToJsonSchema as convert } from 'zod-to-json-schema';
import type { ContractInput } from './gates';

// Conversion is a runtime walk. Avoid instantiating Zod's graph twice (2026-11-10 OOM).
const jsonSchema = convert as unknown as (schema: unknown) => object;
const report = z.object({ summary: z.string(), files: z.array(z.string()) }).strict();
export type Held<T> = { out: T; ref: ExpeditionRef };
export type Readable = Held<unknown> | ExpeditionRef | string;
export type Result<T> =
  | Exclude<ExpeditionResult, { out: unknown }>
  | { t: 'passed'; out: T; ref: ExpeditionRef }
  | { t: 'failed'; out: T; ref: ExpeditionRef; why: string };
type Definition<I = never> = z.input<ReturnType<typeof definition<I>>>;
type ItemDefinition<I extends z.ZodType<{ id: string }>, O extends z.ZodTypeAny> = (Definition<
  z.output<I>
> extends infer D
  ? D extends unknown
    ? Omit<D, 'item' | 'returns'>
    : never
  : never) & { item: I; returns?: O };
export function step<I extends z.ZodType<{ id: string }>, O extends z.ZodTypeAny = typeof report>(
  d: ItemDefinition<I, O>
): typeof d {
  return d;
}
type Options = {
  id?: string | number;
  reads?: readonly Readable[];
  on?: Held<unknown>;
  continues?: Held<unknown>;
};
type Out<D> = D extends { returns?: infer O extends z.ZodTypeAny }
  ? z.output<O>
  : z.output<typeof report>;
type Args<D> = D extends { item: infer I extends z.ZodTypeAny }
  ? [item: z.output<I>, options?: Options]
  : [options?: Options];
type Made<S> = {
  [K in keyof S]: ((...a: Args<S[K]>) => Promise<Held<Out<S[K]>> & { t: 'passed' }>) & {
    try: (...a: Args<S[K]>) => Promise<Result<Out<S[K]>>>;
  };
};
export type Call = {
  key: string;
  usd: number;
  minutes: number;
  needs: string[];
  inputs: Options & { item?: unknown };
  output: object | null;
} & (
  | {
      t: 'agent';
      by: string;
      brief: string;
      reads: string[];
      web: boolean;
      checkout: boolean;
      judge?: { check: string } | { review: string; by: string };
    }
  | { t: 'command'; command: string }
  | { t: 'question'; question: string; kind: 'text' | 'confirm' | 'manager' }
);
export type Message =
  | { t: 'contract'; contract: ContractInput; defaults: string[] }
  | { t: 'call'; seq: number; call: Call }
  | { t: 'waiting'; on: number[] }
  | { t: 'end'; result: Held<unknown> }
  | { t: 'error'; why: string };
const text = <I>() =>
  z.union([z.string().min(1), z.custom<(item: I) => string>((v) => typeof v === 'function')]);
const schema = z.custom<z.ZodTypeAny>((v) => v instanceof z.ZodType);
const common = {
  item: schema.optional(),
  returns: schema.optional(),
  minutes: z.number().positive().optional(),
  needs: z.array(z.string()).optional(),
};
const definition = <I>() =>
  z.union([
    z
      .object({
        ...common,
        by: z.string(),
        brief: text<I>(),
        reads: z.union([z.string(), z.array(z.string())]).optional(),
        web: z.boolean().optional(),
        checkout: z.boolean().optional(),
        usd: z.number().positive().optional(),
        judge: z
          .union([
            z.object({ check: text<I>() }).strict(),
            z.object({ review: z.string(), by: z.string() }).strict(),
          ])
          .optional(),
      })
      .strict(),
    z.object({ ...common, run: text<I>() }).strict(),
  ]);
const render = (value: unknown, item: unknown): string =>
  z
    .string()
    .min(1)
    .parse(typeof value === 'function' ? value(item) : value);

// Pattern: one-write-path (docs/patterns.md#one-write-path)
// The child owns only promises. The server owns all durable answers, including questions.
export function expedition<const S extends Record<string, Definition>>(config: {
  contract: ContractInput;
  agents?: Record<string, string | { use: string; usd?: number; minutes?: number }>;
  steps: S;
  plan: (
    steps: Made<S>,
    x: {
      phase<T>(name: string, body: () => Promise<T>): Promise<T>;
      ask(q: string): Promise<string>;
      confirm(q: string): Promise<boolean>;
      checkin(q: string): Promise<void>;
    }
  ) => Promise<Held<unknown>>;
}) {
  return {
    [Symbol.for('expedition.start')]: async () => {
      let serial = 0;
      const pending = new Map<number, (r: ExpeditionResult) => void>();
      const keys = new Set<string>();
      const send = (m: Message) => process.send!(m);
      const call = (c: Call): Promise<ExpeditionResult> => {
        if (keys.has(c.key)) throw new Error(`Duplicate step key ${c.key}; supply a distinct id.`);
        keys.add(c.key);
        const seq = ++serial;
        return new Promise((resolve) => {
          pending.set(seq, resolve);
          process.channel!.ref();
          send({ t: 'call', seq, call: c });
          process.channel!.unref();
        });
      };
      process.on('message', (m: { seq: number; result: ExpeditionResult }) => {
        pending.get(m.seq)?.(m.result);
        pending.delete(m.seq);
        process.channel!.unref();
      });
      process.on('disconnect', () => process.exit(0));
      process.on('beforeExit', () => {
        send({ t: 'waiting', on: [...pending.keys()] });
        process.channel!.ref();
      });
      const resolve = (name: string) => {
        const a = config.agents?.[name];
        const who = a ? (typeof a === 'string' ? a : a.use) : name;
        if (!who.includes(':')) throw new Error(`Unknown agent ${name}`);
        return who;
      };
      const defaults: string[] = [];
      const compiled = Object.entries(config.steps).map(([name, raw]) => {
        const d = definition<unknown>().parse(raw);
        const agent = 'by' in d ? config.agents?.[d.by] : undefined;
        const cap = (field: 'usd' | 'minutes', fallback: number) => {
          const value =
            (field in d ? d[field as keyof typeof d] : undefined) ??
            (typeof agent === 'object' ? agent[field] : undefined) ??
            config.contract.call?.[field] ??
            fallback;
          defaults.push(`${name}.${field} = ${value}`);
          // Infinity crosses JSON IPC as null, turning an alias cap into a $0 reservation.
          // Guard: expedition-small rejects nonfinite alias caps.
          return z
            .number()
            .positive()
            .max(field === 'minutes' ? 35791 : Number.MAX_VALUE)
            .parse(value);
        };
        const usd = 'by' in d ? cap('usd', 1) : 0,
          minutes = cap('minutes', 20);
        const judge =
          'by' in d && d.judge && 'review' in d.judge
            ? { ...d.judge, by: resolve(d.judge.by) }
            : undefined;
        const by = 'by' in d ? resolve(d.by) : '';
        if (d.needs?.some((key) => ['claude', 'codex', 'gemini', 'cursor', 'muse'].includes(key)))
          throw new Error('needs names resources; agent harness slots are acquired automatically');
        const attempt = async (first?: unknown, second?: Options): Promise<ExpeditionResult> => {
          const item: unknown = d.item?.parse(first);
          if (d.item) z.object({ id: z.string() }).parse(item);
          const input = z
            .object({
              id: z.union([z.string(), z.number()]).optional(),
              reads: z.array(z.unknown()).optional(),
              on: z.unknown().optional(),
              continues: z.unknown().optional(),
            })
            .strict()
            .parse(d.item ? (second ?? {}) : (first ?? {})) as Options;
          const id = input.id ?? (item as { id: string } | undefined)?.id;
          const key = `${name}${id === undefined ? '' : `/${id}`}`;
          const base = {
            key,
            usd,
            minutes,
            needs: d.needs ?? [],
            inputs: { ...input, ...(d.item ? { item } : {}) },
            output: d.returns ? jsonSchema(d.returns) : 'by' in d ? jsonSchema(report) : null,
          };
          const c: Call =
            'run' in d
              ? { ...base, t: 'command', command: render(d.run, item) }
              : {
                  ...base,
                  t: 'agent',
                  by,
                  brief: render(d.brief, item),
                  reads: typeof d.reads === 'string' ? [d.reads] : (d.reads ?? []),
                  web: d.web ?? false,
                  checkout: d.checkout ?? false,
                  judge:
                    judge ??
                    (d.judge && 'check' in d.judge
                      ? { check: render(d.judge.check, item) }
                      : undefined),
                };
          const result = await call(c);
          if (result.t === 'passed' || result.t === 'failed') {
            const parsed = (d.returns ?? report).safeParse(result.out);
            if (!parsed.success) throw new Error(`Step ${key}: ${parsed.error.message}`);
            return { ...result, out: parsed.data };
          }
          return result;
        };
        return [
          name,
          Object.assign(
            async (a?: unknown, b?: Options) => {
              const r = await attempt(a, b);
              if (r.t !== 'passed') {
                throw new Error(`Required step ${name} did not pass; rewrite its inputs to retry.`);
              }
              return r;
            },
            { try: attempt }
          ),
        ];
      });
      const question = async (question: string, kind: 'text' | 'confirm' | 'manager') => {
        const r = await call({
          t: 'question',
          key: `${kind}/${question}`,
          question,
          kind,
          usd: 0,
          minutes: 0,
          needs: [],
          inputs: {},
          output: null,
        });
        if (r.t !== 'passed') throw new Error(`Question unanswered: ${question}`);
        return r.out;
      };
      send({
        t: 'contract',
        defaults,
        contract: {
          ...config.contract,
          leader: resolve(config.contract.leader),
          done: config.contract.done.map((d) => ('review' in d ? { ...d, by: resolve(d.by) } : d)),
        },
      });
      try {
        const result = await config.plan(Object.fromEntries(compiled) as Made<S>, {
          phase: (_name, body) => body(),
          ask: async (q) => z.string().parse(await question(q, 'text')),
          confirm: async (q) => z.boolean().parse(await question(q, 'confirm')),
          checkin: async (q) => {
            await question(q, 'manager');
          },
        });
        if (pending.size) throw new Error('The plan returned with unawaited steps.');
        send({ t: 'end', result });
      } catch (error) {
        send({ t: 'error', why: String(error) });
      }
    },
  };
}
