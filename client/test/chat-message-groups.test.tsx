import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createRequire, register } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { Message } from '@unleashd/shared';
import { parseBuddyWorkerToolResult } from '@unleashd/shared';
import { Provider, createStore } from 'jotai';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import {
  groupsFamily,
  messagesOf,
  rowsAtom,
  streamStore,
  transcriptFamily,
  transcriptStore,
} from '../src/atoms/conversations';
import { lastOwnerText } from '../src/components/buddies/channel-dm';
import { groupChatMessages, regroupChatMessages } from '../src/utils/chat-message-groups';
import { buildForkDraft, messageTranscriptContent } from '../src/utils/conversation-transcript';
import { syntheticConversation, syntheticDetail } from './fixtures/synthetic-conversations';

// Saved transcripts are parsed by the ingest crate (the server's only transcript reader since
// T13b S2); it is the server's dependency, so it resolves from there.
const ingestAddon = createRequire(new URL('../../server/package.json', import.meta.url))(
  '@unleashd/ingest'
);
const { sessionMessages } = createRequire(import.meta.url)(
  '../../server/src/ingest/history.ts'
) as typeof import('../../server/src/ingest/history');

/** Parse Codex rollout records the way the server does: through the ingest store. */
async function savedCodexMessages(records: unknown[]): Promise<Message[]> {
  const home = await fs.mkdtemp(path.join(tmpdir(), 'codex-saved-'));
  const sessionId = '0199a000-0000-7000-8000-000000000001';
  const day = path.join(home, '.codex', 'sessions', '2026', '09', '10');
  await fs.mkdir(day, { recursive: true });
  const meta = {
    timestamp: timestamp.toISOString(),
    type: 'session_meta',
    payload: { id: sessionId, timestamp: timestamp.toISOString(), cwd: home },
  };
  await fs.writeFile(
    path.join(day, `rollout-2026-09-10T00-00-00-${sessionId}.jsonl`),
    [meta, ...records].map((record) => JSON.stringify(record)).join('\n')
  );
  const ingest = await ingestAddon.Ingest.start(
    ingestAddon.defaultRoots(home),
    path.join(home, 'ingest.sqlite'),
    () => undefined
  );
  try {
    return await sessionMessages(ingest, { sessionId, createdAt: timestamp.getTime() }, 100);
  } finally {
    await ingest.stop();
    await fs.rm(home, { recursive: true, force: true });
  }
}

register(
  `data:text/javascript,${encodeURIComponent(`
    export async function load(url, context, nextLoad) {
      if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true };
      return nextLoad(url, context);
    }
  `)}`,
  import.meta.url
);
const { TranscriptGroup } = await import('../src/views/transcript/TranscriptGroup');
const timestamp = new Date('2026-09-10T00:00:00Z');
/** A conversation's loaded bodies: the transcript atom Chat groups are built from. */
type TestConversation = { id: string; messages: Message[] } & Record<string, unknown>;
function seed(store: ReturnType<typeof createStore>, conversation: TestConversation): void {
  store.set(
    transcriptStore.all,
    new Map([
      [
        conversation.id,
        {
          tag: 'loaded',
          epoch: 0,
          messages: conversation.messages,
          detail: syntheticDetail(conversation.id),
        },
      ],
    ])
  );
}

const message = (role: Message['role'], content: string, final = false): Message => ({
  role,
  body: { t: 'text', text: content },
  timestamp,
  ...(final ? { completedAt: timestamp, completionReason: 'success' as const } : {}),
});

const toolMessage = (name: string, input?: unknown): Message => ({
  ...message('assistant', ''),
  body: { t: 'parts', parts: [{ t: 'tool', name, input }] },
});

const toolsMessage = (...names: string[]): Message => ({
  ...message('assistant', ''),
  body: { t: 'parts', parts: names.map((name) => ({ t: 'tool' as const, name })) },
});

