import type { AttemptSpec, EndOutcome, Feedback } from './model';
import { CheckResult, EXTEND_MAX_HOURS, ManagerResult, WorkResult } from './model';

// κ for what the crew and the owner write back, once, at observation (host.ts): an attempt's
// answer becomes its EndOutcome (design.md R11), an owner chat message becomes Feedback. Nothing
// downstream re-parses either.

/** Longest owner text kept per chat message (the steer tool's own limit). */
const CHAT_TEXT_MAX = 2000;

/**
 * An owner chat message as steering (κ, once, at observation; host.ts observeChat): the word
 * pause, resume or stop alone (resume re-plans, R11); `extend 3h` moves the deadline; `lesson: …`
 * a binding lesson every later brief carries; anything else a note the next manager reads (it
 * also answers a pending "needs you"). An `extend` outside 0–72 hours is kept as a note, so the
 * manager and the page show it, never silently clamped.
 */
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

/** Where an answer's result was read from: its last fenced block (with any text after it), or a
 * bare object that ends the answer. */
type Found =
  | { t: 'fence'; json: Json; after: string }
  | { t: 'bare'; json: Json }
  | { t: 'none'; error: string };

/**
 * The answer's result (design.md R11): a bare top-level JSON object that ends the answer after
 * the last fenced ```json block (or with no fence at all), else that last fenced block. A bare
 * final object wins over an earlier fence: 2026-11-01 review, an answer quoting a fenced snippet
 * (a config it edited, a worker's result) and ending with its own bare result parsed the snippet,
 * and lost the repair turn on it. 2026-11-01 incident: a manager answered `{"actions":[…]}` with
 * no fence and the decision was dropped. The schema check after this is unchanged and strict.
 */
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

const isObject = (j: Json) => j.ok && typeof j.value === 'object' && j.value !== null;

/**
 * The bare JSON object that ends `text` (absent: none). It starts at a `{` that opens a line; the
 * first such line whose suffix parses as one object wins, so the object is the longest one. Line
 * starts only: trying every `{` re-parsed the suffix from each brace, quadratic on a large
 * brace-heavy answer (2026-11-01 review).
 */
function trailingObject(text: string): Json | undefined {
  const trimmed = text.trimEnd();
  if (!trimmed.endsWith('}')) return undefined;
  for (const m of trimmed.matchAll(/^[ \t]*\{/gm)) {
    const tried = parsed(trimmed.slice((m.index ?? 0) + m[0].length - 1));
    if (isObject(tried)) return tried;
  }
  return undefined;
}

export function parseOutcome(kind: AttemptSpec['kind'], body: string): EndOutcome {
  const found = findJson(body);
  const malformed = (error: string): EndOutcome => ({ t: 'malformed', error, raw: body });
  if (found.t === 'none') return malformed(found.error);
  if (!found.json.ok) return malformed(found.json.error);
  const value = found.json.value;
  switch (kind) {
    case 'manager': {
      const parsed = ManagerResult.safeParse(value);
      return parsed.success
        ? { t: 'manager', actions: parsed.data.actions }
        : malformed(parsed.error.message);
    }
    case 'work': {
      const parsed = WorkResult.safeParse(value);
      return parsed.success ? { t: 'work', result: parsed.data } : malformed(parsed.error.message);
    }
    case 'check': {
      const ambiguous = verdictAmbiguity(body, found);
      if (ambiguous) return malformed(ambiguous);
      const parsed = CheckResult.safeParse(value);
      return parsed.success ? { t: 'check', result: parsed.data } : malformed(parsed.error.message);
    }
  }
}

/**
 * A check's verdict must be explicit (ported from oompa's `explicit-approval?`): exactly one
 * verdict in the answer, and it ends the answer. Oompa incident (audit 2026-11-01): its queue
 * reviewer approved on any `\bAPPROVED\b`, so "NOT APPROVED" passed; its strict parse also
 * refuses a quoted example verdict followed by the real one, and prose after the verdict. Here
 * the enum already refuses "not verified" and plain prose; this refuses the other two shapes, in
 * fences and bare objects alike (every `"verdict":` key in the answer counts), so a panel vote
 * counts only an unambiguous final verdict. Returns why it is ambiguous (none: it is not).
 */
function verdictAmbiguity(body: string, found: Found): string | undefined {
  const verdicts = body.match(/"verdict"\s*:/g)?.length ?? 0;
  if (verdicts > 1) return `${verdicts} verdicts in the answer: give exactly one verdict`;
  if (found.t === 'fence' && found.after.trim() !== '')
    return 'text follows the verdict block: the verdict must end the answer';
  return undefined;
}
