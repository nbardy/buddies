# Buddy tool surface: what the lean rewrite lost (audit, 2026-10-06)

Asked by: owner, #buddies-dev thread post_01a10cf5-f83f-762b-8d92-527ef0d0fd8d
("anything else related to channels or the MCP stuff we needed get lost?").
Author: Buddies Development Lead. Status: findings + recommendations, no owner decision yet.

## Method

- Planned surface: `agent_notes/2026-09-25_lean-rewrite/02-buddies-server.md` §2.2 (old 47
  registrations → new tool mapping) and §8.3 (the 12 planned tools), at commit 0fef9d4.
- Old surface: `git show 0fef9d4^:server/src/buddies/operations.ts` (`buddy.*` ops).
- Shipped surface: `server/src/buddies/mcp.ts` at main (db00724+), and the live tool
  schema this Buddy received on 2026-10-06 (served by backend pid 2862, started
  2026-10-05 14:03 local).
- Owner requirements: #-thread post_01a1070e-ae96-7251-872c-5dbfcb748f07 (2026-10-04:
  follow a thread; complex, paginated search filtered by channel and author).

## Planned in §8.3 but never shipped

| Planned | Shipped | State |
|---|---|---|
| `channel_post {newChannel}` (old `buddy.new_list`, 60 audit uses) | nothing | Fixed on `fix/buddy-channel-create` @ 1d2c4a0: separate `channel_create {name, purpose, key}`; buddies-v2 41/41, typecheck ok; full test:server not green (dependencies.test.ts, execution-adoption flakes, not shown to be caused by the change). Not merged. |
| `runs {action:'retry'}` (old `buddy.retry_run`, 17 uses) | `runs` list/get/cancel | Lost. A Buddy cannot retry a failed run; only the owner's HTTP "retry reply on another harness" exists (`POST /api/buddies/posts/:postId/retry`). |

## Built, but not reaching Buddies

- Structured search (phrases, -exclude, OR, channels/from/after/before/inThread filters,
  filter-before-paging): merged to main db00724 (2026-10-05 20:08 +0800). The live backend
  started 14:03 that day, so Buddies still get the old `{search: string}` words-only schema.
  Needs a backend restart.
- Fuzzy search (prefix/stem/one-typo, `@Name` / `@"Two Words"` author search, rendered and
  highlighted results): `feat/channel-search-fuzzy` (3 commits), being integrated on
  `integrate/search-fuzzy` @ dfca478 (2026-10-06 01:27) by another lane. Not on main.
  The `from` filter takes Buddy ids or 'owner', not names; names only work through `@Name`.
- Follow a thread (task_01a10757-769e): the Opus worker never committed. Cleanup rescued its
  worktree as `rescue/2026-10-05/unleashd-thread-follow` @ 0711d5e (crate schema/runs/types,
  runner, mcp.ts, ~800 lines incl. tests), unverified.

## Deliberately dropped (not lost)

- `remember_note` / `recall` → notes are agent_notes/*.md files searched with file tools
  (AGENTS.md; doc_read description).
- `create_buddy`, `set_relationship`, `retire_direct_report`, `hire_direct_report` → owner-only
  `team_admin` (§8.3 marks it Owner only). Workers are ordinary Buddies started via `post`
  with `worker`.
- `get_capabilities`, `get_team_state`, `get_message`, `get_runs` → `runs` / `inbox` (§2.2).

## Why these slipped

FEATURE-AUDIT checked owner UI paths (row 30 "Create a channel" PRESENT via ChannelBrowser),
and the tool-count test asserted 12 without naming which planned capabilities each tool must
carry. Recommendation: a test that lists §8.3 capabilities against `toolsFor('worker')`.

## Revisit if

The owner decides run retry should stay owner-only, or that Buddies should hire their own
reports again.

## Successor, 2026-10-06 ~03:45 local (owner: "merge all, complete all work, push")

Owner direction (#buddies-dev post_01a10d8e): merge and push everything; complete the MCP surface
with simple composable primitives, no sprawl. Accepted owner decision; implementation by lead.

- Landed on origin/main db82ba6 (by other lanes before this turn): channel_create (1d2c4a0),
  structured search (db00724), fuzzy/@Name search (integrate/search-fuzzy), follow (990e9b9),
  outage relay. The owner's 02:31 restart predated most of those merges, so they were not live.
- The watcher's queued reload was waiting on active turns; the lead SIGTERMed backend 51178 at
  03:44:28. It drained cleanly (backend-exits.jsonl `drained`), backend 98624 started on db82ba6,
  and the relay (pid 99518) took the stable MCP port 49777, so this turn's tool calls continued.
- Live checks through the relay: tools/list = 13 tools incl. channel_create; follow returns typed
  `not_following` from a foreground chat; "market" matches "Marketing Designer"; unknown `@"Name"`
  is a typed error.
- New finding: 4 cancelled worker runs (run_01a10d42-fa12, run_01a10d44-0e15/-3288/-4a56) sat in
  cancel_requested with leases = started_at + 24 h and no process, filling the lead's pool 5/5.
  Which backend claimed them with a 24 h lease is NOT established (the live backend's code and env
  give 5 min; hypothesis: an older-code server on the live store). Fix: fix/lease-clamp 701c477
  clamps every held lease to one heartbeat at the claim gate.
- Remaining: runs {retry} + capability guard, task_01a10d9a (Sonnet worker queued).

## Successor, 2026-10-06 ~04:42 local: surface complete and live

- origin/main 0f6e91f = runs retry (f58783d, merge a85bc10) + lease clamp (701c477, merge 0f6e91f).
  Lease-clamp verification on the merged commit with a clean tree: crate 65/65, typecheck 0,
  run-lease + buddies-v2 + execution-adoption 63/63. Full test:server was last run on a85bc10 by the
  retry worker (293/296, 1 load-timing flake in swarm-read-model-routes); not rerun on 0f6e91f.
- Backend reloaded by its watcher at 04:33:50 on 0f6e91f. Live via relay: 13 tools; runs has retry
  (typed error on a completed run); channel_read has follow + search filters; channel_create →
  post → channel_admin archive worked end to end (list_01a10dc6-97fa, archived smoke channel).
- The 4 stuck cancel_requested runs were clamped to 20:38:54Z and ended cancelled at 20:38:55Z.
- Leftovers: the adoption test leaked its relay process (pid 97888, ppid 1, temp HOME); killed. Its
  465 MB temp dir unleashd-adoption-eXAI3p under $TMPDIR remains (rm blocked by the dcg guard).
  The source of the 24 h leases is still unidentified.
