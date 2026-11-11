import { keyed } from '@unleashd/shared';
import { parse as parseYaml } from 'yaml';

// κ for the owner's contract.md: YAML frontmatter + the prose under `# Goal`, parsed once into the
// canonical `Contract`. Every problem is collected with the field path it belongs to; nothing is
// defaulted, so a typo (`dones:`) cannot silently drop a criterion.
// Pattern: one parse at the boundary (docs/patterns.md#sum-types)

export type ParsedContract =
  | { t: 'ok'; contract: keyed.Contract }
  | { t: 'invalid'; issues: string[] };

const KNOWN_KEYS = [
  'leader',
  'repo',
  'budget',
  'autoApply',
  'leaderWake',
  'doneReview',
  'pools',
  'rules',
  'done',
] as const;

// The cap of one leader wake or done review when the contract names none, ONE rule:
//   usd     = min(budget.usd, clamp(10% of budget.usd, $0.25, $1.00))
//   minutes = min(budget.hours * 60, clamp(10% of budget.hours * 60, 5, 20))
// The real run (2026-11-11) paid $0.039 and 12 s for a wake, so the $0.25 floor is ~6x a real wake
// and a cap that ends a turn is rare; the 10% share keeps a bigger budget's wakes proportionate
// (a $3 budget reserves $0.30 per wake, not the $2 that held most of it); the $1 ceiling stops a
// large budget reserving an agent-sized sum per wake. Never above what the budget itself allows.
const WAKE_USD = { share: 0.1, floor: 0.25, ceiling: 1 } as const;
const WAKE_MINUTES = { share: 0.1, floor: 5, ceiling: 20 } as const;
const clamp = (x: number, r: { floor: number; ceiling: number }) =>
  Math.min(r.ceiling, Math.max(r.floor, x));
const cents = (x: number) => Math.round(x * 100) / 100;
/** A cap as the `max` of the call it bounds. */
export const maxOfCap = (c: keyed.Cap): keyed.Max => ({ usd: c.usd, minutes: c.minutes });
export function defaultCap(budget: keyed.Budget): keyed.Cap {
  const budgetMinutes = budget.hours * 60;
  return {
    t: 'defaulted',
    usd: cents(Math.min(budget.usd, clamp(budget.usd * WAKE_USD.share, WAKE_USD))),
    minutes: Math.min(budgetMinutes, clamp(budgetMinutes * WAKE_MINUTES.share, WAKE_MINUTES)),
  };
}

const isRecord = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x);

const FRONTMATTER = /^---\n(?:([\s\S]*?)\n)?---[ \t]*(?:\n([\s\S]*))?$/;

/** `~/x` becomes `<home>/x`. Kept out of parseContract so the parse stays pure. */
export function expandHome(path: string, home: string): string {
  if (path === '~') return home;
  return path.startsWith('~/') ? `${home.replace(/\/+$/, '')}/${path.slice(2)}` : path;
}

export function parseContract(markdown: string): ParsedContract {
  const issues: string[] = [];
  const text = markdown.replace(/\r\n/g, '\n');
  const m = FRONTMATTER.exec(text);
  if (!m) {
    return {
      t: 'invalid',
      issues: ['frontmatter: the file must start with a `---` line and close it with another'],
    };
  }
  const front = parseFrontmatter(m[1] ?? '', issues);
  const goal = parseGoal(m[2] ?? '', issues);

  // Top-level keys whose own parse already reported; Zod's follow-up on them would only repeat it.
  const reported = new Set<string>();
  if (goal === undefined) reported.add('goal');

  for (const key of Object.keys(front)) {
    if (!(KNOWN_KEYS as readonly string[]).includes(key)) {
      issues.push(`${key}: unknown key (expected one of ${KNOWN_KEYS.join(', ')})`);
    }
  }
  const done = parseDone(front.done, issues);
  if (done === undefined) reported.add('done');

  const candidate = {
    ...front,
    goal,
    done,
    leaderWake: capOf(front.leaderWake, front.budget),
    doneReview: capOf(front.doneReview, front.budget),
  };
  const canonical = keyed.Contract.safeParse(candidate);
  if (!canonical.success) {
    for (const issue of canonical.error.issues) {
      const top = issue.path[0];
      if (typeof top === 'string' && reported.has(top)) continue;
      // Zod reports an unknown key on the parent; ours is already named above.
      if (issue.path.length === 0 && issue.code === 'unrecognized_keys') continue;
      issues.push(`${pathString(issue.path)}: ${issue.message}`);
    }
  }
  return issues.length > 0 || !canonical.success
    ? { t: 'invalid', issues }
    : { t: 'ok', contract: canonical.data };
}

/** The owner's `{usd, minutes}` as a `given` cap, or the rule's `defaulted` one when the key is
 * absent. A malformed budget is left to Zod's report on `budget`, so no cap is guessed from it. */
