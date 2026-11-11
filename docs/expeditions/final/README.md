# Expeditions as durable, multi-harness scripts

The built system is in [keyed/v1](../keyed/v1/DESIGN.md), with its runnable
[one-file examples](../keyed/v1/examples/README.md). This document is the earlier research record.

Status: **final design, 2026-11-10. Not built.** It replaces the four candidate designs in
`../v1…v4-*.md`, which stay as the research record. Conventions: `../../design-specs.md`.

## 1. What an expedition is

One TypeScript file: a **charter** (data) and a **`run` function** (the plan).

```ts
export default expedition({
  name, userGoal,            // the owner's words, verbatim, never edited
  objective: { criteria },   // version 0; revisable under owner control
  repo, budget: { usd, hours }, pools, rules,
  async run(x) { … x.agent(…) … x.check(…) … x.sample(…) … x.reflect(…) … x.finish(…) }
})
```

The buddies server runs `run` as a durable process. Every call (`agent`, `check`, `ask`) is
journaled. After a restart the host re-runs the script, and calls that already finished return
their recorded result, so nothing runs or spends twice. Agents run on any harness through
`vendor/agent-cli-tool`, so one script can use claude, codex and gemini seats. The full API is
[`expedition.d.ts`](expedition.d.ts); the owner's two loops are a library function,
[`lib/round-loop.ts`](lib/round-loop.ts).

**The split:** the script supplies the flexibility (any shape, from a fixed pipeline to an open
research loop). The host supplies the guarantees (budget, pools, deadline, replay, owner control,
objective revision, honest finish). A script cannot go around a guarantee, because each one lives
inside a primitive the script has to call.

## 2. Why this and not something else

| Alternative | What it lacks |
|---|---|
| Today's expedition host (`server/src/expeditions/host.ts`) | One goal retried until a pass. Cannot express fan-out, a deep serial step, a duel or a gate; a pass ends everything; the owner gate held the only slot (GTM, 2026-11-08). |
| A Claude Code Workflow + a human leader in chat | Right for one session with the owner present (this design was made that way). Dies with the session, Claude-only, cannot wait for the owner without a human driving, no limits shared across runs (7 h of the design run were Quint runs fighting another session for CPU). |
| A plain `.ts` script | Turing complete, so it can overspend, skip a gate or flood a machine; cannot survive a restart; cannot be steered. |
| V1/V2 (leader + round graphs) | The ideas are kept (§5). The graph language is not: most V1 bugs lived in patching a running graph (an early-answered gate deadlocked, a single check finished a multi-criterion objective). |
| V3/V4 (kernel / search) | The kernel is kept as the host (§7). Their plan layers (plan job, recipes, `allocate()`) are replaced by the script. |

**Test for any new host feature:** it must be something a script plus a human in the chat cannot
do: survive restarts, enforce a limit, hold no seat while waiting, or run on another harness.

## 3. Concepts

| Concept | What it is |
|---|---|
| **Charter** | `userGoal` verbatim, budget (usd, hours), pools, owner rules. Data, shown and checked before launch. |
| **Objective** | Versioned list of criteria (`check`, `metric`, `judged`, `owner`). Met = every criterion passes on one commit. |
| **Script** | `run(x)`: the plan. Deterministic, so it can be replayed. |
| **Call** | `x.agent` / `x.check` / `x.ask`. Journaled, budgeted, returns a sum type; the handle can be steered or cancelled. |
| **Pool** | A capped resource: an agent seat, local CPU/GPU (with machine-wide locks), Modal, ssh. A call reserves all its pools or none. |
| **Notebook** | The one shared store: notes with claim levels, ideas with families, results, sources, owner messages. Append-only. |
| **Decision** | The leader's typed reflection: continue / modify / restructure / revise-objective / finish, with predictions the host grades. |

## 4. Goals and mechanisms

| ID | Goal | By |
|---|---|---|
| G1 | Any workload shape: fan-out, deep serial, duel, population search, gate | The script (`parallel`, `pipeline`, `sample`, loops); examples 01–09 |
| G2 | Never overspend money or tokens | Reservation in `x.agent`/`x.check` before start; usage-stream stop with reason `reservation` |
| G3 | Never oversubscribe a machine | Pools with slot caps; `local.lock` shared across expeditions |
| G4 | Survive backend restarts without re-running or re-spending | Journal + deterministic replay; adoption of running turns (`docs/turn-lifecycle.md#execution-adoption`) |
| G5 | Waiting for the owner costs nothing and never blocks other work | `x.ask` holds no pool; answers arrive as journal entries |
| G6 | The deadline bounds work, not judgment | After the deadline, no new `agent`/`check` starts; finish checks, asks and `integrate` complete |
| G7 | The goal can be clarified as work teaches us, without drifting | `userGoal` immutable; `x.objective.revise`: clarify/tighten by leader, weaken/redirect by owner on the exact version |
| G8 | Finish is honest | `x.finish` evaluates every criterion on one sha; owner criteria become an ask |
| G9 | Progress, not activity | `x.reflect` grades predictions; two all-missed reflections force `restructure` |
| G10 | Judges are independent of producers | `judged` criteria and verifier calls run on a seat whose provider differs from the producer's |
| G11 | Width follows the evidence on scaling | `x.sample`: cap W[gauge] = 16 / 4 / 1, plus the ceiling and no-improvement narrowing (§6) |
| G12 | Shared knowledge, no peer chatter | `x.notebook`; agents read it through `context` queries; agents never message each other |
| G13 | Code lands safely | `x.integrate`: serial merge, re-check on the merged commit, fast-forward only |
| G14 | Multi-harness, multi-model | `Seat { provider, model, effort }` through `vendor/agent-cli-tool`, values passed through verbatim |

