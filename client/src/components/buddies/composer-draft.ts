/**
 * client/src/components/buddies/composer-draft.ts
 *
 * Pure rules for the channel composer's draft. Pure and CSS-free so mobile may import it.
 *
 * Pattern: one-definition (docs/patterns.md#one-definition) — the draft is ONE string, the post body in the
 * stored Markdown contract (shared/src/body-references.ts), so text and mention identity cannot
 * drift apart: there is no second "picked" list. The textarea shows a projection of it: a token
 * `[@Name](buddy:id)` is shown as `@Name`, an atom the owner edits as a unit until a keystroke
 * lands inside it, which dissolves only that token to plain text. Everything the composer needs —
 * highlight, chips, the @ trigger, copy/paste, the send body — reads this one `DraftView`.
 */
import {
  type ChannelComposerDraft,
  ChannelComposerDraftSchema,
  type ChannelReference,
  type NamedRef,
  bodyPieces,
  findNames,
  referenceToken,
  resolveReferences,
} from '@unleashd/shared';
import { type BuddyReference, activeReferenceQuery } from './channel-text';

// ── The view ───────────────────────────────────────────────────────────────

/** A reference in the DISPLAY text: written as a token (`token`) or typed as an exact name (`name`). */
export type DraftMark = {
  start: number;
  end: number;
  kind: 'buddy' | 'task';
  id: string;
  label: string;
  origin: 'token' | 'name';
};

type TokenRun = { rawStart: number; rawEnd: number; shownStart: number; shownEnd: number };

export type DraftView = {
  raw: string;
  display: string;
  marks: DraftMark[];
  tokens: TokenRun[];
};

export function rosterOf(references: readonly ChannelReference[]): NamedRef[] {
  return references.flatMap((reference): NamedRef[] =>
    reference.kind === 'buddy' ? [{ kind: 'buddy', id: reference.id, name: reference.label }] : []
  );
}

export function draftView(raw: string, roster: readonly NamedRef[]): DraftView {
  let display = '';
  let rawCursor = 0;
  const marks: DraftMark[] = [];
  const tokens: TokenRun[] = [];
  for (const piece of bodyPieces(raw)) {
    switch (piece.kind) {
      case 'text':
        for (const { start, end, ref } of findNames(piece.raw, roster).hits)
          marks.push({
            start: display.length + start,
            end: display.length + end,
            kind: ref.kind,
            id: ref.id,
            label: ref.name,
            origin: 'name',
          });
        display += piece.raw;
        break;
      case 'opaque':
        display += piece.raw;
        break;
      case 'buddy':
      case 'task': {
        const shown = `@${piece.label}`;
        const run = {
          rawStart: rawCursor,
          rawEnd: rawCursor + piece.raw.length,
          shownStart: display.length,
          shownEnd: display.length + shown.length,
        };
        tokens.push(run);
        marks.push({
          start: run.shownStart,
          end: run.shownEnd,
          kind: piece.kind,
          id: piece.id,
          label: piece.label,
          origin: 'token',
        });
        display += shown;
        break;
      }
    }
    rawCursor += piece.raw.length;
  }
  return { raw, display, marks, tokens };
}

/** The Buddies the draft mentions, in order, as the chips and the model picker show them. */
export function mentionedBuddies(
  view: DraftView,
  directory: readonly ChannelReference[]
): BuddyReference[] {
  const seen = new Set<string>();
  return view.marks.flatMap((mark): BuddyReference[] => {
    if (mark.kind !== 'buddy' || seen.has(mark.id)) return [];
    seen.add(mark.id);
    const known = directory.find((entry) => entry.kind === 'buddy' && entry.id === mark.id);
    // Not in the directory (still loading, or archived): the token still names the Buddy; the
    // server decides whether it can be addressed. Its model is unreported until the directory knows it.
    return [
      known?.kind === 'buddy'
        ? known
        : {
            kind: 'buddy',
            id: mark.id,
            label: mark.label,
            detail: '',
            execution: { kind: 'unreported' },
          },
    ];
  });
}

/** The body that is sent: the stored form for this roster (the server applies the same rule). */
export function sendBody(view: DraftView, roster: readonly NamedRef[]): string {
  return resolveReferences(view.raw, roster).body.trim();
}

/** Names that equal more than one Buddy: they stay text until picked from the @ menu. */
export function ambiguousNames(view: DraftView, roster: readonly NamedRef[]): string[] {
  return resolveReferences(view.raw, roster).ambiguous;
}

// ── Offsets and edits ──────────────────────────────────────────────────────

