# Server-stored Task pins (agents pin via `task_write`): contract proposal

Author: Buddies UI Engineer · 2026-09-30 · status: IMPLEMENTED (8586d1a crate+server, ae83eb5 client) per Product Development Lead's assignment (Task task_01a0f290-cb7f-713b-b184-ede8aa42d2c7): dense-rank reorder, NO pin cap, NO approval flow, same write_task authority. Live DB not migrated and backend not restarted: the column is added by `ensure_column` the first time the rebuilt addon opens the DB (`pnpm addons` + restart).

Original proposal (superseded where it differs: `pin` is `INTEGER NOT NULL DEFAULT 0`, 0 = unpinned; no 8-pin cap):

## Why
Owner: "agents should be able to pin key tasks for us via mcp". Home pins are device-local today
(`prefs.projectPins`, commit bee1afd/1694c56), so agents cannot write them and desktop/phone differ.

## Proposed contract (one field, existing write path)
- `Task.pin?: number` (crate `task` table: `pin INTEGER NULL`). Absent = not pinned; a number is the
  pin's sort key (ascending = earlier on Home). Top-level Tasks only (parent_id IS NULL); a write that
  pins a subtask is a typed error.
- `TaskChanges.pin?: number | null`-style patch through the EXISTING `TaskWrite.update`
  (`baseRevision`, idempotency `key`, `write_task` op, same permission checks). No new op, tool or table.
- Pin/unpin/reorder = `task_write update {changes:{pin}}`. Owner Home UI writes the same call over the
  owner route. Move earlier/later = swap two `pin` keys (two updates; or one key between neighbours).
- Reads: `pin` rides on every Task the client already fetches (`/api/buddies/tasks?workspaceId=`), so
  Home derives the pinned list from Tasks; the change feed already invalidates it. Delete
  `prefs.projectPins` and `setProjectPins` in the same commit.

## Cost / risk (why this needs an explicit go)
1. **Schema migration** in `crates/unleashd-buddies/src/schema.rs`: bump the version, add the column.
   A v-N+1 DB will not open under an older build (see the v33 incident in AGENTS.md); needs
   `pnpm addons` + backend restart; deploy sequence in the crate README. I would NOT run it against the
   live `~/.buddies/buddies-v3.sqlite` without your say-so.
2. **Authority:** any Buddy that can `write_task` on a Task could pin it. Proposed guard: agents may pin
   Tasks in their own workspace only, at most 8 pins per workspace (typed error beyond), and every pin
   is an ordinary Task revision, so it is auditable and the owner can unpin on Home. Owner decides if
   agent pinning should instead be a request the owner approves.
3. **Device-local pins already saved** would be dropped (one-time: Home could offer to import them; I
   would skip that unless you have pins you care about — nothing is pinned for you yet).
4. Files touched: crate `schema.rs`, `tasks.rs`, `types.rs`, generated `index.d.ts`, server
   `buddies/mcp.ts` (task_write schema/description), `client` Home + tests, crate tests.

## Not doing
No `Project` type, no separate pin table, no new MCP tool.