## 5. The two loops and the flexible goal

Your model, kept whole, minus the graph machinery:

- **Outer loop** (`roundLoop`, `x.reflect`): after each round the leader returns a `Decision`.
  Plans are data of the script's own type (`planSchema`), so a plan change is a typed value, not
  generated code. The host grades the previous predictions before the leader sees the notebook;
  after two all-missed reflections it refuses `continue` and `modify`.
- **Inner loop** (`x.round(name, body, watch)`): calls started inside a round report events
  (settled, slow, owner message, budget) to a watcher, batched. The watcher returns an
  `InnerDecision`: steer a call, cancel it, add a call, or end the round. Steering reuses
  `server/src/buddies/harness-steering.ts`.
- **User goal vs objective:** `userGoal` never changes. The objective is versioned. The leader may
  clarify wording or tighten a bar; weakening or redirecting becomes an owner ask, applied only to
  the version the owner saw. Termination comes from budget and deadline, never from the objective.

## 6. Width (research/scaling.md §4)

| Rule | Where it lives |
|---|---|
| 1 Wide only on decomposable work | Script shape: `pipeline` over independent items; serial work is a loop |
| 2 Never wide without a central verifier | `x.sample` requires `verify`; a fan's results enter the notebook as `claimed` until a check passes |
| 3 Central coordination; rebalance stragglers | The script is the coordinator; `slow` events let the watcher cancel and re-add a straggler |
| 4 Share through one store | `x.notebook` |
| 5 The ~45% ceiling | `x.sample` narrows coordinated (`review`/`owner`-gauged) work when **measured** first-try success over ≥ N tries exceeds 0.45 (`narrowedBy: 'ceiling'`) |
| 6 Width earned from the verifier | W[gauge]: machine 16, review 4, owner 1 |
| 7 Narrow when results per dollar stop improving | `x.budget.verifiedPerUsd(family)`; `x.sample` narrows on a flat window (`narrowedBy: 'no-improvement'`) |

## 7. Where each earlier design's parts went

| From | Kept as |
|---|---|
| V1 | Leader reflection, typed predictions + two-miss rule, user goal vs objective, owner ratification on a version |
| V2 | Warm sessions (`warm: { from }`), anchors (as a repo check), only failed checks count as strikes |
| V3 | Pools with all-or-nothing reservation, multi-pool calls (`alsoHolds`), the ledger (notebook), `unjudged` never a strike, judgment after the deadline, serial integration |
| V4 | Verifier-strength width cap, `sample` vs serial revise, results that tolerate failed inputs (`pipeline` over settled calls) |
| Workflows | The script API itself: `agent`, `parallel`, `pipeline`, schemas, resume by journal |

Dropped: round graphs and patches, node kinds, the plan job, recipes, `allocate()` ranking,
canaries, sealed trees, auto-continue, meta-plan as a separate object.

## 8. Examples

| File | Case | Shape |
|---|---|---|
| [`01-gtm`](examples/01-gtm.expedition.ts) | GTM research | wide anchored collection → narrow synthesis → 3 cross-provider duel rounds → owner |
| [`02-game-design`](examples/02-game-design.expedition.ts) | Tidewar balance | |
| [`03-wave-sim-autoresearch`](examples/03-wave-sim-autoresearch.expedition.ts) | wave_sim speed/accuracy | |
| [`04-frontier-math`](examples/04-frontier-math.expedition.ts) | new math → algorithms | |
| [`05-sim-capabilities`](examples/05-sim-capabilities.expedition.ts) | forces, wind, rocks | |
| [`06-deslop`](examples/06-deslop.expedition.ts) | unify types, shrink code | |
| [`07-crud-saas`](examples/07-crud-saas.expedition.ts) | CRUD app | |
| [`08-geometry-kernel`](examples/08-geometry-kernel.expedition.ts) | geometry engine | |
| [`09-document-model`](examples/09-document-model.expedition.ts) | document model design | |

All files typecheck against the API: `cd docs/expeditions/final && ../../../server/node_modules/.bin/tsc -p tsconfig.json`.

## 9. Invariants

Checked by the host model [`../../specs/expedition-host.qnt`](../../specs/expedition-host.qnt)
(random simulation, Rust backend; not proof).

## 10. Build slices

1. **Host core:** script runner with journal + replay, `x.agent` on `vendor/agent-cli-tool` with
   reservation and the usage stop, `x.check`, pools, deadline, `x.ask`, notebook. Pilot: 01 GTM.
2. **Loops:** `x.round` with watcher, `x.reflect` with prediction grading, `x.objective.revise`,
   `x.finish`. Pilot: 09 document model or a design-review script.
3. **Search and landing:** `x.sample` with the width rules, `x.integrate`, warm sessions, Modal/ssh
   pools. Pilot: 03 wave_sim.

Today's `server/src/expeditions/*` (2,349 lines) is replaced, not extended.

## 11. Open questions

## 12. Evidence

`../README.md` (comparison of the four candidates), `../research/` (use cases, prior art,
external systems, scaling papers), `../../specs/expedition-v{1..4}.qnt` and `mutants/`.
