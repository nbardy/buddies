# Buddies: the lean core

Canonical conceptual design · September 13, 2026 · Buddies Development Lead

Start here before changing Buddy concepts, storage, tools or execution. This
document explains the accepted product direction and the reasons for its small
core. The owner requested this canonical reference and its code links. It does
not declare every behavior deployed or approve earlier speculative mechanisms.

Read the short [design philosophy](DESIGN_PHILOSOPHY.md) for the owner's words,
motivations and account of how this design evolved. This document translates that
intent into the core model and its authority boundaries. For concrete proposed
types, APIs, code structure and removals, see
[progress and returns](DESIGN_PROGRESS_AND_RETURNS.md). Current implementation
evidence and remaining gaps are labeled separately below.

## Purpose

A human should be able to discuss an outcome with a lead, have that lead organize
and delegate persistent work, and return to inspect evidence and steer the team.
Workers should continue useful work and communicate without requiring the human
to type at every handoff. The human must still be able to talk to the lead while
background capacity is occupied.

## Core design principle

Owner direction · September 14, 2026 · edited for clarity from the owner’s words.

**Unleashd has three core design components: Buddies, Mail and Tasks.**

The **Buddy** is the main entity the user interacts with. A Buddy has an identity
and access to tools for working with Tasks, Mail, Memory and ordinary files.
Conversations are sessions with that Buddy; the Buddy persists beyond any one
conversation.

Memory is an implementation detail of a Buddy that provides continuity across
sessions. Together with its saved
identity and configuration, memory turns an otherwise stateless LLM session into
a session with a particular Buddy: its role, preferences and useful accumulated
context carry forward. Each session still loads context; the system makes that
continuity explicit instead of leaving every agent to reconstruct it from scratch.

**Mail lets Buddies communicate and coordinate.** It preserves addressed messages
and replies across sessions, so communication does not depend on two Buddies
being active at the same time.

**Tasks give work a persistent identity and shared context.** They collect goals,
progress, decisions, evidence and comment threads around an idea or workstream,
rather than attaching that information to one Buddy. Different Buddies can
contribute to the same effort and recover its context as sessions and ownership
change. Tasks retain explicit work status and responsibility without requiring
an exhaustive progress log.

Buddies and Tasks both organize persistent information: **a Buddy collects
continuity around an identity; a Task collects continuity around an effort.**
Buddies use Memory for their own continuity. Tasks use their description, state,
comment threads and linked material for shared work context. This is shared
memory in the ordinary sense, not a second agent-memory subsystem.

Files remain a first-class foundation beneath these components. Much of
collaboration belongs in files: plans, notes, code, deliverables and checkpoints.
Buddies can save work, make useful commits and link those files from conversations,
Mail or Task comments. Files need no special registration or mandatory reporting
ritual. Formalize the identity and coordination that need system support; leave
collaborative content flexible.

### Conversations, Workers and the return to the spawning call

Owner clarification · September 14, 2026.

**Conversations carry the discussion, working context and tool-call history of
an agent session.** Human conversations let the owner talk to a Buddy; worker
conversations carry delegated execution; background lead conversations carry
review and follow-up. These use the same conversation infrastructure, with
separate histories and explicit context inheritance. The Buddy's identity
persists across them.

**A Worker is a Buddy acting as a helper for a parent agent.** The parent spawns
work through an agent tool call, supplying the assignment and relevant context.
The Worker works in its own conversation and can retain that context across
related assignments. Its parent relationship outlives any single attempt or Task.

**The Worker's result responds to the call that spawned the work.** The return
must remain attributable to that originating call and assignment, so the spawning
agent can tell which request finished and assess whether the requested work is
complete. A launch acknowledgment only says work was started; it is not the
Worker's completion response. The response includes what was accomplished, what
remains or failed, and relevant evidence or file/transcript references.

The workflow is: agent calls Worker → Worker executes → Worker returns against
that call → spawning agent reviews the result → accepts completion or directs
further work. A finished execution is distinct from a completed assignment or
Task. The spawning agent checks the result against the assignment and evidence;
Task status changes through its existing authority.

For asynchronous work, “responds to the call” describes the causal link and
recipient, not a requirement to hold a provider tool invocation open indefinitely.
The existing background return path brings the spawning agent back with the
launch context and correlated response. When launched from a human conversation,
review runs in the separate background branch described below, keeping the human
chat available. Mail can preserve and transport the reply through existing
coordination; it must retain the connection to the spawning request.

