# Expeditions

> An expedition turns a fuzzy goal into independently verified results, using
> disposable agents, an append-only ledger, and a human who steers by teaching
> lessons.

Status: **built on branch `feat/expeditions`** (2026-11-01; design.md Revision 2, R1–R7). Tested
end to end through the real Buddies crate and MCP endpoint; not yet run on a real goal. See
[As built](#as-built-2026-11-01-branch-featexpeditions) and [How to start one](#how-to-start-one).

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

- In a Buddy chat: "Launch an expedition: get wind setup right in Engine E. Done when
  `pnpm test wind` passes. Budget 20 attempts." (see [How to start one](#how-to-start-one)).
- It plans, runs on its own, and puts a live **badge** in the chat:
  `⛺ e-wind · running · 4 live · 3 verified · 9/20 · 1.3M tokens`
- Clicking the badge opens the **inspector**: questions, runs, results, timeline,
  parking lot, self-reflection.
- `@e-wind why did you drop the variational approach?` gets an answer citing runs.
- When it ends, a **retro**: its self-assessment plus the owner's notes become
  playbook rules, brief changes and tool issues.

## As built (2026-11-01, branch feat/expeditions)

| Piece | Where |
|---|---|
| Engine: ledger, fold, decide, effects | `server/src/expeditions/model.ts`, `host.ts` |
| Briefs (manager / work / blind check) and answer parsing | `server/src/expeditions/briefs.ts` |
| Charter schema, launch defaults, draft issues/advice | `server/src/expeditions/charter.ts` |
| The `expedition` Buddy tool (draft, launch, status, list, steer) | `server/src/expeditions/tool.ts` |
| Measured attempt cost (tokens from the run's sessions) | `server/src/expeditions/meter.ts` |
| Page data `GET /api/buddies/expeditions/:id` | `server/src/expeditions/view.ts`, `routes.ts`; type `shared/src/expedition.ts` |
| Badge chip in any post list (thread, DM, channel) | `client/src/components/buddies/ExpeditionBadge.tsx`, branch in `ChannelPostContent.tsx` |
| Page `/expeditions/:id` (focus pane + chat) | `client/src/components/buddies/ExpeditionPage.tsx` |

Where things land:
- **Badge**: one post (purpose `expedition_badge`, evidence `expedition:<id>`) in the chat the
  launch came from; the tool result also returns a markdown link (DM transcripts render it).
- **Expedition chat**: the owner↔crew DM. Every update (questions, starts, results, checks,
  reflections, lessons, needs-you, finish) is a crew post there; the owner's post wakes the crew.
- **Attempts**: requests in the crew's note-to-self DM (plumbing), shown on the page with their
  exact instructions.

Crew roster: `crew: { manager, work[], check[] }`, each `{provider, model?, reasoningEffort?}`.
The manager picks a work seat per attempt; checks run as panels (1–3) on seats other than the
claim author's model and verify by strict majority.

Integration (design.md R3): the expedition owns `expedition/<id>`, checked out in one clean
Cambium tree; the manager's `integrate` merges a validated claim's commit there (`--no-ff`, one at
a time), done validates that head, and the finish post names the branch for the owner to merge.

Cost (design.md R6): each ended attempt records `attempt_metered {cost}` once its Buddy run(s)
settled: the provider-counted tokens of every session the run conversations bound
(`measured {inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens}`), or
`unmeasured {reason}` (a provider that records no usage, a request answered without a run). The
page header, the badge and `status` show the sums and how many attempts are not measured. Tokens
only: no dollar figure, because only an estimate could price them.

Kickoff (design.md R7): a launch names only the WHAT (name, goal, done, maxAttempts); scope,
maxLive (2), hours (8), exploreShare (0.2) and crew (the default crew: manager claude; work
claude, codex; check codex, claude) may be left out, and the tool result lists every default it
applied (`defaulted`) with a one-line summary of what launched and the page link. `draft` runs
the same checks without launching: preflight (repository, base commit, Cambium, each command
check's binary), crew seats against the provider catalog, a work seat with no independent check
seat; plus advice (no command check, no out-of-scope fence).

Not built yet: external jobs (`Waiting(jobId)`), budget
envelopes for Buddy launches, the retro/playbook loop, archiving finished crews.

## How to start one

Type this to any Buddy, in a thread, a DM or a channel (one message):

> Launch an expedition: *make the widget tests pass on Linux and macOS*. Done when
> `pnpm test widget` passes. Budget 20 attempts.

What each part does:
- **Goal**: the fuzzy WHAT. The crew plans the steps; you never list them.
- **Done when**: say a command when completion can be tested (`pnpm test widget`, `cargo test -p
  foo`). The host runs it on every claimed commit and on the expedition branch at done; no agent
  can report it passed. Otherwise say what a reviewer should confirm ("the docs describe the
  fix"), or "I'll judge it".
- **Budget**: attempts (2–60). Optional extras, in plain words: "at most 3 at once", "stop after
  6 hours", "don't touch the website", "use codex for the work".

Variants that work:
- "Draft an expedition for … and show me the charter first." (the Buddy calls `draft`, shows the
  issues and defaults, and launches when you say go)
- "This looks big. Should it be an expedition?" (the Buddy checks the four tests in mcp.md)

After launch: the badge appears in the chat you asked in; click it for the page. Talk to the crew
in its chat on that page (or ask your Buddy to steer it): a lesson ("never edit generated files") reaches every later brief;
"pause", "resume" and "stop" do what they say. At done the finish post names the branch to merge;
nothing is written to your checkout.
