// Plan version 0, as launched.

import {
  buddy,
  check,
  expedition,
  need,
  parallel,
  passed,
  review,
  role,
  seat,
  steps,
} from 'expedition';
import { z } from 'zod';

const OUT = 'business/research/2026-11-10_gtm';
const Org = z.object({
  id: z.string(),
  name: z.string(),
  segment: z.enum(['rl-data', 'design-partner']),
  kind: z.enum(['direct', 'substitute', 'comparator']),
});

// Codex judges the Claude steps; Claude judges the Codex critic.
const judge = seat('codex', 'gpt-6.1-sol', 'low');
const criticJudge = seat('claude', 'claude-sonnet-5-5', 'low');
const traceable = `# Rubric: is every load-bearing claim traceable?

You are reviewing work written on another model. Do not trust its tags.

Pick the claims the conclusion depends on. For each one, open the sources it cites and check:

1. The source exists in the ledger with status \`fetched\`.
2. The source says what the claim says it says. Quote the words.
3. The tag is right: VERIFIED only if a fetched source states it; a vendor describing itself is
   CLAIMED; an inference is SPECULATION.

Pass only if at least nine in ten load-bearing claims meet all three, and none of the failures is
the claim the whole thesis rests on. In your answer, list each claim you checked and what you
found. If the two segments' evidence has been mixed, fail it and say where.
`;
const realCounterexample = `# Rubric: is this counterexample real, sourced and new?

You are judging an attack on a thesis. You did not write either.

Pass only if all three hold:

1. **Real.** It names an organization, event or statement that exists. Open the source.
2. **Sourced.** The source says what the attack claims. Quote the words.
3. **New.** No earlier round raised it.

Then answer one more question, which does not change the pass: does it actually contradict the
thesis as stated, or only a weaker reading of it? Say which.

Fail a plausible story with no source. Fail a repeat. Do not pass an attack because the thesis
looks weak; judge the counterexample.
`;

const lead = role({ by: buddy('market-research'), usd: 8, minutes: 45 }).reads('business/');
const scout = role({
  by: seat('claude', 'claude-sonnet-5-5', 'medium'),
  usd: 1.5,
  minutes: 15,
}).web();
const critic = role({ by: seat('codex', 'gpt-6.1-sol', 'high'), usd: 4, minutes: 30 });