Completion, timeout and failure must be distinguishable. After interruption,
return the actual execution state and the worker's report when available, or an
explicit unavailable-report fallback. Reporting and continuation still obey
existing limits, stop/drain rules and authorization. Neither a return nor a “done”
claim automatically restarts work or completes a Task.

This clarifies the product contract, not shipped provider behavior. The
asynchronous correlation wording is an editorial interpretation that preserves
the earlier owner direction on background review; exact transport and tool-result
representation remain implementation choices.

### How the design evolved

The owner describes Unleashd's starting point as a simple set of conversations.
Each thread wrote notes to files, and later threads used those files to recover
information. This worked surprisingly well, but each new agent session had to
find the relevant notes and reconstruct who it was and what the work needed.

The current direction keeps that successful file-based pattern and adds explicit
continuity. Buddies carry agent context forward through memory; Tasks provide a
lasting home for work context shared across Buddies; Mail preserves communication
between them. Files still hold much of the detail. The improvement is dependable
organization and retrieval across sessions, not the elimination of context loading
or the replacement of files with managed records.

This history is the owner's account recorded on September 14, 2026, rather than
an independently reconstructed implementation timeline. These components describe
the intended design; they do not assert that every workflow is already implemented.

### Test for future design decisions

Use this passage as the starting point for Buddy design changes. First ask whether
Buddies, Mail, Tasks, ordinary files and existing conversations can express the
workflow. Add formal structure only for a concrete missing responsibility or
invariant, with a clear owner and evidence that existing primitives are insufficient.
Keep the responsibilities distinct; link them instead of duplicating their state.

Owner clarification · September 15, 2026 · edited for clarity.

The target is a lean API, lean MCP, lean data model and minimal understandable
code that makes this core dependable. Backlog entries are review candidates;
discard or merge unnecessary work. Prefer a small correction in an existing
authority, deletion, documentation or no code change. Added surface must address
a demonstrated core workflow failure that the existing primitives cannot handle.

Owner clarification · September 16, 2026.

Any expansion of the design, API/MCP or data model requires manual owner review
and explicit approval before implementation. Present the exact before/after,
demonstrated need, alternative using existing primitives and code/schema impact.
Changing an existing tool's output contract also counts. Existing-contract
correctness repairs may proceed within the authorized work scope.

Workers reuse Buddy identity and memory. Conversations and runs retain the existing
context, execution and limit machinery. This principle guides their composition;
it does not remove the runtime guarantees needed to operate them reliably.

## Motivating cases

These are design examples, not claims that live end-to-end tests have passed.

### One helper, several related outcomes

The lead asks a design Worker to clarify budgets, refine Worker behavior and
prepare the related implementation. Each outcome has its own Task and evidence.
The same Worker retains useful context as the work moves between those Tasks.
Finishing the budget Task does not destroy the helper or its learning.

This is why the parent owns the Worker relationship and Tasks own outcomes.
A task-owned Worker would couple identity and context lifetime to checklist
boundaries. A separate Batch entity adds nothing to this example.

### A saved design, a directed handoff, and a review

A Worker saves a design file and sends its lead a short Mail: what changed, what
needs review, and where to read it. The lead reads the actual artifact and records
the resulting work decision on the Task. Later another Worker can discover the
reasoning in `agent_notes/{optional_group}/{datetime}_{topic}.md`.

Files preserve detail; Mail directs attention; Tasks preserve current work state.
A file does not need registration as a Document before anyone can use it. A short
question can remain entirely in Mail. Sending a reference does not prove the
recipient read or accepted the artifact.

A checkpoint can itself be an ordinary file recording saved work and useful
resume guidance. Link it from Task comments, conversations or Mail when helpful;
no checkpoint-specific file type or write API is needed in the proposed model.
Writing a file does not automatically make it curated Memory or notify anybody.

### The owner talks while implementation continues

A Worker is implementing a change when the owner asks the lead about priorities.
That human Conversation remains available independently of background quotas.
The lead can inspect work and issue authorized direction. A Worker report can
bring the lead back through background coordination without creating a human
message or injecting an autonomous turn into the owner's chat.

Human interaction and background execution have different lifetimes. They can
share runtime infrastructure while keeping admission and conversation placement
distinct. Actual host/provider failure still needs an honest error.

### A background lead reviews a worker return

The owner and lead discuss an outcome, constraints and priorities in a human
Conversation, then the lead launches a Worker. A report, completion or timeout
wakes **the lead**, in a separate background management conversation. The lead
needs the discussion that motivated the assignment as well as the new result;
the assignment text alone may omit an important owner constraint.

