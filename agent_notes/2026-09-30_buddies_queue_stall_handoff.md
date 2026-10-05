# Buddies run-queue stall — handoff (2026-09-29/30)

From: wave_sim consolidation session (Claude). For: unleashd owner / Buddies Development Lead.
Status: live system recovered; permanent code fix on branch `fix/run-active-buddy-index-20260930` (commit `337da24`,
worktree `~/git/unleashd-wt-runindex`), **not merged, not pushed**. Three follow-ups below are unowned.

## What happened
- **Symptom:** from 2026-09-29 08:09Z no Buddy run started anywhere for ~8.5 h. 36 runs piled up `queued`
  (28 schedule firings, 8 owner chat turns) while the server stayed up and kept enqueueing schedules.
- **Root cause (verified):** commit `888861c` (2026-09-29 14:57 +0800) added
  `CREATE INDEX run_active_buddy ON run(buddy_id) WHERE status IN ('running','cancel_requested')` only to the base
  `DDL` in `crates/unleashd-buddies/src/schema.rs`. `DDL` runs only for a brand-new empty DB; `open()` upgrades
  existing DBs through the "created on open when missing" lists, and this index was not added there. The claim SQL
  (`runs.rs:24`) reads `FROM run INDEXED BY run_active_buddy`, so on the existing live DB every `claimRun` failed with
  `no such index: run_active_buddy`. The runner swallows it as `[buddies-runner] drain failed:` in the dev terminal only.
- **Proof:** the same `buddies-core.node` addon against a copy of the pre-fix DB fails with `no such index`; against a
  copy after the index was created it claims a run.

## What was done to the live system (owner-approved)
1. Backup: `~/.buddies/backups/buddies-v3.pre-queue-fix-20260930.sqlite` (integrity ok, 4,409 runs).
2. Queue export: `~/git/wave_sim-lean-scope/buddies_queued_runs_20260930.json` (all 36 queued rows).
3. Coalesced repeat schedule firings: 25 runs set `cancelled`, `error_code='coalesced_duplicate_schedule'`, newest per
   schedule kept. Rows preserved, none deleted.
4. Created the missing index in the live DB (`CREATE INDEX IF NOT EXISTS run_active_buddy ...`).
5. The running server still failed (stale schema inside the process); owner restarted it with `pnpm dev:replace`.
6. First restart failed: `Cannot find module 'typescript'` from `vendor/agent-cli-tool`. Its `node_modules` held
   symlinks into the deleted worktree `~/git/unleashd-wt-channels`. Fixed with
   `pnpm install --offline --frozen-lockfile` in `vendor/agent-cli-tool`; no dangling links remain in the repo.
7. After restart the 4 kept schedule runs claimed immediately. **The 8 queued chat turns were cancelled by design**
   (`interrupted: the host restarted before this chat turn started`) and their text was only in server memory, so it
   is lost; the owner must resend them (unleashd: Buddies Development Lead 09:34Z; Product Development Lead 09:35,
   09:36, 09:39Z; Buddies UI Engineer 09:35, 09:37Z. Paint Live: Product Dev 12:31Z; Art Lead 12:52Z).

## The code fix on this branch (`337da24`, +75 lines)
- `RUN_INDEXES` const with `CREATE INDEX IF NOT EXISTS run_active_buddy` applied by `ensure_post_search` on every
  open; comment names the incident and the rule.
- Guard test `schema::tests::every_ddl_index_is_recreated_on_open`: builds a DB, drops every DDL index, reopens, and
  fails if a non-baseline DDL index is not recreated (BASELINE lists the 19 indexes every live DB already has).
- Regression test `claim_run_works_on_a_database_missing_run_active_buddy` (tests/core.rs).
- Verified: `cargo test -p unleashd-buddies --no-default-features` = 37 pass (4 lib, 32 core, 1 query_plan);
  with the `RUN_INDEXES` line removed both new tests fail, the regression test with the incident's error.
- Note: plain `cargo test -p unleashd-buddies` fails to link (napi symbols) because of the default `node` feature;
  use `--no-default-features` as Cargo.toml says. The running server's addon was not rebuilt from this branch.

## Unowned follow-ups
1. **Merge `337da24`** (integrator's call) and rebuild the addon through the normal `ensure-addons` path.
2. **Queued chat turns must survive a restart** (persist the turn text, or re-queue on boot instead of cancelling).
   This is how 8 owner messages were lost.
3. **Surface claim/drain failures** in the UI or an error journal; a stalled queue was invisible except in a terminal.
4. **No cross-worktree symlinks in `node_modules`**: an install in a linked worktree wrote links from the main tree's
   `vendor/agent-cli-tool/node_modules` into that worktree; deleting it broke the main tree's startup.
5. **One schema source** (longer term): the base-DDL-vs-on-open split is what allowed this; the guard test contains it
   but a single declarative index list applied idempotently on open removes the class.
