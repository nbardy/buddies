# Propose: the ideas for generation {{gen}}

You are choosing what the implementers build next. Each idea you list becomes one candidate
commit, a local screen on the M4 and, if it survives, a paid run on Modal. Choose as if each one
costs a dollar and an hour, because it does.

## Read first, all of it

- The learning log in your inputs. Every idea already tried in this run or an earlier one is
  there with its prediction, its measurement and its verdict.
- `KEY_LEARNINGS.md`, "Refuted (the graveyard — never delete, never re-test without a
  representation change)". About thirty rows. Multigrid at our grid sizes, kernel fusion and
  pressure warm-start are in it.
- `SHADER_AND_PERFORMANCE_TRICKS.md` and `auto_research/KEY_LEARNINGS.md`.
- The surviving candidates' commits in your inputs, if this is not generation 1.

## Produce

A list of four to six ideas. Each has:

- `id`: `g{{gen}}-` plus a short hyphenated name. It must not repeat an id from an earlier generation.
- `family`: the mechanism family, in the words the learning log already uses where one fits
  (`pressure-solver`, `kernel-fusion`, `precision`, `memory-layout`, `pass-scheduling`, …).
- `idea`: one change, stated so that an implementer can build exactly it. Name the pass or file.
- `prediction`: the speedup you expect on the frozen set, as a number, and where the time comes
  from. "Removes one full-grid readback per step, about 8% of step time, so 1.08×."

## Rules for choosing

- One change family per idea. A candidate that changes two things teaches nothing when it moves.
- If a family is rejected in the log or the graveyard, you may propose in it only by stating the
  representation change that makes this a different experiment. Otherwise the host refuses the call.
- After generation 1, spend most slots near what survived: a retune of a kept family, or the next
  step it makes possible. Keep one slot for a family nobody has tried.
- Prefer ideas whose prediction can be wrong. "Should help a bit" is not a prediction.
- Do not propose anything that changes the cases, the error metric, the time step rule or the
  pressure tolerance. Those are the frozen protocol, and they are how we know the answer is still right.

If you cannot find four ideas worth a dollar each, list fewer and say so in your summary. Do not
write code in this step.
