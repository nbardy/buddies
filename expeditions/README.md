# Expeditions

> An expedition turns a fuzzy goal into independently verified results, using
> disposable agents, an append-only ledger, and a human who steers by teaching
> lessons.

Status: **design, not built** (2026-11-01). Nothing here has run. The first
step is a by-hand prototype (see [design.md § Proof plan](./design.md#proof-plan)).

| File | Contents |
|---|---|
| [README.md](./README.md) | Motivation and the one-paragraph idea |
| [design.md](./design.md) | Primitives, attempt kinds, the loops, self-reflection, guardrails, open gaps |
| [workflows-vs-expeditions.md](./workflows-vs-expeditions.md) | How this differs from Claude Code workflows, swarms and Buddies automations, and when to use which |
| [mcp.md](./mcp.md) | The MCP surface a Buddy uses, how a Buddy crafts an expedition, when it suggests one |

## Motivation

The owner wants to hand an agent a **big, ambiguous, half-scoped goal** and
have it run a team that parallelizes hard and finishes the work, **without
growing scope and without tunnelling** on one narrow line.

Earlier attempts (Buddies automations + background workers, oompa swarms, a
CEO Buddy dispatching workers, the wave_sim parallel bursts) taught us what
works and what does not.

**What worked**
- One isolated worktree per attempt.
- Competing attempts on the same problem.
- Hard budgets and a two-strike stop rule.
- Typed results with explicit claim flags.
- Fresh-context verification: the single most valuable practice.
- State kept in files and commits.

**What failed**
- **Long-lived agents.** Persistence depended on a model choosing to continue,
  so work did a bit and stopped.
- **State in chat and memory.** Goal text got lost and re-pasted; context
  compaction reset progress.
- **The manager as a long conversation.** CEO turns burned the most tokens and
  drifted.
- **Progress counted as finished tasks.** "Done" was claimed, then refuted;
  agents graded their own work.
- **Lessons stuck to the agent that found them.** Siblings repeated mistakes;
  work was duplicated.
- **Scope policed with prose.** Nothing held when an agent decided to wander.

We do not need to fit the old systems. Expeditions are built from new
primitives, using the history only as evidence.

## The idea in five choices

1. **Progress is verified claims, not finished tasks.** Nothing counts until an
   independent Check passes it.
2. **Agents are disposable; memory lives in the ledger.** Every attempt ends
   with one typed result. Stopping is normal; the next tick picks up.
3. **Failures are diagnosed by re-running, not by asking.** Controlled re-runs
   separate "the child slipped" from "our brief was bad" from "the plan is
   wrong".
4. **Scope is held by budget.** An explore share plus a parking lot, not
   instructions asking agents to stay focused.
5. **Human steering becomes code.** Owner lessons turn into playbook rules and
   brief changes, so the tool improves across expeditions.

## How the owner experiences it

- In a Buddy chat: "launch expedition: get wind setup right in Engine E, $3".
- It plans, runs on its own, and puts a live **badge** in the chat:
  `⛺ e-wind · running · 4 live · 3 verified · $1.12 / $3 · 2h10m · 1 needs you`
- Clicking the badge opens the **inspector**: questions, runs, results, timeline,
  parking lot, self-reflection.
- `@e-wind why did you drop the variational approach?` gets an answer citing runs.
- When it ends, a **retro**: its self-assessment plus the owner's notes become
  playbook rules, brief changes and tool issues.
