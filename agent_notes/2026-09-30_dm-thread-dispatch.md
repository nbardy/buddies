# DM thread dispatch: owner posts in DMs wake the Buddy (2026-09-30)

## Decision 1 (ACCEPTED by owner, #bugfixes post_01a0f3b9-532a…, "yea fix")
- Problem: `channels.ts` posted-event handler returned on every non-public channel. In a DM only a
  `request` or an `answer` started a run (the core queues those). Four owner replies (two @mentions)
  in DM thread `message_66ec2c6a…` of dm_9a6400291f35518c43a2636dc52b9ee3 started no run and no error.
  Evidence: `runs list {buddyId: lead}` showed no run at 14:08, 18:25, 18:34 on 2026-09-30.
- Choice: an owner-authored plain post in a DM (top-level or thread reply) wakes every Buddy member
  via `wake()` (cause `direct`), on the thread seat. Requests/answers skipped (already queued).
  Buddy DM informs still wake nobody (loop prevention).
- Commit: 83794cb (local main, not pushed). Guard test: buddies-v2.test.ts "an owner reply in a DM
  thread wakes the Buddy…" — fails on the pre-fix code (timeout), passes after.
- Pre-existing unrelated failure: "a DM new chat opens the next generation" fails at HEAD too
  (new-chat route body parse; likely 804699b).

## Decision 2 (PROPOSED by lead, awaiting owner) — unify "who a post addresses"
- Execution is already shared (`wake()` → thread seat). Addressing is a per-kind switch; a missing
  case drops posts silently. Remaining hole: `case 'task': return` — @mentions in task comments wake
  nobody. Group DMs have no follow-up gate for Buddy posts.
- Proposal: pure `addressees(channel, post) → [{buddyId, cause}]` across all kinds; handler =
  addressees + wake; one table-driven test (kind × author × request/answer × mention).
- Deliberately NOT merged: the DM request/answer runner path (background run primitive shared with
  workers and Buddy-to-Buddy asks).
- Revisit if: owner rejects task-comment wakes, or a new channel kind appears.
