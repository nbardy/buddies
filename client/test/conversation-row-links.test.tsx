/**
 * The shared ConversationRow (Sidebar `sidebar`, Gallery `card`, mobile `list`)
 * is an "open this conversation" affordance on every variant, so each must be a
 * real anchor at the row's own id, and a row the client no longer holds must
 * render nothing at all.
 *
 * Regression guards:
 *   - Sidebar rows and Gallery cards were `<div onClick={navigate(...)}>` until
 *     T20-F: no href, no middle-click, no open-in-new-tab.
 *   - Sidebar Done and Gallery Restore/Promote are buttons on the same row. A
 *     `<button>` nested inside the `<a>` is invalid HTML and the click would
 *     also navigate, so they must be siblings of the link, never descendants.
 */
import assert from 'node:assert/strict';
import { register } from 'node:module';
import test from 'node:test';
import { Provider, createStore } from 'jotai';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { rowsAtom } from '../src/atoms/conversations';
import { syntheticConversation } from './fixtures/synthetic-conversations';

register(
  `data:text/javascript,${encodeURIComponent(`
    export async function load(url, context, nextLoad) {
      if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true };
      return nextLoad(url, context);
    }
  `)}`,
  import.meta.url
);
// getProjectColor reads the theme's CSS variables; there is no DOM here.
Object.assign(globalThis, {
  document: { documentElement: {} },
  getComputedStyle: () => ({ getPropertyValue: () => '' }),
});
const { ConversationRow } = await import('../src/views/conversation-row/ConversationRow');
type ConversationRowProps =
  import('../src/views/conversation-row/ConversationRow').ConversationRowProps;

const LIVE = 'live-conversation-id';
const DEAD = 'dead-conversation-id';

function render(props: ConversationRowProps): string {
  const store = createStore();
  store.set(rowsAtom, new Map([[LIVE, syntheticConversation(1, { id: LIVE, done: true })]]));
  return renderToStaticMarkup(
    <Provider store={store}>
      <MemoryRouter>
        <ConversationRow {...props} />
      </MemoryRouter>
    </Provider>
  );
}

const VARIANTS: Array<(id: string) => ConversationRowProps> = [
  (id) => ({ variant: 'sidebar', id, active: false, folder: 'badge', onDone: () => {} }),
  (id) => ({
    variant: 'card',
    id,
    worker: false,
    doneView: true,
    connected: true,
  }),
  (id) => ({ variant: 'list', id, routeState: {} }),
];

for (const make of VARIANTS) {
  const variant = make(LIVE).variant;

  test(`${variant} row opens its own conversation through one anchor`, () => {
    const html = render(make(LIVE));
    const hrefs = [...html.matchAll(/<a [^>]*href="([^"]*)"/g)].map((m) => m[1]);
    assert.deepEqual(hrefs, [`/chat/${LIVE}`]);
    const anchors = [...html.matchAll(/<a [^>]*>([\s\S]*?)<\/a>/g)].map((m) => m[1]);
    assert.ok(
      anchors.every((inner) => !inner.includes('<button')),
      'no button nested in the link'
    );
  });

  test(`${variant} row renders nothing for a conversation the client does not hold`, () => {
    assert.equal(render(make(DEAD)), '');
  });
}
