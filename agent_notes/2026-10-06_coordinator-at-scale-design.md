# Coordinating many workers: systems design (proposal, 2026-10-06)

Author: Buddies Development Lead. Status: **PROPOSED**. The owner has not decided anything here.
Asked by: the owner in #case-studies, post_01a10e04 thread: "don't necessarily agree with their
suggestion, but take their context and turn it into systems design."
Input: the Wave_sim CEO's feedback after coordinating about 15 workers (conv 298f67c6), and the
triage at main 0f6e91f in `agent_notes/2026-10-06_ceo-tooling-feedback-triage.md`.
Governing doc: `product/buddies/CORE_DESIGN.md` at 0f6e91f. Two rules from it apply here:
- The test for design decisions: use existing primitives first, and add surface only for a demonstrated failure.
- The 2026-09-16 rule: an MCP or output-contract change needs explicit owner approval. Correctness repairs may proceed.

## The one diagnosis

The CEO spent about 30% of each review pass reconstructing state by **polling**. They re-read runs,
tasks and the inbox, then parsed the dumps with Python. Each complaint is one place where the system
makes the coordinator pull and reassemble something the system already knows:

| Feedback | Underlying problem |
|---|---|
| Outputs are 60–95k chars | Reads return storage records, not views sized for a decision |
| No run transcript | Workers' progress is invisible, so the coordinator audits raw sessions |
| A 2-member DM request started both | Audience (who can see) and obligation (who must act) are the same field |
| Search broke after the restart | A turn's tool schema is fixed when the turn starts; adoption lets turns outlive backend versions |
| The restart killed runs, recovery was manual | A dead attempt ends the *assignment*, and `retry` starts the worker from zero |
| No "what is it working on now" view | Run rows don't say what the run is for |
| Schedules on one task can't see each other | A Task is the unit of coordination, but runs on it are blind to each other |

The CEO's asks (status filters, `limit`, `to`, auto-retry, task locks) add knobs to each of these
symptoms. The proposal instead fixes the six structural causes below. Each one names the existing
primitive it reuses.

## S1. Reads are decision-sized views (items 1, 6)

**Principle:** a list returns summary rows plus a `next` cursor, and detail is one call away by id.
This is the shape `channel_read` already has (`{posts, next}`). Size problems are fixed where the
data is written, not by trimming it when it is read.

- **runs list:** buddy and task scopes use the same window the workspace scope already uses (live
  first, then runs ended in the last 12 h). They page with `before` instead of a fixed 20. Each row
  adds `purpose` (from the request post) and `taskTitle`, a single join in `list_run_rows`. That join
  answers "what is it working on now" without a new view or tool. It drops the CEO's `status` filter:
  live-first ordering plus paging already serves it.
- **tasks get:** child rows are slim (`id, title, status, owner`), comments are previews with `next`,
  and evidence is capped **at write**. Evidence entries are links, not dumps: ≤ 32 entries of ≤ 500
  chars, the same discipline as post evidence. A typed error on write tells the writer to put long
  content in a file. Uncapped evidence is why `tasks get` blew up.
- **inbox:** request rows carry a body preview, `waiting_on` is scoped to the workspace (a
  correctness repair), and channel rows list only those with unread posts, plus a count of the rest.
- **One guard at the boundary:** a result over the budget (about 20k chars) fails a server test. It
  is not truncated at runtime. The views above are what keep results under budget, and silent
  truncation would hide the next regression.

**Rejected:** a generic output cap in `callTool`. It truncates JSON mid-structure and hides what was
lost.

## S2. Workers make progress visible; coordinators read returns, not transcripts (item 2)

CORE_DESIGN already says a worker's return carries what was accomplished, what remains, and
evidence or transcript references. The CEO read transcripts because returns and progress were thin,
not because transcripts were the right tool.

- **Behavior:** the worker briefing says to post a short progress note on the Task at each
  milestone, and that the final answer must carry evidence and paths. Posts are the only channel
  anyone reads. This is the same rule the owner set for channel turns (2026-09-25).
- **Audit path:** `runs get {runId, tail: n}` returns the last n assistant texts and tool-call names
  (arguments truncated) from the run's conversation. It is read through the existing `MessageSource`
  that already serves `GET /api/conversations/:id/messages`. This is for a coordinator verifying a
  doubtful return. It is not the primary channel.

**Rejected:** exposing a general conversation-read tool. It overlaps `channel_read` and would invite
transcript polling.

## S3. Obligation is explicit, and mentions address it (item 3)

Today `ask()` makes every other DM member owe the request. Audience and obligation are one field.

- A request is owed by the Buddies it **@mentions** (`[@Name](buddy:id)`, the syntax channels
  already use).
- In a DM with exactly one other member, that member is owed implicitly, which is today's behavior
  for every 1:1 DM and every self-DM worker request.
- A request in a multi-Buddy DM with no mention is a **typed error** that lists the members. It
  never silently starts everyone.

**Rejected:** the CEO's new `to` field. It adds surface where mentions already exist. "Just use 1:1
DMs" needs no code but leaves the double-start trap armed.

## S4. Tool schemas are a contract with long-lived clients (item 4)

