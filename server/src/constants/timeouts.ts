function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

export const EXTERNAL_GRACE_MS = 30_000;
export const LOCAL_COMPLETION_SUPPRESS_MS = EXTERNAL_GRACE_MS;
export const HOT_RELOAD_FORCE_EXIT_GRACE_MS = readPositiveIntEnv(
  'CWV_HOT_RELOAD_FORCE_EXIT_GRACE_MS',
  3_000
);
// Hard cap on the final state flush. Without it a journal flush that never
// settles leaves the process alive in `exiting`, refusing every request forever.
export const SHUTDOWN_FLUSH_GRACE_MS = readPositiveIntEnv('CWV_SHUTDOWN_FLUSH_GRACE_MS', 5_000);
// A provider process may legitimately spend a long time reasoning or waiting on a
// tool without emitting user-visible output. The shared agent CLI emits liveness
// heartbeats during those gaps; this watchdog is the fallback for a broken event
// bridge, not a normal turn-duration limit.
// The 2026-08-04 incident fixed missing heartbeat coverage during active work.
// Keep bridge liveness, provider inactivity, and total runtime separate; see
// docs/incident-2026-08-04-codex-bridge-idle-timeout.md.
export const DEFAULT_TURN_BRIDGE_TIMEOUT_MS = 2 * 60_000;
export const TURN_BRIDGE_TIMEOUT_MS = readPositiveIntEnv(
  'CWV_TURN_BRIDGE_TIMEOUT_MS',
  DEFAULT_TURN_BRIDGE_TIMEOUT_MS
);
// A turn that launched a background task gets its harness's declared wait on top of this
// (turns/background-wait.ts): `claude -p` sits silent while its background agents run.
export const DEFAULT_TURN_PROVIDER_IDLE_TIMEOUT_MS = 60 * 60_000;
export const TURN_PROVIDER_IDLE_TIMEOUT_MS = readPositiveIntEnv(
  'CWV_TURN_PROVIDER_IDLE_TIMEOUT_MS',
  readPositiveIntEnv('CWV_TURN_IDLE_TIMEOUT_MS', DEFAULT_TURN_PROVIDER_IDLE_TIMEOUT_MS)
);
// Foreground Buddy claims must receive this same budget, including env overrides.
// A separate claim default of 600s killed active chats despite healthy heartbeats
// on 2026-09-10. Raising idle limits cannot fix an earlier absolute deadline.
// See docs/incident-2026-09-10-buddy-chat-timeout.md. Guards: conversation-runtime.test.ts and
// buddies-v2.test.ts (a chat run's deadline is exactly TURN_MAX_RUNTIME_MS). Since 2026-10-01 the
// run's LEASE is a separate, short heartbeat (BUDDY_RUN_LEASE_MS below), never this budget.
export const TURN_MAX_RUNTIME_MS = readPositiveIntEnv('CWV_TURN_MAX_RUNTIME_MS', 24 * 60 * 60_000);
export const TURN_TIMEOUT_KILL_GRACE_MS = readPositiveIntEnv(
  'CWV_TURN_TIMEOUT_KILL_GRACE_MS',
  5_000
);
// Pattern: lease-heartbeat (docs/patterns.md#lease-heartbeat)
// A Buddy run's LEASE: how long its holder may go without renewing before the claim gate
// (crates/unleashd-buddies/src/runs.rs `claim_run_at`) ends the run as lease_expired. It is NOT the
// run's deadline. The deadline is TURN_MAX_RUNTIME_MS for a foreground chat and
// BUDDY_BACKGROUND_TURN_MS otherwise, stored as its own column and enforced as max_runtime_timeout.
// Why they are separate:
// - 2026-09-10: a 600 s claim lease doubled as an owner chat's deadline and killed healthy chats
//   (docs/incident-2026-09-10-buddy-chat-timeout.md).
// - The fix made the lease 24 h, the deadline's length. A run whose holder died then stayed
//   `running` until the next boot swept it: a 9.5 h overnight lie on 2026-09-30→10-01, and 14 and
//   10 orphaned runs at 12:34Z/14:09Z on 09-30. The boot sweep also ended runs a second live
//   backend on the same store still held.
// One number cannot be both "long enough for a day-long chat" and "short enough to notice a
// death". So the lease is minutes, renewed on the turn's bridge clock (TurnPolicy.bridgeAlive),
// and a renewed lease IS the liveness signal: there is no separate lastProgress field.
// Length: renewal costs one SQLite write per running turn per BUDDY_RUN_LEASE_RENEW_MS (1/min).
// Five minutes outlasts four missed renewals and the 2-min bridge timeout, which ends a dead bridge
// first, so it never expires a turn whose watchdog is healthy. A dead holder's run lies at most
// this long, plus the runner's 5 s backstop.
// Guards: server/test/run-lease.test.ts; crate tests `an_expired_lease_ends_its_run_like_a_failed_settle`
// and `a_renewed_lease_outlives_its_first_term`; buddies-v2.test.ts (chat deadline = TURN_MAX_RUNTIME_MS).
export const BUDDY_RUN_LEASE_MS = readPositiveIntEnv('CWV_BUDDY_RUN_LEASE_MS', 5 * 60_000);
/** A live holder renews at most this often, on bridge events (heartbeats arrive ≤ 30 s apart). */
export const BUDDY_RUN_LEASE_RENEW_MS = Math.floor(BUDDY_RUN_LEASE_MS / 5);
/** A background Buddy run's deadline (a request, a return, a schedule), from its claim. */
export const BUDDY_BACKGROUND_TURN_MS = readPositiveIntEnv(
  'CWV_BUDDY_BACKGROUND_TURN_MS',
  60 * 60_000
);
/** The runner's backstop tick: due schedules, runs no write woke (a freed slot), and the claim
 * gate's lease expiry, so a dead holder's run ends within BUDDY_RUN_LEASE_MS plus this. */
export const BUDDY_RUNNER_BACKSTOP_MS = 5_000;
export const SWARM_POLL_INTERVAL_MS = readPositiveIntEnv('CWV_SWARM_POLL_INTERVAL_MS', 2_000);
export const SWARM_POLL_THROTTLE_MS = readPositiveIntEnv('CWV_SWARM_POLL_THROTTLE_MS', 1_500);
export const SWARM_CONTEXT_COMMAND_TIMEOUT_MS = 8_000;
export const PALETTE_GENERATION_TIMEOUT_MS = 90_000;
