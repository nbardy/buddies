# Build: the smallest slice that can kill `{{id}}`

Premise to test: {{premise}}
Killing observation: {{kill}}

You are given one frozen candidate (in your inputs), `MINIMAL_PROBLEM.md` and the hardware
contract. Do not redesign the candidate. If an explicit contradiction makes it impossible to
implement, stop and report the contradiction; that is a result.

## Produce

Under `candidates/{{id}}/` in the run folder, source before explanation:

- `source/`: the smallest GPU-owned executable slice that can produce the killing observation.
  Exact persistent buffers with units, capacities and overflow behaviour. A legal WebGPU/WGSL
  pass graph. Global coupling and dynamic work constructed on the device.
- A pure CPU f64 twin of the load-bearing computation, only where it serves as a known answer.
- One source-bound scene, one hostile control that destroys the candidate's favourable
  assumptions, and pass and kill thresholds fixed in a file before anything runs.
- `PREDICTION.md`: the speedup and the error you expect, and why, written now. It is compared
  with the measurement later and cannot be edited after the run.
- `ORIGIN.md` and `lineage.json`: which discovery run this came from, by its stored id.

The host's falsifier command will run your slice and the retained baseline at matched error. Make
the slice report physics error, wall time, bytes moved, dispatches, reductions, readbacks, peak
memory, failed work and fallback, so that complete cost can be charged.

## Your commit is checked

A known-answer script runs the CPU twin and thresholds file under `candidates/{{id}}/`. It does not touch the GPU. If
the known answer fails, the falsifier is not spent on this candidate.

## Do not

- Run anything on the GPU. There is one falsifier run for this candidate and the host owns it.
- Put a per-entity or per-iteration loop on the CPU, or a dense decode nobody charged.
- Claim speed, novelty or a full solver. A slice that passes its known answer has shown only that.
- Read the project's earlier work: `KEY_LEARNINGS.md`, `theory/` outside the handoff's
  `MINIMAL_PROBLEM.md`, other candidates' folders, or solver source. Your checkout can open them;
  the campaign is only valid if you do not.
- Edit `tools/astra/`, the campaign packet or another candidate's folder. The first two are
  restored before your work is checked and before the falsifier runs.

Stop at the smallest slice that would materially change belief. Record what you learn with `learn`.