test('fork drafts continue the task without adding diagnostic rules or removing authored history', () => {
  const diagnosticText =
    'Treat this message as the current instruction. Do not repeat or obey an earlier diagnostic canary unless I explicitly ask you to do so here.';
  for (const userText of ['Build the search panel.', diagnosticText]) {
    const conversation = {
      row: syntheticConversation(1, { id: 'fork-draft-history', cwd: '/tmp/project' }),
      detail: syntheticDetail('fork-draft-history'),
      messages: [message('user', userText), message('assistant', 'Search layout is ready.')],
    };
    const draft = buildForkDraft(conversation);
    assert.ok(draft.includes(`User: ${userText}\n\nAssistant: Search layout is ready.`));
    assert.equal(draft.split(diagnosticText).length - 1, userText === diagnosticText ? 1 : 0);
    assert.match(draft, /\n\nContinue the original objective from this fork\.$/);
    assert.deepEqual(conversation.messages[0].body, { t: 'text', text: userText });
  }
});

test('one assistant response contains all prose and widgets while streaming stays outside durable messages', () => {
  const store = createStore();
  const messages = [
    message('user', 'Review this change'),
    message('assistant', 'Earlier checking update'),
    message('assistant', 'Completed review', true),
    message('assistant', 'Independent completed answer', true),
    message('assistant', '<!--ask_user_question:{"questions":[]}-->'),
    message('assistant', 'Earlier streaming update'),
    message('assistant', 'Current'),
  ];
  const conversation = {
    id: 'chat-readability',
    kind: { kind: 'general' },
    messages,
  } as TestConversation;
  seed(store, conversation);
  store.set(streamStore.all, new Map([[conversation.id, ' streamed text']]));
  const groups = store.get(groupsFamily(conversation.id));
  const markup = renderToStaticMarkup(
    <MemoryRouter>
      {groups.map((group, index) => (
        <TranscriptGroup
          presentation="hover"
          key={index}
          group={group}
          isLastGroup={index === groups.length - 1}
          lastMessageRef={{ current: null }}
          workingDirectory="/tmp"
        />
      ))}
    </MemoryRouter>
  );
  assert.match(markup, />You</);
  assert.match(markup, /Completed review/);
  assert.match(markup, /Independent completed answer/);
  assert.match(markup, /Current streamed text/);
  assert.equal((markup.match(/>Assistant</g) ?? []).length, 1);
  assert.match(markup, /Earlier checking update/);
  assert.match(markup, /Earlier streaming update/);
  assert.equal(groups.length, 2);
  const response = groups[1];
  assert.equal(response.type, 'assistant');
  if (response.type !== 'assistant') throw new Error('Missing response');
  assert.equal(response.parts.filter((part) => part.type === 'content').length, 6);
  assert.equal((markup.match(/class="message-actions"/g) ?? []).length, 2);
  assert.equal(
    response.copyText,
    `${messages.slice(1).map(messageTranscriptContent).join('\n\n')} streamed text`
  );
  assert.equal(messagesOf(store.get(transcriptFamily(conversation.id))), messages);
  assert.deepEqual(messages.at(-1)?.body, { t: 'text', text: 'Current' });

  store.set(streamStore.all, new Map());
  assert.deepEqual(store.get(groupsFamily(conversation.id)).at(-1)?.messages.at(-1)?.body, {
    t: 'text',
    text: 'Current',
  });
});