An agent CLI fetches `tools/list` once per turn. Adoption (the owner's direction) keeps turns alive
across backend restarts. So every MCP input schema has clients running the previous version.
74d1fd3 changed `channel_read.search` from a string to an object, and adopted turns failed
validation.

- **Rule:** input schemas evolve additively. A breaking reshape keeps the old form, canonicalized
  once at ingestion (string → `{text}`). That is a κ at the boundary, not a fallback.
- **Guard:** a snapshot test of every tool's input schema fails on a non-additive change unless a
  registered legacy canonicalizer and its test exist.
- **Correctness repair, no approval needed:** accept `search: string`. Also fix the `runs`
  description, which says `interrupted` where the real code is `lease_expired`.

## S5. An attempt can die; the assignment survives (item 5)

Today, a worker whose process dies (host reboot, group SIGKILL; adoption covers only backend
restarts) ends as `lease_expired`. Its request is marked failed, the sender gets a FailureNotice,
and `runs retry` starts a **fresh conversation**. Everything the worker knew is gone, and recovery
means manually re-dispatching from scratch.

The prior owner direction (CORE_DESIGN, 2026-09-14) is to branch the worker's conversation so it
reviews its goal and saved work and reports. The owner's 2026-09-30 bug report: "Restarts should not
cause dropped background workers."

**Proposal:** split failures into typed classes, each with one handler.

| Class | Codes | Handler |
|---|---|---|
| Infrastructure | `lease_expired` (holder died) | **Continue once, in the same conversation.** One new turn in the worker's existing conversation: "Your previous attempt was interrupted at T by a host restart. Check what is on disk and continue the assignment." It is recorded as attempt 2, and its answer returns to the requester as usual. A second infrastructure death sends the FailureNotice, as today. |
| Agent | error, deadline | FailureNotice to the requester, as today. The lead decides. |
| Stop | user stop, cancel | Nothing. An explicit stop is never undone (CORE_DESIGN). |

`runs retry` on a Post run also continues the same conversation when the provider is unchanged. A
different provider cannot resume a session, so it starts fresh with a pointer to the old
conversation.

**Decision needed:** continue the assignment (proposal), or only *report* and let the lead direct
(the 09-14 wording). The 09-30 report argues for continue. A host restart is no one's decision, and
the assignment is still authorized.

## S6. Runs on a Task can see each other (item 7)

- Any run with a `taskId` is briefed with the other live runs on that Task: who, purpose, and since
  when. This gives awareness, not a lock, so deliberate fan-out stays parallel.
- A schedule fire is skipped and recorded when the **same schedule's** previous run is still live.
  This stops one automation from piling up on itself. Two *different* schedules on one Task now see
  each other through the briefing, and a lead can merge them.

**Rejected:** a task-level lock (`task_busy`). It would serialize fan-out.

## What needs approval vs. what can proceed

- **Proceeds now (correctness repairs):**
  - S4: legacy search form plus the description fix.
  - S1: workspace scoping of `waiting_on`.
  - S1: buddy/task scope window parity in runs list.
- **Needs owner approval (contract changes):**
  - S1: purpose and title columns, slim task detail, write-side evidence cap, inbox previews.
  - S2: `tail`, and the worker briefing change.
  - S3: mention addressing plus the typed error.
  - S4: the schema snapshot guard.
  - S5: failure classes, continue-once, retry in the same conversation.
  - S6: the task briefing and schedule coalescing.

## Revisit if

- Coordinators still poll after S1/S2 land. Measure with `pnpm token-audit --tag buddy` on the next
  multi-worker night.
- A continue-once run duplicates side effects. That would argue for report-only (the 09-14 wording).

## Successor, 2026-10-06 ~06:50Z: folded into the delivery-model design

The owner asked (#case-studies, post_01a10e04 thread) whether this overlaps the delivery-model thread
and whether the two should be unified. They should. Both are the same Buddy's work. The delivery design is
`agent_notes/2026-10-06_delivery-model-design.md` (Opus design worker, run_01a10fdd, written at
main 47c5f40, file mtime 2026-10-06 14:26 local). It is the spine, because it removes paths where this
note mostly added rules. This is an assistant proposal; there is no owner decision yet.

| This note | Under the delivery model |
|---|---|
| S3 who owes a request | Same mechanism. The delivery design already passes `PostInput.mentions` to the crate and keeps `request` as the obligation only. Amend it so that a request's owed_by is the mentioned Buddies. A 1:1 DM addresses the other member implicitly, and a multi-Buddy DM with no mention gets a typed error. No new field. |
| S5 restart continuity | The delivery design makes a failure notice a post in the request thread. Amendment: a run whose holder died re-enters the SAME conversation (the run table is that conversation's durable queue). That applies to a manual `runs retry` too, when the provider is unchanged. Continue vs report is still the owner's call. |
| S6 schedules on one Task | Candidate simplification: a schedule fire becomes a post into its Task thread, and the one rule delivers it. A busy conversation coalesces the burst into one turn, so S6 needs no separate skip logic. Path 9 merges into the rule. |
| S4 schema contract | Applies directly. The delivery design changes `channel_read.follow` (`until` removed, `wait` added), which is the same breaking-change class as 74d1fd3. The legacy `follow:{until}` must be canonicalized at the boundary, and the snapshot guard should land first. |
| S1 decision-sized reads, S2 tail | Orthogonal to delivery. They remain a small separate read-surface track. The delivery design also makes polling unnecessary: the inbox description says "you do not need to poll this". That removes most of the reason for big reads. |

The S1/S4 correctness repairs landed: bc417ce, merged as 3838b65 and pushed. The cancelled lane
worktrees `_wt/buddy-read-surface` and `_wt/buddy-run-semantics` have no commits and no changes;
cambium refuses to remove worktrees containing submodules.
