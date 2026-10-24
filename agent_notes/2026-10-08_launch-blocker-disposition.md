# 2026-10-08 Launch-blocker disposition: lost-liveness and MCP startup timeout

Question (Delivery PM request post_01a117a3, owner thread post_01a117a1): do
task_01a11636 (Ctrl+C kills the liveness `ps`, so a healthy execution is declared
lost) or task_01a1172a (MCP startup "no reply within 30000ms") block a public
early-access launch?

Status: assistant recommendation by Buddies Development Lead. Not an owner
decision. The 2026-10-07 behavior freeze still holds: nothing was changed.

## Recommendation: neither blocks the launch

### task_01a11636: lost-liveness
- The trigger is SIGINT delivered to the backend's process group, as with Ctrl+C on
  `pnpm dev:server`. That kills the synchronous `ps` child inside `isOwnWrapper`
  (vendor/agent-cli-tool/src/journal.ts:116), so the probe returns false and the
  execution is resolved `lost` while the agent keeps running.
- The packaged app starts the backend with `Bun.spawn` and stops it with
  `server.kill('SIGTERM')`, which signals the pid only and never the group
  (desktop/src/main/index.ts:88-108). The DMG path therefore never sends a
  group SIGINT.
- Still exposed: source installs that Ctrl+C the dev server mid-turn. A second
  trigger, a transient `ps` failure under load, is unproven.
- Live incidence: `pnpm errors:list --all --limit=100000` returned 798 groups
  since 2026-09-22, and none contains "execution was lost". That message is a
  provider error, which goes through `TurnRunner.surfaceError` into the journal,
  so the journal would have recorded one.
- The submodule pointer is 7a41287 at both 2871789 (the DMG) and a453e61 (main).
  Exposure is the same in the shipped build and the next cut.
- Reproduced at a453e61 in the full server suite: lost at 51:37.875, SIGINT
  handler at 51:37.901 (excerpt: ctrl-c-lost-excerpt.log). Run alone, the test
  passes 6/6.
- Phase 2 (Alive | Gone | Unknown liveness) still needs owner approval. I
  recommend it as a post-launch fix, plus a known-issue line for source users.

### task_01a1172a: MCP startup timeout
- The exact signature has occurred once: 2026-10-06T16:59:03Z on run_01a11222,
  right after a ~306 s macOS Maintenance Sleep. It has not recurred since. The
  atomic lease gate 4d34ca3 (2026-10-07T09:14Z) and keep-awake 82f8279 landed
  after it.
- Other MCP-startup failures in the journal have different signatures and are
  older: 401 ×3 on 10-05, ETIMEDOUT ×1 on 09-29, memory-reviewer ×8 on 09-28.
- The cause is still unnamed, so the Task stays open. Its own criterion (2)
  closes it as a sleep-wake side effect if it does not recur.

## Exact-commit evidence: a453e61
Clean worktree `_wt/rv-a453e61`, submodule 7a41287. Evidence files are in
`2026-10-08_launch-blocker-disposition/`.
- typecheck exit 0, line ceiling 11136/11136
- test:client 246/246; test:cli 290/290; test:desktop 4/4
- test:server, full suite with no other suite running at start: 316 tests,
  293 pass, 2 fail, 19 cancelled, 2 skip. Failures:
  - auth (real server): "server did not start in 30s", which cancelled its 18 subtests
  - ctrl-c-adoption: timed out with the lost signature above
  - dependencies: readiness and first-boot
- Rerun alone: auth 23/23, dependencies 4/4, ctrl-c-adoption 6/6.
- Load sensitivity: the server suite is not green in a single pass on this
  machine. Every failure passes alone.
- The first full run collided with Release Engineer's concurrent suites
  (`EADDRINUSE 127.0.0.1:7554`) and was discarded. Port isolation is
  task_01a10d40.

Revisit if: "execution was lost" or "no reply within" appears in the journal from
an installed app, or the owner approves phase 2.