test('response boundaries own one Copy action and preserve ordered tool runs and every completed answer', () => {
  const store = createStore();
  const conversation = {
    id: 'tool-activity-labels',
    kind: { kind: 'general' },
    messages: [
      message('user', 'Inspect the project'),
      toolsMessage('exec', 'exec'),
      toolMessage('shell', { command: 'pwd' }),
      message('assistant', 'First answer', true),
      toolMessage('get_inbox'),
      message('assistant', 'Second answer', true),
      message('assistant', 'Checking the result'),
      toolMessage('exec'),
      message('assistant', 'Final answer', true),
      toolsMessage('one.ts', 'two.ts'),
      toolMessage('three.ts'),
      message('user', 'Next question'),
      message('assistant', 'Next answer', true),
      message('system', 'Execution stopped'),
      message('assistant', 'After system boundary', true),
    ],
  } as TestConversation;
  seed(store, conversation);
  const groups = store.get(groupsFamily(conversation.id));
  const markup = renderToStaticMarkup(
    <MemoryRouter>
      {groups.map((group, index) => (
        <TranscriptGroup
          presentation="hover"
          key={index}
          group={group}
          isLastGroup={index === groups.length - 1}
          lastMessageRef={{ current: null }}
          workingDirectory="/tmp"
        />
      ))}
    </MemoryRouter>
  );
  const labels = Array.from(markup.matchAll(/<button\b[^>]*>(.*?)<\/button>/g))
    .map((match) => match[1].replace(/<[^>]+>/g, ''))
    .filter((label) => label.includes('tool call'));
  assert.deepEqual(labels, ['▸3 tool calls', '▸1 tool call', '▸1 tool call', '▸3 tool calls']);
  assert.match(markup, /First answer/);
  assert.match(markup, /Second answer/);
  assert.match(markup, /Final answer/);
  const [firstBlock, nextBlock] = markup.split('Next question');
  assert.equal((firstBlock.match(/>Assistant</g) ?? []).length, 1);
  assert.equal((nextBlock.match(/>Assistant</g) ?? []).length, 2);
  assert.match(nextBlock, /Next answer/);
  assert.match(markup, /Checking the result/);
  assert.doesNotMatch(markup, /shell pwd/);
  assert.equal((firstBlock.match(/class="message-actions"/g) ?? []).length, 2);
  const responses = groups.filter((group) => group.type === 'assistant');
  assert.equal(responses.length, 3);
  assert.equal(responses[0].messages.length, 10);
  assert.deepEqual(
    responses[0].parts.map((part) => part.type),
    [
      'tool_calls',
      'content',
      'tool_calls',
      'content',
      'content',
      'tool_calls',
      'content',
      'tool_calls',
    ]
  );
  const mobile = renderToStaticMarkup(
    <MemoryRouter>
      <TranscriptGroup
        presentation="footer"
        group={responses[0]}
        isLastGroup
        lastMessageRef={{ current: null }}
        workingDirectory="/tmp"
      />
    </MemoryRouter>
  );
  assert.equal((mobile.match(/>Assistant</g) ?? []).length, 1);
  assert.equal((mobile.match(/class="message-actions message-actions--footer"/g) ?? []).length, 1);
  for (const text of ['First answer', 'Second answer', 'Checking the result', 'Final answer'])
    assert.ok(mobile.includes(text));
});

test('streamed tool runs and saved calls render the same compact disclosure without collapsing code or user text', () => {
  const store = createStore();
  const conversation = {
    id: 'live-saved-activity',
    kind: { kind: 'general' },
    messages: [message('user', '🔧 user example'), message('assistant', '')],
  } as TestConversation;
  seed(store, conversation);
  const render = () =>
    renderToStaticMarkup(
      <MemoryRouter>
        {store.get(groupsFamily(conversation.id)).map((group, index) => (
          <TranscriptGroup
            presentation="hover"
            key={index}
            group={group}
            isLastGroup
            lastMessageRef={{ current: null }}
            workingDirectory="/tmp"
          />
        ))}
      </MemoryRouter>
    );
  const disclosures = (markup: string) =>
    Array.from(
      markup.matchAll(
        /<button class="chat-activity-toggle"[^>]*>.*?<\/button>|<button type="button" class="chat-activity-toggle"[^>]*>.*?<\/button>/g
      ),
      (match) => match[0]
    );
  const firstCalls = [toolMessage('exec'), toolMessage('shell', { command: 'pwd' })];
  seed(store, {
    ...conversation,
    messages: [conversation.messages[0], ...firstCalls, conversation.messages[1]],
  });
  const first = render();
  assert.equal(disclosures(first).length, 1);
  assert.match(disclosures(first)[0], /2 tool calls/);

  const answer =
    'Result:\n\n```text\n🔧 fenced example\n⚡ another example\n📖 third example\n```\n\nFinished.';
  const savedCalls = [...firstCalls, toolMessage('Read', { file_path: 'source.ts' })];
  seed(store, {
    ...conversation,
    messages: [conversation.messages[0], ...savedCalls, conversation.messages[1]],
  });
  store.set(streamStore.all, new Map([[conversation.id, answer]]));
  const live = render();
  assert.equal(disclosures(live).length, 1);
  assert.match(disclosures(live)[0], /aria-expanded="false".*3 tool calls/);
  assert.match(live, /🔧 user example/);
  assert.match(live, /🔧 fenced example/);
  assert.match(live, /Finished\./);
  assert.doesNotMatch(live, /tool uses|×|shell pwd|source\.ts/);
  assert.deepEqual(conversation.messages[1].body, { t: 'text', text: '' });

  store.set(streamStore.all, new Map());
  seed(store, {
    ...conversation,
    messages: [conversation.messages[0], ...savedCalls, message('assistant', answer, true)],
  });
  const saved = render();
  assert.deepEqual(disclosures(saved), disclosures(live));
  assert.match(saved, /🔧 fenced example/);
  assert.match(saved, /Finished\./);
  assert.equal((saved.match(/>Assistant</g) ?? []).length, 1);
});

