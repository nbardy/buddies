// The keyed owner thread’s commands and yes/no answers. Unrecognised text becomes a note.
// Pattern: sum-types (docs/patterns.md#sum-types): parsed once here; nothing downstream re-reads
// the text.

export type OwnerWord =
  | { readonly t: 'pause' }
  | { readonly t: 'resume' }
  | { readonly t: 'stop' }
  /** `extend 2h` / `extend 30m`; a duration outside (0, 72] h is talk. */
  | { readonly t: 'extend'; readonly hours: number }
  /** `retry <key>`: the key keeps its case (keys are `phase/step/id`). */
  | { readonly t: 'retry'; readonly key: string }
  | { readonly t: 'approve' }
  | { readonly t: 'decline' }
  /** `note: <text>`, the text at most 2,000 characters. */
  | { readonly t: 'note'; readonly text: string }
  | { readonly t: 'talk' };

const WORDS: Readonly<Record<string, OwnerWord>> = {
  pause: { t: 'pause' },
  resume: { t: 'resume' },
  stop: { t: 'stop' },
  approve: { t: 'approve' },
  decline: { t: 'decline' },
};
const TALK: OwnerWord = { t: 'talk' };
const MAX_EXTEND_HOURS = 72;

/** Lowercased, trimmed, without trailing `.` or `!`. */
const said = (body: string) =>
  body
    .trim()
    .toLowerCase()
    .replace(/[.!]+$/, '');

export function ownerWord(body: string): OwnerWord {
  const trimmed = body.trim();
  const note = /^note:?\s+(\S[\s\S]*)$/i.exec(trimmed);
  if (note) return { t: 'note', text: (note[1] as string).slice(0, 2000) };
  const retry = /^retry:?\s+(\S+)$/i.exec(trimmed);
  if (retry) return { t: 'retry', key: retry[1] as string };
  const word = said(body);
  const extend = /^extend:?\s*(\d+(?:\.\d+)?)\s*(h|m)$/.exec(word);
  if (extend) {
    const hours = Number(extend[1]) / (extend[2] === 'm' ? 60 : 1);
    return hours > 0 && hours <= MAX_EXTEND_HOURS ? { t: 'extend', hours } : TALK;
  }
  return Object.hasOwn(WORDS, word) ? (WORDS[word] as OwnerWord) : TALK;
}

/** An answer to a yes-or-no question. Anything but these words is `unclear`, and the host asks
 * again rather than guess. */
export type YesNo = { readonly t: 'yes' } | { readonly t: 'no' } | { readonly t: 'unclear' };
export const YES_WORDS = [
  'yes',
  'y',
  'yeah',
  'yep',
  'ok',
  'okay',
  'confirm',
  'confirmed',
  'approve',
  'approved',
  'accept',
  'accepted',
  'pass',
  'true',
] as const;
export const NO_WORDS = [
  'no',
  'n',
  'nope',
  'nah',
  'decline',
  'declined',
  'reject',
  'rejected',
  'fail',
  'false',
] as const;
const YES_NO = new Map<string, YesNo>([
  ...YES_WORDS.map((w) => [w, { t: 'yes' }] as const),
  ...NO_WORDS.map((w) => [w, { t: 'no' }] as const),
]);

export function yesNo(body: string): YesNo {
  return YES_NO.get(said(body)) ?? { t: 'unclear' };
}
