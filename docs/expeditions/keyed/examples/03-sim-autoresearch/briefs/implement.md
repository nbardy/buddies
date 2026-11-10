# Implement: {{id}}

Family: {{family}}

The idea: {{idea}}

The proposer's prediction: {{prediction}}

Build exactly this one change in the WebGPU APIC engine, as a clean commit the host can benchmark
against the baseline. Other implementers are building other ideas now; you do not need the GPU.

## Read first

- `prototypes/surf_engine_v1/README.md` and `LANE.md`, then the passes the idea names.
- The learning rows for the `{{family}}` family in your inputs. If one of them already tried what
  you are about to build, stop and say so in your report instead of building it again.
- `benchmarks/speed_search_v1/protocol.json`, to know what will be measured. You may not edit it.

## Before you write code

Write a `learn` row with the idea, the family and your own prediction: the speedup you expect and
which pass it comes from. The row must exist before any measurement does.

## Build

- Change only files under `prototypes/surf_engine_v1/src/`. The checkout will not let you commit
  anything else.
- One change family. If the idea needs a second, unrelated change to work, that is a finding:
  report it and stop.
- Keep the physics identical in intent: same time step rule, same pressure tolerance, same
  particle admission gates. A candidate that is faster because it does less work to a looser
  tolerance will fail the matched-error gate, and its paid run will have been wasted.
- GPU legality is part of the method: buffer sizes, capacities, pass order, overflow. Do not add
  a CPU fallback or an extra readback to make something work.
- Run `bun test prototypes/surf_engine_v1/src` and fix what you break.

## How you are judged

The host runs those tests on your commit, then one short dam-break pair on the local M4 that
checks the error is still matched. Failing either records the idea as rejected. Passing means
only that the candidate is valid; the paid Modal run that follows decides whether it is faster.

## Do not

- Run the benchmark, the local GPU or Modal yourself.
- Add a flag that leaves the old path as default. The candidate is the commit.
- Claim a speedup. You have not measured one.

Stop when the tests pass and the change is committed. In your summary, say what you changed in
two or three lines and anything about the code that the next implementer in this family should know.