The first review inherits the launching conversation's context through the
launch boundary. Later returns resume that same background management history,
so prior reviews and redirections remain available. The Worker's execution
conversation stays separate and retains its own context when continued. The
human chat remains usable; later human messages are not silently mirrored into
the background branch. Further owner direction must be delivered explicitly.

Each wake carries the original assignment; the actual event (completion, timeout
or message); the returned report; current project criteria/state, execution state
and remaining limits; and a host-resolved reference to the worker transcript for
inspection. Progress may be recorded in Task comments, ordinary note files,
commits and correspondence, with relevant references attached wherever useful.
These surfaces are complementary; no mandatory reporting ritual or exclusive
progress store is required. Missing reports or transcript files are identified
as unavailable. Existing checkpoint records remain historical evidence while
their dedicated write workflow is proposed for retirement.

The lead inspects enough evidence to decide whether to accept the work, continue
or redirect the existing Worker, stop the work, or assign another Worker. It
records its decision and evidence through existing Task/Mail operations and
performs the authorized next action. Waking the lead or printing a recommendation
does not by itself complete that management step.

The runtime supplies fresh tool definitions, responses and current authority on
every wake. Historical tool calls/results explain prior work; they are not live
capabilities or new grants. Continuing context does not replay old owner-control
tokens, extend a budget or convert a worker's report into owner authorization.
A background branch inheriting private owner context must preserve that audience
through execution, memory review and persistence; it cannot be copied into the
current workspace/project audience merely because the same Buddy owns both.

This is owner-requested behavior clarified on September 13. Full launch-context
inheritance, transcript references and this complete review input are requirements,
not claims about the current implementation. Native provider forking versus an
explicit transcript handoff is an implementation choice; neither may silently
claim to carry history it did not receive. Reuse the existing conversation,
admission, tools and continuation paths rather than adding a review supervisor.

### A process stops before the outcome is complete

A bounded attempt expires after saving partial work. The Buddy identity, Task,
Mail and saved files remain. The parent inspects evidence and effects before
authorizing continuation through the existing work path. A process exit neither
completes the Task nor retires the Worker. A late message cannot revive stopped
work. Cancellation keeps execution ownership until the provider exits and drains.

This is why identity, outcome, correspondence, execution attempt and limits must
remain distinct even when one workflow touches all five.

The September 14 owner direction adds a reporting handoff: after interruption,
branch the worker's conversation so it can review its goals and saved work and
report to the lead. The lead then reviews and directs continuation, adjustment
or a pivot. The proposed implementation gives reporting an explicit bounded
allowance, preserves stop/drain authority, and supplies a fallback when reporting
is unavailable. It does not automatically restart after an explicit user stop.
See [the progress and returns draft](DESIGN_PROGRESS_AND_RETURNS.md) for proposed
types, code boundaries, checkpoint retirement and verification. This is design
direction, not implementation evidence.

## Data model and authority

This is a conceptual map, not a proposal for new tables or a schema rename.

| Concept | Owns | Relationships and lifetime |
|---|---|---|
| Buddy | Durable identity, role, model preference and common memory lifecycle | Participates in workspace/team relationships; survives provider turns |
| Worker | Ordinary Buddy in temporary Worker mode | Exactly one parent through the existing manager relationship; may receive several related Tasks |
| Task | Persistent workstream identity, outcome, accountable Buddy, criteria, progress, blockers and evidence | Existing Buddy-owned project plus embedded todos; anchors communication across agents and attempts |
| Mail | Directed correspondence, replies and delivery history | Sender/recipient Buddy references and optional work context; delivery is distinct from execution and completion |
| Conversation | Session discussion, working context and tool-call/result history | Human, worker execution and background lead review contexts use existing infrastructure; preserve launch provenance and audience |
| File | Collaborative work: code, designs, notes, checkpoints and deliverables | Ordinary path, with commit/hash when the exact version matters; linked from conversations, Mail or Tasks |
| Execution context/run | Provider session continuity, admitted attempt and execution result | Existing runtime links Buddy, work and authorized audience; no second Worker executor |

`Task` maps to existing `BuddyWorkProject`/project APIs; a repository Workspace is
a different scope. Embedded todos are steps with completion criteria, not workers
or independent executors. Preserve existing IDs and revision checks.

The existing conversation infrastructure also stores background contexts. Human discussion, worker execution and lead review do not require a parallel
session store. Worker returns retain their link to the originating agent call
through this existing infrastructure.

There are deliberately several independent facts: a Task can remain unfinished
after a successful turn; Mail can be delivered while execution is held; a Worker
can remain available after one Task is done. Read each fact from its authority.
Do not copy current Task status into memory, Mail metadata or a Worker ledger and
then reconcile competing writers.

