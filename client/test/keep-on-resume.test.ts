import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {
  createResumeTracker,
  createWakeDetector,
  isViteClientModule,
  patchViteResumeReload,
  resumeNeedsSocketReconnect,
} from '../src/pwa/resume';

test('a backgrounded page is kept across the dev-server reconnect, then settles', () => {
  const pending: Array<() => void> = [];
  const tracker = createResumeTracker(15_000);
  const schedule: Parameters<typeof tracker.noteVisible>[0] = (_afterMs, callback) => {
    pending.push(callback);
  };

  assert.equal(tracker.keep(), false);

  tracker.noteHidden();
  assert.equal(tracker.keep(), true);

  tracker.noteVisible(schedule);
  assert.equal(
    tracker.keep(),
    true,
    'the resume ping reloads only after the page is visible again'
  );

  const first = pending.shift();
  assert.ok(first);
  first();
  assert.equal(tracker.keep(), false);
});

test('a hide during the settle window cancels the earlier clear', () => {
  const pending: Array<() => void> = [];
  const tracker = createResumeTracker(15_000);
  const schedule: Parameters<typeof tracker.noteVisible>[0] = (_afterMs, callback) => {
    pending.push(callback);
  };

  tracker.noteHidden();
  tracker.noteVisible(schedule);
  tracker.noteHidden();
  tracker.noteVisible(schedule);

  const stale = pending[0];
  assert.ok(stale);
  stale();
  assert.equal(tracker.keep(), true);

  const current = pending[1];
  assert.ok(current);
  current();
  assert.equal(tracker.keep(), false);
});

test('patchViteResumeReload redirects only the socket-drop reload', () => {
  const source = `
		location.reload();
		await waitForSuccessfulPing(url.href);
		location.reload();
	`;
  const patched = patchViteResumeReload(source);
  assert.equal(patched.match(/location\.reload\(\)/g)?.length, 2);
  assert.match(patched, /__unleashdKeepOnResume/);
  assert.equal(patchViteResumeReload(patched), patched);
  assert.throws(() => patchViteResumeReload('location.reload();'), /waitForSuccessfulPing/);
});

test('the installed Vite client still has the socket-drop reload this guard wraps', () => {
  const clientPath = new URL('../node_modules/vite/dist/client/client.mjs', import.meta.url);
  const source = fs.readFileSync(clientPath, 'utf8');
  const patched = patchViteResumeReload(source);
  assert.match(patched, /__unleashdKeepOnResume/);
  assert.equal(
    source.match(/location\.reload\(\)/g)?.length,
    patched.match(/location\.reload\(\)/g)?.length
  );
});

test('isViteClientModule matches the served client and not the app', () => {
  assert.equal(isViteClientModule('/x/node_modules/vite/dist/client/client.mjs'), true);
  assert.equal(isViteClientModule('/x/node_modules/vite/dist/client/client.mjs?v=1'), true);
  assert.equal(isViteClientModule('/x/client/src/main.tsx'), false);
});

test('resume reconnects a closed socket and leaves an open one alone', () => {
  assert.equal(resumeNeedsSocketReconnect(undefined), true);
  assert.equal(resumeNeedsSocketReconnect(2), true);
  assert.equal(resumeNeedsSocketReconnect(3), true);
  assert.equal(resumeNeedsSocketReconnect(0), false);
  assert.equal(resumeNeedsSocketReconnect(1), false);
});

// Regression (2026-10-08): a Mac sleep or a tab stalled in swap never fires visibilitychange, so
// the dev client reloaded a "visible" page on wake. A frozen page shows as a large timer gap.
test('a long gap between clock looks reads as a wake; a normal tick does not', () => {
  let clock = 0;
  const wake = createWakeDetector(5_000, () => clock);
  clock += 1_000;
  assert.equal(wake.gapExceeded(), false);
  clock += 60_000;
  assert.equal(wake.gapExceeded(), true);
  clock += 1_000;
  assert.equal(wake.gapExceeded(), false, 'the gap is consumed once');
});
