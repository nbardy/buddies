import assert from 'node:assert/strict';
import test from 'node:test';
import type { Location } from 'react-router-dom';
import { backgroundOf, expeditionOverlay } from '../src/components/buddies/expedition-overlay';

const at = (pathname: string, state: unknown = null): Location => ({
  pathname,
  search: '',
  hash: '',
  state,
  key: pathname,
});

// /expeditions/:id is a modal over the view it was opened from (owner, 2026-11-01). Dropping the
// background makes Back stop closing the modal over its opener and every close jump home; a
// nested open that kept the first modal's URL as background would stack modals on Back. Where a
// direct load lands (its workspace's channels expedition index) is useOverlayBase, rendered through
// the real AppRoutes in expedition.test.tsx.
test('an expedition URL opens the modal over its opener, a direct load without one, and keeps the first background when opened from inside', () => {
  const channel = at('/channels/ws-1/c-1');
  const opened = at('/expeditions/widget-abc123', { background: channel });
  const over = expeditionOverlay(opened);
  assert.deepEqual(over, { t: 'over', id: 'widget-abc123', background: channel });

  const direct = at('/expeditions/widget-abc123');
  assert.deepEqual(expeditionOverlay(direct), { t: 'direct', id: 'widget-abc123' });
  // History state is untyped: a background that is not a location is no background.
  assert.equal(expeditionOverlay(at('/expeditions/x', { background: 'nope' })).t, 'direct');

  // Opening another expedition from inside this modal keeps the channel underneath.
  assert.equal(backgroundOf(opened), channel);
  assert.equal(backgroundOf(channel), channel);

  assert.deepEqual(expeditionOverlay(channel), { t: 'none' });
  assert.deepEqual(expeditionOverlay(at('/expeditions/a/b')), { t: 'none' });
});
