import { withPrompts } from './executor/prompts';
import type { KeyedExpeditions, Mutated, Viewed } from './service';

// Every view the keyed-expedition service returns carries, per bar, the prompt files its turns
// were sent (executor/prompts.ts, CONNECT_PLAN §10 F4). The projection cannot add them (the log
// does not know where they are), so the one place every view leaves through adds them.
// Pattern: table-driven (docs/patterns.md#table-driven)

const MUTATED: {
  readonly [K in Mutated['t']]: (m: Extract<Mutated, { t: K }>, root: string) => Mutated;
} = {
  ok: (m, root) => ({ ...m, view: withPrompts(root, m.view) }),
  unavailable: (m) => m,
  missing: (m) => m,
  refused: (m) => m,
  rejected: (m) => m,
};
const VIEWED: {
  readonly [K in Viewed['t']]: (v: Extract<Viewed, { t: K }>, root: string) => Viewed;
} = {
  ok: (v, root) => ({ ...v, view: withPrompts(root, v.view) }),
  missing: (v) => v,
};

export function keepingPrompts(root: string, x: KeyedExpeditions): KeyedExpeditions {
  const mutated = async (m: Promise<Mutated>): Promise<Mutated> => {
    const done = await m;
    return (MUTATED[done.t] as (m: Mutated, root: string) => Mutated)(done, root);
  };
  // Every other member (mode, consumes, load, boot, rows, preview, close) is `x`'s own: plain
  // values and closures, no `this`.
  return {
    ...x,
    async view(id) {
      const v = await x.view(id);
      return (VIEWED[v.t] as (v: Viewed, root: string) => Viewed)(v, root);
    },
    act: (id, act) => mutated(x.act(id, act)),
    answer: (id, ref, answer) => mutated(x.answer(id, ref, answer)),
    approval: (id, approve) => mutated(x.approval(id, approve)),
    launch: (workspaceId, folder, expect) => mutated(x.launch(workspaceId, folder, expect)),
  };
}
