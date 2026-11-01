# Expeditions

> An expedition turns a fuzzy goal into independently verified results, using
> disposable agents, an append-only ledger, and a human who steers by teaching
> lessons.

Status: **built on branch `feat/expeditions`** (2026-11-01; design.md Revision 2, R1–R9). Tested
end to end through the real Buddies crate and MCP endpoint; one live smoke on a toy repository
(design.md R9 lists what it found and the fixes); not yet run on a real goal. See
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
  `⛺ e-wind · running · 4 live · 3 verified · 9/20 attempts · 1.3M tokens` (attempts = work and
  checks; manager decisions are not budgeted, they have their own cap)
- Clicking the badge opens the **page**: tasks with their honest stage, workers (each with its
  exact instructions, branch, validations and result), reflections and the goal, beside the
  expedition chat; the header carries the integration line (branch, head, merges, last refusal)
  and the measured cost.
- Answer it in that chat: `pause`, `resume`, `stop`, `lesson: …` (binding on every later brief),
  or anything else as a note the manager reads next (it also answers a "needs you").
- `@e-wind why did you drop the variational approach?` gets an answer citing runs.
- Planned, not built: a timeline and parking-lot view, and a **retro** at the end (its
  self-assessment plus the owner's notes become playbook rules, brief changes and tool issues).

## As built (2026-11-01, branch feat/expeditions)

All engine code is under `server/src/expeditions/`. The pure core (no I/O) is re-exported by
`model.ts`; `host.ts` is the only I/O shell.

| Piece | Where |
|---|---|
| Ledger: the `Entry` sum type, folded `State`, `fold`/`apply` | `ledger.ts` |
| Decide: state → intent entries, every manager-action guardrail | `decide.ts` |
| Effects: the idempotent writes a state licenses (admission, releases) | `effects.ts` |
| Read-only queries (live, panels, custody, stages, seats) | `queries.ts` |
| Badge, chat news lines, outcome/validation/integration labels, cost totals | `news.ts` |
| Charter schema, launch defaults, draft issues/advice, answer schemas | `charter.ts` |
| Briefs (manager / work / blind check / repair), answer parsing, owner chat words | `briefs.ts` |
| Host: ticks (typed observation, failure backoff), one handler per effect, launch/steer | `host.ts` |
| Ledger file: durable append (fsync, cut back on failure), exclusive create, boot read | `store.ts` |
| Git: preflight, Cambium worktrees, claim checks, merges, releases | `git.ts` |
| Host-run command checks (curated env, process group, timeout) | `command.ts` |
| Measured attempt cost (tokens from the run's sessions) | `meter.ts` |
| The `expedition` Buddy tool (draft, launch, status, list, steer) | `tool.ts` |
| Page data `GET /api/buddies/expeditions/:id` | `view.ts`, `routes.ts`; type `shared/src/expedition.ts` |
| Badge chip in any post list (thread, DM, channel) | `client/src/components/buddies/ExpeditionBadge.tsx`, branch in `ChannelPostContent.tsx` |
| Page `/expeditions/:id` (focus pane + chat) | `client/src/components/buddies/ExpeditionPage.tsx` |

Where things land:
- **Badge**: one post (purpose `expedition_badge`, evidence `expedition:<id>`) in the chat the
  launch came from, posted by the host as the launching Buddy: in a thread or channel, a reply in
  that thread; in a DM, a threaded reply to the owner's launch message. The tool result returns
  the page path as data (`page`) and tells the Buddy the badge is already there; it posts no link.
- **Expedition chat**: the owner↔crew DM. Every update (questions, starts, results, checks,
  reflections, lessons, needs-you, finish) is a crew post there. Each owner message there is
  recorded by the host as steering (`feedback {via: chat}`): `pause`, `resume` (also re-plans:
  a new manager decision), `stop`, `extend 3h` (moves the deadline), `lesson: …`, else a note;
  the crew only acknowledges it.
- **Attempts**: requests in the crew's note-to-self DM (plumbing), shown on the page with their
  exact instructions. Answering one wakes nobody (the host observes it); the crew is never handed
  its own answers as new work (design.md R9, P1).
- **Where runs start**: a work or check attempt's run starts in its own worktree; a manager's in
  its own detached checkout of the expedition branch head (`<expeditions root>/<id>/manager`,
  reset before every decision; never the owner's checkout, never the integration tree); every
  other crew turn (a mention, the owner's chat, a worker it spawned) in the crew's
  own directory, `<expeditions root>/<id>/crew`, which is no git checkout; every other Buddy turn
  in its workspace root.

Crew roster: `crew: { manager, work[], check[] }`, each `{provider, model?, reasoningEffort?}`
(a model may be the owner's words, e.g. `haiku`: it resolves to the catalog id at launch).
The manager picks a work seat per attempt; checks run as panels (1–3) on seats other than the
claim author's model and verify by strict majority.

Acceptance is per question (design.md R11): every question the manager adds names how its claims
are accepted, `{t:'command', argv, timeoutSeconds}` (the host runs it on the claim's exact commit
in a fresh tree) or `{t:'panel'}` (an independent check panel). The charter's done commands run
only on the expedition branch head at done, never on a candidate unless the manager names one as
a question's acceptance, so preparation steps can integrate before the goal holds. A claim whose
command acceptance passed and that was integrated is verified (host-verified): its question closes
verified and it counts on the badge. Judged done items always need a goal panel.

Answers: an attempt's answer ends with a fenced json block (a final bare JSON object is accepted
too). One that cannot be read gets ONE repair request on the same seat (it quotes the answer and
the schema); a work attempt still unreadable after that whose branch holds commits ends as
`unreported_commits` with the shas, and the manager may `claim` one, which the host checks
against that attempt's branch and paths before it is validated like any claim.

Budget: `maxAttempts` counts work and check attempts. Manager decisions are bounded separately at
`2 × maxAttempts + 2` (finish reason `decisions_spent`), and a manager is woken only when it has
something to act on (never just to wait for a host validation or merge).

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

Safety boundaries (tested through the real MCP endpoint): a crew Buddy cannot launch or steer
(it could otherwise resume a run the owner paused); another workspace's Buddy cannot see or
steer an expedition; a host whose execution gate is disabled (a copied store) refuses launch and
steer and never ticks; a relaunch of a still-open name returns `alreadyRunning`, a finished name
launches anew. Recovery: each ledger line is one append batch, so a torn last line (crash during
the append) is cut off whole at boot; a ledger that does not read or fold is quarantined (the
page answers 409 with the reason) and the other expeditions keep running.

Closed gap (design.md R1, R9): Buddy runs used to start in the workspace root with only the brief
sending the worker to its worktree; they now start there (see "Where runs start").

Known, out of scope: killing the server can leave the Buddy MCP relay process running (it
predates expeditions; pre-existing Buddies behavior).

Not built yet: external jobs (`Waiting(jobId)`), budget
envelopes for Buddy launches, the retro/playbook loop, archiving finished crews.

## How to start one

Type this to any Buddy, in a thread, a DM or a channel (one message):

> Launch an expedition: *make the widget tests pass on Linux and macOS*. Done when
> `pnpm test widget` passes. Budget 20 attempts.

What each part does:
- **Goal**: the fuzzy WHAT. The crew plans the steps; you never list them.
- **Done when**: say a command when completion can be tested (`pnpm test widget`, `cargo test -p
  foo`). The host runs it on the expedition branch at done; no agent can report it passed. (Each
  step's own acceptance is the manager's: a test that can pass for that step, or a check panel.) Otherwise say what a reviewer should confirm ("the docs describe the
  fix"), or "I'll judge it".
- **Budget**: attempts (2–60): work and check attempts; the manager's decisions are not counted.
  Optional extras, in plain words: "at most 3 at once", "stop after 6 hours", "don't touch the
  website", "use codex for the work", "check with claude haiku".

Variants that work:
- "Draft an expedition for … first." The Buddy calls `draft`, and a **draft card** appears in the
  chat (where the badge would go): `⛺ Draft · <name>`, the goal's first line, the budget
  (`6 attempts · 3 at once · 12 h`) and two buttons. **Info** opens the expedition modal on the
  draft: goal, charter, issues, advice and every default it filled. **Launch** starts it through
  the same launch as the tool, re-checking the issues when you click; it is disabled, with the
  reason, while issues stand or after a newer draft of the same name replaced it. After launch the
  card reads **Launched →** and opens the live expedition. The Buddy replies in one line; it does
  not paste the charter or ask you to type "launch it".
- "This looks big. Should it be an expedition?" (the Buddy checks the four tests in mcp.md)

After launch: the badge appears in the chat you asked in (in a DM, as a threaded reply to your
launch message); click it to open the **expedition modal** over the chat (the URL is
`/expeditions/<id>`, so a link or a reload opens it too; on a phone it is a full-height sheet).
The header shows the status pill, attempts and decisions against their caps, live/queued/verified,
elapsed and time left, measured cost and the expedition branch (click to copy). Below it: a "needs
you" callout with a reply shortcut, the goal (rendered markdown, "Show more"), and tabs for
Workers (one card per attempt: kind, seat, stage, cost, validations, its instructions), Tasks
(stage chips, dependencies, paths), Reflections and Charter; the chat sits beside them on desktop
and is a tab on the phone. Esc, the backdrop or ✕ close it. Talk to the crew
in its chat in the modal (or ask your Buddy to steer it): `lesson: never edit generated files`
reaches every later brief; `pause` and `stop` do what they say; `resume` continues and re-plans
(after a host upgrade, `resume` is how a run stuck at "needs you" picks up the new rules; nothing
resumes by itself); `extend 2h` moves the deadline; anything else is a note the manager reads
next, which is how you answer a "needs you". At done the finish post names the
branch to merge; nothing is written to your checkout.
