# Pending delivery: Product Development Lead review

Reviewed `agent_notes/2026-09-30_pending-delivery-design.md` on October 1.
Outcome: the durable-intake direction fits the owner's requested outcome. The design needs the
following corrections before implementing its schema wave. P1 recovery stays with its current owner.

1. **Legacy migration must actually open.** W0a adds a CHECK requiring body on live chat runs,
   while the existing rows have no body. The proposal also says legacy rows survive until W0b
   recovery. Copying them into the proposed table would violate the CHECK before recovery runs.
   Specify the atomic disposition of queued/running legacy chat rows and test migration with all
   live statuses, including P1-adoptable runs. Do not manufacture missing message bodies.
2. **One writer is not FIFO.** Name the durable order for Buddy conversation inputs, and how it
   survives enqueue/promote/requeue. `ready_at` plus a uniqueness constraint on running rows does
   not by itself state the semantics of the queue. Test order when messages have equal times and
   when one pending message is promoted across a restart.
3. **Read marks must follow completed handling.** The design marks thread_read at prompt
   composition and then uses that mark to skip a follow-up on recovery. A crash after composition
   but before mark_executing could therefore suppress the unanswered input. A read cursor is not
   proof an obligation was fulfilled. Define the authoritative completion/skip disposition and
   mutation-test this precise window.
4. **Config races must not silently change picks.** The proposal says concurrent seat generation
   requests converge and the second gets the first config. That cannot silently discard the
   second message's explicit harness/model choice. Persist each accepted choice and author
   provenance; serialize generation resolution or return a clear conflict. Test the two picks.
5. **Group requests have one-answer semantics today.** Per-recipient enqueue keys fix the observed
   missing run. They do not turn the request into a multi-answer object: posts.rs flips one request
   from awaiting to answered. Keep this correctness repair separate from the schema work; test
   two recipient runs, the first answer, and the second recipient's late answer/fallback. Any
   change to the public meaning of a group request needs an explicit design decision.
6. **Scope and performance claims.** The measured 0.2–0.7 ms medians and ~15 ms sample maximum
   are enqueue/post microbenchmarks on a temp store, not complete chat-send latency or a worst-case
   bound. Records intake was not measured. Report them that way. Memory-review durability (W5)
   is a separate scope decision; do not delay user-message continuity to add it.

The existing owner outcome is authorized. The schema/tool-surface expansion is still subject to
CORE_DESIGN.md's explicit owner review rule; Product review is not a substitute for it. Prepare a
short exact before/after for the internal schema changes and remove the contradictions above.
Meanwhile, existing-contract repairs (including the per-recipient key bug with its existing answer
semantics) and P1 review/testing need not wait on a larger schema proposal.

Acceptance remains the parent Task's matrix: accepted input survives before dispatch, slot wait,
execution, and posted-but-not-settled completion, with no duplicate writer/reply and unchanged
authority/config. Use isolated temporary stores and fake CLIs for destructive restart tests.