const insideToken = (view: DraftView, shown: number) =>
  view.tokens.find((run) => run.shownStart < shown && shown < run.shownEnd);

function rawOffset(view: DraftView, shown: number): number {
  let offset = shown;
  for (const run of view.tokens)
    if (run.shownEnd <= shown)
      offset += run.rawEnd - run.rawStart - (run.shownEnd - run.shownStart);
  return offset;
}

/** Where a raw offset sits in the display text (a caret after an edit). */
export function shownOffset(view: DraftView, raw: number): number {
  let offset = raw;
  for (const run of view.tokens)
    if (run.rawEnd <= raw) offset -= run.rawEnd - run.rawStart - (run.shownEnd - run.shownStart);
  return offset;
}

export type DraftEdit = { raw: string; caret: number };

/**
 * Replace display range [start, end) with `replacement` (raw Markdown). A boundary that lands
 * inside a token dissolves that token to the plain text the owner could see, so a partial delete of
 * `@Lead` leaves `@Lea`, not half a token. `caret` is the raw offset after the replacement.
 */
export function spliceDraft(
  view: DraftView,
  start: number,
  end: number,
  replacement: string
): DraftEdit {
  const startRun = insideToken(view, start);
  const endRun = insideToken(view, end);
  const prefix = startRun ? view.display.slice(startRun.shownStart, start) : '';
  const suffix = endRun ? view.display.slice(end, endRun.shownEnd) : '';
  const rawStart = startRun ? startRun.rawStart : rawOffset(view, start);
  const rawEnd = endRun ? endRun.rawEnd : rawOffset(view, end);
  return {
    raw: view.raw.slice(0, rawStart) + prefix + replacement + suffix + view.raw.slice(rawEnd),
    caret: rawStart + prefix.length + replacement.length,
  };
}

/**
 * The edit a textarea `input` event made, as a display range and its replacement. The caret the
 * browser reports after the edit pins the end of the change, so repeated characters ("@Lead@Lead")
 * cannot attribute a delete to the wrong neighbour.
 */
export function inputEdit(
  oldDisplay: string,
  newDisplay: string,
  caret: number
): { start: number; end: number; replacement: string } {
  const tail = newDisplay.slice(caret);
  let suffix = 0;
  if (caret >= 0 && caret <= newDisplay.length && oldDisplay.endsWith(tail)) suffix = tail.length;
  else
    while (
      suffix < Math.min(oldDisplay.length, newDisplay.length) &&
      oldDisplay[oldDisplay.length - 1 - suffix] === newDisplay[newDisplay.length - 1 - suffix]
    )
      suffix++;
  const room = Math.min(oldDisplay.length, newDisplay.length) - suffix;
  let start = 0;
  while (start < room && oldDisplay[start] === newDisplay[start]) start++;
  return {
    start,
    end: oldDisplay.length - suffix,
    replacement: newDisplay.slice(start, newDisplay.length - suffix),
  };
}

// ── The @ menu ─────────────────────────────────────────────────────────────

/**
 * The @-query under the caret. An `@` that already starts a token is a reference, not a query:
 * after a pick the menu closes (it stayed open and covered the model chip, 2026-09-24).
 */
export function activeTrigger(
  view: DraftView,
  caret: number
): { start: number; query: string } | null {
  const trigger = activeReferenceQuery(view.display, caret);
  if (!trigger) return null;
  return view.marks.some((mark) => mark.origin === 'token' && mark.start === trigger.start)
    ? null
    : trigger;
}

export function pickReference(
  view: DraftView,
  trigger: { start: number; query: string },
  reference: ChannelReference
): DraftEdit {
  const token = referenceToken({ kind: reference.kind, id: reference.id, name: reference.label });
  return spliceDraft(view, trigger.start, trigger.start + 1 + trigger.query.length, `${token} `);
}

// ── Clipboard ──────────────────────────────────────────────────────────────

// The same attribute marks a rendered mention (ChannelMarkdown) and a composer copy, so a copy from
// either carries local ids to a paste. Other apps' HTML has none: their text pastes as plain text.
export const REF_ATTRIBUTE = 'data-unleashd-ref';

const escapeHtml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const unescapeHtml = (text: string) =>
  text
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');