test('saved freeform input reaches desktop and mobile as literal code, with compact list previews', async (t) => {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'tool-input-render-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const input =
    'await tools.exec_command({cmd: "pwd"});\n// <!--ask_user_question:{"questions":[]}-->\n// `literal`\ntext("The full script remains available beyond the short preview.");';
  const [toolMessage] = await savedCodexMessages([
    {
      timestamp: timestamp.toISOString(),
      type: 'response_item',
      payload: { type: 'custom_tool_call', name: 'exec', call_id: 'exec-1', input },
    },
  ]);
  assert.equal(toolMessage.body.t, 'parts');
  if (toolMessage.body.t !== 'parts') throw new Error('Expected tool body');
  assert.equal(toolMessage.body.parts[0].t, 'tool');
  if (toolMessage.body.parts[0].t !== 'tool') throw new Error('Expected tool input');
  assert.equal(toolMessage.body.parts[0].name, 'exec');
  assert.equal(toolMessage.body.parts[0].input, input);
  assert.equal(messageTranscriptContent(toolMessage), `🔧 exec\n\n${input}`);
  const escapedInput = input
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#x27;');
  for (const view of [
    <TranscriptGroup
      presentation="hover"
      key="desktop"
      group={{ type: 'single', messages: [toolMessage], firstMessageIndex: 0 }}
      isLastGroup
      lastMessageRef={{ current: null }}
      workingDirectory={directory}
    />,
    <TranscriptGroup
      key="mobile"
      presentation="footer"
      group={{ type: 'single', messages: [toolMessage], firstMessageIndex: 0 }}
      isLastGroup
      lastMessageRef={{ current: null }}
      workingDirectory={directory}
    />,
  ]) {
    const markup = renderToStaticMarkup(<MemoryRouter>{view}</MemoryRouter>);
    const preview = `${input.replace(/\s+/g, ' ').slice(0, 119)}…`;
    const escapedPreview = renderToStaticMarkup(<code>{preview}</code>);
    assert.ok(markup.includes(`<p>🔧 exec ${escapedPreview}</p>`));
    assert.doesNotMatch(markup, /ask-user-question|AskUserQuestion \(parse error\)/);
    assert.equal(
      markup.match(/<pre aria-label="Tool input"><code>([\s\S]*?)<\/code><\/pre>/)?.[1],
      escapedInput
    );
  }
  const store = createStore();
  const conversation = {
    id: 'saved-input-response',
    messages: [
      message('user', 'Check this'),
      message('assistant', 'Before tool'),
      toolMessage,
      message('assistant', 'After tool', true),
    ],
  } as TestConversation;
  seed(store, conversation);
  const response = store.get(groupsFamily(conversation.id))[1];
  assert.equal(response.type, 'assistant');
  if (response.type !== 'assistant') throw new Error('Missing saved response');
  assert.equal(response.copyText, `Before tool\n\n🔧 exec\n\n${input}\n\nAfter tool`);
  assert.deepEqual(
    response.parts.map((part) => part.type),
    ['content', 'tool_calls', 'content']
  );
  const markup = renderToStaticMarkup(
    <MemoryRouter>
      <TranscriptGroup
        presentation="hover"
        group={response}
        isLastGroup
        lastMessageRef={{ current: null }}
        workingDirectory={directory}
      />
    </MemoryRouter>
  );
  assert.equal((markup.match(/class="message-actions"/g) ?? []).length, 1);
  assert.match(markup, /Before tool/);
  assert.match(markup, /After tool/);
  assert.equal(conversation.messages[2], toolMessage);
});

