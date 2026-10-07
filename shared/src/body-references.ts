// Pattern: one-definition (docs/patterns.md#one-definition)
// Pattern: parse-dont-validate (docs/patterns.md#parse-dont-validate)
//
// The ONE interpretation of references in a channel post body, shared by the owner composer, the
// owner post route and the Buddy MCP `post` tool. A body is Markdown; a reference is a link with an
// app scheme:
//   `[@Name](buddy:<id>)`  a mention (starts that Buddy's turn)
//   `[Title](task:<id>)`   a Task chip
// A plain `@Name` is a mention only when it equals exactly ONE roster name (case-insensitive,
// longest name first, ending at a word boundary). Unknown and ambiguous names stay text: nothing
// here guesses a recipient. Code spans, fences, e-mail addresses and other links are never read.
//
// History (2026-10-06 → 10-08): the composer kept `@Label` text plus hidden picked snapshots, and the
// server resolved names on the Buddy path only, so a pasted `@Name` highlighted and mentioned nobody.
// Guards: client/test/composer-draft.test.ts, server/test/owner-mentions.test.ts.

/** Who a name can address: a Buddy or a Task. The server's roster holds Buddies only. */
export type NamedRef = { kind: 'buddy' | 'task'; id: string; name: string };

export type BodyPiece =
  | { kind: 'text'; raw: string }
  /** Code and links that are not references: never rewritten, never read for names. */
  | { kind: 'opaque'; raw: string }
  | { kind: 'buddy'; raw: string; id: string; label: string }
  | { kind: 'task'; raw: string; id: string; label: string };

const SPAN = /(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)|\[([^\]]*)\]\(([^)]*)\)/g;
const SCHEME = /^(buddy|task):([A-Za-z0-9_-]+)$/;

function linkPiece(raw: string, label: string, destination: string): BodyPiece {
  const scheme = SCHEME.exec(destination);
  if (!scheme) return { kind: 'opaque', raw };
  const id = scheme[2];
  if (scheme[1] === 'task') return { kind: 'task', raw, id, label };
  return label.length > 1 && label.startsWith('@')
    ? { kind: 'buddy', raw, id, label: label.slice(1) }
    : { kind: 'opaque', raw };
}

/** The body as ordered pieces; their `raw` strings concatenate back to the body. */
export function bodyPieces(body: string): BodyPiece[] {
  const pieces: BodyPiece[] = [];
  let cursor = 0;
  for (const span of body.matchAll(SPAN)) {
    const start = span.index ?? 0;
    if (start > cursor) pieces.push({ kind: 'text', raw: body.slice(cursor, start) });
    pieces.push(
      span[1] === undefined
        ? linkPiece(span[0], span[2], span[3])
        : { kind: 'opaque', raw: span[0] }
    );
    cursor = start + span[0].length;
  }
  if (cursor < body.length) pieces.push({ kind: 'text', raw: body.slice(cursor) });
  return pieces;
}

/** The Buddies a body mentions, by id, in order of first mention. */
export function mentionedIds(body: string): string[] {
  const ids = bodyPieces(body).flatMap((piece) => (piece.kind === 'buddy' ? [piece.id] : []));
  return [...new Set(ids)];
}

/** Whether a body @mentions a Buddy: its reply (or a notice) will land in the post's thread. */
export const mentionsABuddy = (body: string): boolean => mentionedIds(body).length > 0;

const stripBrackets = (name: string) => name.replace(/[[\]]/g, '');

export function referenceToken(ref: NamedRef): string {
  switch (ref.kind) {
    case 'buddy':
      return `[@${stripBrackets(ref.name)}](buddy:${ref.id})`;
    case 'task':
      return `[${stripBrackets(ref.name)}](task:${ref.id})`;
  }
}

// ── Names ──────────────────────────────────────────────────────────────────

// `@` at the start or after a character that cannot make it part of an e-mail/word/path.
const AT = /(^|[^\w@./-])@/g;
const WORD = /\w/;
// `@owner` addresses the human, who is not on the roster; it is not a failed Buddy mention.
const NOT_BUDDIES = new Set(['owner']);

export type NameHit = { start: number; end: number; ref: NamedRef };

