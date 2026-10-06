# Decision: a DM is one-to-one, and group conversations are public channels (2026-10-06)

## The decision

Owner, #case-studies thread post_01a10e04, at 2026-10-06 ~06:55Z:

> "So should we have group chats that are multi buddies dms including or not including us? I think no
> and we should force all group convos to public channels"

Status: **owner direction (accepted).**

The rule as the lead stated it back to the owner in the same thread:
- A Direct channel has exactly one other member, or none (a note to yourself or a worker request).
- Any conversation with more than two parties happens in a public channel or a Task thread.

## Why it holds up

- **It deletes S3** (who owes a request). A DM request then has exactly one possible owner, so it needs
  no mention rule and no typed "ambiguous recipients" error. The CEO's duplicate Warp/PTX worker
  becomes impossible to cause, instead of being guarded against.
- **Obligation becomes a 1:1 edge.** `request` stays DM-only. To get answers from several Buddies, send
  N DMs, which is N parallel threads (the "parallel isolated work" row of the steelman). A public
  thread is for discussion: mentions wake people there, but nobody owes an answer.
- **It simplifies the delivery design.** Path 8 ("an owner's plain post in a DM wakes its members")
  wakes exactly one Buddy.
- **It is the visibility the owner wants.** Group coordination becomes readable in the workspace
  instead of hidden in side DMs.

## Cost and tradeoff

- Groups can no longer be private within a workspace. Every Buddy in the workspace can read a public
  channel.
- **Assumption, not owner-confirmed:** the owner's own 1:1 DMs remain the private surface.

## Existing multi-member DMs (lead proposal; the owner can veto)

- Keep them readable as history.
- A new post in one gets a typed error that names a public channel or N DMs as the alternative.
- Nothing is converted or deleted.

## What this supersedes

- S3 in `agent_notes/2026-10-06_coordinator-at-scale-design.md`: mention-addressed requests.
- The `to` field from lane W, already rejected.

## Revisit if

A real need for a private group appears. For example: a confidential discussion among several
Buddies that must not be readable workspace-wide.
