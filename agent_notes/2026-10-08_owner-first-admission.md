# 2026-10-08 — Owner messages bypass occupied Buddy capacity

Question: should an owner post wait behind the Buddy's own workers when all five slots are occupied?

Accepted owner decision: no. The task records owner approval at 2026-10-08T07:31Z,
post_01a11a6c-8660 in thread post_01a117e1-1b0e-72e6-bef4-52b764bac275,
“fix the root issues… fix and commit all and push”, approving the lead's proposal
post_01a11a67-d4f3, “a reply to you never waits on the run limit”. These excerpts are
preserved from task_01a11a6d-4075-754e-be99-dfcc1caa2e5a revision 1, read through native
`tasks get` on 2026-10-08. The implementation request also explicitly authorizes pushing
main. The original approval post was not independently re-read in this implementation turn.

Implementation choice (engineer): one typed `Admission` on the existing run, classified from
its triggering post's author at enqueue. Owner chat intake is owner admission; schedule
fires (chat inputs without a conversation), worker requests and Buddy posts stay capped.
The shared waiting/claim predicate bypasses only the pool cap. Retries retain classification;
upgrade classifies old inputs once in the column-add transaction, so an already queued owner reply is repaired too.
No new queue or controller, and no authority grant is changed.

Motivation/evidence: the Task reports that dc299ec removed the one-hour background deadline,
and five running workers could block the owner's reply for hours. The failing-first crate
regression reproduces five self-spawned workers running plus three older workers queued:
an owner delivery cannot be claimed under the old predicate, while Buddy work remains held.
With the fix, DM wakes, mentions and followed-thread owner replies each take the sixth slot.

Tradeoff: the Buddy can exceed its configured cap while answering the owner; capped work still
counts all active runs and stays queued. Waiting for capacity preserves a strict count but
breaks foreground availability. Stopping workers to free a slot disrupts useful work. Separate
queues duplicate admission state. The existing one-turn-per-conversation rule remains; live
steering is separately assigned to task_01a11a68.

Historical basis: product/buddies/CORE_DESIGN.md at f1011d0 (the worktree base) says:
“The human must still be able to talk to the lead while background capacity is occupied.”
The design already calls for foreground independence, so this is an existing-contract repair.
docs/patterns.md at f1011d0 defines one shared waiting/claim predicate; this change retains it.

Revisit if repeated owner-triggered work causes measured resource exhaustion. Any later bound
must preserve owner responsiveness and remain independent of the workers' capacity.

Validation at the implementation milestone: all 87 Rust tests pass, including the four new
owner-admission guards (five workers/three queued across three delivery routes, capped Buddy
post, busy owner conversation, upgrade plus retry persistence). Addon and server/type checks
are recorded in the Task and final handoff once complete; this note does not claim them early.

Line-ceiling adjustment: +34 production lines for the accepted durable classification, additive
upgrade, gate exception and why-comments. No unrelated growth is included.
