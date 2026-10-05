import assert from 'node:assert/strict';
import test from 'node:test';
import { buildScreens, contactSheet } from './screenshots.mjs';

// A misplaced image-viewer screen crashed the gallery after every successful capture.
test('a real screenshot manifest produces an escaped gallery', () => {
  const html = contactSheet({
    createdAt: '2026-10-04T00:00:00Z',
    clockMs: Date.UTC(2026, 9, 4),
    baseUrl: 'http://localhost:7509',
    found: { workspaceName: 'Model <review>', buddyName: 'Lead', channelName: 'general' },
    sizes: ['desktop', 'phone'],
    screens: ['thread-selection'],
    shots: [{ screen: 'thread-selection', size: 'desktop', file: 'thread-selection@desktop.png' }],
    skipped: [{ screen: 'thread-selection', size: 'phone', reason: 'no <seat>' }],
  });
  assert.match(html, /Model &lt;review&gt;/);
  assert.match(html, /thread-selection@desktop.png/);
  assert.match(html, /no &lt;seat&gt;/);
});

test('the image viewer and thread selection belong to the screen inventory on both trees', () => {
  const screens = buildScreens(
    { workspaceId: 'workspace', channelId: 'channel', threadRootId: 'root' },
    null
  );
  for (const name of ['image-viewer', 'thread-selection', 'thread-selection-picker']) {
    const screen = screens.find((entry) => entry.name === name);
    assert.ok(screen);
    assert.equal(screen.missing, null);
    assert.ok(screen.views.desktop.prepare);
    assert.ok(screen.views.mobile.prepare);
  }
});
