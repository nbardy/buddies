import assert from 'node:assert/strict';
import { register } from 'node:module';
import test from 'node:test';
import { type Message, createDefaultConversationConfig } from '@unleashd/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { CODEX_INSTALLED, buddyFixture, rosterFixture } from './fixtures/buddy-roster';
import { inboxFixture, postFixture, publicChannel } from './fixtures/channel-posts';
import { syntheticConversation, syntheticDetail } from './fixtures/synthetic-conversations';
register(
  `data:text/javascript,${encodeURIComponent(`
    export async function load(url, context, nextLoad) {
      if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true };
      return nextLoad(url, context);
    }
  `)}`,
  import.meta.url
);
const { ChannelBrowser } = await import('../src/components/buddies/ChannelBrowser');
const { ChannelsMobile } = await import('../src/mobile/channels/ChannelsMobile');
const { ReplyRetry } = await import('../src/components/buddies/HarnessPicker');
const { directChainUrl, startNewDirectChat } = await import('../src/components/buddies/ChannelDm');
const { workspaceDirectory } = await import('../src/components/buddies/channel-data');
const { channelsView, channelsHref } = await import('../src/components/buddies/channels-view');
const { Provider } = await import('jotai');
const { jotaiStore } = await import('../src/atoms/store');
const { loadResource } = await import('../src/atoms/resources');
const { rowsAtom, transcriptStore } = await import('../src/atoms/conversations');

// 493c1c7: a Buddy DM opened in Channels showed the conversation page, and "New chat" / the
// out-of-tokens retry did not exist. The DM is now drawn as a thread, every chat generation in
// order with a divider, on desktop and phone.

const WS = 'ws-dm';
const lead = buddyFixture({ id: 'lead', name: 'Lead', role: 'Own the work' });
const OLD = '11111111-1111-4111-8111-000000000001';
const NEW = '11111111-1111-4111-8111-000000000002';
const at = (minute: number) => new Date(Date.UTC(2026, 8, 26, 9, minute));
const message = (role: Message['role'], content: string, minute: number): Message => ({
  role,
  body: { t: 'text', text: content },
  timestamp: at(minute),
});

async function seed() {
  const row = (id: string, index: number) =>
    syntheticConversation(index, {
      id,
      kind: { t: 'buddy', buddyId: 'lead', workspaceId: WS, visibility: 'foreground' },
      provider: 'codex',
      createdAt: at(index === 1 ? 0 : 30).getTime(),
      messageCount: 2,
    });
  jotaiStore.set(
    rowsAtom,
    new Map([
      [OLD, row(OLD, 1)],
      [NEW, row(NEW, 2)],
    ])
  );
  const loaded = (id: string, messages: Message[]) =>
    [id, { tag: 'loaded' as const, epoch: 0, messages, detail: syntheticDetail(id) }] as const;
  jotaiStore.set(transcriptStore.patch, {
    set: [
      loaded(OLD, [message('user', 'Old question', 0), message('assistant', 'Old answer', 1)]),
      loaded(NEW, [message('user', 'Fresh start', 30), message('assistant', 'Fresh answer', 31)]),
    ],
    remove: [],
  });
  await loadResource({
    key: directChainUrl('lead'),
    load: async () => ({ buddyId: 'lead', generations: [OLD, NEW] }),
  });
  await loadResource({
    key: `/api/buddies/workspaces/${WS}/inbox`,
    load: async () => inboxFixture([{ channel: publicChannel('ch_a', 'general', WS), unread: 0 }]),
  });
  await loadResource({
    key: '/api/buddies/overview',
    load: async () => [rosterFixture([lead], { id: WS, name: 'unleashd' })],
  });
  await loadResource({ key: `/api/buddies/tasks?workspaceId=${WS}`, load: async () => [] });
  // The divider reads the previous chat's config from its detail alone (ChannelDm DmGeneration).
  await loadResource({ key: `/api/conversations/${OLD}`, load: async () => syntheticDetail(OLD) });
}

const directory = () =>
  workspaceDirectory(
    [rosterFixture([lead], { id: WS, name: 'unleashd' })],
    WS,
    [],
    CODEX_INSTALLED
  );

function desktop(dm: string) {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[`/?dm=${dm}`]}>
      <Provider store={jotaiStore}>
        <ChannelBrowser
          workspaceId={WS}
          directory={directory()}
          availableConversationIds={new Set([OLD, NEW])}
        />
      </Provider>
    </MemoryRouter>
  );
}