export type NameScan = {
  hits: NameHit[];
  /** `@Token`s that matched no roster name. */
  unknown: string[];
  /** Names that matched more than one roster entry: left as text, the owner must pick. */
  ambiguous: string[];
};

/** The `@Name` spans of one run of prose that equal exactly one roster name. */
export function findNames(text: string, roster: readonly NamedRef[]): NameScan {
  // Longest name first, so `@Wave_sim CEO` never half-matches a shorter `Wave_sim`.
  const names = [...roster].sort((a, b) => b.name.length - a.name.length);
  const hits: NameHit[] = [];
  const unknown = new Set<string>();
  const ambiguous = new Set<string>();
  let last = 0;
  for (const hit of text.matchAll(AT)) {
    const at = (hit.index ?? 0) + hit[1].length;
    if (at < last) continue;
    const rest = text.slice(at + 1);
    const quoted = rest.startsWith('"') ? rest.indexOf('"', 1) : -1;
    const candidate = quoted > 0 ? rest.slice(1, quoted) : null;
    const found = names.find((ref) => {
      const n = ref.name.toLowerCase();
      if (candidate !== null) return candidate.toLowerCase() === n;
      return rest.slice(0, n.length).toLowerCase() === n && !WORD.test(rest[n.length] ?? '');
    });
    if (!found) {
      const token = /^[\w-]+/.exec(rest)?.[0];
      if (token && !NOT_BUDDIES.has(token.toLowerCase())) unknown.add(`@${token}`);
      continue;
    }
    const sameName = names.filter((ref) => ref.name.toLowerCase() === found.name.toLowerCase());
    if (sameName.length > 1) {
      ambiguous.add(`@${found.name}`);
      continue;
    }
    const length = candidate !== null ? quoted + 1 : found.name.length;
    hits.push({ start: at, end: at + 1 + length, ref: found });
    last = at + 1 + length;
  }
  return { hits, unknown: [...unknown], ambiguous: [...ambiguous] };
}

// ── Canonical body ─────────────────────────────────────────────────────────

export type Resolution = {
  /** The body in the stored contract: every reference a token carrying the current name. */
  body: string;
  mentioned: Array<{ id: string; name: string }>;
  unresolved: string[];
  ambiguous: string[];
};

/**
 * The stored form of a body. A Buddy token whose id is on the roster is rewritten with the Buddy's
 * CURRENT name (a rename never breaks a pasted mention). One whose id is not (archived, another
 * workspace, another install) dissolves to plain `@Label` text and is then read like any other
 * name — never trusted. Task tokens pass through. Plain exact names become tokens. Idempotent.
 */
export function resolveReferences(body: string, roster: readonly NamedRef[]): Resolution {
  const buddies = new Map(roster.filter((ref) => ref.kind === 'buddy').map((ref) => [ref.id, ref]));
  const mentioned = new Map<string, { id: string; name: string }>();
  const unresolved = new Set<string>();
  const ambiguous = new Set<string>();
  let out = '';
  let prose = '';

  const flush = () => {
    const scan = findNames(prose, roster);
    let cursor = 0;
    for (const { start, end, ref } of scan.hits) {
      out += prose.slice(cursor, start) + referenceToken(ref);
      cursor = end;
      if (ref.kind === 'buddy') mentioned.set(ref.id, { id: ref.id, name: ref.name });
    }
    out += prose.slice(cursor);
    for (const token of scan.unknown) unresolved.add(token);
    for (const name of scan.ambiguous) ambiguous.add(name);
    prose = '';
  };

  for (const piece of bodyPieces(body)) {
    switch (piece.kind) {
      case 'text':
        prose += piece.raw;
        break;
      case 'opaque':
      case 'task':
        flush();
        out += piece.raw;
        break;
      case 'buddy': {
        const current = buddies.get(piece.id);
        if (!current) {
          prose += `@${piece.label}`;
          break;
        }
        flush();
        mentioned.set(current.id, { id: current.id, name: current.name });
        out += referenceToken(current);
        break;
      }
    }
  }
  flush();
  return {
    body: out,
    mentioned: [...mentioned.values()],
    unresolved: [...unresolved],
    ambiguous: [...ambiguous],
  };
}