const { scope, collect, thesis, attack, revise, packet } = steps({
  scope: lead.lists(Org).brief(`# Scope: who to study

You are choosing the organizations this research will collect evidence on. You are not collecting
the evidence yet.

## Read first

- \`business/plans/REVENUE_PLAN.md\`, the current October 22 section
- \`business/plans/2026-10-22_gtm_program.md\`
- \`business/research/2026-10-03_rl_env_buyers/\` (earlier supplier and buyer work; it is a month old)

## What to produce

A list of 25–40 organizations, each with an \`id\` (lowercase, hyphenated), a \`name\`, a \`segment\`
and a \`kind\`: \`direct\` (sells or buys the thing itself), \`substitute\` (in-house, open source,
consulting, doing nothing) or \`comparator\` (a generic data or CAD vendor, listed only for scale).

There are two segments, and they stay separate through the whole expedition:

- \`rl-data\`: anyone who sells or buys engineering RL environments, executable evaluations,
  trajectories, or task/data pilots. Keep those four deliveries distinct in your notes.
- \`design-partner\`: marine, coastal, foil and hull design-tool users, and the CAD, CAE and
  consulting workarounds they use today.

Cover every kind of substitute, not only direct suppliers: building it in-house, open source,
consultants, and doing nothing. Among them, name the 3–5 largest publicly reporting incumbents and
say what measure of size you used. A private company has no earnings calls; do not list it as if
it did.

## What good looks like

- Each organization is there for a stated reason, not because it is well known.
- A reader can tell from the list which substitute categories are thin.
- If no public company sells engineering RL environments, say so plainly. Generic AI-data vendors
  may be listed as comparators, labelled as comparators.

## Stop

About 30 minutes. Do not fetch product pages in this step.
`),
  collect: scout
    .checkout()
    .brief(
      (item: z.infer<typeof Org>) => `# Collect: the public record for ${item.name}

Segment: ${item.segment}

You are gathering what ${item.name} says in public, exactly as it says it. One organization, this
call only. Someone else will draw conclusions; your job is a record they can trust.

## Fetch

- Product, pricing, documentation and case-study pages, and the internal links that matter.
- If ${item.name} is a publicly reporting company: its latest two or three earnings calls, from the
  official investor-relations transcripts or filings.

A landing-page summary is not a fetched site. Open the pages.

## Record

For every surface you tried, write one row in \`sources/${item.id}.md\`:
the URL, the retrieval date, and its status: \`fetched\`, \`missing\` or \`login-blocked\`.

For every fact you keep, write the fact, the exact quoted words it rests on, and the URL. Your
work is checked by a script that looks for each quote in the stored page. A paraphrase presented
as a quote fails the check.

Store raw page bodies through \`artifact_store_v1\` under \`output/\`. Do not commit them.

## Do not

- Guess at pricing or customers that the pages do not state. Write "not stated".
- Use search-engine summaries as sources. They are leads until you open the page.
- Draw conclusions about demand.

## Report

In your summary, say how many surfaces were fetched, missing and login-blocked, and name anything
that surprised you, especially anything that changes who we should study (a company went private,
was acquired, or shut the product).
`
    )
    .judged(check((item: z.infer<typeof Org>) => `python tools/gtm/anchors.py ${item.id}`)),
  thesis: lead
    .brief(`# Synthesize: one falsifiable thesis per segment

You have the whole collected record. Read all of it before writing anything.

## Answer these two questions, in these words

1. What do the winners in this market know that their customers would never admit?
2. Which beliefs does the industry take for granted, and what would make each one false?

## Produce

- One falsifiable sales hypothesis for the \`rl-data\` segment: who buys, what they buy (name which
  of the four deliveries), what triggers the purchase, and what observation would prove it wrong.
- One separately argued hypothesis for the \`design-partner\` segment.
- A belief/falsifier table: each belief, and the evidence that would make it false.

## Rules of evidence

- Every load-bearing claim links to the source rows it rests on. A reviewer on another model will
  open those sources and check that they say what you say they say.
- Tag each claim VERIFIED (a fetched source states it), CLAIMED (a vendor asserts it about
  itself) or SPECULATION (your inference).
- An absence is ambiguous. "No fluids supplier exists" and "zero qualified buyers" each fit an
  open niche and a market with no demand. Say which further evidence would separate the two.
- If the evidence does not support a thesis, write that. "No thesis yet, and here is what is
  missing" is a result.

Take the time this needs. This step is one mind holding everything; it is not parallel work.
`)
    .judged(review(traceable, judge)),
  attack: critic
    .brief(`# Attack: the strongest counterexample

You are given the current thesis and the sources behind it. Your job is to break it.

First state the thesis in its strongest form, so that you are not attacking a weak reading.
Then find the single strongest counterexample: a real, sourced case that the thesis says should
not exist, or a buyer the thesis predicts who demonstrably does not buy.

## It counts only if it is

- **Real.** A named organization, a dated event, or a quoted statement.
- **Sourced.** Give the source rows or a URL you opened. A plausible story is not a counterexample.
- **New.** Not something an earlier round already raised. Earlier rounds are in your inputs.

A reviewer on another model decides whether your counterexample meets all three. If you cannot
find one that does, say so and stop. Do not pad the round with a weak one: a round that finds
nothing is evidence that the thesis is holding.

Keep the two segments separate. Evidence about generic data vendors does not refute a claim about
engineering RL buyers unless you show why it transfers.
`)
    .judged(review(realCounterexample, criticJudge)),
  revise: lead
    .brief(`# Revise: answer the counterexample

You wrote the current thesis. A counterexample has been judged real, sourced and new.

Do one of three things, and say which:

- **Hold.** Show from the sources why the counterexample does not apply. Do not explain it away.
- **Bend.** Narrow or change the thesis so that it survives. State exactly what changed.
- **Reject.** The thesis is wrong. Say what the evidence now supports, if anything.

Keep the previous thesis text in the record unchanged, followed by the counterexample and your
answer. The history of what was claimed and what broke it is part of the result.

Update the belief/falsifier table. The same evidence rules apply: every load-bearing claim links
to its sources and carries its tag.
`)
    .judged(review(traceable, judge)),
  packet: lead
    .checkout()
    .brief(`# Packet: what the owner will read and act on

Write the final packet under \`business/research/2026-11-10_gtm/\` and commit it. Write in the
repo's own structure; add the packet to the index in \`business/README.md\`.

## Contents

1. **Decision first.** The two hypotheses as they now stand, or "no thesis", in a few plain lines.
2. **Coverage, counted.** How many organizations, by segment and substitute category; how many
   surfaces fetched, missing and login-blocked. Name the gaps candidly.
3. **The reasoning, kept.** Every thesis version, the counterexample that bent or killed it, and
   the answer. Do not tidy this into a single clean argument.
4. **Belief/falsifier table**, final state.
5. **A buyer test the owner can run himself.** Five accounts with checked contact routes, the
   questions to ask, and this pass rule: at least two concrete current cases and at least one
   scoped commercial next step. Customer-facing wording is the owner's to write; mark it
   \`NEEDS OWNER WORDS\`.

## Rules

- Every claim keeps its VERIFIED / CLAIMED / SPECULATION tag. Do not promote a claim.
- No outreach. The buyer test is a plan, not something you start.
- A polished report does not establish product-market fit. Do not write as if it did.

Your commit is checked by a ledger audit: every source id cited in the packet must exist in the
source ledger, and every ledger row must have a status.
`)
    .judged(check(`python tools/gtm/audit_ledger.py ${OUT}`)),
});

