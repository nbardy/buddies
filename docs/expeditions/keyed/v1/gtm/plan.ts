// Plan version 0, as launched.
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
} from '../expedition';

const OUT = 'business/research/2026-11-10_gtm';
const Org = z.object({
  id: z.string(),
  name: z.string(),
  segment: z.enum(['rl-data', 'design-partner']),
  kind: z.enum(['direct', 'substitute', 'comparator']),
});

// The judge sits on a third provider, so it shares neither the lead's nor the critic's biases.
const judge = seat('gemini', 'gemini-3.1-pro-preview', 'high');
const lead = role({ by: buddy('market-research'), usd: 8, minutes: 45 }).reads('business/');
const scout = role({
  by: seat('claude', 'claude-sonnet-5-5', 'medium'),
  usd: 1.5,
  minutes: 15,
}).web();
const critic = role({ by: seat('codex', 'gpt-6.1-sol', 'high'), usd: 4, minutes: 30 });

const { scope, collect, thesis, attack, revise, packet } = steps({
  scope: lead.lists(Org),
  collect: scout.checkout().judged(check('python tools/gtm/anchors.py {{id}}')),
  thesis: lead.judged(review('traceable', judge)),
  attack: critic.judged(review('real-counterexample', judge)),
  revise: lead.judged(review('traceable', judge)),
  packet: lead.checkout().judged(check(`python tools/gtm/audit_ledger.py ${OUT}`)),
});

export default plan(async (x) => {
  const orgs = need(await x.phase('scope', () => scope()), 'No list of organizations.');

  const found = await x.phase('collect', () => parallel(orgs.out, (org) => collect({ item: org })));
  const sources = passed(found);
  await x.review('Is the coverage enough to argue from, or is a kind of source missing?');

  let current = need(
    await x.phase('synthesize', () => thesis({ reads: sources })),
    'No traceable thesis.'
  );

  await x.phase('duel', async () => {
    for (const round of [1, 2, 3]) {
      const hit = await attack({ id: round, reads: [current] });
      if (hit.t !== 'passed') continue; // no real, sourced, new counterexample this round
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
