import type { keyed } from '@unleashd/shared';
import { z } from 'zod';
import { renderBrief } from './brief';
import { maxOfCap } from './contract';
import type { Expedition } from './kernel';

// Only the host says "done" (DESIGN §1): it evaluates the contract's `done` on the plan's
// candidate itself, each criterion as a host call `done/<i>` in the log. A check is a command run
// on the candidate, a review an agent run on the rubric, the owner an ask, which holds nothing and
// may be answered after the deadline. Checks and reviews first, together; the owner only on a
// candidate that passed them.

// The owner's acceptance question names its candidate on a last line. `candidateQuestion` writes
// it and `askedAbout` reads it back: the one pair, so the host can show what the ref holds
// (owner/candidate.ts) without the ask call carrying a new field (a field would change the hash
// of every ask already in a log, and the log's hash check would refuse it).
const CANDIDATE_LINE = /\n\nCandidate: (\S+)$/;
export const candidateQuestion = (question: string, of: keyed.RefId): string =>
  `${question}\n\nCandidate: ${of}`;
export type AskedAbout =
  | { readonly t: 'nothing' }
  | { readonly t: 'candidate'; readonly ref: keyed.RefId };
export function askedAbout(question: string): AskedAbout {
  const m = CANDIDATE_LINE.exec(question);
  return m?.[1] ? { t: 'candidate', ref: m[1] } : { t: 'nothing' };
}

/** The gaps left, or `closed` if the expedition finished meanwhile. */
export async function evaluateDone(
  m: Expedition,
  candidate: keyed.RefId
): Promise<string[] | 'closed'> {
  const done = m.state().contract.done.map((c, i) => ({ c, i }));
  const machine = await Promise.all(
    done.filter(({ c }) => c.t !== 'owner').map(({ c, i }) => criterion(m, c, i, candidate))
  );
  if (machine.includes('closed')) return 'closed';
  const gaps = machine.flat() as string[];
  if (gaps.length > 0) return gaps;
  const owner = await Promise.all(
    done.filter(({ c }) => c.t === 'owner').map(({ c, i }) => criterion(m, c, i, candidate))
  );
  return owner.includes('closed') ? 'closed' : (owner.flat() as string[]);
}

/** One criterion as a host call (`done/<i>`); the gaps it leaves. */
async function criterion(
  m: Expedition,
  c: keyed.Criterion,
  i: number,
  candidate: keyed.RefId
): Promise<string[] | 'closed'> {
  const built = CRITERION[c.t](c as never, `done/${i}`, candidate, m);
  if (built.t === 'gap') return [built.why];
  const d = await m.hostCall(() => built.call);
  if (d.t === 'closed') return 'closed';
  return GAPS[d.outcome.t](d.outcome as never, c);
}

type Built =
  | { readonly t: 'call'; readonly call: keyed.Call }
  | { readonly t: 'gap'; readonly why: string };
const CRITERION: {
  [K in keyed.Criterion['t']]: (
    c: Extract<keyed.Criterion, { t: K }>,
    key: keyed.Key,
    of: keyed.RefId,
    m: Expedition
  ) => Built;
} = {
  check: (c, key, of, m) => ({
    t: 'call',
    call: {
      t: 'verdict',
      key,
      of,
      verdict: { t: 'check', command: c.command },
      pools: [],
      max: maxOfCap(m.state().contract.doneReview),
    },
  }),
  review: (c, key, of, m) => {
    const brief = renderBrief(m.planDir(m.version()), c.rubric, {}, m.state().contract.rules);
    if (brief.t === 'invalid')
      return { t: 'gap', why: `review ${c.rubric}: ${brief.issues.join('; ')}` };
    return {
      t: 'call',
      call: {
        t: 'verdict',
        key,
        of,
        verdict: { t: 'review', rubric: c.rubric, by: c.by, brief: brief.text },
        pools: [c.by.provider],
        max: maxOfCap(m.state().contract.doneReview),
      },
    };
  },
  // The candidate is in the question, so a new candidate is a new question, never a reused yes.
  owner: (c, key, of) => ({
    t: 'call',
    call: { t: 'ask', key, question: candidateQuestion(c.question, of), answer: 'confirm' },
  }),
};

const nameOf = (c: keyed.Criterion): string =>
  c.t === 'check'
    ? `check \`${c.command}\``
    : c.t === 'review'
      ? `review ${c.rubric}`
      : `owner: ${c.question}`;
const GAPS: {
  [K in keyed.Outcome['t']]: (o: Extract<keyed.Outcome, { t: K }>, c: keyed.Criterion) => string[];
} = {
  passed: (o, c) => {
    if (c.t !== 'owner') return [];
    const yes = z.boolean().safeParse(o.out);
    if (!yes.success) return [`${nameOf(c)}: the answer is not yes or no`];
    return yes.data ? [] : [`${nameOf(c)}: the owner said no`];
  },
  failed: (o, c) => [`${nameOf(c)}: failed: ${o.why}`],
  errored: (o, c) => [`${nameOf(c)}: errored: ${o.why}`],
  cancelled: (_o, c) => [`${nameOf(c)}: cancelled`],
  refused: (o, c) => [`${nameOf(c)}: refused (${o.reason})`],
};
