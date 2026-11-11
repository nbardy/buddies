import { realpath, stat } from 'node:fs/promises';
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
      // Second real run (2026-11-11): the leader answered `retry` for a FAILED call twice; each was
      // rejected ("it has a result, so a retry would rebuy it") and each rejection cost a wake.
      '- {"t":"retry","keys":["<key>", ...]}: run errored, cancelled or refused calls again. Never a failed or passed call: it has a result; to run it differently, rewrite its brief or the plan.',
      `- {"t":"rewrite","file":"${path.join(e.folder, 'plan.expedition.ts')}","why":"<reason>"}: you edited that one file and submit it as the next plan version. Keep its owner contract unchanged.`,
    ],
    fails: 'An answer that does not parse or is not one of these acts fails the wake.',
  }),
};

/** What the brief tells the agent about its answer. */
export function answerInstruction(expected: Expected): string {
  const f = (FORMAT[expected.t] as (e: Expected) => Format)(expected);
  return [
    'ANSWER FORMAT',
    `Your final message is your answer: its LAST fenced json block is read; without a block, the message is read as JSON (or its last complete top-level JSON value). ${f.must}`,
    ...f.body,
    // Real conformance answer-bare lost to the old mandatory-fence footer (one wasted turn).
    // The reader accepts both: keep its contract and the instruction in agreement.
    `End with your JSON answer, preferably in a fenced json block; if the brief requests bare JSON or progress text followed by JSON, use that rendering instead. ${f.fails}`,
    'If your answer has files, name existing files inside your own tree or work directory as relative paths, never ref IDs or paths outside it.',
  ].join('\n');
}

// The last ```json fence; a bare ``` fence is not an answer block.
const JSON_FENCE = /```json[^\S\n]*\n([\s\S]*?)\n?```/g;

/** Last fenced JSON block, else the final message as JSON, else its last complete JSON value. */
function answerValue(body: string): unknown {
  let last: string | undefined;
  for (const m of body.matchAll(JSON_FENCE)) last = m[1];
  if (last !== undefined) return JSON.parse(last.trim());
  try {
    return JSON.parse(body.trim());
  } catch {
    // Run 3's Codex final was valid bare JSON after prose. Scan complete top-level values,
    // skipping whole containers/strings so nested values cannot become accidental answers.
    // Guard: expeditions-v1-executor, exact run-3 answer shapes and truncated containers.
    let found: { value: unknown } | undefined;
    for (let i = 0; i < body.length; i++) {
      const start = i;
      const ch = body[i];
      if (i > 0 && /[\w]/.test(body[i - 1])) continue;
      if (ch === '{' || ch === '[' || ch === '"') {
        const stack: string[] = ch === '"' ? [] : [ch === '{' ? '}' : ']'];
        let quoted = ch === '"';
        let escaped = false;
        for (i++; i < body.length; i++) {
          const c = body[i];
          if (quoted) {
            if (escaped) escaped = false;
            else if (c === '\\') escaped = true;
            else if (c === '"') {
              quoted = false;
              if (stack.length === 0) break;
            }
          } else if (c === '"') quoted = true;
          else if (c === '{' || c === '[') stack.push(c === '{' ? '}' : ']');
          else if (c === '}' || c === ']') {
            if (c !== stack.pop()) break;
            if (stack.length === 0) break;
          }
        }
      } else {
        const token =
          /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)(?![\w.])/.exec(
            body.slice(i)
          );
        if (!token) continue;
        i += token[0].length - 1;
      }
      try {
        found = { value: JSON.parse(body.slice(start, i + 1)) };
      } catch {}
    }
    if (found) return found.value;
    throw new Error('no complete JSON value');
  }
}

const malformed = (why: string): RawOutcome => ({ t: 'errored', why: `malformed answer: ${why}` });

/** A JSON value checked against a JSON Schema, then read as an outcome. */
const bySchema =
  (schema: unknown, read: (value: unknown) => RawOutcome) =>
  (value: unknown): RawOutcome => {
    const checked = checkOutput(schema, value);
    return checked.t === 'valid' ? read(value) : malformed(checked.why);
  };

/** A leader's act. A rewrite names exactly the wake's draft plan file; relative paths are read
 * from its draft directory. The directory itself is never a plan input. */
function actOf(value: unknown, folder: string): RawOutcome {
  const act = keyed.LeaderAct.safeParse(value);
  if (!act.success) return malformed(`not a leader act: ${act.error.message}`);
  if (act.data.t === 'continue' && act.data.why.trim() === '')
    return malformed('a continue needs a reason in "why"');
  if (act.data.t !== 'rewrite') return { t: 'ok', out: act.data };
  const named = path.resolve(folder, act.data.file);
  if (named !== path.resolve(folder, 'plan.expedition.ts'))
    return malformed(`the rewrite names ${act.data.file}, not its draft folder ${folder}`);
  return { t: 'ok', out: { ...act.data, file: path.resolve(folder, 'plan.expedition.ts') } };
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
    value = answerValue(body);
  } catch (e) {
    return malformed(
      `not JSON (${(e as Error).message}); excerpt ${JSON.stringify(body.trim().slice(0, 160))}`
    );
  }
  return (OUTCOME[expected.t] as (v: unknown, e: Expected) => RawOutcome)(value, expected);
}

const inside = (root: string, file: string) => {
  const relative = path.relative(root, file);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

/** Read at the boundary, before the worktree is released. Report.files stays ordinary paths;
 * lexical and real paths must both be inside this call, so symlinks cannot export outside files.
 * Guard: expeditions-v1-executor (absolute, traversal, symlink and missing file answers). */
// Pattern: parse-dont-validate (docs/patterns.md#parse-dont-validate)
export async function readAnswer(
  expected: Expected,
  body: string,
  directory: string
): Promise<RawOutcome> {
  const outcome = outcomeOf(expected, body);
  if (outcome.t !== 'ok' || expected.t !== 'typed') return outcome;
  const out = outcome.out;
  if (typeof out !== 'object' || out === null || !('files' in out)) return outcome;
  if (!Array.isArray(out.files) || !out.files.every((f) => typeof f === 'string'))
    return malformed('files must be paths inside this call');
  const root = await realpath(directory);
  const files: string[] = [];
  for (const file of out.files as string[]) {
    const absolute = path.resolve(directory, file);
    if (!file.trim() || !inside(path.resolve(directory), absolute))
      return malformed(
        `file ${JSON.stringify(file)} is outside this call's directory ${directory}`
      );
    try {
      if (!inside(root, await realpath(absolute)))
        return malformed(
          `file ${JSON.stringify(file)} resolves outside this call's directory ${directory}`
        );
      if (!(await stat(absolute)).isFile())
        return malformed(`file ${JSON.stringify(file)} is not a file`);
    } catch {
      return malformed(
        `file ${JSON.stringify(file)} does not exist in this call's directory ${directory}`
      );
    }
    files.push(path.relative(directory, absolute));
  }
  return { t: 'ok', out: { ...out, files } };
}
