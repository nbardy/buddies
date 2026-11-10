import { z } from 'zod';
import {
  buddy,
  check,
  checkout,
  gap,
  passed,
  plan,
  review,
  role,
  seat,
  steps,
  usd,
  wide,
} from '../../api/expedition';

const OUT = 'business/research/2026-11-10_gtm';
const Org = z.object({
  id: z.string(),
  name: z.string(),
  segment: z.enum(['rl-data', 'design-partner']),
});

// Who. The judge sits on a third provider, so it shares neither the lead's nor the critic's biases.
const judge = seat('gemini', 'gemini-3.1-pro-preview', 'high');
const lead = role({ by: buddy('market-research'), max: usd(8), minutes: 45 }).reads('business/');
const scout = role({
  by: seat('claude', 'claude-sonnet-5-5', 'medium'),
  max: usd(1.5),
  minutes: 15,
}).web();
const critic = role({ by: seat('codex', 'gpt-6.1-sol', 'high'), max: usd(4), minutes: 30 });

// The cast: every step that can run. Each agent step's prompt is briefs/<name>.md.
const { scope, collect, thesis, attack, revise, packet } = steps({
  scope: lead.lists(Org),
  collect: scout
    .in(checkout(`${OUT}/sources/`))
    .judged(check('python tools/gtm/anchors.py', 'tools/gtm/')),
  thesis: lead.judged(review('traceable', judge)),
  attack: critic.judged(review('real-counterexample', judge)),
  revise: lead.judged(review('traceable', judge)),
  packet: lead
    .in(checkout(`${OUT}/`))
    .judged(check(`python tools/gtm/audit_ledger.py ${OUT}`, 'tools/gtm/')),
});

export default plan(async (x) => {
  const orgs = await x.phase('scope', () => scope());
  if (orgs.t !== 'passed') return gap('The scope step produced no list of organizations.', orgs);

  const found = await x.phase('collect', () =>
    wide(orgs.value.out, (org) => collect({ item: org }))
  );
  const sources = passed(found).map((f) => f.value); // the rest stay in the log as counted gaps

  await x.review('Is the coverage enough to argue from, or is a kind of source missing?');

  let current = await x.phase('synthesize', () => thesis({ reads: sources }));

  await x.phase('duel', async () => {
    for (const round of [1, 2, 3]) {
      if (current.t !== 'passed') return;
      const hit = await attack({ id: round, reads: [current.value] });
      if (hit.t !== 'passed') continue; // no real, sourced, new counterexample this round
      current = await revise({
        id: round,
        reads: [current.value, hit.value],
        continues: current.value,
      });
    }
  });
  if (current.t !== 'passed') return gap('No traceable thesis survived the three rounds.', current);
  const final = current.value;

  await x.review('Did the thesis hold, bend or die? Stopping with "no thesis" is a valid result.');

  const written = await x.phase('packet', () => packet({ reads: [final, ...sources] }));
  if (written.t !== 'passed') return gap('The packet failed its ledger audit.', written);

  await x.land('packet', written.value);
  return written.value; // the contract's owner criterion is the buyer-test gate; it holds nothing while it waits
});
