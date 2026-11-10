---
leader: simulation-research        # a named Buddy; it reflects and may rewrite the plan. It never invents.
repo: ~/git/wave_sim
budget: { usd: 400, hours: 36 }
autoApply: { usd: 40 }             # a rewrite adding more new cost than this waits for the owner
pools:
  codex:      { slots: 4 }         # the four blind discovery runs go out together
  claude:     { slots: 2 }
  gemini:     { slots: 2 }
  gpu:        { slots: 1, scope: machine }   # the local M4: one GPU runner at a time, across every expedition
  falsifiers: { uses: 2 }          # one falsifier run per selected candidate, two candidates at most, no reruns
done:                              # the host evaluates these on ONE commit; nobody else may
  - check: python3 tools/astra/audit_run.py auto_research/experiments/astra_wave_sim_restart_2026-11-10
  - metric: { run: python3 tools/astra/receipt.py --best --json, field: speedup, atLeast: 10 }
  - review: { rubric: matched-error, by: gemini/gemini-3.1-pro-preview/high }
  - owner: Do you accept this candidate (or this no-go) as the result of the campaign?
rules:                             # appended verbatim to every brief, so they name no project architecture
  - Label every load-bearing statement TEXTBOOK, LITERATURE (with the citation), DERIVATION or CONJECTURE.
  - Speed counts only at matched physical error and complete cost. Charge setup, compile, adaptation, certification, conversion, rejected work, fallback, readback and output.
  - A precise no-go or lower bound is a full result. Page count, theorem count and polished prose are not progress.
  - No Modal and no paid compute. The local GPU is used only by the host's falsifier command. Do not start a GPU run yourself.
  - Raw responses and run output go to output/ through artifact_store_v1. Tracked summaries go under the run folder and cite a commit, never a dirty tree.
---

# Goal

I want a materially faster true-3D breaking-water system: new mathematics that gives a 10× to 200×
speedup at matched physical error and complete target-GPU cost, not another tuning pass on what we
have. Everything we have tried so far is in the graveyard, and I think the next real step comes
from a representation we have not looked at.

Run the Astra restart packet the way it was designed. The discovery runs must be blind: they see
the minimal problem and the hardware facts and nothing else of ours, no architecture names, no
attempt ledger, no sibling output. Otherwise I cannot tell invention from our own vocabulary read
back to us. Then a blind census by a different model, then one GPU falsifier per selected
candidate against the best admissible baseline, then a hostile judgment by someone who did not
write it.

I would rather get "nothing survived, and here is the lower bound that says why" than a candidate
that was graded by its author or timed against an unfair baseline. That has happened to us: an
integrator-order result sold as novelty against a first-order baseline, an elimination that cut
iterations 18% and ran 30% slower. If two clean falsifiers fail, stop.

Whatever happens, the refuted representations go into the graveyard with their mechanism, so the
next campaign does not pay for them again.

## Not yet real

- `tools/astra/known_answer.py`, `tools/astra/falsify.py`, `tools/astra/audit_run.py` and
  `tools/astra/receipt.py` do not exist in wave_sim. They are four small scripts to write and
  review before launch; the launch dry run refuses a check that cannot run. `falsify.py` must
  print one JSON object with `speedup` and write the full receipt the packet's `01_build.md` asks
  for, including the physical error of both sides.
- `auto_research/experiments/astra_wave_sim_restart_2026-11-10/` does not exist. The packet's
  README says to create the dated run folder and copy the frozen campaign files into it at launch.
- The `simulation-research` Buddy id is assumed. It must not run on gemini, or the `record` review
  is refused at the dry run.
- The freeze step (`! rg -q TBD_AT_LAUNCH` over the two contracts) uses only real paths, and it
  fails today, as it should: `MODEL_AND_HARDWARE_CONTRACT.md` and
  `REFERENCE_AND_ACCOUNTING_CONTRACT.md` still carry `TBD_AT_LAUNCH` fields. The status lines that
  mention the token must be rewritten when the fields are frozen.
- The blind allowlist names `MODEL_AND_HARDWARE_CONTRACT.md` for the hardware facts. The packet
  also lists "solver-neutral scene and observation schemas" without a path; that file has to be
  named and added to the allowlist before launch.
- Seat names (`gpt-6-astra`, `claude-opus-5-5`, `gemini-3.1-pro-preview`) are the ones the repo's
  own charters use; the packet leaves model identity `TBD_AT_LAUNCH`.
- No falsifier against "the best admissible baseline" exists as one command today. The retained
  reference class is a field of the unfrozen reference contract.
