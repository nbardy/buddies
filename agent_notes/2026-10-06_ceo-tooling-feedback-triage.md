# Wave_sim CEO tooling feedback: triage and fix lanes (2026-10-06)

Asked by: owner, #case-studies post_01a10e04-f590-7574-a49e-ca329af4d006 ("turn into bug fixes or
ai improvements and change and fix them, dial it in and merge and commit and push"). The source is
the Wave_sim CEO's feedback (conv 298f67c6) after coordinating ~15 workers.
Decision-maker: the owner directed the fix, merge and push. The lane split and the design choices
below are the lead's (assistant) decisions, made under that direction.
Code state read: main 0f6e91f. Triage was done by an Explore subagent, which cited file:line.

## Triage (what main does today)

| # | Feedback | Finding at 0f6e91f | Lane |
|---|---|---|---|
| 1 | runs list / tasks get / inbox reach 60–95k chars | No output cap anywhere (`callTool` stringifies as is). runs list has no status or limit filter, and buddy/task scopes return the 20 newest runs ever, each with full error and input. tasks get returns full children, 20 full comments and uncapped evidence. inbox is uncapped, and `waiting_on` is not workspace-filtered. An open Task already covers this: task_01a0e746. | R |
| 2 | No run transcript | runs get returns metadata plus the final text only. The `MessageSource` page reader already exists (`conversations/messages.ts`). | R |
| 3 | A request in a 2-member DM starts both | `ask()` sets owed_by to every non-author member. No assignee exists. | W |
| 4 | channel_read {search} validation errors after the restart | The relay is a byte forwarder and the backend rebuilds tools on every request. The agent CLI caches tools/list for the whole turn, and adopted turns keep their CLI across restarts, so a turn that started before 74d1fd3 sends `search: "string"`. | R |
| 5 | A restart killed runs and nothing resumed them | Adoption covers journaled turns. A run whose process really died ends at the claim gate as `lease_expired` (not "interrupted": the tool description is stale). After that, the only option is a manual `runs retry` (f58783d). | W |
| 6 | No "what is each Buddy working on now" view | runs list {buddyId} puts live runs first but has no task title or post purpose. team get has no runs. | R |
| 7 | Schedules on one task can't see each other | No task-level gate exists. Dedup works per schedule slot only. The schedule prompt doesn't mention other runs. | W |

## Lanes

- **R: read surface** (Sonnet: the done criteria are concrete). This lane covers items 1, 2, 4 and 6, and the stale "interrupted" description.
  - **Item 4:** accept the legacy string form at ingestion (κ: string → `{text}`). This is canonicalization at the boundary, not a fallback. Without it, every turn adopted across a schema change breaks.
- **W: run and request semantics** (Opus: items 5 and 7 carry design choices). This lane covers items 3, 5 and 7.
  - **Item 7 constraint:** a task gate must not serialize deliberate fan-out. A lead that starts N workers on one task must still get N concurrent runs. The gate therefore applies to scheduled runs only.
  - **Item 5 constraint:** an automatic retry has to be visible and recorded as a new attempt, bounded to one, never silent. A worker's partial work stays on disk in its worktree, so the retry has to be told that it is a retry.

## Process note

The triage subagent ran `sqlite3 -readonly` against the live `~/.buddies/buddies-v3.sqlite` to
find existing Tasks. That breaks the AGENTS.md rule (never open the live stores from outside the
backend). Nothing was written and the backend did not crash. Future triage prompts must forbid it
explicitly.

## Revisit if

The owner wants task-level serialization for all runs (not only schedules), or automatic retry
without the one-attempt bound.

## Successor, 2026-10-06 (same session): lanes cancelled, replaced by a systems design

The owner, in the same thread, said: "don't necessarily agree with their suggestion, but take their context and turn it into systems design."
Both lane workers were cancelled minutes after they started: run_01a10e09-02fe (R) and run_01a10e09-2494 (W).
They were building the CEO's literal asks. Two lane W choices also contradicted owner direction:
- auto-retry went against the CORE_DESIGN 09-14 report-and-lead-directs wording;
- the `to` field was new surface where mentions already exist.
The replacement proposal is `agent_notes/2026-10-06_coordinator-at-scale-design.md`, status PROPOSED.
Tasks task_01a10e08-bb22 and task_01a10e08-d781 are blocked until the owner decides.
