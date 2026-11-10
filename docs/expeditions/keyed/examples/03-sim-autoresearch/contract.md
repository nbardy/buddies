---
leader: wave-simulation-lead       # a named Buddy; it reflects and may rewrite the plan
repo: ~/git/wave_sim
budget: { usd: 140, hours: 36 }
autoApply: { usd: 15 }             # a rewrite adding more new cost than this waits for the owner
pools:
  claude:  { slots: 3 }            # an agent call reserves the pool named for its provider
  codex:   { slots: 3 }            # implementers keep preparing candidates while the GPU is busy
  gemini:  { slots: 1 }
  gpu:     { slots: 1, scope: machine }   # the one local M4 GPU runner, shared with every other expedition
  modal:   { usd: 30, slots: 4 }   # billed; four L4 containers at most, each scale-to-zero
  confirm: { uses: 2 }             # the long audit run may happen twice in the whole expedition
done:                              # the host evaluates these on ONE commit; nobody else may
  - check: bun test prototypes/surf_engine_v1/src tools/sim_runner_v1/runner.test.ts
  - metric: { run: python3 tools/speed_search_v1/abba.py --all --device modal-l4 --blocks 6 --complete-cost --json, field: errorRatio, atMost: 1.0, needs: [modal] }
  - metric: { run: python3 tools/speed_search_v1/abba.py --all --device modal-l4 --blocks 6 --complete-cost --json, field: speedup, atLeast: 1.15, needs: [modal] }
  - review: { rubric: speed-claim, by: gemini/gemini-3.1-pro-preview/high }
  - owner: Do you accept the audit, and may this case set record matchedErrorSpeedup=true?
rules:                             # appended verbatim to every brief
  - Speed counts only at matched error on the frozen case set in benchmarks/speed_search_v1/protocol.json. Nobody edits that file, the reference fields or the scoring code during the run.
  - Every speed number is an ABBA pair on one named device, with complete cost (setup, compile, evolution, readback, output, rejected work). A single timing is not a measurement.
  - One change family per candidate. Before proposing or building, read the graveyard in KEY_LEARNINGS.md and the learning log. A refuted family is not re-tested without a stated representation change.
  - Write a `learn` row for every idea you touch, with the prediction made before the measurement. Do not write agent notes for timing checkpoints; notes are not progress.
  - Results cite a commit, never a dirty tree. Raw output goes to output/ through artifact_store_v1; only small summaries are tracked.
  - Use "candidate" for everything that has not passed the confirm audit. Do not set matchedErrorSpeedup yourself.
  - One local GPU runner at a time. Modal runs are scale-to-zero, carry --max-usd, and are launched only by the host's benchmark steps, never from an agent turn.
---

# Goal

Make the WebGPU APIC engine (`prototypes/surf_engine_v1`) faster without making it less accurate,
and do it as a search I do not have to babysit.

I want many ideas tried in parallel: kernel variants, solver changes, precision, scheduling. Each
one has to clear the same matched-error gate before its speed counts for anything. Use the local
M4 for a quick screen and Modal for the full case set, and keep the implementers working while the
GPU is busy.

Two things have burned us before. First, noisy baselines: we once recorded a false 0.842× because
the A and B runs were not paired. If the benchmark cannot tell an A/A pair apart from a real
change, fix the benchmark before tuning anything. Second, repetition: the swarm re-tested ideas
that were already in the graveyard, and wrote hundreds of notes while no kernel moved. Keep one
dense shared record of what was tried and what it measured, and make every proposer read it.

A real result is one candidate that is at least 15% faster at matched error on the frozen cases,
under complete cost, on a named L4, confirmed by an ABBA audit and checked by someone who did not
build it. "Nothing beat the baseline, and here are the twelve ideas that failed and why" is also
a result I will accept. Either way the graveyard in `KEY_LEARNINGS.md` gets the new rows.

## Not yet real

- `tools/speed_search_v1/` does not exist in wave_sim. The plan assumes four scripts in it, written
  and committed before launch (the dry run refuses a command that cannot run on the base):
  - `cases.py --json` prints the frozen case ids from the protocol file;
  - `abba.py` runs an ABBA pair of the checked-out commit against the protocol's pinned baseline
    commit and prints `{ speedup, errorRatio, spread, usd, device, sha }`. Flags assumed: `--aa`,
    `--case`, `--all`, `--device local-m4|modal-l4`, `--blocks`, `--complete-cost`, `--max-usd`,
    and three that turn a number into an exit code: `--require-matched` (error ratio at most 1.0
    on every case), `--require-speedup N` and `--max-spread N`;
  - its own unit tests, discoverable by `python3 -m unittest discover -s tools/speed_search_v1`,
    including a synthetic-noise test of the pairing arithmetic.
- `benchmarks/speed_search_v1/protocol.json` (frozen cases, error metric, reference fields, pinned
  baseline commit, device names) and `benchmarks/speed_search_v1/results/` do not exist.
- The case ids are expected to be a subset of the READY cases in
  `tools/surf_engine_bench_v1/cases.ts` (`dam_break`, `soliton_ridge`, `flat_rest`, …). Which
  ones, and the error metric per case, is the owner's choice and is not made yet.
- `bun test prototypes/surf_engine_v1/src` is assumed to run the engine's existing `*.test.ts`
  files without a GPU. Not verified.
- The `wave-simulation-lead` Buddy id is assumed from "Accountable: Wave Simulation Lead" in
  `goals/2026-10-12_three_engine_goals.md`. Its provider is not known here; the dry run must show
  it is not gemini, or the `speed-claim` review needs another seat.
- The `--device modal-l4` path is assumed to wrap the existing central runner
  (`bun run sim surf_engine_v1 <case>`), which already keeps one scale-to-zero L4 per invocation.
  No ABBA mode exists in that runner today.
- The 15% bar, the 3% A/A spread limit, the $30 Modal pool and the two confirm uses are example
  numbers, not owner decisions.
