import { keyed } from '@unleashd/shared';
import { z } from 'zod';
import { askedAbout } from '../../expedition-kernel/done';
import type { ExpeditionView } from '../../expedition-kernel/ports';
import { refFilesOf } from '../executor/refs';

// What the owner is shown of a candidate they are asked to accept (F5 of CONNECT_PLAN §10): the
// ask names it by an opaque ref (`rank@<64 hex>`), so the post and the view carry its summary and
// the path of its answer file instead. One function builds both, from the stored output.

const EXCERPT_MAX = 600;
/** The standard report (`summary` + `files`, authoring `report`): its summary is the text. */
const REPORT = z.object({ summary: z.string().min(1) }).passthrough();

const bounded = (text: string): string =>
  text.length <= EXCERPT_MAX ? text : `${text.slice(0, EXCERPT_MAX).trimEnd()}…`;

/** A report's summary, else a bounded excerpt of the typed answer rendered as text. */
export function summaryOf(out: unknown): string {
  const report = REPORT.safeParse(out);
  if (report.success) return bounded(report.data.summary);
  return bounded(typeof out === 'string' ? out : (JSON.stringify(out, null, 2) ?? String(out)));
}

export const describeCandidate = (
  ref: keyed.RefId,
  out: unknown,
  answerPath: string
): Extract<keyed.AskAbout, { t: 'candidate' }> => ({
  t: 'candidate',
  ref,
  summary: summaryOf(out),
  answerPath,
});

/** The lines an ask post adds under its question; nothing for an ask about nothing. */
export const ABOUT_LINES: {
  readonly [K in keyed.AskAbout['t']]: (a: Extract<keyed.AskAbout, { t: K }>) => string[];
} = {
  nothing: () => [],
  candidate: (a) => ['', 'Summary:', a.summary, '', `Full answer: ${a.answerPath}`],
};

/** What each ask's question is about, from the expedition's logged outputs. A candidate the kernel
 * names has settled with an output; one that has not is a broken invariant, not a blank. */
export const aboutIn =
  (view: ExpeditionView) =>
  (question: string): keyed.AskAbout => {
    const about = askedAbout(question);
    if (about.t === 'nothing') return about;
    for (const byHash of view.state.calls.values())
      for (const [hash, r] of byHash) {
        if (keyed.refOf(r.call.key, hash) !== about.ref || r.status.t !== 'settled') continue;
        const o = r.status.outcome;
        if (o.t === 'passed' || o.t === 'failed')
          return describeCandidate(about.ref, o.out, refFilesOf(view.dir, about.ref).answer);
      }
    throw new Error(`candidate ${about.ref} has no output in ${view.id}`);
  };
