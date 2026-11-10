// Plan version 1: the leader's rewrite at the 50% budget wake. See REWRITE.md for why and the diff.
// Changed lines are marked `// v1`.
import { z } from 'zod';
import {
  buddy,
  check,
  need,
  parallel,
  passed,
  plan,
  review,
  role,
  seat,
  steps,
} from '../../expedition';

const OUT = 'business/research/2026-11-10_gtm';
const Org = z.object({
  id: z.string(),
  name: z.string(),
  segment: z.enum(['rl-data', 'design-partner']),
  kind: z.enum(['direct', 'substitute', 'comparator']),
});
// v1: where practitioners complain in public. Each is one bounded search with a stop rule.
const THREADS = [
  {
    id: 'rl-forums',
    where: 'r/reinforcementlearning, r/MachineLearning, Hacker News',
    about: 'buying or outsourcing RL environments and evals',
  },
  {
    id: 'vendor-work',
    where: 'r/LocalLLaMA and threads about working for Mercor, Outlier, DataAnnotation',
    about: 'task quality and what the labs reject',
  },
  {
    id: 'cfd-forums',
    where: 'cfd-online.com, r/CFD, Eng-Tips',
    about: 'license cost and workflow pain in hull and foil CFD',
  },
  {
    id: 'naval-forums',
    where: 'boatdesign.net, r/navalarchitecture, r/foiling',
    about: 'which design tools people use and why they give up on them',
  },
];

const judge = seat('gemini', 'gemini-3.1-pro-preview', 'high');
const lead = role({ by: buddy('market-research'), usd: 8, minutes: 45 }).reads('business/');
const scout = role({
  by: seat('claude', 'claude-sonnet-5-5', 'medium'),
  usd: 1.5,
  minutes: 15,
}).web();
const critic = role({ by: seat('codex', 'gpt-6.1-sol', 'high'), usd: 4, minutes: 30 });

const { scope, collect, mine, thesis, attack, revise, packet } = steps({
  scope: lead.lists(Org),
  collect: scout.checkout().judged(check('python tools/gtm/anchors.py {{id}}')),
  mine: scout.checkout().judged(check('python tools/gtm/anchors.py {{id}}')), // v1
  thesis: lead.judged(review('traceable', judge)),
  attack: critic.judged(review('real-counterexample', judge)),
  revise: lead.judged(review('traceable', judge)),
  packet: lead.checkout().judged(check(`python tools/gtm/audit_ledger.py ${OUT}`)),
});

export default plan(async (x) => {
  const orgs = need(await x.phase('scope', () => scope()), 'No list of organizations.');
  const studied = orgs.out.filter((org) => org.kind !== 'comparator'); // v1: comparators taught us nothing about demand

  const found = await x.phase('collect', () => parallel(studied, (org) => collect({ item: org }))); // v1: `studied`
  const voices = await x.phase('mine', () => parallel(THREADS, (thread) => mine({ item: thread }))); // v1
  const sources = [...passed(found), ...passed(voices)]; // v1
  await x.review('Is the coverage enough to argue from, or is a kind of source missing?');

  let current = need(
    await x.phase('synthesize', () => thesis({ reads: sources })),
    'No traceable thesis.'
  );

  await x.phase('duel', async () => {
    for (const round of [1, 2, 3]) {
      const hit = await attack({ id: round, reads: [current] });
      if (hit.t !== 'passed') continue;
      current = need(
        await revise({ id: round, reads: [current, hit], continues: current }),
        `No thesis survived round ${round}.`
      );
    }
  });
  await x.review('Did the thesis hold, bend or die? Stopping with "no thesis" is a valid result.');

  return need(
    await x.phase('packet', () => packet({ reads: [current, ...sources] })),
    'The packet failed its ledger audit.'
  );
});
