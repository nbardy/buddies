import type { z } from 'zod';
import type { AttemptSpec, EndOutcome, Feedback } from './model';
import { CheckResult, EXTEND_MAX_HOURS, ManagerResult, WorkResult } from './model';

// κ, once, at observation (observe.ts): an attempt's answer becomes its EndOutcome (R11), an
// owner chat message becomes Feedback. Nothing downstream re-parses either.

/** Longest owner text kept per chat message (the steer tool's own limit). */
const CHAT_TEXT_MAX = 2000;

/** `pause`/`resume`/`stop` alone, `extend 3h`, `lesson: …`, else a note. An `extend` outside
 * 0–72 hours is kept as a note, never silently clamped. */
export function chatFeedback(body: string): Feedback {
  const text = body.trim().slice(0, CHAT_TEXT_MAX);
  const word = text.toLowerCase().replace(/[.!]+$/, '');
  if (word === 'pause' || word === 'resume' || word === 'stop') return { t: word };
  const extend = /^extend:?\s*(\d+(?:\.\d+)?)\s*(h|hours?)?$/i.exec(word);
  const hours = extend ? Number(extend[1]) : 0;
  if (extend && hours > 0 && hours <= EXTEND_MAX_HOURS) return { t: 'extend', hours };
  const lesson = /^lesson:\s*(\S[\s\S]*)$/i.exec(text);
  return lesson ? { t: 'lesson', text: lesson[1] } : { t: 'note', text };
}

const FENCE = /```json\s*([\s\S]*?)```/g;

type Json = { ok: true; value: unknown } | { ok: false; error: string };

type Found =
  | { t: 'fence'; json: Json; after: string }
  | { t: 'bare'; json: Json }
  | { t: 'none'; error: string };

/** A bare JSON object ending the answer after the last ```json fence wins over that fence.
 * 2026-11-01: a quoted fenced snippet was parsed instead of the bare result; a fenceless
 * `{"actions":[…]}` was dropped. */
function findJson(body: string): Found {
  const last = [...body.matchAll(FENCE)].at(-1);
  const tailStart = last ? (last.index ?? 0) + last[0].length : 0;
  const bare = trailingObject(body.slice(tailStart));
  if (bare) return { t: 'bare', json: bare };
  if (last) return { t: 'fence', json: parsed(last[1] ?? ''), after: body.slice(tailStart) };
  return { t: 'none', error: 'no ```json block or final JSON object' };
}

function parsed(text: string): Json {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return { ok: false, error: `invalid JSON: ${error instanceof Error ? error.message : error}` };
  }
}

/** The longest object ending `text`, tried from line-start `{` only (every `{` was quadratic). */
function trailingObject(text: string): Json | undefined {
  const trimmed = text.trimEnd();
  if (!trimmed.endsWith('}')) return undefined;
  for (const m of trimmed.matchAll(/^[ \t]*\{/gm)) {
    const tried = parsed(trimmed.slice((m.index ?? 0) + m[0].length - 1));
    if (tried.ok && typeof tried.value === 'object' && tried.value !== null) return tried;
  }
  return undefined;
}

export function parseOutcome(kind: AttemptSpec['kind'], body: string): EndOutcome {
  const found = findJson(body);
  const malformed = (error: string): EndOutcome => ({ t: 'malformed', error, raw: body });
  if (found.t === 'none') return malformed(found.error);
  if (!found.json.ok) return malformed(found.json.error);
  const value = found.json.value;
  const schema = <T>(r: z.SafeParseReturnType<unknown, T>, ok: (data: T) => EndOutcome) =>
    r.success ? ok(r.data) : malformed(r.error.message);
  switch (kind) {
    case 'manager':
      return schema(ManagerResult.safeParse(value), (r) => ({ t: 'manager', actions: r.actions }));
    case 'work':
      return schema(WorkResult.safeParse(value), (result) => ({ t: 'work', result }));
    case 'check': {
      const ambiguous = verdictAmbiguity(body, found);
      if (ambiguous) return malformed(ambiguous);
      return schema(CheckResult.safeParse(value), (result) => ({ t: 'check', result }));
    }
  }
}

/** Exactly one verdict, ending the answer (oompa incident: "NOT APPROVED" passed). */
function verdictAmbiguity(body: string, found: Found): string | undefined {
  const verdicts = body.match(/"verdict"\s*:/g)?.length ?? 0;
  if (verdicts > 1) return `${verdicts} verdicts in the answer: give exactly one verdict`;
  if (found.t === 'fence' && found.after.trim() !== '')
    return 'text follows the verdict block: the verdict must end the answer';
  return undefined;
}
