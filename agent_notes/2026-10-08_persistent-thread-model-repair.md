# Persistent thread model repair — 2026-10-08

Task: task_01a105b0-2c7c-7527-bff6-aa092ec61da0. Request:
post_01a11b2b-ebba-732f-b99c-b722f2c0dd5f. Base:
4fcc0be34ba3f0cf92123e45f9ed00e000344ee9. Branch: fix/persistent-thread-model.

## Decision and evidence

This implements the owner's accepted selection rule, not a new product decision.
Owner reaffirmed it at 10:59Z in post_01a11b2a-a3bc-7746-8cbe-80c82d154f66,
thread post_01a117e1-1b0e-72e6-bef4-52b764bac275. Task revision 3 authorizes
correctness fixes and branch commit/push; release integration owns the combined cut.
Original October 4 decision (read October 8), uncommitted source SHA256 01e487e790edfa70aee97bd6ceb5b3d29622149e10345d4310bdea150186a441.
Preserved relevant excerpt: “A changed choice is an explicit override and persists for
subsequent replies, including after a failed attempt.” Its implementation predecessor
is 27027d637ebd86eaa4c1b30b6fc53d1b0487b3d2; implementation notes are preserved
in that commit at agent_notes/2026-10-04_thread-model-selection-refactor.md.
CORE_DESIGN was read at base 4fcc0be, including the October 7 background-return successor.

Concrete gap: a saved Codex thread choice projects correctly into the picker, while
an unconfigured delivery resumes an older subscribed Claude conversation. Owner
scope evidence: run_01a11b27-81d7-71f9-8ec3-10c7013a79b4 failed on quota in
e671d06f-843d-52db-beb4-bcdcae55ff1d at 10:55:39Z; the later reply ran in
8c0c0bfc-698d-5e15-afe3-621ef2af1cc5. Native tools supplied those run/post rows.
They do not record the original picker click and do not alone prove its configuration.
The foreign Game Designer thread was not opened through owner credentials or stores.

Failing-first temp-store owner-HTTP reproduction on the base: Claude seat follows
thread → explicit Codex Sol medium attempt fails → picker still projects Codex →
next unconfigured HTTP owner reply invokes Claude. Assertion failure preserved:
`subscription must not override chosen harness`: `'claude' !== 'codex'`.
This establishes the boundary defect independently of incomplete live click history.

## Implementation choice

Engineer recommendation within the accepted repair scope: every resumed thread
delivery resolves through the existing channels.openSeat / threadChoice authority.
Deleted the runner's unconditional subscribed-origin execution shortcut. openSeat now
receives the subscribed conversation as a candidate: a matching config or undecided
thread keeps that context; a differing saved/thread-history choice uses its canonical
seat. The existing record/provenance, provider-generation rule and CAS writer remain
authoritative. No new store/controller/schema/API, model translation or quota fallback.
The already-selected Codex session resumes; the old Claude native session is never
handed to Codex. Thread posts and saved older conversations remain available.

A request return is causally addressed to its requester and keeps that context/model.
Its worker's latest answer must not seed the requester from the worker model. This
exception preserves CORE_DESIGN's return-to-spawning-call contract; different-model
self-worker return evidence explicitly checks the parent invocation.
Revisit if a future owner decision changes that return contract, or concrete evidence
shows that independent thread choices need a different subscription policy.

The old comments were condensed to current behavior (preserving provider-generation,
gate, no-hop-cap and failure rationale). Counted Buddy source stays at 12005 with the
existing ceiling unchanged. Exact source/test deltas are in the artifact RESULT.

## Verification and limits

Tests use the actual crate, owner HTTP, MCP/grants, config records, runner and runtime;
only provider execution is substituted. The regression now includes earlier successful
Claude history, an exhausted Claude attempt, a failed chosen Codex attempt, all-fresh
services/runtimes over persisted stores, repeated unconfigured owner follow-ups, gate
config, invoked harness/model/effort, native-session separation and revoked grants.
Existing failed-choice/reopen/HTTP retry, default, per-Buddy, deleted/unavailable
history, worker return, subscription and steering tests remain.

The latest-history test now waits for terminal idle before each distinct follow-up:
its old polling stopped at the model's post, allowing the next input to be consumed as
live steering rather than creating the separate turn that test asserted. The first full
run exposed that fixture race; its log is retained. This is a boundary synchronization,
not a sleep or relaxed assertion. Focused tests pass after that change.

No client or CSS changes, so this candidate needs no new screenshot capture. No live
backend restart/turn cancellation, foreign-workspace reads, live store opening or paid
CLI trial. Historical picker intent cannot be reconstructed from an unsent screenshot.
Atomic steering/model-pick admission remains the separate acf0a1a / waiting lane.
This repair concerns next-turn selection, not changing a CLI's already-running model.
The event-loop stall monitor is untouched. Prompt/briefing construction is unchanged;
token-audit was run, with no before/after prompt-cost claim.

Post-commit checks and exact SHA are recorded in
/Users/nicholasbardy/.codex/artifacts/persistent-thread-model-2026-10-08/RESULT.md.
The parent/integration Task must combine this candidate with the waiting/race lane and
verify the resulting release commit. This note makes no production activation claim.
