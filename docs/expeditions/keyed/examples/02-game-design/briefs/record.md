# Record: write the round into the repo

The round is over. Your inputs hold the learning log, every A/B measurement, and, if a stack was
built, its re-measurement, the exploit hunter's report and the reserved-seed confirmation. Write
what happened into the files that already own this knowledge. You are the only one editing them
in this step.

The first line of your inputs is the outcome of the stack in one sentence: nothing stacked,
dropped at a named gate, refused by the owner's playtest, or landed. Use it as written. If the
stack landed, the shipped map in your checkout already carries it.

## Write

1. **Progression log** (theory doc, section 11). For every row opened this round, fill in the
   seeds, the measured numbers and the verdict: confirmed, refuted or inconclusive. Say whether
   the mechanism was confirmed, not only the headline number. Mark each lever kept or reverted.
   Leave no open row. Never delete or soften an earlier row. The host has already written each
   lever's keep or reject into the learning log; your rows must agree with it.
2. **What the theory got wrong** (section 12). For each prediction that missed, say which
   formula or assumption was at fault, and correct it where it stands, with its tag: `[code:
   file:line]`, `[derived]`, `[assumption]` or `[measured]`. Only a number from this round's
   runs is `[measured]`.
3. **Human playtest questions** (section 14) and **owner decisions** (section 15). Add what this
   round raised, each question with the AI-side number it checks.
4. **Run summaries.** For each variant, a short `reports/tidewar-balance/<id>/README.md` with
   the command, the commit, the numbers and a pointer to the raw lines.
5. **The meta prompt**, `notes/design/2026-11-01_balance_swarm_meta_prompt.md`: a "Lessons from
   round 2" section about running the round itself: what wasted effort, what the plan should do
   differently. One durable lesson may also go in `key_learnings/agent_workflow_and_evidence.md`.
6. **`keel/GAMES.md`**, "Balance status", is outside your fence. Put its replacement paragraph
   in your report for the owner to apply.

## Honesty

- Take every number from the measurements in your inputs. Do not round toward the prediction.
- If nothing was confirmed, write that the round ships no change. That is a result.
- If the stack was built and then dropped, say at which gate: re-measurement, exploit hunt,
  reserved seeds or playtest. If the reserved seed set was used, say that it is now spent.
- AI against AI measures structure. Claim nothing about how the game feels.

A reviewer on another model checks your rows against the raw measurements.
