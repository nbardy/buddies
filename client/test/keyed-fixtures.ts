import { keyed } from '@unleashd/shared';

// Fixture views, parsed with the real wire schema: a fixture that drifts from KeyedView fails
// here, before any view test runs.

const at = (hhmmss: string) => `2026-11-10T${hhmmss}Z`;
const passed = (key: string) => ({ t: 'passed', ref: `${key}@h`, out: {} }) as const;
const settled = (end: string, outcome: object) => ({ t: 'settled', at: at(end), outcome });

const row = {
  id: 'ex-1',
  goal: 'Find ten design partners\nthen write them up',
  status: { t: 'running' },
  plan: { t: 'planned', version: 1 },
  spentUsd: 1.2,
  reservedUsd: 0.8,
  budget: { usd: 5, hours: 8 },
  launchedAt: at('10:00:00'),
  deadline: at('18:00:00'),
  needsYou: false,
  workspace: { t: 'workspace', id: 'ws-1' },
};
const diff = {
  reused: ['build/compile/1'],
  attached: [],
  dropped: [],
  started: ['build/agent/1', 'gtm/ask/owner'],
  newCostUsd: 0.4,
};
const base = {
  ...row,
  lanes: [
    {
      key: 'build/compile/1',
      kind: 'command',
      status: 'settled',
      bars: [
        {
          key: 'build/compile/1',
          hash: 'h',
          kind: 'command',
          attempt: 1,
          planVersion: 0,
          start: at('10:00:05'),
          end: settled('10:00:08', passed('build/compile/1')),
        },
      ],
    },
    {
      key: 'build/agent/1',
      kind: 'agent',
      status: 'running',
      bars: [
        {
          key: 'build/agent/1',
          hash: 'h',
          kind: 'agent',
          attempt: 1,
          planVersion: 0,
          start: at('10:01:00'),
          end: settled('10:20:00', {
            t: 'failed',
            ref: 'build/agent/1@h',
            out: {},
            why: 'tests are red',
          }),
        },
        {
          key: 'build/agent/1',
          hash: 'h2',
          kind: 'agent',
          attempt: 2,
          planVersion: 1,
          start: at('10:30:00'),
          end: { t: 'open' },
        },
      ],
    },
    {
      key: 'gtm/lint/1',
      kind: 'command',
      status: 'settled',
      bars: [
        {
          key: 'gtm/lint/1',
          hash: 'h',
          kind: 'command',
          attempt: 1,
          planVersion: 1,
          start: at('10:31:00'),
          end: settled('10:31:30', { t: 'errored', why: 'lint crashed' }),
        },
      ],
    },
  ],
  markers: [
    {
      t: 'plan',
      at: at('10:00:00'),
      version: 0,
      by: 'launch',
      why: 'first plan',
      diff,
      dropped: {},
    },
    {
      t: 'review',
      at: at('10:21:00'),
      planVersion: 0,
      question: 'Is the build step stuck?',
      decision: 'rewrite',
      why: 'two failures in a row',
    },
    {
      t: 'plan',
      at: at('10:25:00'),
      version: 1,
      by: 'leader',
      why: 'split the build in two',
      diff,
      dropped: {},
    },
  ],
  asks: [],
  approval: { t: 'none' },
  faults: [],
};

const parse = (x: object): keyed.KeyedView => keyed.KeyedView.parse(x);

/** Running, two plan versions, a failed and an errored bar, an unanswered text ask and a yes/no. */
export const runningWithAsks = parse({
  ...base,
  needsYou: true,
  lanes: [
    ...base.lanes,
    {
      key: 'gtm/ask/owner',
      kind: 'ask',
      status: 'running',
      bars: [
        {
          key: 'gtm/ask/owner',
          hash: 'h',
          kind: 'ask',
          attempt: 1,
          planVersion: 1,
          start: at('10:40:00'),
          end: { t: 'open' },
        },
      ],
    },
  ],
  asks: [
    {
      ref: 'gtm/ask/owner@h',
      key: 'gtm/ask/owner',
      question: 'Which segment first?',
      answer: 'text',
      askedAt: at('10:40:00'),
    },
    {
      ref: 'gtm/ask/ok@h',
      key: 'gtm/ask/ok',
      question: 'Send the cold emails?',
      answer: 'confirm',
      askedAt: at('10:41:00'),
    },
  ],
  faults: [{ at: at('10:35:00'), what: 'executor cannot run a web call' }],
});

/** A rewrite is waiting for the owner. */
export const awaitingApproval = parse({
  ...base,
  id: 'ex-2',
  goal: 'Approve the rewrite',
  needsYou: true,
  approval: {
    t: 'pending',
    diff,
    why: 'drop the lint step',
    reasons: ['costs $0.40 more than reserved'],
  },
});

/** Done: nothing is pending and no act is offered. */
export const finished = parse({
  ...base,
  id: 'ex-3',
  status: { t: 'finished', reason: { t: 'met', candidate: 'build/agent/1@h2' } },
  markers: [
    ...base.markers,
    { t: 'finished', at: at('11:00:00'), reason: { t: 'met', candidate: 'build/agent/1@h2' } },
  ],
});

export const rowOf = (view: keyed.KeyedView): keyed.KeyedRow =>
  keyed.KeyedRow.parse({
    ...row,
    id: view.id,
    goal: view.goal,
    status: view.status,
    needsYou: view.needsYou,
    workspace: view.workspace,
  });
