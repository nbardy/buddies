# Writing design specs

How to write a system design in this repo so its gaps show up before code does. Example:
`docs/expeditions-leader-design.md`.

## The conventions

1. **Types in `ts` blocks**, written as the discriminated unions they will become in Zod
   (`shared/src/*.ts`, one type source). If behaviour differs by kind, the kind is a variant.
2. **Goals table: every goal names its mechanism.** Columns: ID, goal, by. "The system ensures
   it" is not a mechanism; name the file, function, act or invariant.
3. **Invariants table: every invariant names its guard.** The guard is a test, a Quint invariant
   or an assertion at one write path.
4. **Gaps are written as ❌, never left out.** A guard not yet built reads `❌ <what to build>`.
   The ❌ rows are the build list.
5. **Acts table: every action says who may perform it** (owner, leader, host, worker…), what it
   requires, and what happens otherwise.
6. **Open questions are written down** in their own list. An unasked question becomes a silent
   default.
7. **Prose stays prose.** LLM judgment (rubrics, prompts, "is this progressing?") is described,
   not typed; types cover the structure around it.

Why: on 2026-11-08 writing the expedition-leader design this way exposed five gaps that the prose
version had hidden: parallel budget overshoot, a plan rewrite dropping an owner gate, a leader
certifying its own finish, a patch racing a node start, and fan-out over an output not known to
be a list. The check that found them was asking "which mechanism delivers this?" for each goal.
A custom notation with a linter ("Plumb", e771c8f) was tried and removed the same day: it checked
format, not meaning, and `0 errors` read as verification.

## When to check a design for real

Conventions are not checking. For the concurrent core of a design (lifecycles, budgets, races,
restart), write a **Quint** model (`docs/specs/*.qnt`, installed through npm, TS-like syntax over
TLA+'s logic):

- `quint run`: random simulation, no JVM.
- `quint verify`: Apalache, a bounded symbolic check of every interleaving (needs a JVM).
- Link the model to the code: drive the real implementation with the model's transitions
  (fast-check, or replaying Quint ITF traces). A proof covers the model, not the code.

Proofs cover structure, never LLM judgment: "the leader can never drop a gate" is provable,
"the leader reflects well" is not.

Landscape as of 2026-11-08: the Thoughtworks Radar (Nov 2026) rates Quint "Assess" and found it
a close call against TLA+ (better tooling against more maturity). The 2026 research keeps TLA+
as the target and has LLMs write it with the checker in the loop (Specula, arXiv 2607.25333;
TLA-Prover, arXiv 2606.06133, whose best public baseline across 25 LLMs passed the model checker
8.6% of the time). LLM-written specs need the checking loop.
