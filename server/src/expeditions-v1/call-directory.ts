import path from 'node:path';
import type { BuddyContext } from '@unleashd/shared';
import type { TurnDirectory } from '../buddies/briefing';
import { type BuddiesCore, OWNER, coreError } from '../buddies/core';
import { EXPEDITION_CALL_PURPOSE, EXPEDITION_RUN_EVIDENCE } from '../buddies/expedition-calls';
import { recordPathOf } from './executor/calls';
import { readRecord } from './executor/records';

// Which directory an expedition call's turn runs in (CONNECT_PLAN §1 "Turn directory"). The Buddy
// server asks this for every Buddy turn that executes a run (server.ts `createBriefings`); it is
// inert for every turn but a call's: a run whose input is not a request post, or whose post does
// not carry BOTH purpose `expedition_call` and `expedition-run:` evidence, is `not-a-call`, and the
// turn's directory is decided exactly as before.
//
// For a call, the executor's own run record is the authority (not the post, which any Buddy can
// write): it must exist, be live (posting or posted), and name this run's Buddy and this post's
// exact body. Anything else throws, so the turn fails visibly instead of running somewhere else:
// a closed record means the kernel settled the call, and a late claim must not run it.

/** The executor's data root under the app data dir (D9). */
export const EXPEDITIONS_V1_DIR = 'expeditions-v1';
export const expeditionsV1Root = (appDataDir: string): string =>
  path.join(appDataDir, EXPEDITIONS_V1_DIR);

/** The directory of the turn `context` runs, when its run is an expedition call; otherwise
 * whatever `otherwise` decides. */
export async function callDirectory(
  core: BuddiesCore,
  root: string,
  context: BuddyContext,
  otherwise: () => Promise<TurnDirectory>
): Promise<TurnDirectory> {
  const runId = context.coordinationRunId;
  if (!runId) return otherwise();
  // This read must never make a non-call turn fail where it used to succeed: a context naming a
  // run the crate does not hold is not a call (a call's run always exists).
  const run = await core.getRun(runId).catch((e: unknown) => {
    if (coreError(e)?.code === 'not_found') return null;
    throw e;
  });
  if (run === null || run.input.kind !== 'post') return otherwise();
  const post = await core.getPost(OWNER, run.input.postId);
  const tag = post.evidence.find((e) => e.startsWith(EXPEDITION_RUN_EVIDENCE));
  if (post.purpose !== EXPEDITION_CALL_PURPOSE || tag === undefined) return otherwise();
  const kernelRunId = tag.slice(EXPEDITION_RUN_EVIDENCE.length);
  const found = await readRecord(recordPathOf(root, kernelRunId));
  const refuse = (why: string): never => {
    throw new Error(`expedition call ${kernelRunId} (run ${runId}) may not run: ${why}`);
  };
  if (found.t === 'missing') return refuse('the executor has no record of it');
  const r = found.value;
  if (r.t !== 'posting' && r.t !== 'posted') return refuse(`its record is ${r.t}`);
  if (r.buddyId !== run.buddyId || r.body !== post.body)
    return refuse('the request is not the one the executor posted');
  if (r.tree.t !== 'dir' && r.tree.t !== 'checkout')
    return refuse(`a call never runs in a ${r.tree.t} tree`);
  return { t: 'call', runId, path: r.tree.path };
}