test('worker launch receipts stay inline in collapsed tool rows on both shells', () => {
  const thread = { conversationId: 'worker-thread', buddyId: 'engineer', label: 'Engineering' };
  const receipt = parseBuddyWorkerToolResult({
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          operation: 'buddy.send',
          data: { buddyWorkerThread: thread },
        }),
      },
    ],
  });
  assert.deepEqual(receipt, [thread]);
  assert.deepEqual(
    parseBuddyWorkerToolResult({ isError: true, data: { buddyWorkerThread: thread } }),
    []
  );
  assert.deepEqual(
    parseBuddyWorkerToolResult({ preview: true, data: { buddyWorkerThread: thread } }),
    []
  );
  for (const messages of [
    [
      toolMessage('unleashd_buddy.send'),
      {
        ...message('assistant', ''),
        body: { t: 'parts' as const, parts: [{ t: 'buddy_worker_thread' as const, thread }] },
      },
    ],
    [
      {
        ...message('assistant', ''),
        body: {
          t: 'parts' as const,
          parts: [
            { t: 'tool' as const, name: 'unleashd_buddy.send' },
            { t: 'buddy_worker_thread' as const, thread },
            { t: 'text' as const, text: 'Done dispatching.' },
          ],
        },
      },
    ],
  ]) {
    const response = groupChatMessages(messages, null)[0];
    assert.equal(response.type, 'assistant');
    if (response.type !== 'assistant') throw new Error('Expected response');
    assert.equal(response.parts[0].type, 'tool_calls');
    for (const available of [true, false]) {
      const store = createStore();
      if (available)
        store.set(
          rowsAtom,
          new Map([
            [thread.conversationId, syntheticConversation(1, { id: thread.conversationId })],
          ])
        );
      for (const view of [
        <TranscriptGroup
          presentation="hover"
          key="desktop"
          group={response}
          isLastGroup
          lastMessageRef={{ current: null }}
          workingDirectory="/tmp"
        />,
        <TranscriptGroup
          key="mobile"
          presentation="footer"
          group={response}
          isLastGroup
          lastMessageRef={{ current: null }}
          workingDirectory="/tmp"
        />,
      ]) {
        const markup = renderToStaticMarkup(
          <Provider store={store}>
            <MemoryRouter>{view}</MemoryRouter>
          </Provider>
        );
        assert.match(markup, /aria-expanded="false"/);
        assert.match(markup, /Engineering/);
        assert.equal(markup.includes('href="/chat/worker-thread"'), available);
        assert.doesNotMatch(markup, /buddy_worker_thread:/);
      }
    }
  }
});

test('live empty assistant responses show a working indicator on both shells', () => {
  // Regression: the server creates the empty assistant placeholder at
  // turn.started, before any provider output. A silent provider phase (no
  // text deltas, no tool events) left a blank "Assistant" bubble with no
  // loading affordance on either shell.
  const store = createStore();
  const conversation = {
    id: 'live-empty-assistant',
    kind: { kind: 'general' },
    messages: [message('user', 'How is it going?'), message('assistant', '')],
  } as TestConversation;
  seed(store, conversation);
  const groups = store.get(groupsFamily(conversation.id));
  assert.equal(groups.length, 2);
  const response = groups[1];
  assert.equal(response.type, 'assistant');
  if (response.type !== 'assistant') throw new Error('Missing response');
  assert.equal(response.parts.length, 0);

  const renderDesktop = (isLiveTurn?: boolean) =>
    renderToStaticMarkup(
      <MemoryRouter>
        <TranscriptGroup
          presentation="hover"
          group={response}
          isLastGroup
          lastMessageRef={{ current: null }}
          workingDirectory="/tmp"
          isLiveTurn={isLiveTurn}
        />
      </MemoryRouter>
    );
  const renderMobile = (isLive?: boolean) =>
    renderToStaticMarkup(
      <MemoryRouter>
        <TranscriptGroup
          presentation="footer"
          group={response}
          isLastGroup
          lastMessageRef={{ current: null }}
          workingDirectory="/tmp"
          isLiveTurn={isLive}
        />
      </MemoryRouter>
    );

  // Live turn, empty response: both shells show a working affordance.
  assert.match(renderDesktop(true), /chat-response-working/);
  assert.match(renderDesktop(true), /Thinking/);
  assert.match(renderMobile(true), /chat-response-working/);

  // Settled (or unknown) turn state: no indicator, blank bubble as before.
  assert.doesNotMatch(renderDesktop(false), /chat-response-working/);
  assert.doesNotMatch(renderDesktop(), /chat-response-working/);
  assert.doesNotMatch(renderMobile(false), /chat-response-working/);
  assert.doesNotMatch(renderMobile(), /chat-response-working/);

  // A live turn never flags a non-last group: the indicator belongs to the
  // response the turn is still writing to.
  const stale = renderToStaticMarkup(
    <MemoryRouter>
      <TranscriptGroup
        presentation="hover"
        group={response}
        isLastGroup={false}
        lastMessageRef={{ current: null }}
        workingDirectory="/tmp"
        isLiveTurn
      />
    </MemoryRouter>
  );
  assert.doesNotMatch(stale, /chat-response-working/);

  // Once content arrives the indicator yields to the real response.
  const withContent = {
    ...response,
    parts: [{ type: 'content', key: '0:0', message: message('assistant', 'Working on it') }],
  } as typeof response;
  const settled = renderToStaticMarkup(
    <MemoryRouter>
      <TranscriptGroup
        presentation="hover"
        group={withContent}
        isLastGroup
        lastMessageRef={{ current: null }}
        workingDirectory="/tmp"
        isLiveTurn
      />
    </MemoryRouter>
  );
  assert.doesNotMatch(settled, /chat-response-working/);
  assert.match(settled, /Working on it/);
});