/** The selection as the clipboard gets it: readable text, and HTML that keeps whole references. */
export function copyPayload(
  view: DraftView,
  start: number,
  end: number
): { text: string; html: string } {
  const parts: string[] = [];
  const text = (from: number, to: number) => {
    if (to > from) parts.push(escapeHtml(view.display.slice(from, to)));
  };
  let cursor = start;
  for (const run of view.tokens) {
    if (run.shownEnd <= start || run.shownStart >= end) continue;
    text(cursor, Math.max(cursor, run.shownStart));
    const whole = run.shownStart >= start && run.shownEnd <= end;
    if (whole) {
      const mark = view.marks.find((m) => m.origin === 'token' && m.start === run.shownStart);
      if (mark)
        parts.push(
          `<a ${REF_ATTRIBUTE}="${mark.kind}:${escapeHtml(mark.id)}">${escapeHtml(view.display.slice(run.shownStart, run.shownEnd))}</a>`
        );
    } else text(Math.max(start, run.shownStart), Math.min(end, run.shownEnd));
    cursor = Math.min(end, run.shownEnd);
  }
  text(cursor, end);
  return {
    text: view.display.slice(start, end),
    html: `<span style="white-space:pre-wrap">${parts.join('')}</span>`,
  };
}

const ANCHOR = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
const REF_VALUE = new RegExp(`${REF_ATTRIBUTE}="(buddy|task):([A-Za-z0-9_-]+)"`, 'i');
// A rendered mention is a router link; some browsers drop unknown attributes, never the href.
const BUDDY_HREF = /href="(?:[^"]*\/)?buddies\/([A-Za-z0-9_-]+)"/i;

type HtmlRef = { kind: 'buddy' | 'task'; id: string; shown: string };

function referencesInHtml(html: string): HtmlRef[] {
  return [...html.matchAll(ANCHOR)].flatMap((anchor): HtmlRef[] => {
    const shown = unescapeHtml(anchor[2].replace(/<[^>]*>/g, ''));
    const attribute = REF_VALUE.exec(anchor[1]);
    if (attribute) return [{ kind: attribute[1] as HtmlRef['kind'], id: attribute[2], shown }];
    const href = BUDDY_HREF.exec(anchor[1]);
    return href && shown.startsWith('@') ? [{ kind: 'buddy', id: href[1], shown }] : [];
  });
}

/**
 * Pasted clipboard into the stored form. The plain text is the base (it is what every browser
 * would paste); each HTML reference, in order, claims the next occurrence of its shown text and
 * becomes a token with its LOCAL id. Then the roster rule runs: tokens are checked and renamed,
 * unknown ids dissolve, exact unique `@Name`s resolve, code and e-mail stay text.
 */
export function pastedBody(plain: string, html: string, roster: readonly NamedRef[]): string {
  let joined = '';
  let cursor = 0;
  for (const ref of referencesInHtml(html)) {
    const at = plain.indexOf(ref.shown, cursor);
    if (at < 0) continue;
    const label = ref.shown.replace(/^@/, '');
    joined += plain.slice(cursor, at) + referenceToken({ kind: ref.kind, id: ref.id, name: label });
    cursor = at + ref.shown.length;
  }
  return resolveReferences(joined + plain.slice(cursor), roster).body;
}

// ── Persistence ────────────────────────────────────────────────────────────

export type StoredDraft = Pick<ChannelComposerDraft, 'text' | 'mentionConfigs'>;

export const EMPTY_CHANNEL_DRAFT: StoredDraft = { text: '' };

/** Empty text stores '' so the draft hook deletes the key instead of keeping `{}`. */
export function encodeChannelDraft(draft: StoredDraft): string {
  return draft.text === '' ? '' : JSON.stringify(draft);
}

/**
 * A stored draft back into composer state. Local storage is outside the type system: a blob that
 * is not a draft (hand-edited, or an older shape) is discarded whole, the same policy as
 * atoms/ui.ts validatedStorage. A legacy draft (`picked` beside `@Label` text) folds its picks
 * into tokens here, once; the next save writes only the Markdown.
 */
export function decodeChannelDraft(stored: string): StoredDraft {
  if (stored === '') return EMPTY_CHANNEL_DRAFT;
  try {
    const parsed = ChannelComposerDraftSchema.safeParse(JSON.parse(stored));
    if (!parsed.success) return EMPTY_CHANNEL_DRAFT;
    const { text, picked, mentionConfigs } = parsed.data;
    if (!picked || picked.length === 0) return { text, mentionConfigs };
    const roster = new Map(
      picked.map((ref): [string, NamedRef] => [
        `${ref.kind}:${ref.id}`,
        { kind: ref.kind, id: ref.id, name: ref.label },
      ])
    );
    return { text: resolveReferences(text, [...roster.values()]).body, mentionConfigs };
  } catch {
    return EMPTY_CHANNEL_DRAFT;
  }
}
