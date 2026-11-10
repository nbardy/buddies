import assert from 'node:assert/strict';
import { register } from 'node:module';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';

register(
  `data:text/javascript,${encodeURIComponent(`
    export async function load(url, context, nextLoad) {
      if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true };
      return nextLoad(url, context);
    }
  `)}`,
  import.meta.url
);
const { BuddyRailRow } = await import('../src/components/buddies/BuddyRailRow');

// Clicking a Buddy name in the Slack rail opens the DM (the ongoing owner
// chat), matching the mobile Buddies home. It used to link to the Buddy page,
// leaving the DM behind a hover-only icon.
test('desktop slack rail: buddy name is a DM button, never a buddy-page link', () => {
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <BuddyRailRow
        member={{ id: 'b1', name: 'Lead', role: 'Own the work' }}
        openDm={() => {}}
        current={false}
        workspaceId="workspace"
      />
    </MemoryRouter>
  );
  assert.ok(html.includes('aria-label="Message Lead"'), 'name must offer the DM action');
  assert.ok(!html.includes('href="/buddies/b1'), 'rail name must not link to a buddy page');
  assert.ok(
    html.includes('/buddies/workspaces/workspace/channels?workers=b1'),
    'workers stay inside the Buddy workspace'
  );
  assert.ok(
    html.indexOf('channel-browser-buddy-actions') < html.indexOf('buddy-background-link'),
    'Wake controls should precede the worker link so the right-side worker target stays clear'
  );
});