## Composition rules

1. **Reuse ordinary Buddy infrastructure for Workers.** Identity, parent edge,
   memory, inbox, continuation, admission and retirement keep their established
   owners. Standing teammates remain ordinary Buddies. Inspectability under a
   parent is a presentation choice; hiding a roster entry grants no authority.
2. **Reuse compatible context without widening access.** Related Tasks may share
   a Worker's context. A common memory implementation does not copy a parent's
   private memory. Parentage or a Task reference does not grant private audience
   access. Preserve configured provider values through the canonical resolver.
3. **Keep one active background work executor per Worker.** Incoming work and
   communication use existing admission/continuation. Human foreground capacity
   is independent. Do not add a parallel Worker mailbox execution loop.
4. **Separate information from authority.** Mail may carry a question, result or
   work request; execution still requires the existing authorized admission path.
   Delivery alone cannot grant staffing, renew limits, revive stopped work or
   mark an outcome complete. An approval request is not an approval.
5. **Keep evidence with the outcome.** Save files before reporting them. Task
   completion follows the existing evidence-backed work contract. Neither a
   successful send nor a provider exit substitutes for that evidence.
6. **Use files and the common memory lifecycle.** Ordinary employees create and
   search notes with normal file tools; Workers receive ordinary Buddy memory
   initialization, review and refresh. Current work stays in Tasks. Restricted
   automatic memory maintenance retains its own mandate and authority.
7. **Use existing limits and recovery.** Select explicit work-request bounds;
   inspect effects before retrying. Stop, drain and settle/reassign obligations
   before retirement. Foreground deadlines remain explicit and separate from
   background limits.

File references must be accessible to the intended recipient and survive the
worktree that produced them. A hash identifies bytes but cannot recover a deleted
file. Keep private history private; ordinary files do not imply bulk export into
a shared repository.

## Why this core stays small

| Alternative | Why we do not choose it for this core | Tradeoff we accept |
|---|---|---|
| Worker owned by one Task | Related outcomes need one helper's continuity | Parent manages when the coherent body of work is finished |
| Separate Worker store, supervisor or memory system | Duplicates existing identity and lifecycle authority | Worker behavior must fit and improve shared boundaries |
| Managed Document plus employee knowledge CRUD | Ordinary files/search already carry briefs and detailed knowledge | File discoverability, permissions and lifetime need care |
| Separate Batch/Assignment truth for every handoff | Existing Task ownership and relationships express the motivating cases | Richer work graphs require their own demonstrated use case |
| Autonomous turns in human chat | Couples owner access/history to background coordination | Background work needs its own inspectable execution context. **Superseded 2026-10-06 (owner decision A): see "October 6 successor" below; this row is kept as history.** |
| New Worker lifetime budget ledger and candidate-acceptance protocol | The lean redo intentionally retained baseline work limits and completion | Advanced supervision and exact version acceptance are not promised |

The first and third choices are explicit owner corrections. The remaining
rationale is the assistant's synthesis of those directions and the accepted
lean redo, not a claim that the owner selected every implementation detail.

Small names alone do not establish a small system. Before adding a concept,
table, tool or controller, state the concrete workflow gap, why existing
primitives cannot express it, which component owns the invariant, and what old
code it replaces or why the addition is necessary. Compare the production diff
and verify the behavior through a real boundary. Reopen a choice only with a
concrete failure or new requirement; preserve its history with a dated successor.

## Accepted direction, implementation and open questions

**Accepted direction:** simple composable primitives; parent-owned reusable
Workers; foreground independence; ordinary notes plus directed Mail; common
Buddy/Worker memory; complementary Task comments, commits, notes and messages.
Conversations and Workers explicitly compose these components, with worker
results responding to the spawning call for agent review. This document
consolidates those choices.

**Isolated implementation evidence:** app `9cfd997dc7446876f31544cdca0ccfb0da5a4c97`
and package `62769689116b18b2cc5532639d6165da427d00a9` implement the lean redo from
app `c3cdfa8` and package `03638bd`. Its handoff reports ordinary project assignment
and `send` work delivery/continuation, one Worker mode column and relationship
integrity triggers, and reuse of admission, memory and drain/retirement. Combined
production change was +79/-240, excluding tests/docs/archive. It retains baseline
evidence-backed completion and explicit per-request limits. The preserved
[source record](core-design-sources-2026-09-13.json) includes the complete handoff.

