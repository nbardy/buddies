import assert from 'node:assert/strict';
import test from 'node:test';
import {
  type Entry,
  INTEGRATION_TREE,
  MANAGER_TREE,
  type ManagerAction,
  decide,
  fold,
} from '../src/expeditions/model';
import { canonical, charter } from './fixtures/expedition-fixture';

// Pure decide over a hand-written ledger: no host, no git.

const AT = '2026-11-03T10:00:00.000Z';
const SHA = 'a'.repeat(40);
const place = (path: string) => ({ t: 'detached' as const, path });

/** A ready expedition with one panel-accepted question q1 and a work attempt w1 that ended with
 * a code claim, then a manager attempt m1 that ended with `actions`. */
function ledger(actions: ManagerAction[]): Entry[] {
  return [
    {
      t: 'launched',
      at: AT,
      id: 'exp-1',
      key: 'k',
      charter: canonical(charter('derive')),
      origin: { t: 'direct' },
      launcherId: 'lead',
      workspaceId: 'ws',
      repo: { root: '/repo', baseSha: SHA, branch: 'expedition/exp-1' },
    },
    { t: 'tree_planned', at: AT, tree: INTEGRATION_TREE, place: place('/t/integration') },
    { t: 'tree_ready', at: AT, tree: INTEGRATION_TREE },
    { t: 'tree_planned', at: AT, tree: MANAGER_TREE, place: place('/t/manager') },
    { t: 'tree_ready', at: AT, tree: MANAGER_TREE },
    { t: 'crew_ready', at: AT, buddyId: 'crew', chatChannelId: 'chat' },
    {
      t: 'question_added',
      at: AT,
      questionId: 'q1',
      title: 'widget',
      detail: 'make it pass',
      scope: 'in',
      paths: ['widget'],
      after: [],
      acceptance: { t: 'panel' },
    },
    ...posted('w1', { kind: 'work', questionId: 'q1', brief: 'fix it', seat: 0 }),
    {
      t: 'attempt_ended',
      at: AT,
      attemptId: 'w1',
      outcome: {
        t: 'work',
        result: {
          result: 'claim',
          statement: 'passes',
          change: { t: 'commit', sha: SHA },
          evidence: [],
          howToCheck: 'run it',
        },
      },
    },
    ...posted('m1', { kind: 'manager' }),
    { t: 'attempt_ended', at: AT, attemptId: 'm1', outcome: { t: 'manager', actions } },
  ];
}

function posted(attemptId: string, spec: Extract<Entry, { t: 'attempt_planned' }>['spec']) {
  return [
    { t: 'attempt_planned', at: AT, attemptId, spec },
    { t: 'attempt_posting', at: AT, attemptId, body: 'brief' },
    { t: 'attempt_posted', at: AT, attemptId, requestId: `r-${attemptId}` },
  ] satisfies Entry[];
}

function clock() {
  let n = 0;
  return {
    now: AT,
    nextId: (prefix: string) => {
      n += 1;
      return `${prefix}${n}`;
    },
  };
}

// Regression (B8, 2026-11-03): queries.ts derive caches the panel views per state, and decide
// mutates that state while it applies a manager's actions. A cache keyed on the state alone kept
// the panels it saw before the `check` below (primed by the close_question guard), so the
// integrate read "no panel yet" instead of the panel the same decision had just planned. The
// cache is per `revision` (ledger.ts apply); keying it on the state alone re-breaks this.
test('a check planned in one decision is seen by the integrate after it', () => {
  const s = fold(
    ledger([
      { do: 'close_question', question: 'q1', status: 'verified', why: 'early' },
      { do: 'check', claimAttempt: 'w1', goal: false, panel: 1 },
      { do: 'integrate', claimAttempt: 'w1' },
    ])
  );
  const out = decide(s, clock());
  const rejected = out.flatMap((e) => (e.t === 'rejected' ? [[e.action.do, e.reason]] : []));
  assert.deepEqual(rejected, [
    [
      'close_question',
      'a question closes verified only after a check panel verified it, or its claim passed every command check and was integrated',
    ],
    ['integrate', 'a check panel on it is still running'],
  ]);
  assert.ok(out.some((e) => e.t === 'attempt_planned' && e.spec.kind === 'check'));
});
