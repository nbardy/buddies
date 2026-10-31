# Expedition MCP surface and Buddy behaviour

Status: design, not built (2026-11-01). Primitives: [design.md](./design.md).

## Tools

```
expedition_draft(request, context?)
    → { charter, issues[] }            // a Goal draft + what is missing or weak; launches nothing
expedition_launch(charter)
    → { id, badge } | Rejected(issues)  // rejects: no done check (unless OwnerJudgment), no budget, budget over envelope
expedition_list(filter?)               → [{ id, badge }]
expedition_status(id)                  → overview: questions, live attempts, results, spend, needs-you
expedition_ledger(id, since?, kinds?)  → raw entries, for the inspector or detailed questions
expedition_ask(id, question)           → answer citing runs and results (a read-only Answer attempt)
expedition_steer(id, feedback)         // Feedback from design.md: Approve | Redirect | Fund | Kill | Lesson | Pause | Resume | Stop | AmendGoal | RaiseBudget
```

Event stream: each expedition pushes badge updates and "needs you" items to the
chat that launched it.

### Permissions

| Action | Buddy | Owner |
|---|---|---|
| draft, list, status, ledger, ask | yes | yes |
| launch | only within the owner's pre-approved budget envelope | yes |
| steer: Approve, Redirect, Fund (within explore share), Kill, Lesson, Pause, Resume, Stop | yes | yes |
| steer: AmendGoal, RaiseBudget | proposes; owner confirms with one click | yes |

So "only the owner changes the WHAT" holds even when a Buddy drives.

## How a Buddy crafts one

The Buddy does not need to be good at writing charters. Crafting is an intake
with typed checks, not a prose skill:

1. **Draft.** The Buddy calls `expedition_draft` with the owner's request and
   any context (linked docs, task, repo). The engine returns a charter plus
   `issues[]`: missing done check, no scope fence, budget absent, goal too broad
   to plan, a done check that cannot fail.
2. **Fill gaps.** The Buddy fills what it can from context and asks the owner
   only for what it cannot infer, usually the budget and the done check, in one
   message.
3. **Launch.** `expedition_launch` refuses a charter with unresolved blocking
   issues. No silent defaults: a missing done check is either supplied or
   explicitly declared `OwnerJudgment`.

The tool guide in the Buddy briefing carries a short how-to: when to suggest an
expedition (below), the intake steps, and the permission rules.

## Can a poorly crafted expedition improve itself?

Yes, within the guardrail.

- **What it can fix itself:** Questions, briefs, allocation, routing. A vague
  goal produces a rough first Plan; Reflect and Zoom-out refine the Questions as
  results arrive.
- **What it can only propose:** Goal, scope fence, done checks, budget. When
  results show the charter is weak (a done check that cannot fail, a scope that
  excludes the real problem, an unreachable target), Zoom-out files an
  `AmendGoal` proposal with evidence. It shows as "needs you" on the badge; one
  click applies it.

The first Plan's output is the main moment for this: the expedition returns
its Questions and any charter amendments it already sees. Reviewing that is
optional, but it is the highest-leverage point to steer.

## When a Buddy suggests an expedition

It suggests; it never launches unprompted (cost). One line at the end of its
reply, e.g. "This looks like an expedition: the steps aren't known and it needs
parallel attempts. Want me to draft one for $3?"

It suggests only when all four hold (same ladder as
[workflows-vs-expeditions.md](./workflows-vs-expeditions.md#which-one-to-use)):

| Test | Means |
|---|---|
| Unknown shape | The Buddy cannot list the steps with confidence |
| Checkable | A done check exists or can be written, or the owner accepts OwnerJudgment |
| Big enough | Needs parallel attempts, or more than a few hours of work |
| Worth it | The goal matters at a budget of a few dollars and up |

It does not suggest one for: questions, single bounded tasks, known-shape
batch work (a workflow fits), or work that needs owner taste at every step.

Signals in the owner's phrasing that often pass the tests: "figure out why…",
"get X passing", "make many parallel attempts", "keep going until…", "half of
this is unscoped".
