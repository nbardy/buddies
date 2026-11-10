---
leader: wave-simulation-lead       # a named Buddy; it reflects and may rewrite the plan
repo: ~/git/wave_sim
budget: { usd: 220, hours: 72 }
autoApply: { usd: 15 }             # a rewrite adding more new cost than this waits for the owner
pools:
  claude:  { slots: 1 }            # an agent call reserves the pool named for its provider
  codex:   { slots: 3 }            # one deep worker per open row
  gemini:  { slots: 1 }
  gpu:     { slots: 1, scope: machine }   # the one local M4 GPU runner: replays of saved failures
  modal:   { usd: 40, slots: 3 }   # billed; every run carries --max-usd and scales to zero
  strikes: { uses: 6 }             # paid scoring runs of a repair: two per row, three rows, and no more
done:                              # the host evaluates these on ONE commit; nobody else may
  - check: bun test tools/sim_runner_v1/runner.test.ts tools/sim_runner_v1/tolerance.test.ts
  - metric: { run: python3 tools/capability_matrix_v1/matrix.py --max-usd 6.00 --json, field: failing, atMost: 0, needs: [modal] }
  - review: { rubric: matrix-honest, by: gemini/gemini-3.1-pro-preview/high }
  - owner: Do you accept Engine E as the engine that carries forces, moving bodies and wind together?
rules:                             # appended verbatim to every brief
  - The gates in benchmarks/capability_matrix_v1/matrix.json are frozen. Same Scene, initial state, observation window, reference and scoring for every engine. A changed window or reference is a separate case, never a pass.
  - Tolerances come from the typed constructors in tools/sim_runner_v1/tolerance.ts. f32 relative tolerances are at least 1e-4. No bare numbers.
  - Two strikes per row. After a second failed paid run on a row, paid runs on it stop until the owner decides. A repair renamed as a "sidecar" or a "probe" is still a strike.
  - No paid run before the local replay of every saved failure for that row passes. Agents never launch Modal or the local GPU; the host's benchmark steps do.
  - A result cites a commit and its complete cost (setup, compile, evolution, output, readback, dollars). A run from a dirty tree is exploratory and cannot be cited.
  - Say "passes row R on engine X at commit S". Do not write "working", "validated" or "qualified" for an engine that fails any row.
  - Write a `learn` row for each diagnosed mechanism and each repair, with the prediction made before the measurement.
---

# Goal

I want one engine that does forces, moving bodies and wind at the same time. Today no engine
does. Engine E (the Eulerian CUDA solver) is the one I want to carry all three; Engine A (CUDA
APIC) is measured on the same cases so the matrix shows where each stands.

The rows are the ones already written down in `goals/2026-10-12_three_engine_goals.md`, unchanged:

- **R6 forces.** Foil lift within 10% at Re 1000 on two grids, with the error falling.
- **R7 moving bodies.** Floating-box draft within 2%, heave decays, period within 5%; a dropped
  rock settles; momentum exchange closes.
- **R9 wind.** Solved air/water coupling, not only a prescribed stress; setup slope within 10% of
  τ/(ρgh).

R12 conservation is checked inside each of those cases. Sand (R8) is out of scope here.

Where it stood on 2026-10-12: Engine E has foil lift 15.75% low, draft off by 16.5%, wind setup
31% low. Engine A has a sphere force 177% high and nothing else measured on CUDA.

What went wrong before is the reason for the rules. Plate lift took about nineteen paid attempts,
each one moving the fault to the next particle. The beta quietly depended on the hardest physics
row. So: each row gets a written diagnosis of the whole failure class first, a free local replay
of its saved failures before any paid run, and at most two paid tries. The rows are independent
of each other and can be worked at the same time. Inside a row the work is serial.

Done means all three rows pass their frozen gates on Engine E, from one committed source, with
the cost recorded, re-scored by the host and not by the people who fixed it. If a row does not
close in two strikes, I want the matrix to say so plainly and the failure-class document to tell
me what decision I have to make.

## Not yet real

- `tools/capability_matrix_v1/` does not exist in wave_sim. The plan assumes four scripts in it,
  written and committed before launch:
  - `cells.py --json` prints the cells `{ id, row, engine }` from the matrix file;
  - `score.py --row R --engine E|A --max-usd N --json` runs that row's frozen case through the
    central runner on Modal and prints `{ pass, error, bound, usd, sha, device }`; with
    `--require-pass` it exits non-zero when the row is outside its gate;
  - `replay.py --row R --require-fixed` replays every saved failure of the row against the
    checked-out source on the local M4 and exits 0 only if all of them now pass;
  - `matrix.py --max-usd N --json` scores every cell and prints `{ failing, cells: [...] }`, where
    `failing` counts Engine E rows outside their gate.
- `benchmarks/capability_matrix_v1/matrix.json` (rows, engines, case ids, gates, references) and
  `benchmarks/capability_matrix_v1/saved_failures/` do not exist. The saved failures of the
  earlier foil, draft and wind runs are scattered across `output/` and `agent_notes/`; collecting
  them into replayable form is work that must happen before launch.
- A local M4 replay of a CUDA engine's saved failure does not exist. Engine E is CUDA and the M4
  has no CUDA. `replay.py` is assumed to run the repaired operator on the saved state through a
  CPU or WebGPU twin. Whether such a twin can be faithful for each row is not established.
- The central runner (`bun run sim <engine> <case>`) has no foil, floating-box or wind-setup case
  today; its case list is still water, sloshing, solitary wave, dam break and four others. The
  per-row tools that exist (`tools/sim_runner_v1/e_foil_score_v3.py`, `wind_campaign_v3d.ts`,
  `rocks_campaign_v2.ts`, …) are separate scripts with their own launchers.
- `python3 -m unittest discover -s prototypes/eulerian_mac_mg_v0/cuda_body_forces_v1 -p 'test_*.py'`
  is assumed to run that directory's existing Python tests without a GPU. Not verified.
- `agent_notes/2026-11-10_capabilities/` is a new directory the plan writes failure-class
  documents into. `goals/2026-11-10_capability_matrix.md` is a new file the record step writes.
- The `wave-simulation-lead` Buddy id is assumed from "Accountable: Wave Simulation Lead" in the
  goals file. Its provider is assumed to be claude; the dry run must show it is not gemini.
- The dollar figures, the three Modal slots and the 72 hours are example numbers.
