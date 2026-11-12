import assert from 'node:assert/strict';
import test from 'node:test';
import { MessagePageSchema, classifyServerFrame, legacyBody } from '@unleashd/shared';
import { reviewTranscript } from '../src/buddies/memory-review';
import { nativeBody } from '../src/ingest/content';
import { sessionMessages } from '../src/ingest/history';

const id = '00000000-0000-4000-8000-000000000001';

test('old HTTP pages and v3 socket frames retain visible prose through the reload window', () => {
  const old = { role: 'assistant', content: 'Visible answer', timestamp: '2026-09-27T00:00:00Z' };
  const page = MessagePageSchema.parse({ epoch: 0, total: 1, afterSeq: -1, messages: [old] });
  assert.deepEqual(page.messages[0].body, { t: 'text', text: 'Visible answer' });
  const oldTool = MessagePageSchema.parse({
    epoch: 0,
    total: 1,
    afterSeq: -1,
    messages: [
      {
        role: 'assistant',
        content: '⚡ shell oompa run :: oompa run runs.json',
        toolCall: { name: 'shell', input: '{"command":"oompa run runs.json"}' },
        timestamp: '2026-09-27T00:00:00Z',
      },
    ],
  });
  assert.deepEqual(oldTool.messages[0].body, {
    t: 'parts',
    parts: [{ t: 'tool', name: 'shell', input: { command: 'oompa run runs.json' } }],
  });
  const frame = classifyServerFrame({
    type: 'message',
    conversationId: id,
    role: 'assistant',
    content: 'Visible answer',
  });
  assert.equal(frame.t, 'message');
  if (frame.t === 'message' && frame.message.type === 'message') {
    assert.deepEqual(frame.message.body, { t: 'text', text: 'Visible answer' });
  }
});

test('native ordered blocks keep tools, questions and prose typed', () => {
  const body = nativeBody(
    JSON.stringify([
      { t: 'text', text: 'Before' },
      { t: 'tool', name: 'Read', input: { file_path: '/a' } },
      {
        t: 'tool',
        name: 'AskUserQuestion',
        input: { questions: [{ question: 'Pick', options: [{ label: 'A' }] }] },
      },
      { t: 'text', text: 'After' },
    ]),
    'old formatted line'
  );
  assert.deepEqual(body, {
    t: 'parts',
    parts: [
      { t: 'text', text: 'Before' },
      { t: 'tool', name: 'Read', input: { file_path: '/a' } },
      { t: 'question', question: { questions: [{ question: 'Pick', options: [{ label: 'A' }] }] } },
      { t: 'text', text: 'After' },
    ],
  });
});

test('plain native text parts normalize to the same body as a live user turn', async () => {
  const plain = {
    seq: 0,
    role: 'user',
    content: 'First\nsecond',
    partsJson: JSON.stringify([
      { t: 'text', text: 'First\n' },
      { t: 'text', text: 'second' },
    ]),
    at: 1,
  };
  const [message] = await sessionMessages(
    { messages: async () => [plain] } as never,
    { sessionId: 's', createdAt: 1 },
    1
  );
  assert.deepEqual(message.body, { t: 'text', text: 'First\nsecond' });
});

test('an unchanged pre-upgrade stored tool row equals a full rebuilt native part', async () => {
  const input = { command: 'oompa run runs.json' };
  const old = {
    seq: 0,
    role: 'assistant',
    content: '⚡ shell oompa run :: oompa run runs.json',
    toolCall: { name: 'shell', input: JSON.stringify(input) },
    at: 1,
  };
  const rebuilt = {
    seq: 0,
    role: 'assistant',
    content: '',
    partsJson: JSON.stringify([{ t: 'tool', name: 'shell', input }]),
    at: 1,
  };
  const read = (row: typeof old | typeof rebuilt) =>
    sessionMessages({ messages: async () => [row] } as never, { sessionId: 's', createdAt: 1 }, 1);
  assert.deepEqual((await read(old))[0].body, (await read(rebuilt))[0].body);
  assert.deepEqual((await read(old))[0].body, {
    t: 'parts',
    parts: [{ t: 'tool', name: 'shell', input: { command: 'oompa run runs.json' } }],
  });
});

test('legacy markers decode only at ingress, suppress retired output, and respect fenced examples', () => {
  const old = legacyBody(
    'Start\n<!--buddy_team_configuration:%7B%7D-->\n```\n🔧 shell example\n```\n🔧 Read /a\nEnd'
  );
  assert.equal(old.t, 'parts');
  if (old.t !== 'parts') return;
  assert.equal(
    old.parts.some((part) => part.t === 'tool' && part.name === 'shell'),
    false
  );
  assert.equal(
    old.parts.some((part) => part.t === 'tool' && part.name === 'Read'),
    true
  );
  assert.equal(
    old.parts.some((part) => part.t === 'text' && part.text.includes('buddy_team_configuration')),
    false
  );
});

test('memory review removes hidden briefing from each typed text part', () => {
  const hidden =
    '<!-- unleashd:buddy-context-v2 abc 3 -->secret<!-- /unleashd:buddy-context-v2 -->';
  const reviewed = reviewTranscript([
    {
      role: 'user',
      body: {
        t: 'parts',
        parts: [
          { t: 'text', text: `${hidden}Visible` },
          { t: 'tool', name: 'Read', input: { file_path: '/a' } },
        ],
      },
    },
  ]);
  assert.equal(reviewed[0].content.includes('secret'), false);
  assert.match(reviewed[0].content, /Visible/);
  assert.match(reviewed[0].content, /\[tool call\] Read/);
});