That evidence is from an isolated branch, not proof of the running app. Its app
checks depended on existing uncommitted agent-cli source. Browser/live-provider
behavior and autonomous artifact review remain unproven. The current checkout
can still expose legacy employee knowledge tools; this documentation does not
remove them or migrate stored history.

**Open or deferred:** exact automatic check-in/required-review mechanics, Worker
lifetime accounting, exact artifact-version acceptance, automatic Mail attention
semantics, and separate native Mail/Prompt operations. The earlier expanded
design's APIs and timing presets are not requirements to rebuild them. Mail,
Prompt and “Desk turns” originated as assistant naming proposals; use the actual
native contract when calling tools.

**September 13 follow-up:** the owner requested that work launched from a human
thread return completion/timeout to that Buddy in a separate background thread,
with an inline launch badge opening the worker thread. The local implementation
stores a background return route on existing Mail, reuses admission/execution,
and passes the scoped assignment/report rather than inheriting the launching
human conversation. Checkpoints are currently injected for failure notices;
the fresh review reproduced an omission for terminal managed-work replies.
Legacy mailbox history is not replayed. The owner's subsequent clarification
requires the background lead context described in the motivating case above;
the current implementation does not yet meet that complete contract. See the
[dated implementation evidence](../../agent_notes/buddies/20260913_background-returns-inline-links.md)
for tests, source hashes and the remaining live-provider verification limit.

**October 6 successor (owner decision A, 2026-10-06; supersedes the September 13
background-branch return and the "Autonomous turns in human chat" row above).**
An answer, failure notice or follow wake now returns to the conversation that
asked, an owner chat included. Reason: the owner and lead agreed the work in that
chat, and a lead that cannot continue there when its worker finishes (U2) leaves
the owner to relay results by hand. The September 13 concern, that the human must
still be able to talk to the lead while work is in flight, is kept by ordering
instead of exclusion: (1) an owner message queued in that chat runs before any
queued return (`owner_first` in the claim gate); (2) the owner's Stop cancels that
conversation's queued returns, whose posts stay unread (D1); (3) a return turn
resumes the chat's own provider session and is Buddy-authored, so a worker's
answer never runs with the owner's grant (D9, guard B1). Background
conversations return as before. Accepted by the owner as decisions A, B and C of
the delivery design review; design, alternatives and revisit conditions:
`agent_notes/2026-10-06_delivery-model-design.md` (D0, D1, D3, D9; uncommitted at
the time of writing). Revisit if the owner finds automated turns in their chat
noisy even with these three protections. The September 13 text above is kept as
history, not deleted.

## Reading map and decision evidence

This file owns the conceptual core and rationale. Detailed operating contracts
remain in the [team operator guide](TEAM_OPERATOR_GUIDE.md),
[coordination primitives](PLANNING_PRIMITIVES.md),
[automation ownership](AUTOMATION_OWNERSHIP.md) and
[limits specification](BUDGETS_AND_LIMITS.md). Check each document's implementation
and proposal labels; a historical design is not an instruction to add machinery.

The [owner-direction record](LATEST_HUMAN_DESIGN.md) preserves attribution. The
[earlier integrated design](worker-design-review-2026-09-13/07-final-design.md)
is historical context where it proposes mechanisms omitted by the lean redo.
The [files decision](../../agent_notes/buddies/20260913T063400Z_files-mail-memory-simplification.md)
preserves the explicit rejection of managed Documents and employee knowledge CRUD.

For historical citations, use [the dated source snapshot](core-design-sources-2026-09-13.json):
it contains source paths, SHA-256 hashes and full preserved text for the owner
direction, Worker correction, files correction, expanded design and committed
lean handoff. Mutable reading links above are navigation, not frozen evidence.

## Implementation evidence — September 14, 2026

The [lean implementation record](../../agent_notes/buddies/20260914_lean-workers-implementation.md)
updates the earlier implementation-gap assessment above. Correlated contextual
returns, reusable Workers, bounded interruption reports and Task comments are now
implemented locally. Real-provider normal and runtime-timeout workflows proved
artifact reading and lead acceptance while human chat remained available.
The record preserves source hashes, tests and limits: one provider verified,
bounded transcript handoffs, and no production deployment.

## Owner clarification and local closeout — September 14, 2026

Checkpoint-history preservation and backward compatibility are not requirements;
this supersedes the earlier assistant-selected preservation constraint above.
The verified delivery retired checkpoint writes/UI but still contains historical
readers and a rejecting compatibility adapter. See the
[dated closeout](../../agent_notes/buddies/20260914_delivery-closeout/README.md)
for the exact delivered boundary, fresh checks and local source preservation.
