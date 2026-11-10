import type { RawOutcome } from '../../expedition-kernel/ports';
import { checkOutput } from './output-schema';
import type { Expected } from './records';

// A call's answer is its turn's final text (the `call` grant shows no tools). The ONE place that
// says what that text must look like, and the one reader of it: the brief carries
// `answerInstruction`, the settle runs `outcomeOf`. A malformed answer is `errored("malformed
// answer: …")` here, before the kernel logs a `passed`, starts a paid judge or a ref is written
// (CONNECT_PLAN §0.3).

/** A review judge's answer. `yes` is `ok`, `no` is `no(why)`. */
export const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['yes', 'no'] },
    why: { type: 'string', minLength: 1 },
  },
  required: ['verdict', 'why'],
  additionalProperties: false,
} as const;

const fence = (json: string) => `\`\`\`json\n${json}\n\`\`\``;

const SCHEMA_OF: { readonly [K in Expected['t']]: (e: Extract<Expected, { t: K }>) => unknown } = {
  typed: (e) => e.schema,
  verdict: () => VERDICT_SCHEMA,
};
const schemaOf = (e: Expected): unknown => SCHEMA_OF[e.t](e as never);

/** What the brief tells the agent about its answer. */
export function answerInstruction(expected: Expected): string {
  return [
    'ANSWER FORMAT',
    'Your final message is your answer, and only its LAST fenced json block is read (with no fenced block, the whole message must be the JSON). It must be one JSON value valid against this JSON Schema:',
    fence(JSON.stringify(schemaOf(expected), null, 2)),
    'End your final message with that block. An answer that does not parse or does not match the schema fails the call.',
  ].join('\n');
}

// The last ```json fence; a bare ``` fence is not an answer block.
const JSON_FENCE = /```json[^\S\n]*\n([\s\S]*?)\n?```/g;

/** The JSON text of an answer: its last fenced json block, else the whole body. */
function answerText(body: string): string {
  let last: string | undefined;
  for (const m of body.matchAll(JSON_FENCE)) last = m[1];
  return (last ?? body).trim();
}

type Parsed =
  | { readonly t: 'json'; readonly value: unknown }
  | { readonly t: 'malformed'; why: string };
function parsed(body: string, schema: unknown): Parsed {
  let value: unknown;
  try {
    value = JSON.parse(answerText(body));
  } catch (e) {
    return { t: 'malformed', why: `not JSON (${(e as Error).message})` };
  }
  const checked = checkOutput(schema, value);
  return checked.t === 'valid' ? { t: 'json', value } : { t: 'malformed', why: checked.why };
}

const malformed = (why: string): RawOutcome => ({ t: 'errored', why: `malformed answer: ${why}` });

const OUTCOME: {
  readonly [K in Expected['t']]: (value: unknown, e: Extract<Expected, { t: K }>) => RawOutcome;
} = {
  typed: (value) => ({ t: 'ok', out: value }),
  // The schema guarantees the shape.
  verdict: (value) => {
    const v = value as { verdict: 'yes' | 'no'; why: string };
    return v.verdict === 'yes' ? { t: 'ok', out: v } : { t: 'no', why: v.why };
  },
};

/** An answered call's outcome, from its answer's text. */
export function outcomeOf(expected: Expected, body: string): RawOutcome {
  const p = parsed(body, schemaOf(expected));
  if (p.t === 'malformed') return malformed(p.why);
  return OUTCOME[expected.t](p.value, expected as never);
}
