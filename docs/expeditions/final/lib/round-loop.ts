/**
 * The owner's two-level loop as a library function, not a host concept.
 *
 *   outer: run a round → leader reflects → continue | modify | restructure | revise | finish
 *   inner: while a round runs, a watcher sees batched events and may steer, cancel, add, or
 *          end the round early.
 *
 * The host enforces what makes it honest: predictions are graded by the host, two all-missed
 * reflections force `restructure`, weakening the objective needs the owner, and the deadline
 * ends new work. A fixed pipeline (case 7) simply does not call this.
 */

import type { z } from 'zod';
import type { AgentPool, Decision, NotebookQuery, PoolMap, WatchSpec, X } from '../expedition';

export interface RoundLoopSpec<P extends PoolMap, Plan, R> {
  /** The first plan. Later plans come from the leader's Decisions. */
  plan: Plan;
  planSchema: z.ZodType<Plan>;
  /** Run one round of the current plan. Returns a short summary for the log. */
  round: (plan: Plan, n: number) => Promise<R>;
  /** Commit the finish proposal is judged on. */
  head: () => Promise<string>;
  leader: AgentPool<P>;
  reflectPrompt: string;
  context: NotebookQuery[];
  watch: WatchSpec<P> | 'no-watcher';
}

export async function roundLoop<P extends PoolMap, Plan, R>(
  x: X<P>,
  spec: RoundLoopSpec<P, Plan, R>
): Promise<void> {
  let plan = spec.plan;
  for (let n = 1; ; n++) {
    const summary = await x.round(`round-${n}`, () => spec.round(plan, n), spec.watch);
    x.log(`round ${n}: ${String(summary)}`);
    const d: Decision<Plan, P> = await x.reflect({
      key: `reflect-${n}`,
      pool: spec.leader,
      plan,
      planSchema: spec.planSchema,
      prompt: spec.reflectPrompt,
      context: spec.context,
    });
    switch (d.kind) {
      case 'continue':
        break;
      case 'modify':
      case 'restructure':
        plan = d.plan;
        break;
      case 'revise-objective':
        x.log(`objective revision ${d.revision.kind}: ${await x.objective.revise(d.revision)}`);
        break;
      case 'finish': {
        const r = await x.finish({ sha: await spec.head(), report: d.report });
        if (r.kind !== 'not-met') return;
        x.log(`finish refused, failing: ${r.failing.join(', ')}`);
        break;
      }
    }
  }
}
