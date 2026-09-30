# Ctrl+C proof: do running agents survive `pnpm dev` stop + relaunch? (2026-10-01)

Owner question (Task task_01a0f2cb, request post_01a0f309): "if I ctrl+C the server and bring it
back up, do the background agents work?" Branch `continuity/ctrl-c-proof` off `26d9e28`.

## Answer

Yes, for all four driven cases, on the real dev entry (`pnpm run dev:server` → dev-supervisor →
watch-server runner → server.ts), stopped by SIGINT to the whole process group as a terminal does.

| Case | Result |
|---|---|
| 1. One Ctrl+C | yes: group fully exits, agents keep journaling, relaunch adopts, ordered output, Buddy tool works, one completion each |
| 2. Two Ctrl+C (supervisor SIGKILL escalation) | yes: same assertions |
| 3. `dev:server --replace` over a running runtime | yes: same assertions |
| 4. ~30 s outage with a Buddy tool call in the gap | the call gets `ECONNREFUSED` (a plain tool error, no automatic retry); the run still completes after relaunch and later calls with the same grant succeed |
| 5. Real claude CLI (manual) | yes: survived, wrote 17 KB of stream-json to its journal with no backend, saw `ECONNREFUSED` on its Buddy call, waited, retried with the same grant on the new backend (post landed), run `complete`, one answer |

## Bug found and fixed: one Ctrl+C under pnpm was a double Ctrl+C

pnpm relays the terminal's SIGINT to its script, so the supervisor received SIGINT twice, 0.1-0.2 ms
apart (measured, three runs). The second counted as "press again" and the supervisor SIGKILLed
the backend ~30 ms into its graceful shutdown, every time. Running `node tools/dev-supervisor.mjs`
directly (no pnpm) gave `Backend stopped (exit 0)`; via pnpm `Backend stopped (signal SIGKILL)`.
Adoption hid it (turns survive a SIGKILL too), but the graceful path (state flush, the 3 s drain of
in-memory work) never ran under `pnpm dev`.

Fix (`tools/dev-supervisor.mjs`): a repeat signal within 250 ms of the first is the relay and is
ignored; a later press still escalates to SIGKILL. `tools/watch-server.mjs` now logs
`Backend stopped (<exit>)` so the outcome is visible. Guard: the single-press test asserts
`exit 0`; the double-press test asserts `signal SIGKILL`.

## Other changes

- `dev-server` task honours `PORT` for its port check (it was hardcoded 7499), so a test can run
  the real dev entry beside the owner's live runtime. `dev` stays fixed (Vite proxies to 7499).

## Limits (not fixed, reported)

- A message queued behind a running turn is lost on Ctrl+C (backend B never delivered it). This is
  the documented behaviour in `server/src/lifecycle/shutdown.ts` ("Queued sends and waiting chats
  are lost").
- Case 3 used `pnpm run dev:server --replace`, not `pnpm dev:replace`: the `dev` task needs port
  7489/7499, held by the owner's live runtime. The replace code path (`claimDevRuntime`) is the same.
- Case 5 ran on `claude-sonnet-5-5` at low effort, not haiku: at `26d9e28` the catalog has no haiku
  model (`Model is unavailable for claude: claude-haiku-4-5-20251001`). The real CLI authenticates
  from the real home, so its transcript goes to `~/.claude/projects`; the test deletes its own
  directory afterwards. One directory from an earlier, failed attempt remains
  (`~/.claude/projects/-private-var-folders-dp-…-unleashd-ctrlc-real-jS5Fv2-workspace`). A safety hook blocked
  deleting it from the shell.
- The real CLI's retry was prompted ("if the post fails, wait for the backend, then retry"). Without
  that instruction, whether an agent retries is the model's choice; the transport does not retry.
- The submodule commit `43744e8` (pinned by `26d9e28`) is not on the submodule remote; the worktree
  fetched it from the local adopt worktree's module store.

Reproduce: `pnpm exec tsx --test server/test/ctrl-c-adoption.test.ts` (4 cases, ~95 s);
manual: `UNLEASHD_REAL_CLAUDE=1 UNLEASHD_REAL_CLAUDE_MODEL=claude-sonnet-5-5 CTRLC_LOG_FILE=/tmp/x.log`
plus the same command with `--test-name-pattern=manual`.
