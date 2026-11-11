import path from 'node:path';
import { keyed } from '@unleashd/shared';
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

/** What the instruction says each answer must be: one JSON Schema, or (a leader wake) one act. */
type Format = { readonly must: string; readonly body: readonly string[]; readonly fails: string };
const bySchemaFormat = (schema: unknown): Format => ({
  must: 'It must be one JSON value valid against this JSON Schema:',
  body: [fence(JSON.stringify(schema, null, 2))],
  fails: 'An answer that does not parse or does not match the schema fails the call.',
});
const FORMAT: { readonly [K in Expected['t']]: (e: Extract<Expected, { t: K }>) => Format } = {
  typed: (e) => bySchemaFormat(e.schema),
  verdict: () => bySchemaFormat(VERDICT_SCHEMA),
  act: (e) => ({
    must: 'It must be exactly one of these acts:',
    body: [
      '- {"t":"continue","why":"<reason>"}: carry on as planned (at a review, the plan goes past it). The reason is required: the owner reads it on the review.',
      '- {"t":"stop","why":"<reason>"}: end the expedition now, its goal not met.',
      '- {"t":"retry","keys":["<key>", ...]}: run errored, cancelled or refused calls again.',
      `- {"t":"rewrite","folder":"${e.folder}","why":"<reason>"}: you edited plan.ts or briefs/ in that folder and submit it as the next plan version. The folder must be exactly this one.`,
    ],
    fails: 'An answer that does not parse or is not one of these acts fails the wake.',
  }),
};

/** What the brief tells the agent about its answer. */
export function answerInstruction(expected: Expected): string {
  const f = (FORMAT[expected.t] as (e: Expected) => Format)(expected);
  return [
    'ANSWER FORMAT',
    `Your final message is your answer, and only its LAST fenced json block is read (with no fenced block, the whole message must be the JSON). ${f.must}`,
    ...f.body,
    `End your final message with that block. ${f.fails}`,
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

const malformed = (why: string): RawOutcome => ({ t: 'errored', why: `malformed answer: ${why}` });

/** A JSON value checked against a JSON Schema, then read as an outcome. */
const bySchema =
  (schema: unknown, read: (value: unknown) => RawOutcome) =>
  (value: unknown): RawOutcome => {
    const checked = checkOutput(schema, value);
    return checked.t === 'valid' ? read(value) : malformed(checked.why);
  };

/** A leader's act. A rewrite names a folder; it must be the wake's own draft (a relative path is
 * read from the draft), so a wake can never submit a folder it was not given. */
function actOf(value: unknown, folder: string): RawOutcome {
  const act = keyed.LeaderAct.safeParse(value);
  if (!act.success) return malformed(`not a leader act: ${act.error.message}`);
  if (act.data.t === 'continue' && act.data.why.trim() === '')
    return malformed('a continue needs a reason in "why"');
  if (act.data.t !== 'rewrite') return { t: 'ok', out: act.data };
  const named = path.resolve(folder, act.data.folder);
  if (named !== path.resolve(folder))
    return malformed(`the rewrite names ${act.data.folder}, not its draft folder ${folder}`);
  return { t: 'ok', out: { ...act.data, folder: path.resolve(folder) } };
}

const OUTCOME: {
  readonly [K in Expected['t']]: (value: unknown, e: Extract<Expected, { t: K }>) => RawOutcome;
} = {
  typed: (value, e) => bySchema(e.schema, (v) => ({ t: 'ok', out: v }))(value),
  // The schema guarantees the shape.
  verdict: bySchema(VERDICT_SCHEMA, (value) => {
    const v = value as { verdict: 'yes' | 'no'; why: string };
    return v.verdict === 'yes' ? { t: 'ok', out: v } : { t: 'no', why: v.why };
  }),
  act: (value, e) => actOf(value, e.folder),
};

/** An answered call's outcome, from its answer's text. */
export function outcomeOf(expected: Expected, body: string): RawOutcome {
  let value: unknown;
  try {
    value = JSON.parse(answerText(body));
  } catch (e) {
    return malformed(`not JSON (${(e as Error).message})`);
  }
  return (OUTCOME[expected.t] as (v: unknown, e: Expected) => RawOutcome)(value, expected);
}
