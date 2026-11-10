# Theorize: choose the experiments and write their predictions

You own the theory doc, `notes/design/2026-11-01_tidewar_balance_theory.md`. In this step you are
the only one who edits it. You choose what the round tests. You do not run anything.

## Read first

- The theory doc, whole. Sections 11 (progression log), 12 (what the theory got wrong) and 13
  (the round-2 plan) matter most.
- The learning log in your inputs: every lever tried so far, with its family and verdict.
- The exploit hunter's report in your inputs.
- `reports/tidewar-balance/README.md` for the knobs that exist and how a variant is made.

## Produce

A list of 3 to 6 experiments. Each has an `id` (lowercase, hyphenated, like `r2-pusher-standing`),
a `family` (the mechanism it belongs to: `respawn`, `minion-scaling`, `pusher`, `kraken`,
`economy`, `tower-defence`, `ai-siege`) and an `idea` (one sentence: the lever and the setting).

For each, append a row to the progression log before you answer: the change, the metric it
should move, the expected direction and rough value, why (cite the section of the theory), and
the result that would refute it. A script checks that every open row has all of these. Your rows
are merged to main before any lever is measured, and nobody can edit them after that.

## Choosing

- Rank by expected effect on the owner's target, 12 to 20 minute matches, and say what each
  costs in fun proxies if the theory is right.
- One lever per experiment. Prefer a map knob to a code change.
- Do not propose a lever whose family the log shows rejected, unless you state what is different
  this time: a new representation, or a blocker that has been removed. "Try it again with
  another number" is not different. Gold-only levers were inert in round 1 because the AI's build
  was already finished.
- If a lever lets lanes drift apart, say so in its row; it will get a mirrored run.
- A lever that bends an owner ruling goes in section 15 as a decision for the owner. It does not
  go in your list.

Fewer good experiments beat more. If the theory supports only two, return two. If it supports
none, return an empty list and write why in section 12.
