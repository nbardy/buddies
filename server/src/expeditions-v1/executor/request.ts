import type { keyed } from '@unleashd/shared';
import type { RunAddress } from './address';
import { answerInstruction } from './answer';
import type { ExpeditionContext } from './context';
import type { Expected, Tree } from './records';
import type { RefRecord } from './refs';

// The body of a call's request post (CONNECT_PLAN §1): a pure function of the run's spec, the refs
// it names and the paths it runs at (themselves functions of the run id). No timestamps: the post
// key `xk:<runId>` replays an identical payload and rejects a different one. The record stores
// the body it posted, and a finished post after a restart re-sends exactly that.

/** A ref the body names, resolved from the ref store. */
export type NamedRef = { readonly ref: keyed.RefId; readonly record: RefRecord };

const CHECKOUT: {
  readonly [K in RefRecord['checkout']['t']]: (
    c: Extract<RefRecord['checkout'], { t: K }>
  ) => string;
} = {
  none: () => '',
  branch: (c) => `; branch ${c.branch}`,
};
const refLine = (n: NamedRef): string =>
  `- ${n.ref}: answer file ${n.record.answerPath}; commit ${n.record.commit}${CHECKOUT[n.record.checkout.t](n.record.checkout as never)}`;

const INPUT: {
  readonly [K in keyed.Input['t']]: (i: Extract<keyed.Input, { t: K }>, refs: RefsByName) => string;
} = {
  ref: (i, refs) => refLine(refs.get(i.ref) as NamedRef),
  text: (i) => `- text: ${i.text}`,
};
type RefsByName = ReadonlyMap<keyed.RefId, NamedRef>;

const WHERE: {
  readonly [K in Tree['t']]: (
    t: Extract<Tree, { t: K }>,
    ctx: ExpeditionContext,
    base: string
  ) => string;
} = {
  none: () => 'You have no working directory of your own.',
  detached: (t) => `Your working directory is ${t.path}.`,
  dir: (t, ctx, base) =>
    `Your working directory is ${t.path}, a scratch directory. The repository is ${ctx.repo}, at commit ${base}: read it there, do not change it.`,
  checkout: (t, _ctx, base) =>
    `Your working directory is ${t.path}: a checkout of the repository on its own branch ${t.branch}, starting at commit ${base}. Commit your work on this branch; uncommitted changes are not your answer.`,
};
const whereOf = (tree: Tree, ctx: ExpeditionContext, base: string): string =>
  WHERE[tree.t](tree as never, ctx, base);

const CONTEXT: {
  readonly [K in keyed.AgentCall['context']['t']]: (
    c: Extract<keyed.AgentCall['context'], { t: K }>,
    refs: RefsByName
  ) => string[];
} = {
  cold: () => [],
  // D3: real resume does not exist. A request run opens a fresh `buddy-run-<id>` conversation and
  // the crate cannot bind it to another call's (CONNECT_PLAN §0.2). v1 hands off softly: the earlier
  // call's answer and conversation are named here, and the agent reads what it needs.
  continue: (c, refs) => {
    const n = refs.get(c.of) as NamedRef;
    const conversation =
      n.record.conversation.t === 'conversation'
        ? `; it ran in conversation ${n.record.conversation.id}`
        : '';
    return [
      'CONTINUES',
      `This call continues an earlier one (${c.of})${conversation}. This is a fresh conversation, not that one: read its answer and work first.`,
      refLine(n),
      '',
    ];
  },
};

const header = (address: RunAddress) =>
  `Expedition call ${address.runId} (expedition ${address.expedition}).`;

/** An agent call's request. `refs` holds every ref its inputs and `context` name. */
export function agentBody(x: {
  readonly address: RunAddress;
  readonly ctx: ExpeditionContext;
  readonly call: keyed.AgentCall;
  readonly refs: RefsByName;
  readonly tree: Tree;
  readonly base: string;
  readonly expected: Expected;
}): string {
  const { call, refs } = x;
  return [
    header(x.address),
    '',
    call.brief,
    '',
    ...(call.inputs.length > 0
      ? ['INPUTS', ...call.inputs.map((i) => INPUT[i.t](i as never, refs)), '']
      : []),
    ...CONTEXT[call.context.t](call.context as never, refs),
    'WHERE YOU WORK',
    whereOf(x.tree, x.ctx, x.base),
    '',
    // D11: advisory in v1; nothing enforces them.
    'ACCESS (advisory)',
    `Read: ${call.grant.reads.length > 0 ? call.grant.reads.join(', ') : 'what the brief names'}. Web: ${call.grant.web ? 'allowed' : 'not allowed'}.`,
    '',
    answerInstruction(x.expected),
  ].join('\n');
}

/** A review judge's request: the rubric, then the work it judges. */
export function reviewBody(x: {
  readonly address: RunAddress;
  readonly ctx: ExpeditionContext;
  readonly brief: string;
  readonly judged: NamedRef;
  readonly tree: Tree;
  readonly expected: Expected;
}): string {
  return [
    header(x.address),
    'You are judging work against the rubric below. Do not change the work.',
    '',
    x.brief,
    '',
    'THE WORK TO JUDGE',
    refLine(x.judged),
    `The repository is ${x.ctx.repo}.`,
    '',
    'WHERE YOU WORK',
    whereOf(x.tree, x.ctx, x.judged.record.commit),
    '',
    answerInstruction(x.expected),
    'Say verdict "yes" only when the work meets the rubric; "why" is your reason, in a few sentences.',
  ].join('\n');
}
