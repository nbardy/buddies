import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import {
  http,
  type BackendCase,
  ask,
  backendExited,
  disposeCase,
  eventually,
  executionJournals,
  fakeClaude,
  fakeExists,
  fakeFile,
  hire,
  makeBackendCase,
  runOf,
  spawnsOf,
  startBackend,
  within,
  workspace,
} from './fixtures/adoption-backend';

/**
 * Release blocker 2b (product review of P1, 2026-10-01): a turn's execution journal was removed
 * when its drain resolved, BEFORE the fire-and-forget run settle (answer + crate settle) landed. A
 * backend death in that window left no journal and a running run, and the next boot recovered a
 * finished run as `interrupted`. Now the settle commits before the journal goes, and both
 * crash points replay safely: a finished journal whose run is unsettled is settled from the
 * journal once; a journal whose run is already settled is only cleaned.
 *
 * Deterministic: `UNLEASHD_TEST_CRASH_DIR` arms a test-only crash point (lifecycle/test-hooks.ts)
 * at which the backend SIGKILLs itself, at exactly that boundary.
 */

const PORT = 7535;

const FAKE = fakeClaude(String.raw`
async function main(scenario) {
  text('one;');
  mark(scenario + '.midturn', process.pid);
  await until(scenario + '.go');
  text('done;');
  say({ type: 'result', subtype: 'success' });
  mark(scenario + '.exited', process.pid);
}
`);

/** Finish a worker's turn with the backend armed to die at `point`; then boot a replacement. */
async function crashAt(c: BackendCase, point: 'run-settle' | 'journal-cleanup', scenario: string) {
  const env = { UNLEASHD_TEST_CRASH_DIR: c.fakeDir };
  await startBackend(c, 'A', env);
  const ws = await workspace(c, scenario);
  const worker = await hire(c, ws, scenario);
  const request = await ask(c, worker, scenario);
  await eventually(c, () => fakeExists(c, `${scenario}.midturn`), Boolean, 'mid-turn');
  // Armed only now, so no earlier settle (bootstrap work) can trip it.
  fs.writeFileSync(fakeFile(c, `crash-at-${point}`), '');
  const died = backendExited(c);
  fs.writeFileSync(fakeFile(c, `${scenario}.go`), '');
  await within(c, died, 30_000, `the backend to die at ${point}`);
  c.backend = null;
  assert.ok(fakeExists(c, `crashed-at-${point}`), `the backend died at ${point}`);
  fs.rmSync(fakeFile(c, `crash-at-${point}`));

  await startBackend(c, 'B', env);
  const run = await eventually(
    c,
    () => runOf(c, worker),
    (r) => r?.status !== 'running' && r?.status !== 'queued',
    'run settled after the crash'
  );
  assert.equal(
    run?.status,
    'complete',
    `a finished run is never interrupted: ${JSON.stringify(run)}`
  );
  const thread = await http(c, 'GET', `/api/buddies/posts/${request.id}/thread`);
  const answers = ((thread.body.posts ?? thread.body) as Array<{ body: string }>).filter(
    (p) => p.body === 'one;done;'
  );
  assert.equal(answers.length, 1, 'exactly one answer returns to the requester');
  const attempt = (await http(c, 'GET', `/api/conversations/${run?.conversationId}`)).body
    .latestAttempt as { state: string; terminalCause: string };
  assert.deepEqual([attempt.state, attempt.terminalCause], ['succeeded', 'provider_complete']);
  assert.equal(spawnsOf(c, scenario).length, 1, 'never respawned');
  await eventually(
    c,
    () => executionJournals(c),
    (left) => left.length === 0,
    'the journal is removed'
  );
}

test(
  'a crash between the drain and the run settle: the next boot settles it complete, once',
  { timeout: 180_000 },
  async () => {
    const c = makeBackendCase(PORT, 'settle-crash-a', FAKE);
    try {
      await crashAt(c, 'run-settle', 'beforesettle');
    } finally {
      await disposeCase(c);
    }
  }
);

test(
  'a crash between the run settle and the journal cleanup: the next boot only cleans',
  { timeout: 180_000 },
  async () => {
    const c = makeBackendCase(PORT, 'settle-crash-b', FAKE);
    try {
      await crashAt(c, 'journal-cleanup', 'beforecleanup');
    } finally {
      await disposeCase(c);
    }
  }
);