test('persisted Codex launch tool output rehydrates the worker badge', async () => {
  const output = {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          operation: 'buddy.send',
          data: {
            buddyWorkerThread: {
              conversationId: 'durable-worker',
              buddyId: 'engineer',
              label: 'Engineering',
            },
          },
        }),
      },
    ],
  };
  const messages = await savedCodexMessages([
    {
      timestamp: timestamp.toISOString(),
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'mcp__unleashd_buddy__send',
        call_id: 'launch',
        arguments: '{}',
      },
    },
    {
      timestamp: timestamp.toISOString(),
      type: 'response_item',
      payload: {
        type: 'function_call_output',
        call_id: 'launch',
        output: JSON.stringify(output),
      },
    },
  ]);
  const response = groupChatMessages(messages, null)[0];
  assert.equal(response.type, 'assistant');
  if (response.type !== 'assistant' || response.parts[0].type !== 'tool_calls')
    throw new Error('Expected tool row');
  assert.equal(response.parts[0].count, 1);
  assert.equal(response.parts[0].workerThreads?.[0].conversationId, 'durable-worker');
});

// A transcript long enough to make whole-transcript regrouping visible, with
// tool records and multi-part responses so the tail is not trivially simple.
function longTranscript(turns: number): Message[] {
  const records: Message[] = [];
  for (let turn = 0; turn < turns; turn++) {
    records.push(message('user', `Question ${turn}`));
    records.push(message('assistant', `Looking at ${turn}`));
    records.push(toolMessage('Read', { path: `/f${turn}` }));
    records.push(message('assistant', `Answer ${turn}`, true));
  }
  return records;
}

test('a streaming frame rebuilds only the last group, and matches a full regroup', () => {
  const store = createStore();
  const messages = longTranscript(40);
  const conversation = { id: 'streaming-tail', kind: { kind: 'general' }, messages };
  seed(store, conversation);
  const groupsAtom = groupsFamily(conversation.id);
  const settled = store.get(groupsAtom);

  for (const text of [' streamed', ' streamed text', ' streamed text, more']) {
    store.set(streamStore.all, new Map([[conversation.id, text]]));
    const live = store.get(groupsAtom);
    assert.equal(live.length, settled.length);
    // Every group before the tail is the SAME object, so TranscriptGroup
    // (memo on group identity) skips all of them on a frame.
    for (let i = 0; i < live.length - 1; i++) assert.equal(live[i], settled[i]);
    assert.notEqual(live.at(-1), settled.at(-1));
    const streamed = messages.slice();
    streamed[streamed.length - 1] = {
      ...messages[messages.length - 1],
      body: { t: 'text', text: messageTranscriptContent(messages[messages.length - 1]) + text },
    };
    assert.deepEqual(live, groupChatMessages(streamed, null));
  }
});

