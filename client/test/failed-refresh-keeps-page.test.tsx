/**
 * A failed background refresh never takes a loaded page away.
 *
 * Observed 2026-09-24 on a phone: the server answered in ~7 s, one background
 * refresh failed with "Failed to fetch", and a Buddy page that had already
 * loaded was replaced by the full-screen "Could not load buddy". The keyed
 * cache still held the page (`stale`), but usePolledFetch flattened that into
 * `{data, error}` and the page tested `error` first. The desktop Buddies
 * directory blanked the same way on one failed poll of the overview the
 * Sidebar shares. The view state is now the cache's sum (`PolledState` in
 * hooks/usePolledFetch.ts): a failed refresh and a failed first load are
 * different variants.
 *
 * Real routes and components over the real keyed cache; only the network
 * (`fetch`) is stubbed.
 */
import assert from 'node:assert/strict';
import { register } from 'node:module';
import test from 'node:test';
// biome-ignore lint/style/useImportType: tsx's test transform uses the classic JSX runtime.
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

register(
  `data:text/javascript,${encodeURIComponent(`
    export async function load(url, context, nextLoad) {
      if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true };
      return nextLoad(url, context);
    }
  `)}`,
  import.meta.url
);
const { Provider } = await import('jotai');
const { jotaiStore } = await import('../src/atoms/store');
const { clearResourceCache, loadResource } = await import('../src/atoms/resources');
const { buddyApi } = await import('../src/components/buddies/api');
const { BUDDY_OVERVIEW_URL, buddyDetailUrl } = await import('../src/hooks/useBuddyData');
const { BuddiesDashboard } = await import('../src/components/BuddiesDashboard');
const { BuddyDetailMobile } = await import('../src/mobile/buddies/BuddyDetailMobile');
const { ShellMobile } = await import('../src/mobile/components/ShellMobile');
const { buddyFixture, rosterFixture } = await import('./fixtures/buddy-roster');

const buddy = buddyFixture({ id: 'b1', name: 'Ada', role: 'Keeps the release train moving' });

const SERVER: Record<string, unknown> = {
  [buddyDetailUrl('b1')]: { buddy, tasks: [], schedules: [], runs: [] },
  [BUDDY_OVERVIEW_URL]: [rosterFixture([buddy])],
};

// Offline is the slow server dropping a request: fetch rejects as a browser's does.
let online = true;
const realFetch = globalThis.fetch;
globalThis.fetch = async (input: RequestInfo | URL) => {
  if (!online) throw new TypeError('Failed to fetch');
  const path = String(input);
  assert.ok(path in SERVER, `unexpected request ${path}`);
  return new Response(JSON.stringify(SERVER[path]), {
    headers: { 'content-type': 'application/json' },
  });
};
test.after(() => {
  globalThis.fetch = realFetch;
});
test.beforeEach(() => {
  clearResourceCache();
  online = true;
});

/** A URL-keyed read, as usePolledFetch loads a URL source. */
const urlResource = (path: string) => ({
  key: path,
  load: (signal: AbortSignal) => buddyApi(path, { signal }),
});

function render(path: string, routes: React.ReactNode) {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[path]}>
      <Provider store={jotaiStore}>
        <Routes>{routes}</Routes>
      </Provider>
    </MemoryRouter>
  );
}

// The phone route as App.tsx mounts it: the Buddy page inside the shell.
const phone = () =>
  render(
    '/buddies/b1/conversations',
    <Route element={<ShellMobile />}>
      <Route path="/buddies/:buddyId/:tab" element={<BuddyDetailMobile />} />
    </Route>
  );

test('a failed refresh keeps a loaded Buddy page on the phone, with a notice', async () => {
  const reads = [urlResource(buddyDetailUrl('b1')), urlResource(BUDDY_OVERVIEW_URL)];
  const refresh = () => Promise.all(reads.map((read) => loadResource(read)));

  // Nothing ever loaded: the full-screen failure is the whole page.
  online = false;
  await refresh();
  assert.match(phone(), /Could not load buddy/);

  online = true;
  await refresh();
  assert.match(phone(), /<h1>Ada<\/h1>/);

  // The 2026-09-24 incident: one background refresh fails over a loaded page.
  online = false;
  await refresh();
  const html = phone();
  assert.match(html, /<h1>Ada<\/h1>/);
  assert.doesNotMatch(html, /Could not load buddy/);
  assert.match(html, /Could not refresh: Failed to fetch/);
});

test('a failed poll of the overview keeps the desktop Buddies directory', async () => {
  const overview = urlResource(BUDDY_OVERVIEW_URL);
  await loadResource(overview);
  online = false;
  await loadResource(overview);

  const html = render('/buddies', <Route path="/buddies" element={<BuddiesDashboard />} />);
  assert.match(html, /Ada/);
  assert.match(html, /Could not refresh: Failed to fetch/);
});