export default expedition({
  contract: {
    leader: 'market-research',
    repo: '~/git/wave_sim',
    budget: {
      usd: 60,
      hours: 8,
    },
    autoApply: {
      usd: 10,
    },
    pools: {
      claude: 6,
      codex: 1,
    },
    done: [
      {
        check: 'python tools/gtm/audit_ledger.py business/research/2026-11-10_gtm',
      },
      {
        review: {
          rubric: traceable,
          by: {
            t: 'seat',
            provider: 'codex',
            model: 'gpt-6.1-sol',
            effort: 'low',
          },
        },
      },
      {
        owner: 'Do you accept the packet and the buyer-test plan?',
      },
    ],
    rules: [
      'No paid scraping or enrichment, no GPU, no outreach, no publication. Nick does all external sending.',
      'Tag every claim VERIFIED, CLAIMED or SPECULATION. A polished report does not establish PMF.',
      'Keep RL/data evidence and design-partner evidence separate. Generic data or CAD vendors are comparators, not proof of demand.',
      'Commit on your own branch and never merge or push. Nick merges.',
    ],
    goal: 'Follow the raw evidence → difficult questions → adversarial revision → buyer conversations method.\n\nProduce one falsifiable engineering RL/data sales hypothesis and one separately judged\ndesign-partner hypothesis. The blocker today is that we lack evidence connecting actual buyer\nworkflows and buying triggers to an offer we can deliver.\n\nI want traceable conclusions, the actual coverage (or candid gaps), the adversarial reasoning kept\non the record, and a buyer test I can run myself.',
  },
  plan: async (x) => {
    const orgs = need(await x.phase('scope', () => scope()), 'No list of organizations.');

    const found = await x.phase('collect', () =>
      parallel(orgs.out, (org) => collect({ item: org }))
    );
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
    await x.review(
      'Did the thesis hold, bend or die? Stopping with "no thesis" is a valid result.'
    );

    return need(
      await x.phase('packet', () => packet({ reads: [current, ...sources] })),
      'The packet failed its ledger audit.'
    );
  },
});