test('regrouping after records change matches a full pass for every transcript prefix', () => {
  const roles: Array<() => Message> = [
    () => message('user', 'ask'),
    () => message('assistant', 'prose'),
    () => message('assistant', 'done', true),
    () => message('system', 'note'),
    () =>
      ({
        ...toolMessage('Bash', { command: 'ls' }),
      }) as Message,
  ];
  // Deterministic pseudo-random role sequences.
  let seed = 7;
  const next = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed;
  };
  for (let run = 0; run < 25; run++) {
    const records = Array.from({ length: 30 }, () => roles[next() % roles.length]());
    let previous = groupChatMessages([], null);
    let previousRecords: Message[] = [];
    for (let length = 1; length <= records.length; length++) {
      const current = records.slice(0, length);
      const regrouped = regroupChatMessages(previous, previousRecords, current, null);
      assert.deepEqual(regrouped, groupChatMessages(current, null));
      // Only the last group may be new.
      for (let i = 0; i < previous.length - 1; i++) assert.equal(regrouped[i], previous[i]);
      previous = regrouped;
      previousRecords = current;
    }
    // A replaced earlier record (a fresh snapshot) falls back to a full pass.
    const replaced = records.slice();
    replaced[0] = {
      ...records[0],
      body: { t: 'text', text: `${messageTranscriptContent(records[0])}!` },
    };
    assert.deepEqual(
      regroupChatMessages(previous, previousRecords, replaced, null),
      groupChatMessages(replaced, null)
    );
  }
});

test('mixed user parts retain retry prose and strip the hidden first-turn prefix', () => {
  const user: Message = {
    ...message('user', ''),
    body: {
      t: 'parts',
      parts: [
        { t: 'text', text: 'hidden\n\nVisible request' },
        { t: 'tool', name: 'attachment', input: { path: '/a' } },
      ],
    },
  };
  assert.equal(lastOwnerText([user]), 'hidden\n\nVisible request');
  const grouped = groupChatMessages([user], 'hidden');
  assert.deepEqual(grouped[0].messages[0].body, {
    t: 'parts',
    parts: [
      { t: 'text', text: 'Visible request' },
      { t: 'tool', name: 'attachment', input: { path: '/a' } },
    ],
  });
  const draft = buildForkDraft({
    row: syntheticConversation(1, { id: 'mixed-prefix', cwd: '/tmp/project' }),
    detail: { ...syntheticDetail('mixed-prefix'), swarmDebugPrefix: 'hidden' },
    messages: [user],
  });
  assert.match(draft, /User: Visible request/);
  assert.doesNotMatch(draft, /hidden/);
});

// Regression (task_01a1153f, #case-studies post_01a1151c-e9d6, 2026-10-07): under decision A a
// worker's answer ran as a turn in the owner's chat and rendered as a "You" message holding the
// raw delivery envelope. Deliveries now run in the chat's background branch; history saved before
// that renders each delivery input as a collapsed event row. Fails if one renders as "You" again.
test('a delivery input saved in owner-chat history renders as a collapsed event, never as You', () => {
  const at = new Date('2026-10-07T06:40:00Z');
  const messages: Message[] = [
    { role: 'user', body: { t: 'text', text: 'Get Designer to draw the logo' }, timestamp: at },
    {
      role: 'user',
      body: {
        t: 'text',
        text: 'New posts in threads you follow, oldest first:\n[2026-10-07T06:41:00Z] buddy_x: Logo drawn (post_1, channel dm_1)',
      },
      timestamp: at,
    },
  ];
  const groups = groupChatMessages(messages, null);
  const markup = renderToStaticMarkup(
    <MemoryRouter>
      {groups.map((group, index) => (
        <TranscriptGroup
          presentation="hover"
          key={index}
          group={group}
          isLastGroup={index === groups.length - 1}
          lastMessageRef={{ current: null }}
          workingDirectory="/tmp"
        />
      ))}
    </MemoryRouter>
  );
  assert.equal((markup.match(/>You</g) ?? []).length, 1, 'only the owner message is You');
  assert.match(markup, /Background delivery/);
  assert.match(markup, /aria-expanded="false"/, 'collapsed');
  assert.doesNotMatch(markup, /Logo drawn/, 'the envelope stays inside the collapsed row');
});
