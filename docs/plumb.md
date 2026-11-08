# Plumb: the house dialect for design specs

Named for the plumb line, which checks that a wall is true. (Not "Keel": that is the UI library
in `~/git/room-runners-arena-lib`.)

Plumb is a small pseudo-formal notation for writing system designs in this repo. It is written in
fenced ```` ```plumb ```` blocks inside markdown and checked by `pnpm check:plumb`
(`tools/plumb-lint.mjs`). No proof checker runs over it. What it does buy:

- **Every case listed.** Sum types make "what else can this be?" explicit.
- **Every guarantee named.** Every `goal` must say `by:` which mechanism delivers it, and every
  `inv` must say `guard:` which test or code enforces it. A missing mechanism is written as a
  `❌` gap: visible and counted, never silently left out.
- **One-to-one with real code.** The syntax is TypeScript-flavored on purpose, so a Plumb `type`
  becomes a Zod discriminated union in `shared/src/*.ts` with no translation step (AGENTS.md:
  one type source; `~/.claude/CLAUDE.md`: types as control flow).

Origin: the expedition-leader design conversation of 2026-11-08
(`docs/expeditions-leader-design.md`). There, writing the design half-formally turned up five
gaps that prose had hidden: parallel budget overshoot, a plan rewrite that could drop an owner
gate, a leader that could certify its own finish, a patch racing a node start, and fan-out over
an output not known to be a list. The notation drifted between Lean, Haskell and TS from turn to
turn, so it is now fixed here.

## The constructs

Each declaration starts at column 0. An indented line continues the declaration above it.

```plumb
role owner | leader | host | worker                     -- who can act; every act names one

type Node = Agent{prompt, inputs: Ref[]} | Map{over: Ref, maxPar: n} | Gate{q}
                                                       -- sum type: the variants own behaviour
struct Charter { userGoal: md; budget: Budget }        -- product type
state Node: pending -> running -> (done | cancelled)   -- the allowed transitions, nothing else

goal G1 terminates: finished by charter.deadline
  by: budget and deadline only shrink (host enforces)   -- required; `by: ❌ <why>` = a known gap
inv I1 done-immutable: done(n) => n never changes
  guard: ❌ no test yet                                 -- required; same gap convention

act patch(n, ops) @leader                              -- @role: who may perform it (declared roles only)
  requires: n is pending
  ensures: plan.version + 1
  else: reject to the leader

on roundDone => leader wakes                           -- what an event causes
? q1: one segment or a ranked shortlist?               -- open question, kept as data
-- comment: intent and why, in prose
```

| Construct | Meaning | Becomes in code |
|---|---|---|
| `role a \| b` | the actors that can perform acts | grant/seat types |
| `type T = A{…} \| B{…}` | sum type; behaviour differs by variant | `z.discriminatedUnion('t', …)` + one handler per variant |
| `struct S { … }` | product type | `z.object({…}).strict()` |
| `state T: a -> b -> (c \| d)` | allowed transitions only | a phase union + a transition table, checked at one write path |
| `goal ID name: claim` + `by:` | what must hold, and the mechanism that makes it hold | a doc claim with a code pointer |
| `inv ID name: claim` + `guard:` | an invariant and its enforcement | a regression test or assertion |
| `act f(args) @role` + `requires/ensures/else` | an operation, who may perform it, its contract | a handler + a `valid` check |
| `on Event => effect` | event → reaction | a wake/handler registration |
| `? ID: question` | open ambiguity, explicit | a tracked question, never a guess |
| `-- text` | prose | a comment |

## Rules the linter enforces

1. Every `goal` has a non-empty `by:`. Every `inv` has a non-empty `guard:`.
2. A `by:` or `guard:` that starts with `❌` is a **gap**. Gaps are reported and counted, not
   failed (honesty beats false green); `--strict` fails on them.
3. Every `act` names at least one `@role`, and every role is declared in a `role` line in the
   same file.
4. IDs (`goal`, `inv`, `?`) are unique within a file.
5. A column-0 line that is not a Plumb construct is an error. The dialect stays small because
   the linter refuses inventions; to add a construct, change this doc and the linter together.

The status markers in obligation tables are `✅` discharged, `⚠️` partial, `❌` gap.

## Writing guidance

- **Theorems are claims, not proofs.** Write `goal`, never `theorem`. Nothing here is checked
  beyond structure.
- **Name the mechanism concretely:** a file, function or test (`host.ts finishIfDue`), not
  "the system ensures it".
- **Prose stays prose.** LLM judgment (rubrics, prompts, "is this progressing?") is written as
  `--` text or a `rubric` field. Plumb types the structure *around* the judgment.
- **Put ambiguity in `?` lines.** An unasked question becomes a silent default, which the house
  style forbids (no silent fallbacks).

## Where Plumb sits among the options

Measured on what each catches and what it costs:

| Level | Examples | Catches | Cost | Use here for |
|---|---|---|---|---|
| Free prose | design docs | intent, why | lowest | the why, beside every Plumb block |
| **Plumb** (pseudo-formal) | this doc | missing cases, unnamed guarantees, gaps | low | every new design |
| Real types | TS + Zod (`shared/src`) | data shape, exhaustiveness | medium | the single type source |
| Model-based tests | TS state machine + fast-check | races and orderings, by random sampling | medium | the concurrent core of a design |
| Model checker | Quint, TLA+, P, FizzBee | races and orderings, exhaustively in small models | medium-high | only when sampled tests keep missing interleavings |
| Proof assistant | Lean, Coq, Dafny | real proofs | high | not used: these systems are mostly LLM judgment |

The model-checker landscape as of 2026-11-08:

- **Quint**, from Informal Systems: a TS-like syntax over TLA+'s logic, with a type checker,
  REPL and simulator, installed through npm. It started around 2022 as "TNT" (dates from
  memory). The Thoughtworks Radar of Nov 2026 rates it "Assess", and found Quint vs TLA+ a close
  call: better tooling against more maturity. It is the closest fit to this stack.
- **Nothing newer has replaced TLA+.** The 2026 research has LLMs write TLA+ and keeps the
  checker in the loop:
  - Specula (arXiv 2607.25333) runs coding agents that write models and invariants.
  - TLA-Prover (arXiv 2606.06133) reports that the best public baseline across 25 LLMs gets
    26.6% of specs to parse and 8.6% to pass the model checker. LLM-written specs need a
    checking loop.
- **FizzBee** (Python-like) and **P** (event-driven state machines) are alternatives worth
  knowing; noted from memory, not re-checked.

The default path for a design: Plumb in the doc → Zod types → a TS model + fast-check against the
real implementation. Quint is the escalation.