function capOf(raw: unknown, budget: unknown): unknown {
  if (raw !== undefined) return isRecord(raw) ? { t: 'given', ...raw } : raw;
  const b = keyed.Budget.safeParse(budget);
  return b.success ? defaultCap(b.data) : undefined;
}

function parseFrontmatter(yamlText: string, issues: string[]): Record<string, unknown> {
  try {
    const value: unknown = parseYaml(yamlText);
    if (isRecord(value)) return value;
    issues.push('frontmatter: must be a YAML mapping of keys');
  } catch (e) {
    issues.push(`frontmatter: not valid YAML (${(e as Error).message.split('\n')[0]})`);
  }
  return {};
}

/** The prose under `# Goal`, up to the next `## ` heading or the end of the file. */
function parseGoal(body: string, issues: string[]): string | undefined {
  const lines = body.split('\n');
  const start = lines.findIndex((l) => /^# Goal\s*$/.test(l));
  if (start < 0) {
    issues.push('goal: the file has no `# Goal` section');
    return undefined;
  }
  const rest = lines.slice(start + 1);
  const next = rest.findIndex((l) => /^## /.test(l));
  const goal = (next < 0 ? rest : rest.slice(0, next)).join('\n').trim();
  if (goal === '') {
    issues.push('goal: the `# Goal` section is empty');
    return undefined;
  }
  return goal;
}

/** The three done shapes, as written: `{check}`, `{review: {rubric, by}}`, `{owner}`. */
function parseDone(raw: unknown, issues: string[]): keyed.Criterion[] | undefined {
  if (!Array.isArray(raw)) {
    // A missing `done` is reported here, once: Zod would say the same under a different wording.
    issues.push('done: must be a list of {check}, {review} or {owner} items');
    return undefined;
  }
  const before = issues.length;
  const out: keyed.Criterion[] = [];
  raw.forEach((item, i) => {
    const c = parseCriterion(item, `done[${i}]`, issues);
    if (c !== undefined) out.push(c);
  });
  return issues.length === before ? out : undefined;
}

const CRITERION_KINDS = ['check', 'review', 'owner'] as const;

function parseCriterion(item: unknown, at: string, issues: string[]): keyed.Criterion | undefined {
  if (!isRecord(item)) {
    issues.push(`${at}: must be a mapping with exactly one of check, review, owner`);
    return undefined;
  }
  const keys = Object.keys(item);
  const kinds = keys.filter((k) => (CRITERION_KINDS as readonly string[]).includes(k));
  const stray = keys.filter((k) => !kinds.includes(k));
  if (stray.length > 0) issues.push(`${at}: unknown key ${stray.join(', ')}`);
  if (kinds.length !== 1) {
    issues.push(
      `${at}: must have exactly one of check, review, owner (found ${kinds.length === 0 ? 'none' : kinds.join(' and ')})`
    );
    return undefined;
  }
  if (stray.length > 0) return undefined;
  const kind = kinds[0] as (typeof CRITERION_KINDS)[number];
  const value = item[kind];
  if (kind === 'review') return parseReview(value, `${at}.review`, issues);
  if (typeof value !== 'string' || value.trim() === '') {
    issues.push(`${at}.${kind}: must be a non-empty string`);
    return undefined;
  }
  return kind === 'check' ? { t: 'check', command: value } : { t: 'owner', question: value };
}

function parseReview(value: unknown, at: string, issues: string[]): keyed.Criterion | undefined {
  if (!isRecord(value)) {
    issues.push(`${at}: must be { rubric, by }`);
    return undefined;
  }
  const before = issues.length;
  for (const k of Object.keys(value)) {
    if (k !== 'rubric' && k !== 'by') issues.push(`${at}: unknown key ${k}`);
  }
  const { rubric, by } = value;
  if (typeof rubric !== 'string' || rubric.trim() === '')
    issues.push(`${at}.rubric: must be a non-empty string`);
  const seat = typeof by === 'string' ? parseSeat(by, `${at}.by`, issues) : undefined;
  if (typeof by !== 'string') issues.push(`${at}.by: must be a string 'provider/model/effort'`);
  if (issues.length !== before || typeof rubric !== 'string' || seat === undefined)
    return undefined;
  return { t: 'review', rubric, by: seat };
}

function parseSeat(by: string, at: string, issues: string[]): keyed.Seat | undefined {
  const parts = by.split('/');
  if (parts.length !== 3 || parts.some((p) => p.trim() === '')) {
    issues.push(`${at}: '${by}' must be three non-empty parts 'provider/model/effort'`);
    return undefined;
  }
  const [provider, model, effort] = parts as [string, string, string];
  return keyed.Seat.parse({ t: 'seat', provider, model, effort });
}

function pathString(path: readonly (string | number)[]): string {
  if (path.length === 0) return 'contract';
  return path.reduce<string>(
    (s, k) => (typeof k === 'number' ? `${s}[${k}]` : s === '' ? k : `${s}.${k}`),
    ''
  );
}