test('a desktop DM opens on its latest chat, earlier ones behind a button, Refresh context in the header', async () => {
  await seed();
  const html = desktop(NEW);
  assert.match(html, /aria-label="Direct message with Lead"/);
  // 2026-10-05: drawing and fetching every earlier chat on open cost up to ~1 s per click.
  assert.doesNotMatch(html, /Old question/, 'earlier chats are not drawn until asked for');
  const order = [
    'Show 1 earlier chat',
    'Context refreshed · New chat',
    'Fresh start',
    'Fresh answer',
  ].map((text) => html.indexOf(text));
  assert.ok(
    order.every((index, i) => index !== -1 && (i === 0 || index > order[i - 1])),
    `generations in order around the divider: ${order}`
  );
  assert.match(html, /class="channel-browser-author">Lead</);
  assert.match(html, /class="channel-inline-action"[^>]*>Refresh context</);
  assert.ok(html.indexOf('Refresh context') < html.indexOf('Fresh start'));
  assert.match(html, /Model: /);
  assert.match(html, /aria-label="About Lead"/);
  assert.match(html, /placeholder="Message Lead"/);
  assert.doesNotMatch(html, /class="chat-container/, 'not the conversation page');

  // A link to an earlier chat shows that chat alone, with a way to the latest.
  const old = desktop(OLD);
  assert.match(old, /Old answer/);
  assert.doesNotMatch(old, /Fresh answer/);
  assert.match(old, />Latest chat</);
});

test('a sending DM queue head disappears once its owner message is in the transcript', async () => {
  await seed();
  const body =
    'Please delegate the kernel implementation now, then review the result against the saved reference and report any mismatch.';
  jotaiStore.set(transcriptStore.patch, {
    set: [
      [
        NEW,
        {
          tag: 'loaded' as const,
          epoch: 0,
          messages: [message('user', body, 44)],
          detail: syntheticDetail(NEW, {
            queue: [
              { id: 'sending', content: body, queuedAt: at(43), status: 'sending' },
              {
                id: 'pending',
                content: 'A distinct next message',
                queuedAt: at(45),
                status: 'pending',
              },
            ],
          }),
        },
      ],
    ],
    remove: [],
  });

  const html = desktop(NEW);
  assert.equal(html.split(body).length - 1, 1, 'the transcript owns the already-sent message');
  assert.equal(html.split('A distinct next message').length - 1, 1, 'pending queue stays visible');
});

test('starting a new DM leaves the visible conversation available while its replacement loads', async () => {
  await seed();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ conversationId: 'next' }), {
      headers: { 'content-type': 'application/json' },
    });
  try {
    const result = await startNewDirectChat('lead', {
      config: syntheticDetail(NEW).config.config,
    });
    assert.equal(result, 'next');
    assert.equal(jotaiStore.get(rowsAtom).get(NEW)?.done, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a phone DM stays in Channels with Back to where it was opened', async () => {
  await seed();
  assert.deepEqual(channelsView('?channel=ch_a&dm=x'), { kind: 'dm', conversationId: 'x' });
  assert.equal(
    channelsHref(WS, { kind: 'dm', conversationId: 'x' }),
    `/buddies/workspaces/${WS}/channels?dm=x`
  );
  const html = renderToStaticMarkup(
    <MemoryRouter initialEntries={[`/buddies/workspaces/${WS}/channels?channel=ch_a&dm=${NEW}`]}>
      <Provider store={jotaiStore}>
        <Routes>
          <Route path="/buddies/workspaces/:workspaceId/channels" element={<ChannelsMobile />} />
        </Routes>
      </Provider>
    </MemoryRouter>
  );
  assert.match(html, /class="mobile-channel[^"]*" aria-label="Direct message with Lead"/);
  assert.match(
    html,
    new RegExp(`aria-label="Back" href="/buddies/workspaces/${WS}/channels\\?channel=ch_a"`)
  );
  assert.match(html, /class="mobile-channel-header__dm-actions ui-row">[\s\S]*Refresh context/);
  assert.match(html, /mobile-channel-header__dm-actions ui-row">[\s\S]*Model: /);
  assert.match(html, /Fresh answer/);
});

test('only a harness failure offers a retry on another harness', () => {
  const failed = (body: string) =>
    renderToStaticMarkup(
      <Provider store={jotaiStore}>
        <ReplyRetry
          post={postFixture({
            id: `post_${body.length}`,
            author: { kind: 'buddy', id: 'lead' },
            purpose: 'reply_failed',
            body,
          })}
        />
      </Provider>
    );
  assert.match(failed('Couldn’t reply: Out of tokens: usage limit'), />Retry with model…</);
  assert.match(
    failed('Couldn’t reply: Provider completed the turn with reason: error'),
    /Retry with model…/
  );
  assert.equal(failed('Couldn’t reply: Buddy is not active'), '');
  assert.equal(failed('Couldn’t reply: the turn ended without a channel post'), '');
});

// PORT-3 "needs owner" (493c1c7 Chat.tsx): the /chat page stitched a DM's generations and sent an
// earlier one to the latest. DMs live in Channels now, so the page points there instead of
// drawing a second joined view. Without this, a DM opened from the sidebar was a dead end: no
// New chat, and no hint that its earlier or later chats exist.
test('the conversation page sends a Buddy DM chat to Channels; other Buddy chats get no notice', async () => {
  await seed();
  const { ChatRoute } = await import('../src/components/Chat');
  const SEAT = '11111111-1111-4111-8111-000000000009';
  const seat = syntheticConversation(3, {
    id: SEAT,
    kind: { t: 'buddy', buddyId: 'lead', workspaceId: WS, visibility: 'foreground' },
    messageCount: 2,
  });
  jotaiStore.set(rowsAtom, new Map([...jotaiStore.get(rowsAtom), [SEAT, seat]]));
  jotaiStore.set(transcriptStore.patch, {
    set: [
      [
        SEAT,
        {
          tag: 'loaded' as const,
          epoch: 0,
          messages: [message('user', 'Seat question', 5)],
          detail: syntheticDetail(SEAT),
        },
      ],
    ],
    remove: [],
  });
  const page = (id: string) =>
    renderToStaticMarkup(
      <MemoryRouter initialEntries={[`/chat/${id}`]}>
        <Provider store={jotaiStore}>
          <Routes>
            <Route path="/chat/:id" element={<ChatRoute />} />
          </Routes>
        </Provider>
      </MemoryRouter>
    );
  const latest = `href="/buddies/workspaces/${WS}/channels\\?dm=${NEW}"`;
  const current = page(NEW);
  assert.match(current, new RegExp(`${latest}[^>]*>Open DM<`));
  assert.match(current, /class="channel-inline-action"[^>]*>Refresh context</);
  // An earlier generation says so and opens the latest, as the snapshot's redirect did.
  const earlier = page(OLD);
  assert.match(earlier, new RegExp(`${latest}[^>]*>Open DM<`));
  // A seat or Wake chat is a Buddy conversation but not a DM generation.
  const other = page(SEAT);
  assert.match(other, /class="chat-view /, 'the page rendered the conversation');
  assert.doesNotMatch(other, />Open DM</);
});

test('the New chat divider says when the harness changed, and stays plain when it did not', async () => {
  await seed();
  assert.doesNotMatch(desktop(NEW), /harness and model changed to/);
  const codex = createDefaultConversationConfig('codex');
  jotaiStore.set(transcriptStore.patch, {
    set: [
      [
        NEW,
        {
          tag: 'loaded' as const,
          epoch: 0,
          messages: [message('user', 'Fresh start', 30)],
          detail: syntheticDetail(NEW, {
            config: { ...syntheticDetail(NEW).config, config: codex },
          }),
        },
      ],
    ],
    remove: [],
  });
  assert.match(desktop(NEW), /harness and model changed to codex/);
});

test('reset banners follow the date on desktop and in an empty new chat', async () => {
  await seed();
  const tomorrow = new Date(Date.UTC(2026, 8, 27, 9, 30));
  const row = jotaiStore.get(rowsAtom).get(NEW)!;
  jotaiStore.set(
    rowsAtom,
    new Map([
      ...jotaiStore.get(rowsAtom),
      [NEW, { ...row, createdAt: tomorrow.getTime(), messageCount: 0 }],
    ])
  );
  jotaiStore.set(transcriptStore.patch, {
    set: [[NEW, { tag: 'loaded', epoch: 0, messages: [], detail: syntheticDetail(NEW) }]],
    remove: [],
  });
  const html = desktop(NEW);
  const date = tomorrow.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
  assert.ok(html.indexOf(date) > html.indexOf('earlier chat'));
  assert.ok(html.indexOf('Context refreshed · New chat') > html.indexOf(date));
  assert.match(html, /class="channel-dm-notice"/);
});

test('a long DM draws only its newest rows, opening on a lead, with older ones paged on scroll-up', async () => {
  // Fix guard (2026-10-05): a 331-row DM drew ~3,300 nodes on every open (0.7-1.2 s of long
  // tasks). The open chat draws a window of rows and ChannelHistory reveals more on scroll-up.
  await seed();
  // Pairs a minute apart: each owner line is a lead, each answer continues nothing (author flips).
  const long = Array.from({ length: 150 }, (_, i) =>
    message(i % 2 ? 'assistant' : 'user', `Line ${i} end`, 30 + Math.floor(i / 10))
  );
  jotaiStore.set(transcriptStore.patch, {
    set: [[NEW, { tag: 'loaded', epoch: 0, messages: long, detail: syntheticDetail(NEW) }]],
    remove: [],
  });
  const html = desktop(NEW);
  assert.match(html, /Line 149 end/, 'the newest row is drawn');
  assert.doesNotMatch(html, /Line 0 end/, 'the oldest row is held back');
  assert.match(html, /class="channel-history"/, 'a scroll-up sentinel pages the rest in');
  assert.doesNotMatch(html, /Show 1 earlier chat/, 'earlier chats wait until this one is revealed');
  const drawn = html.split('Line ').length - 1;
  assert.ok(drawn >= 40 && drawn < 60, `a window of rows, not all 150 (drew ${drawn})`);
});
