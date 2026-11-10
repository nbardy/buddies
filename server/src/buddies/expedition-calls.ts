import { type BuddiesCore, CoreError, OWNER } from './core';

// Expedition calls (expeditions-v1/executor/calls.ts) are Buddy requests whose runs only their
// expedition's executor may cancel or retry. A cancel or retry from anywhere else (the owner's run
// list, a Buddy's `runs` tool) would end or create a run the expedition log does not hold: a retry
// is an unbudgeted second turn, and a cancel settles a call behind the kernel's back
// (CONNECT_PLAN §7.7). Every other run is untouched: the check reads the run's request post and
// refuses only for this purpose.

/** The `purpose` of the request post an expedition call is. */
export const EXPEDITION_CALL_PURPOSE = 'expedition_call';
/** Evidence on that post naming the kernel's run id: `expedition-run:<runId>`. */
export const EXPEDITION_RUN_EVIDENCE = 'expedition-run:';

/** Throws `[denied]` (HTTP 403, a tool error over MCP) when `runId` is an expedition call's run. */
export async function refuseExpeditionCallRun(
  core: BuddiesCore,
  runId: string,
  action: 'cancel' | 'retry'
): Promise<void> {
  const run = await core.getRun(runId);
  if (run.input.kind !== 'post') return;
  const post = await core.getPost(OWNER, run.input.postId);
  if (post.purpose !== EXPEDITION_CALL_PURPOSE) return;
  throw new CoreError(
    'denied',
    `run ${runId} is an expedition call; ${action} it from its expedition (a ${action} here would make a run its expedition does not hold)`
  );
}
