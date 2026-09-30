import assert from 'node:assert/strict';
import { test } from 'node:test';

// Regression guard (2026-09-30): Home pins moved from the prefs blob (`projectPins`) to the
// server's `Task.pin`. The prefs schema dropped the field and zod strips it on read, so the first
// unrelated prefs write (any toggle) rewrote the blob without it and a device's saved pins were
// gone before the owner could import them. Loading the atoms must lift them into their own key.
test('pins saved in the old prefs blob survive a prefs write and can be forgotten', async () => {
  const store = new Map<string, string>();
  Object.assign(globalThis, {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    },
  });
  store.set(
    'unleashd-ui-local',
    JSON.stringify({ showTempSessions: true, projectPins: { w1: ['t2', 't1'], w2: [] } })
  );
  const ui = await import('../src/atoms/ui');
  const { jotaiStore } = await import('../src/atoms/store');

  ui.setShowDoneConversations(true);
  assert.deepEqual(jotaiStore.get(ui.retiredHomePinsAtom), { w1: ['t2', 't1'] });
  const prefs = JSON.parse(store.get('unleashd-ui-local') ?? '{}');
  assert.equal('projectPins' in prefs, false);
  assert.equal(prefs.showTempSessions, true);

  ui.forgetRetiredHomePins('w1');
  assert.deepEqual(JSON.parse(store.get('unleashd-retired-home-pins') ?? 'null'), {});
});
