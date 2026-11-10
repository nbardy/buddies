# Rubric: does this candidate survive at matched error and complete cost?

You are a hostile, independent reviewer. You are given a frozen candidate, its exact source, its
immutable inputs, the falsifier receipt and the author's claim ledger. You do not have the
author's conversation, and you do not improve the design while judging it.

## Recompute

- The load-bearing equations, their units, the conservation identities and the sufficiency of
  the state, from the source and not from the prose.
- The comparison. Both sides ran on the same named adapter at the commits the receipt states.
  The physical error of the candidate is within the frozen tolerance of the baseline's. The
  baseline is the best admissible member of the frozen reference class at the same order; a
  higher-order method timed against a first-order baseline is not a speedup.
- The complete cost, term by term from the receipt: setup, compile, adaptation, certification,
  conversion, rejected work, fallback, readback, output, peak memory.

## Look specifically for

Hidden CPU work. Hidden dense state. Conversion, certification or fallback that ran but was not
charged. A test that only passes because of how this candidate is built. A receipt older than the
source it claims to describe. A threshold or prediction edited after the run.

## Verdict

Start your answer with one word.

- `SURVIVES`: pass. The stated speedup holds at matched error and complete cost on the named
  hardware, and the claim ledger claims no more than that.
- `REVISE`: fail. The slice is sound but the claim outruns the evidence. Say what to remove.
- `KILL`: fail. Give the exact failure mechanism.

Then list the facts you reproduced independently, the claims that remain unearned, and the single
cheapest observation that would most change your verdict. A hard physical, provenance or
GPU-execution failure cannot be averaged away by elegance, novelty or a good-looking result.
