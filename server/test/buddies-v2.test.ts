import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { type McpServerSpec, createParser } from '@nbardy/agent-cli';
import {
  BuddiesCore,
  type Buddy,
  type Inbox,
  type Post,
  type Run,
  type ThreadStat,
} from '@unleashd/buddies-core';
import {
  type BuddyContext,
  type ConversationConfig,
  createDefaultConversationConfig,
} from '@unleashd/shared';
import express from 'express';
import { BUDDY_TOOL_GUIDE, composeBriefing, createBriefings } from '../src/buddies/briefing';
import { type StableConversationPorts, slotOf } from '../src/buddies/buddy-conversation-slots';
import {
  type GateVerdict,
  createCliReplyGate,
  parseGateVerdict,
} from '../src/buddies/channel-reply-gate';
import { createChannels } from '../src/buddies/channels';
import {
  OWNER,
  buddiesLocation,
  buddyActor,
  legacyBuddiesDatabasePath,
  openBuddiesCore,
} from '../src/buddies/core';
import {
  type BuddyEvent,
  type MentionPicks,
  NO_PICKS,
  createBuddyEvents,
} from '../src/buddies/events';
import { INBOX, createGrants } from '../src/buddies/grants';
import { startMcpEndpoint } from '../src/buddies/mcp';
import { createMemoryReviewer } from '../src/buddies/memory-review';
import { createBuddyPolicyPort } from '../src/buddies/policy-port';
import { registerBuddyRoutes } from '../src/buddies/routes';
import { createRunner } from '../src/buddies/runner';
import { workerConversationConfig } from '../src/buddies/worker-config';
import { TURN_MAX_RUNTIME_MS } from '../src/constants/timeouts';
import { createBuddyCreationService } from '../src/conversations/buddy-creation-service';
import { ConversationConfigService } from '../src/conversations/config-service';
import {
  type ConversationRuntime,
  type ConversationRuntimeDependencies,
  createConversationRuntime,
} from '../src/conversations/runtime';
import { replaceRuntimeConfig } from '../src/conversations/runtime-config';
import { resolveConfigAgainstProviderCatalog } from '../src/providers/catalog-service';
import { testExecutions } from './fixtures/fake-turn';
import { recordStore } from './fixtures/records';

// The Buddy server end to end through its real boundaries: the crate on a temp DB, the HTTP MCP
// endpoint, the runner, the channels responder, the creation service and the conversation
// runtime. Only the provider process is faked. A fake turn calls tools the way a CLI would: over
// HTTP, with the exact MCP spec (URL + bearer) the runtime handed the provider.

type ProviderRequest = Parameters<NonNullable<ConversationRuntimeDependencies['executeTurn']>>[0];
type Turn = { n: number; request: ProviderRequest; mcp: McpServerSpec };

async function until<T>(
  read: () => T | undefined | false | Promise<T | undefined | false>,
  what: string
): Promise<T> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function connect(spec: McpServerSpec): Promise<Client> {
  assert.equal(spec.kind, 'http');
  if (spec.kind !== 'http') throw new Error('unreachable');
  const client = new Client({ name: 'fake-cli', version: '1' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(spec.url), {
      requestInit: { headers: { ...spec.headers } },
    })
  );
  return client;
}

async function call(spec: McpServerSpec, name: string, args: Record<string, unknown>) {
  const client = await connect(spec);
  try {
    const result = (await client.callTool({ name, arguments: args })) as {
      isError?: boolean;
      content: Array<{ text: string }>;
    };
    const text = result.content[0].text;
    const isError = result.isError === true;
    return { isError, text, value: isError ? null : JSON.parse(text) };
  } finally {
    await client.close();
  }
}

async function toolNames(spec: McpServerSpec): Promise<string[]> {
  const client = await connect(spec);
  try {
    return (await client.listTools()).tools.map((t) => t.name).sort();
  } finally {
    await client.close();
  }
}

/** A raw HTTP probe, as a CLI's startup probe sends it: 401 means the grant is gone. */
async function probe(spec: McpServerSpec): Promise<number> {
  if (spec.kind !== 'http') throw new Error('http only');
  const response = await fetch(spec.url, {
    method: 'POST',
    headers: {
      ...spec.headers,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'probe', version: '1' },
      },
    }),
  });
  await response.text();
  return response.status;
}

async function world() {
  const scratch = mkdtempSync(join(tmpdir(), 'buddies-v2-'));
  const dbPath = join(scratch, 'buddies-v3.sqlite');
  const core = await BuddiesCore.open(dbPath);
  const ws = (await core.createWorkspace(OWNER, { name: 'Team', rootPath: scratch })).id;
  const hire = (slug: string, name: string) =>
    core.createBuddy(OWNER, {
      workspaceId: ws,
      slug,
      name,
      role: `${name} role`,
      manager: { kind: 'nobody' },
      provider: 'codex',
      key: slug,
    });
  const lead = await hire('lead', 'Lead');
  const designer = await hire('designer', 'Designer');
  const general = await core.createChannel(OWNER, {
    workspaceId: ws,
    name: 'general',
    purpose: 'Team chat',
    key: 'general',
  });

  const events = createBuddyEvents();
  const seen: BuddyEvent[] = [];
  events.on((event) => seen.push(event));
  const grants = createGrants({ ttlMs: TURN_MAX_RUNTIME_MS });
  const briefings = createBriefings(core);
  const endpoint = await startMcpEndpoint({
    core,
    events,
    grants,
    uploadsRoot: () => join(scratch, 'uploads'),
    portFile: join(scratch, 'buddy-mcp.json'),
  });

  // The provider. `during(turn)` runs inside turn n, as the model's tool calls would.
  const turns: Turn[] = [];
  const during = new Map<number, (turn: Turn) => Promise<void>>();
  const answers = new Map<number, string>();
  // A channel seat's reply is the Buddy's own `post` (channels.ts). The fake model follows the
  // prompt's instruction and posts its answer, except in turns listed in `silent`.
  const silent = new Set<number>();
  // Turns that end out of tokens, as a harness at its usage limit reports it.
  const outOfTokens = new Set<number>();
  // Turns whose provider process was told to stop.
  const stopped = new Set<number>();
  const seatPost = /post\(\{ channel: \{ id: "([^"]+)" \}, replyToId: "([^"]+)"/;
  const executeTurn = ((request: ProviderRequest) => {
    const turn: Turn = { n: turns.length + 1, request, mcp: request.mcpServers!.unleashd_buddy };
    turns.push(turn);
    const sessionId = request.resumeSessionId ?? `native-${turn.n}`;
    let finish!: (value: {
      exitCode: number;
      signal: null;
      sessionId: string;
      reason: 'success';
    }) => void;
    const completed = new Promise<{
      exitCode: number;
      signal: null;
      sessionId: string;
      reason: 'success';
    }>((resolve) => {
      finish = resolve;
    });
    return {
      // No process: the journal the runtime created for this turn, removed at its drain.
      pid: 0,
      journalDir: request.journalDir,
      events: (async function* () {
        yield { type: 'session.started' as const, sessionId };
        yield { type: 'turn.started' as const };
        await during.get(turn.n)?.(turn);
        if (outOfTokens.has(turn.n)) {
          yield { type: 'out_of_tokens' as const, message: 'You have hit your usage limit' };
          yield { type: 'turn.complete' as const, reason: 'out_of_tokens' as const };
          finish({ exitCode: 0, signal: null, sessionId, reason: 'success' });
          return;
        }
        const answer = answers.get(turn.n) ?? `Answer ${turn.n}`;
        const seat = seatPost.exec(request.prompt);
        if (seat && !silent.has(turn.n)) {
          const posted = await call(turn.mcp, 'post', {
            channel: { id: seat[1] },
            replyToId: seat[2],
            purpose: 'reply',
            body: answer,
            key: `seat-reply-${turn.n}`,
          });
          assert.equal(posted.isError, false, posted.text);
        }
        yield { type: 'text.delta' as const, text: answer };
        yield { type: 'turn.complete' as const, reason: 'success' as const };
        finish({ exitCode: 0, signal: null, sessionId, reason: 'success' });
      })(),
      completed,
      stop: () => {
        stopped.add(turn.n);
      },
    };
  }) as unknown as NonNullable<ConversationRuntimeDependencies['executeTurn']>;

  // `hold` keeps a gate in flight until the test settles it.
  const gate: { verdict: GateVerdict; calls: number; hold: Promise<void> } = {
    verdict: { kind: 'pass' },
    calls: 0,
    hold: Promise.resolve(),
  };
  const reviewer = createMemoryReviewer({
    core,
    grants,
    spec: endpoint.spec,
    execute: () => {
      throw new Error('no review in this world');
    },
  });
  const conversations = new Map<string, ConversationRuntime>();
  const configService = new ConversationConfigService({
    store: recordStore(join(scratch, 'config')),
    resolver: { resolve: async (config) => resolveConfigAgainstProviderCatalog(config) },
  });
  const runner = createRunner({
    core,
    grants,
    events,
    briefings,
    leaseMs: TURN_MAX_RUNTIME_MS,
    backgroundTurnMs: 60_000,
    backstopMs: 200,
    logger: { warn: () => undefined, log: () => undefined },
    host: {
      registered: (id) => conversations.has(id),
      openBackground: async ({ conversationId, context, commandId, config }) => {
        await creation.createServerBuddyConversation({
          context,
          conversationId,
          commandId,
          config: config && workerConversationConfig(config),
          deferInitialMessage: true,
          visibility: 'background',
        });
      },
      runTurn: async ({ conversationId, context, prompt, leaseToken, deadlineMs }) =>
        conversations
          .get(conversationId)!
          .runCoordinationMessage(
            prompt,
            context,
            leaseToken,
            new Date(Date.now() + deadlineMs).toISOString()
          ),
      stop: (id) => conversations.get(id)?.stop(),
    },
  });
  const port = createBuddyPolicyPort({ runner, grants, briefings, reviewer, spec: endpoint.spec });
  const Conversation = createConversationRuntime({
    executions: testExecutions(),
    buddies: port,
    broadcast: () => undefined,
    registerSessionAlias: () => undefined,
    unregisterSessionAlias: () => undefined,
    clearExternalRunningStatus: () => undefined,
    clearLocalCompletionSuppression: () => undefined,
    markLocalCompletionSuppression: () => undefined,
    persistCurrentSession: (conversation, sessionId, key) =>
      creation.persistCurrentSession(conversation, sessionId, key),
    getConversation: (id) => conversations.get(id),
    readLatestOompaRuntime: async () => ({ available: false, run: null, reason: 'fixture' }),
    createSessionId: () => `provisional-${turns.length}`,
    executeTurn,
  });
  let ids = 0;
  const creation = createBuddyCreationService({
    configService,
    resolveBuddyConversation: (context) => briefings.warm(context),
    resolveWorkingDirectory: (directory) => directory,
    createId: () => `conversation-${++ids}`,
    getConversation: (id) => conversations.get(id),
    createConversation: (options) => new Conversation(options),
    registerConversation: (conversation) => conversations.set(conversation.id, conversation),
    createConversationLink: async () => undefined,
    updateConversationStatus: () => undefined,
    broadcast: () => undefined,
  });
  const stable: StableConversationPorts = {
    slot: async (id) => slotOf(await configService.getRecord(id)),
    getConversation: (id) => conversations.get(id),
    ensureConversationReady: creation.ensureConversationReady,
    createConversation: (input) => creation.createServerBuddyConversation(input),
    reconfigure: (conversation, config) =>
      replaceRuntimeConfig(configService, conversation, config),
  };
  const channels = createChannels({
    core,
    events,
    conversations: stable,
    uploadsRoot: () => join(scratch, 'uploads'),
    gate: async () => {
      gate.calls += 1;
      await gate.hold;
      return gate.verdict;
    },
    channelChanged: () => undefined,
    logger: { warn: () => undefined },
  });
  await runner.start([]);
  return {
    core,
    /** A crate post, unwrapped from its PostWrite. */
    post: async (...args: Parameters<typeof core.post>) => (await core.post(...args)).post,
    /** Announce a post in #general, as every post writer does: the one dispatch entry. */
    announce: (post: Post, picks: MentionPicks = NO_PICKS) =>
      events.emit({ kind: 'posted', post, channel: general, picks }),
    ws,
    lead,
    designer,
    general,
    events: seen,
    emit: events.emit,
    grants,
    endpoint,
    turns,
    during,
    answers,
    silent,
    outOfTokens,
    stopped,
    gate,
    channels,
    creation,
    conversations,
    runner,
    scratch,
    runs: (buddyId: string) => core.listRuns({ kind: 'buddy', buddyId }, 50),
    async close() {
      runner.stop();
      await endpoint.close();
      rmSync(scratch, { recursive: true, force: true });
    },
  };
}

test('one full chat turn: an owner chat asks another Buddy, it answers, the return is delivered; grants die with their turns', async () => {
  const w = await world();
  try {
    let request!: Post;
    w.during.set(1, async (turn) => {
      // Owner-authored input: the grant is the owner's, so team_admin is listed.
      const names = await toolNames(turn.mcp);
      assert.equal(names.length, 12);
      assert.ok(names.includes('team_admin'));
      assert.ok(names.includes('channel_admin'));
      for (const removed of ['answer', 'channel_archive', 'channel_rename'])
        assert.equal(names.includes(removed), false);
      assert.equal(await probe(turn.mcp), 200);
      const posted = await call(turn.mcp, 'post', {
        channel: { direct: [w.designer.id] },
        kind: 'request',
        body: 'Draw the logo',
        key: 'ask-logo',
      });
      assert.equal(posted.isError, false, posted.text);
      request = posted.value;
    });
    w.during.set(2, async (turn) => {
      assert.match(turn.request.prompt, /Draw the logo/);
      // An answer ignores thread/request fields; passing one must fail loudly, not post anyway.
      const misfired = await call(turn.mcp, 'post', {
        answers: request.id,
        kind: 'request',
        body: 'Logo drawn?',
        key: 'answer-logo-misfire',
      });
      assert.equal(misfired.isError, true, misfired.text);
      const answered = await call(turn.mcp, 'post', {
        answers: request.id,
        body: 'Logo drawn',
        evidence: ['logo.png'],
        key: 'answer-logo',
      });
      assert.equal(answered.isError, false, answered.text);
    });
    const chat = await w.creation.createServerBuddyConversation({
      context: { buddyId: w.lead.id, workspaceId: w.ws },
      conversationId: 'owner-chat',
      commandId: 'owner-chat',
      deferInitialMessage: true,
    });
    chat.sendMessage('Get Designer to draw the logo', {
      origin: 'owner_input',
      inputId: 'owner-1',
    });

    const designerRun = await until(
      async () => (await w.runs(w.designer.id)).find((r) => r.status === 'complete'),
      "Designer's request run"
    );
    assert.deepEqual(designerRun.input, { kind: 'post', postId: request.id });
    const done = await w.core.getPost(OWNER, request.id);
    assert.equal(done.request.state, 'answered');
    const answer = await w.core.getPost(OWNER, (done.request as { answerId: string }).answerId);
    assert.equal(answer.body, 'Logo drawn');
    assert.deepEqual(answer.author, buddyActor(w.designer.id));

    // The request was sent from Lead's owner chat, a human chat, so its route is Inbox: the
    // answer post is the delivery and no return run exists (the next test guards the incident).
    const leadRuns = await until(async () => {
      const runs = await w.runs(w.lead.id);
      return runs.every((r) => r.status === 'complete') && runs.length === 1 && runs;
    }, "Lead's chat run");
    assert.deepEqual(done.returns, { kind: 'inbox' });
    assert.equal(w.turns.length, 2, 'no automated turn in the owner chat');

    // A chat run's lease IS the foreground deadline: exactly TURN_MAX_RUNTIME_MS (the 2026-09-10
    // incident killed healthy owner chats at an inherited 600 s).
    const chatRun = leadRuns.find((r) => r.input.kind === 'chat')!;
    const leased = Date.parse(chatRun.leaseExpiresAt!) - Date.parse(chatRun.startedAt!);
    assert.ok(Math.abs(leased - TURN_MAX_RUNTIME_MS) < 1_000, `lease ${leased} ms`);

    // Tokens are readable by the agent's shell, so a settled turn's grant must be dead.
    for (const turn of w.turns)
      assert.equal(await probe(turn.mcp), 401, `turn ${turn.n}'s grant outlived its turn`);
    assert.equal(w.grants.size(), 0);
  } finally {
    await w.close();
  }
});

// Pattern: fix-guards (docs/patterns.md#fix-guards). 2026-10-01 (agent_notes/2026-10-01_
// unleashd_case_study_conversation_busy.md): answers to requests sent from an owner chat each
// queued a `reply` run behind that chat (`conversation_busy`, up to 2h44m) only to settle as a
// no-op when it ended; reading "9 blocked", a CEO Buddy offered to cancel the owner's GPU turn.
// The route is now fixed when the request is sent, so this answer must create no run at all.
test('an answer to a request sent from a human chat starts no run and never queues behind that chat', async () => {
  const w = await world();
  try {
    let request!: Post;
    let whileRunning: Run[] = [];
    w.during.set(1, async (turn) => {
      const posted = await call(turn.mcp, 'post', {
        channel: { direct: [w.designer.id] },
        kind: 'request',
        body: 'Draw the logo',
        key: 'ask-logo',
      });
      assert.equal(posted.isError, false, posted.text);
      request = posted.value;
      // The owner turn is still running while Designer answers.
      await until(
        async () => (await w.core.getPost(OWNER, request.id)).request.state === 'answered',
        'the answer while the owner turn runs'
      );
      whileRunning = await w.runs(w.lead.id);
    });
    w.answers.set(2, 'Logo drawn');
    const chat = await w.creation.createServerBuddyConversation({
      context: { buddyId: w.lead.id, workspaceId: w.ws },
      conversationId: 'owner-chat',
      commandId: 'owner-chat',
      deferInitialMessage: true,
    });
    chat.sendMessage('Get Designer to draw the logo', {
      origin: 'owner_input',
      inputId: 'owner-1',
    });
    const leadRuns = await until(async () => {
      const runs = await w.runs(w.lead.id);
      return runs.every((r) => r.status === 'complete') && runs.length > 0 && runs;
    }, "the owner chat's turn");
    assert.deepEqual(
      whileRunning.map((r) => [r.input.kind, r.status]),
      [['chat', 'running']],
      'the answer queued nothing behind the running owner turn'
    );
    assert.deepEqual(
      leadRuns.map((r) => r.input.kind),
      ['chat'],
      'the answer is delivered by its post (Lead reads its inbox); it is not a run'
    );
    assert.equal(w.turns.length, 2, 'no automated turn in the owner chat');
  } finally {
    await w.close();
  }
});

// Pattern: fix-guards (docs/patterns.md#fix-guards). 2026-10-01: a request to a group DM started
// only its first recipient (run key `post:<id>` was shared, so the second enqueue returned the
// first recipient's run). Both recipients must run; one answer closes the request and the other
// recipient's late answer is refused, not silently lost. Crate guard:
// `a_group_request_starts_one_run_per_recipient` (crates/unleashd-buddies/tests/core.rs).
test('a group-DM request starts a run for each recipient; the first answer wins and the late one is refused', async () => {
  const w = await world();
  try {
    const reviewer = await w.core.createBuddy(OWNER, {
      workspaceId: w.ws,
      slug: 'reviewer',
      name: 'Reviewer',
      role: 'Reviewer role',
      manager: { kind: 'nobody' },
      provider: 'codex',
      key: 'reviewer',
    });
    let request!: Post;
    w.during.set(1, async (turn) => {
      const posted = await call(turn.mcp, 'post', {
        channel: { direct: [w.designer.id, reviewer.id] },
        kind: 'request',
        body: 'Both of you: review the logo',
        key: 'ask-group',
      });
      assert.equal(posted.isError, false, posted.text);
      request = posted.value;
    });
    // Each recipient answers; the second to arrive is the late one. Answers are serialised on one
    // tail so the outcome is deterministic whichever run the runner claims first.
    const outcomes: boolean[] = [];
    let tail: Promise<void> = Promise.resolve();
    for (const n of [2, 3]) {
      w.during.set(n, (turn) => {
        const answered = tail.then(async () => {
          const result = await call(turn.mcp, 'post', {
            answers: request.id,
            body: `Answer from turn ${n}`,
            key: `answer-group-${n}`,
          });
          outcomes.push(!result.isError);
        });
        tail = answered;
        return answered;
      });
    }
    const chat = await w.creation.createServerBuddyConversation({
      context: { buddyId: w.lead.id, workspaceId: w.ws },
      conversationId: 'owner-chat',
      commandId: 'owner-chat',
      deferInitialMessage: true,
    });
    chat.sendMessage('Ask Designer and Reviewer', { origin: 'owner_input', inputId: 'owner-1' });

    const complete = (id: string) =>
      w
        .runs(id)
        .then((runs) => runs.find((r) => r.status === 'complete' && r.input.kind === 'post'));
    const designerRun = await until(() => complete(w.designer.id), "Designer's run");
    const reviewerRun = await until(() => complete(reviewer.id), "Reviewer's run");
    assert.deepEqual(designerRun.input, { kind: 'post', postId: request.id });
    assert.deepEqual(reviewerRun.input, { kind: 'post', postId: request.id });
    assert.deepEqual(outcomes.sort(), [false, true], 'one answer lands, the late one is refused');
    assert.equal((await w.core.getPost(OWNER, request.id)).request.state, 'answered');
  } finally {
    await w.close();
  }
});

test('an MCP write fires the change bus in this process (B2)', async () => {
  const w = await world();
  try {
    const grant = w.grants.issueBuddy({
      role: 'worker',
      buddyId: w.lead.id,
      workspaceId: w.ws,
      conversationId: 'c',
      runId: null,
      returns: INBOX,
    });
    const before = w.events.length;
    const posted = await call(w.endpoint.spec(grant), 'post', {
      channel: { id: w.general.id },
      body: 'standup: shipped',
      key: 'standup',
    });
    assert.equal(posted.isError, false, posted.text);
    const fired = w.events.slice(before);
    assert.ok(
      fired.some((e) => e.kind === 'posted' && e.post.id === posted.value.id),
      'posted'
    );
    assert.ok(
      fired.some((e) => e.kind === 'changed'),
      'changed'
    );
  } finally {
    await w.close();
  }
});

// Pattern: fix-guards (docs/patterns.md#fix-guards). The queue view once had no reason and could
// drift from claim admission. This crosses the real HTTP MCP endpoint; the crate test pins the
// single SQL expression used by both list and claim.
test('workspace run rows expose task_paused and clear it when the same run becomes claimable', async () => {
  const w = await world();
  try {
    w.runner.stop();
    const task = await w.core.upsertTask(OWNER, {
      kind: 'create',
      ownerId: w.designer.id,
      title: 'Held task',
      doneCriteria: 'Claimed after unpausing',
      key: 'waiting-task',
    });
    const paused = await w.core.upsertTask(OWNER, {
      kind: 'update',
      taskId: task.id,
      baseRevision: task.revision,
      changes: { paused: true },
      key: 'waiting-pause',
    });
    const request = await w.post(
      buddyActor(w.lead.id),
      { kind: 'direct', members: [buddyActor(w.lead.id), buddyActor(w.designer.id)] },
      {
        kind: 'request',
        body: 'Held work',
        evidence: [],
        taskId: task.id,
        broadcast: false,
        key: 'waiting-request',
      }
    );
    const spec = w.endpoint.spec(
      w.grants.issueBuddy({
        role: 'worker',
        buddyId: w.lead.id,
        workspaceId: w.ws,
        conversationId: 'waiting-view',
        runId: null,
        returns: INBOX,
      })
    );
    const listed = await call(spec, 'runs', {
      action: { kind: 'list', scope: { workspace: w.ws } },
    });
    assert.equal(listed.isError, false, listed.text);
    const row = listed.value.runs.find(
      (item: { input: { kind: string; postId?: string } }) => item.input.postId === request.id
    );
    assert.deepEqual(row.waiting, { kind: 'task_paused' });
    assert.deepEqual(row.requester, buddyActor(w.lead.id));
    for (const bodyField of [
      'outcome',
      'workspaceId',
      'inputKey',
      'leaseExpiresAt',
      'readyAt',
      'attempt',
    ])
      assert.equal(bodyField in row, false, `${bodyField} stays on runs get`);

    await w.core.upsertTask(OWNER, {
      kind: 'update',
      taskId: task.id,
      baseRevision: paused.revision,
      changes: { paused: false },
      key: 'waiting-unpause',
    });
    const released = await call(spec, 'runs', {
      action: { kind: 'list', scope: { workspace: w.ws } },
    });
    const releasedRow = released.value.runs.find((item: { id: string }) => item.id === row.id);
    assert.equal(releasedRow.waiting ?? null, null);
    assert.equal((await w.core.claimRun(60_000))?.run.id, row.id);

    const missing = await w.core.enqueueRun(OWNER, {
      buddyId: w.designer.id,
      input: { kind: 'post', postId: 'missing-post' },
    });
    const relisted = await call(spec, 'runs', {
      action: { kind: 'list', scope: { workspace: w.ws } },
    });
    const missingRow = relisted.value.runs.find((item: { id: string }) => item.id === missing.id);
    assert.equal(missingRow.requester, undefined, 'a missing post is not attributed to the owner');

    // The workspace view is the "all live work" read: past 20 live runs it must still list them
    // all, and past its cap it must say so rather than stop silently (lead review, 2026-09-29).
    const enqueue = (count: number, from: number) =>
      Promise.all(
        Array.from({ length: count }, (_, i) =>
          w.core.enqueueRun(OWNER, {
            buddyId: w.designer.id,
            input: { kind: 'post', postId: `live-${from + i}` },
          })
        )
      );
    await enqueue(30, 0);
    const live = await call(spec, 'runs', {
      action: { kind: 'list', scope: { workspace: w.ws } },
    });
    assert.equal(live.value.runs.length, 32);
    assert.equal(live.value.truncated, false);
    await enqueue(80, 30);
    const capped = await call(spec, 'runs', {
      action: { kind: 'list', scope: { workspace: w.ws } },
    });
    assert.equal(capped.value.runs.length, 100);
    assert.equal(capped.value.truncated, true);

    // A Buddy turn reads only its own workspace: the crate list queries take no actor, so a
    // foreign id here once returned another workspace's tasks, runs and schedule prompts.
    for (const [tool, action] of [
      ['runs', { kind: 'list', scope: { workspace: 'project_elsewhere' } }],
      ['tasks', { kind: 'list', scope: { workspace: 'project_elsewhere' } }],
      ['schedule', { kind: 'list', scope: { workspace: 'project_elsewhere' } }],
    ] as const) {
      const foreign = await call(spec, tool, { action });
      assert.equal(foreign.isError, true, `${tool} must refuse another workspace`);
    }
  } finally {
    await w.close();
  }
});

test('B1: a seat turn holds owner authority only when the owner wrote its trigger post', async () => {
  const w = await world();
  try {
    const soulOfDesigner = {
      buddyId: w.designer.id,
      kind: 'soul',
      scope: 'buddy',
      content: 'rewritten',
      baseRevision: 0,
      reason: 'x',
    };
    w.during.set(1, async (turn) => {
      assert.ok((await toolNames(turn.mcp)).includes('team_admin'), 'owner mention: owner tools');
      const write = await call(turn.mcp, 'doc_write', { ...soulOfDesigner, key: 'owner-turn' });
      assert.equal(write.isError, false, `the owner may write any soul: ${write.text}`);
    });
    const root = await w.post(
      OWNER,
      { kind: 'id', id: w.general.id },
      {
        kind: 'inform',
        body: `[@Lead](buddy:${w.lead.id}) plan the launch`,
        evidence: [],
        broadcast: false,
        key: 'owner-1',
      }
    );
    w.announce(root);
    const leadReplies = async () =>
      (await w.core.listPosts(OWNER, { kind: 'thread', rootId: root.id }, null, 50)).posts.filter(
        (p) => p.author.kind === 'buddy' && p.author.id === w.lead.id
      );
    await until(async () => (await leadReplies()).length === 1, "Lead's reply to the owner");

    // Designer (a Buddy) posts in the thread; the gate says respond; Lead runs a follow-up.
    w.gate.verdict = { kind: 'respond' };
    w.during.set(2, async (turn) => {
      // Lead's reply (hop 2) may still start one more follow-up under the hop bound; this test
      // is about authority, so Designer declines it rather than run past the test's end.
      w.gate.verdict = { kind: 'pass' };
      assert.ok(
        !(await toolNames(turn.mcp)).includes('team_admin'),
        'Buddy-authored trigger: no owner tools'
      );
      const write = await call(turn.mcp, 'doc_write', {
        ...soulOfDesigner,
        baseRevision: 1,
        key: 'buddy-turn',
      });
      assert.equal(write.isError, true);
      assert.match(
        write.text,
        /^\[denied\]/,
        'the crate refuses: Lead neither is nor manages Designer'
      );
    });
    const designerPost = await w.post(
      buddyActor(w.designer.id),
      { kind: 'id', id: w.general.id },
      {
        kind: 'inform',
        body: 'Lead, which date?',
        replyToId: root.id,
        evidence: [],
        broadcast: false,
        key: 'designer-1',
      }
    );
    w.announce(designerPost);
    await until(async () => (await leadReplies()).length === 2, "Lead's follow-up");
    assert.equal(w.turns.length, 2);
    assert.equal(w.turns[1].request.resumeSessionId, 'native-1', 'the follow-up resumes the seat');
    assert.match(
      w.turns[1].request.prompt,
      /Replies since then/,
      'a resumed seat is sent only what is new'
    );
  } finally {
    await w.close();
  }
});

// 2026-09-28: a Buddy's @mention dispatched nothing — a live-looking chip that woke nobody. It now
// takes the owner's mention path (same seat, latest config), with Buddy authority and the chain cap.
test("a Buddy's @mention wakes that Buddy, and Buddy hand-offs are not capped", async () => {
  const w = await world();
  try {
    const thread = async (rootId: string) =>
      (await w.core.listPosts(OWNER, { kind: 'thread', rootId }, null, 50)).posts.reverse();
    const root = await w.post(
      OWNER,
      { kind: 'id', id: w.general.id },
      {
        kind: 'inform',
        body: `[@Lead](buddy:${w.lead.id}) plan the launch`,
        evidence: [],
        broadcast: false,
        key: 'owner-root',
      }
    );
    // Each turn hands off by @mentioning the other Buddy in a NEW top-level post, through the
    // real `post` tool. Until 2026-09-29 the bound counted Buddy posts in ONE thread, so this
    // ping-pong had no bound in code (review R7).
    const handOff = (to: { id: string; name: string }, key: string) => async (turn: Turn) => {
      const posted = await call(turn.mcp, 'post', {
        channel: { id: w.general.id },
        body: `[@${to.name}](buddy:${to.id}) your turn`,
        key,
      });
      assert.equal(posted.isError, false, posted.text);
      return posted.value as Post;
    };
    w.during.set(1, async (turn) => void (await handOff(w.designer, 'hop-1')(turn)));
    w.during.set(2, async (turn) => {
      assert.ok(
        !(await toolNames(turn.mcp)).includes('team_admin'),
        'a Buddy-authored mention holds no owner authority'
      );
      assert.match(turn.request.prompt, /Lead mentioned you in a new message/);
      await handOff(w.lead, 'hop-2')(turn);
    });
    w.during.set(3, async (turn) => void (await handOff(w.designer, 'hop-3')(turn)));
    w.during.set(4, async (turn) => void (await handOff(w.lead, 'hop-4')(turn)));
    // Owner decision 2026-10-03: no hand-off cap. A "3 hand-offs since the owner last spoke"
    // counter used to post a reply_failed notice and kill a live review thread; the chain now
    // runs until a Buddy stops handing off (turn 5 posts nothing).
    w.announce(root);
    await until(async () => w.turns.length >= 5, 'the chain runs past three hand-offs');
    const all = await w.core.listPosts(
      OWNER,
      { kind: 'channel', channelId: w.general.id } as never,
      null,
      100
    );
    assert.ok(
      !all.posts.some((p) => /waiting for the owner/.test(p.body)),
      'no hand-off cap notice'
    );
  } finally {
    await w.close();
  }
});

// 493c1c7: the server pasted the seat's final text into the thread — the scratchpad, tool lines
// and all, or "(no reply text)". Now the Buddy's own posts are the reply, and silence is a notice.
test('a seat reply is what the Buddy posts; a turn that posts nothing leaves a failure notice', async () => {
  const w = await world();
  try {
    const say = (body: string, replyToId?: string) =>
      w.post(
        OWNER,
        { kind: 'id', id: w.general.id },
        { kind: 'inform', body, replyToId, evidence: [], broadcast: false, key: body }
      );
    const thread = async (rootId: string) =>
      (await w.core.listPosts(OWNER, { kind: 'thread', rootId }, null, 50)).posts.reverse();
    const root = await say(`[@Lead](buddy:${w.lead.id}) status?`);
    w.answers.set(1, 'Shipped');
    w.announce(root);
    await until(async () => (await thread(root.id)).length === 1, 'the posted reply');
    const [reply] = await thread(root.id);
    assert.equal(reply.body, 'Shipped');
    assert.equal(reply.purpose, 'reply');

    w.silent.add(2);
    w.answers.set(2, 'private scratchpad text');
    const again = await say(`[@Lead](buddy:${w.lead.id}) and now?`, root.id);
    w.announce(again);
    const notice = await until(
      async () => (await thread(root.id)).find((post) => post.purpose === 'reply_failed'),
      'the missing-post notice'
    );
    assert.match(notice.body, /without a channel post/);
    assert.equal(notice.replyToId, again.id, 'only the silent turn is a failure');
    assert.equal(
      (await thread(root.id)).some((post) => post.body.includes('private scratchpad')),
      false,
      'the text output never reaches the channel'
    );
  } finally {
    await w.close();
  }
});

// The wave_sim thread, 2026-09-28: an owner's effort pick (high -> max) opened a new seat and
// dropped three hours of resumed context; the later provider switch's fresh seat saw 10 of ~50
// replies and none of its own. Only a provider change needs a new seat, and that seat is shown
// the Buddy's own earlier replies.
test("an effort pick keeps the seat's session; a provider pick opens a new seat that sees its own earlier replies", async () => {
  const w = await world();
  try {
    const codex = (effort: string): ConversationConfig => ({
      ...createDefaultConversationConfig('codex'),
      reasoning: { mode: 'explicit' as const, effort },
    });
    let n = 0;
    const say = (body: string, replyToId?: string) =>
      w.post(
        OWNER,
        { kind: 'id', id: w.general.id },
        { kind: 'inform', body, replyToId, evidence: [], broadcast: false, key: `say-${++n}` }
      );
    const replies = async () =>
      (await w.core.listPosts(OWNER, { kind: 'thread', rootId: root.id }, null, 100)).posts.filter(
        (post) => post.purpose === 'reply'
      ).length;
    const mention = async (text: string, config: ConversationConfig, expected: number) => {
      const post = await say(`[@Lead](buddy:${w.lead.id}) ${text}`, root.id);
      w.announce(post, new Map([[w.lead.id, config]]));
      await until(async () => (await replies()) === expected, `reply ${expected}`);
    };
    const root = await say('Plan the barrel solver');
    w.answers.set(1, 'Lead finding one: the flux donor is wrong');
    await mention('look at the solver', codex('high'), 1);
    assert.equal(w.turns[0].request.resumeSessionId, undefined);

    w.answers.set(2, 'Lead finding two: pressure solve diverges');
    await mention('go deeper', codex('max'), 2);
    assert.equal(w.turns[1].request.resumeSessionId, 'native-1', 'the effort pick resumed');
    assert.equal(w.turns[1].request.reasoningEffort, 'max');
    assert.match(w.turns[1].request.prompt, /You have seen this thread through your last turn/);

    for (let i = 0; i < 12; i++) await say(`owner note ${i}`, root.id);
    await mention('now on claude', createDefaultConversationConfig('claude'), 3);
    const fresh = w.turns[2].request;
    assert.equal(fresh.harness, 'claude');
    assert.equal(fresh.resumeSessionId, undefined, 'a provider pick is a new seat');
    assert.match(fresh.prompt, /Your own earlier replies here/);
    assert.match(fresh.prompt, /Lead finding one/);
    assert.match(fresh.prompt, /Lead finding two/);
  } finally {
    await w.close();
  }
});

// F1 (agent_notes/2026-09-28_channels-state-machine-review.md): a gate in flight for P1 while a
// mention P2 ran; the mention turn read P1, then the gate's yes started a second turn answering it.
test('a follow-up for a post a mention turn already read starts no second turn', async () => {
  const w = await world();
  try {
    let n = 0;
    const say = (body: string, replyToId?: string) =>
      w.post(
        OWNER,
        { kind: 'id', id: w.general.id },
        { kind: 'inform', body, replyToId, evidence: [], broadcast: false, key: `say-${++n}` }
      );
    const replies = async () =>
      (await w.core.listPosts(OWNER, { kind: 'thread', rootId: root.id }, null, 50)).posts.filter(
        (post) => post.purpose === 'reply'
      ).length;
    const root = await say(`[@Lead](buddy:${w.lead.id}) status?`);
    w.announce(root);
    await until(async () => (await replies()) === 1, "Lead's first reply");

    let release!: () => void;
    w.gate.hold = new Promise((resolve) => {
      release = resolve;
    });
    w.gate.verdict = { kind: 'respond' };
    w.announce(await say('Thoughts?', root.id));
    await until(() => w.gate.calls === 1, 'the gate for P1 in flight');
    const p2 = await say(`[@Lead](buddy:${w.lead.id}) answer now`, root.id);
    w.announce(p2);
    await until(async () => (await replies()) === 2, 'the mention reply');
    assert.match(w.turns[1].request.prompt, /Thoughts\?/, 'the mention turn read P1');
    release();
    // The gate's yes is queued now; a later mention runs behind it on the pair's serial queue.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const p3 = await say(`[@Lead](buddy:${w.lead.id}) one more`, root.id);
    w.announce(p3);
    await until(async () => (await replies()) === 3, 'the reply to P3');
    assert.equal(
      w.turns.filter((turn) => /you chose to reply/.test(turn.request.prompt)).length,
      0,
      "the gate's yes for an already-read post starts no turn"
    );
  } finally {
    await w.close();
  }
});

// 493c1c7: a reply that failed on its harness (here out of tokens) had no way forward but to
// re-mention and hope. The owner reruns it on another harness; the same harness is refused.
test('a harness failure is retried on another harness, in a new seat of the same thread', async () => {
  const w = await world();
  try {
    const root = await w.post(
      OWNER,
      { kind: 'id', id: w.general.id },
      {
        kind: 'inform',
        body: `[@Lead](buddy:${w.lead.id}) ship it`,
        evidence: [],
        broadcast: false,
        key: 'ask',
      }
    );
    w.outOfTokens.add(1);
    w.announce(root);
    const thread = async () =>
      (await w.core.listPosts(OWNER, { kind: 'thread', rootId: root.id }, null, 50)).posts;
    const notice = await until(
      async () => (await thread()).find((post) => post.purpose === 'reply_failed'),
      'the out-of-tokens notice'
    );
    assert.match(notice.body, /Out of tokens/);
    await assert.rejects(
      w.channels.retryReply(notice, createDefaultConversationConfig('codex')),
      /Pick a different harness/
    );
    // A double click starts one rerun (review R3: each click started a turn).
    const [retried] = await Promise.all([
      w.channels.retryReply(notice, createDefaultConversationConfig('claude')),
      w.channels.retryReply(notice, createDefaultConversationConfig('claude')),
    ]);
    assert.deepEqual(retried, { buddyId: w.lead.id, status: 'started' });
    const answer = await until(
      async () => (await thread()).find((post) => post.purpose === 'reply'),
      'the retried reply'
    );
    assert.equal(answer.replyToId, root.id);
    assert.equal(w.turns[1].request.harness, 'claude');
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(w.turns.length, 2, 'one rerun for two clicks');

    const silent = await w.post(
      buddyActor(w.lead.id),
      { kind: 'id', id: w.general.id },
      {
        kind: 'inform',
        purpose: 'reply_failed',
        body: 'Couldn’t reply: Buddy is not active',
        replyToId: root.id,
        evidence: [],
        broadcast: false,
        key: 'not-harness',
      }
    );
    await assert.rejects(
      w.channels.retryReply(silent, createDefaultConversationConfig('claude')),
      /out-of-tokens or provider-error/
    );
  } finally {
    await w.close();
  }
});

// 493c1c7: "New chat" in a DM starts the next generation and keeps the earlier ones, which the DM
// shows above a divider; the out-of-tokens retry is a new chat on another harness that resends.
test('a DM new chat opens the next generation; the chain keeps every earlier one', async () => {
  const w = await world();
  const { server, http } = await ownerHttp(w);
  try {
    const first = (await w.channels.openDirect(w.lead.id)).conversationId;
    const created = await http('POST', `/api/buddies/${w.lead.id}/direct/new-chat`, {});
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const second = (created.body as unknown as { conversationId: string }).conversationId;
    assert.notEqual(second, first);
    assert.deepEqual((await w.channels.openDirect(w.lead.id)).conversationId, second);
    await assert.rejects(
      w.channels.newDirect(w.lead.id, {
        config: createDefaultConversationConfig('codex'),
        message: 'again',
      }),
      /Pick a different harness/
    );
    const third = (
      await w.channels.newDirect(w.lead.id, {
        config: createDefaultConversationConfig('claude'),
        message: 'Resend this',
      })
    ).conversationId;
    const chain = await http('GET', `/api/buddies/${w.lead.id}/direct/chain`);
    assert.deepEqual((chain.body as unknown as { generations: string[] }).generations, [
      first,
      second,
      third,
    ]);
    await until(() => w.turns.length === 1, 'the resent message runs');
    assert.equal(w.turns[0].request.harness, 'claude');
    assert.match(w.turns[0].request.prompt, /Resend this/);
  } finally {
    server.close();
    await w.close();
  }
});

test('a scheduled run asks for help in the background and its answer comes back as a turn there', async () => {
  const w = await world();
  try {
    let requestId = '';
    w.during.set(1, async (turn) => {
      assert.match(turn.request.prompt, /Scheduled run "daily"/);
      const posted = await call(turn.mcp, 'post', {
        channel: { direct: [w.designer.id] },
        kind: 'request',
        body: 'Summarize the metrics',
        key: 'daily-ask',
      });
      requestId = posted.value.id;
    });
    // Designer ends its turn without calling `answer`: its final text is posted as the answer.
    w.answers.set(2, 'Metrics are up 4%');
    const schedule = await w.core.putSchedule(OWNER, {
      buddyId: w.lead.id,
      name: 'daily',
      cron: '0 9 * * *',
      timezone: 'UTC',
      prompt: 'Run the daily review',
      limits: '{}',
      enabled: true,
      key: 'daily',
    });
    await w.core.enqueueRun(OWNER, {
      buddyId: w.lead.id,
      input: { kind: 'schedule', scheduleId: schedule.id, slot: new Date().toISOString() },
    });
    w.emit({ kind: 'changed' });
    const returned = await until(() => w.turns[2], "Lead's return turn");
    assert.match(returned.request.prompt, /Metrics are up 4%/);
    assert.equal(
      returned.request.resumeSessionId,
      'native-1',
      'the return runs in the conversation that asked'
    );
    const answered = await w.core.getPost(OWNER, requestId);
    assert.equal(answered.request.state, 'answered');
    await until(
      async () => (await w.runs(w.lead.id)).every((r) => r.status === 'complete'),
      "Lead's runs settle"
    );
  } finally {
    await w.close();
  }
});

// 2026-09-28: a Buddy launched four untracked `codex exec` workers from a thread because no tool
// could choose a run's model (agent_notes/2026-09-28_buddy-worker-spawn-gap.md). A worker is a
// request to itself carrying `worker`: a tracked run on that model whose answer wakes the spawning
// conversation, and the Buddy's own `runs cancel` reaches the worker's process.
test('a Buddy spawns tracked workers on a model it picks; an answer wakes it and runs cancel stops one', async () => {
  const w = await world();
  try {
    const worker = { provider: 'codex', model: 'gpt-6-luna', reasoningEffort: 'low' };
    const spawned: Post[] = [];
    w.during.set(1, async (turn) => {
      const unknown = await call(turn.mcp, 'post', {
        channel: { direct: [] },
        kind: 'request',
        body: 'x',
        worker: { ...worker, model: 'gpt-nope' },
        key: 'unknown-model',
      });
      assert.equal(unknown.isError, true);
      assert.match(
        unknown.text,
        /gpt-6-luna/,
        `the error names the models it could run: ${unknown.text}`
      );
      const peer = await call(turn.mcp, 'post', {
        channel: { direct: [w.designer.id] },
        kind: 'request',
        body: 'switch models',
        worker,
        key: 'peer',
      });
      assert.equal(peer.isError, true, 'a peer is never moved off the profile the owner picked');
      for (const body of ['Sweep A', 'Sweep B']) {
        const posted = await call(turn.mcp, 'post', {
          channel: { direct: [] },
          kind: 'request',
          body,
          worker,
          key: body,
        });
        assert.equal(posted.isError, false, posted.text);
        spawned.push(posted.value);
      }
    });
    const [a, b] = [() => spawned[0], () => spawned[1]];
    // The spawns are posted by the schedule turn, which may not have run when polling starts:
    // an absent post reads as "no run yet", not a throw that `until` cannot retry (flaked 5 of 6).
    const runOf = async (post: Post | undefined) =>
      post &&
      (await w.runs(w.lead.id)).find((r) => r.input.kind === 'post' && r.input.postId === post.id);
    // Workers and the return turn start in any order: route each turn by what it was asked.
    const route = async (turn: Turn) => {
      if (turn.request.prompt.includes('Sweep B'))
        return void (await until(() => w.stopped.has(turn.n), 'the stop to reach worker B'));
      if (turn.request.prompt.includes(`Your request ${a().id} was answered`)) {
        const cancelled = await call(turn.mcp, 'runs', {
          action: { kind: 'cancel', runId: (await runOf(b()))!.id },
        });
        assert.equal(cancelled.isError, false, cancelled.text);
      }
    };
    for (let n = 2; n <= 6; n++) w.during.set(n, route);

    const schedule = await w.core.putSchedule(OWNER, {
      buddyId: w.lead.id,
      name: 'sweep',
      cron: '0 9 * * *',
      timezone: 'UTC',
      prompt: 'Run the sweeps',
      limits: '{}',
      enabled: true,
      key: 'sweep',
    });
    await w.core.enqueueRun(OWNER, {
      buddyId: w.lead.id,
      input: { kind: 'schedule', scheduleId: schedule.id, slot: new Date().toISOString() },
    });
    w.emit({ kind: 'changed' });

    const cancelledB = await until(async () => {
      const run = await runOf(b());
      return run?.status === 'cancelled' && run;
    }, 'worker B cancelled');
    const doneA = await until(async () => {
      const run = await runOf(a());
      return run?.status === 'complete' && run;
    }, 'worker A complete');
    for (const run of [doneA, cancelledB]) {
      assert.deepEqual(run.config, worker, 'the run records the model it was spawned on');
      const turn = w.turns.find((t) =>
        t.request.prompt.includes(`Request ${run.input.kind === 'post' && run.input.postId}`)
      )!;
      const request = turn.request as { harness: string; model?: string; reasoningEffort?: string };
      assert.deepEqual(
        [request.harness, request.model, request.reasoningEffort],
        ['codex', 'gpt-6-luna', 'low'],
        'the worker ran on the chosen model, not the profile'
      );
    }
    const lead = w.turns[0].request as { model?: string };
    assert.notEqual(lead.model, 'gpt-6-luna', 'the spawner itself stays on its profile');
    const returned = w.turns.find((t) =>
      t.request.prompt.includes(`Your request ${a().id} was answered`)
    )!;
    assert.equal(
      returned.request.resumeSessionId,
      'native-1',
      'the answer wakes the spawning call'
    );
  } finally {
    await w.close();
  }
});

// The reviewer used to see prose only (tool calls dropped) in a private temp cwd, so it tried to
// verify claims with file tools and the guard killed it (12 failed reviews, 2026-09 audit).
test('the reviewer climbs the ladder on credit exhaustion, sees tool calls, runs in the workspace, and curates memory on the same endpoint', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'buddies-review-'));
  const dbPath = join(scratch, 'db.sqlite');
  const core = await BuddiesCore.open(dbPath);
  const ws = (await core.createWorkspace(OWNER, { name: 'Team', rootPath: scratch })).id;
  const lead = await core.createBuddy(OWNER, {
    workspaceId: ws,
    slug: 'lead',
    name: 'Lead',
    role: 'r',
    manager: { kind: 'nobody' },
    key: 'lead',
  });
  const events = createBuddyEvents();
  const grants = createGrants({ ttlMs: 60_000 });
  const endpoint = await startMcpEndpoint({
    core,
    events,
    grants,
    uploadsRoot: () => scratch,
    portFile: join(scratch, 'buddy-mcp.json'),
  });
  const harnesses: string[] = [];
  const requests: ProviderRequest[] = [];
  let spec!: McpServerSpec;
  const reviewer = createMemoryReviewer({
    core,
    grants,
    spec: endpoint.spec,
    logger: { warn: () => undefined },
    execute: ((request: ProviderRequest) => {
      harnesses.push(request.harness);
      requests.push(request);
      spec = request.mcpServers!.unleashd_memory;
      const exhausted = request.harness === 'codex';
      const completed = (async () => {
        if (!exhausted) {
          const read = await call(spec, 'doc_read', { kind: 'working' });
          assert.equal(read.isError, false, read.text);
          const write = await call(spec, 'doc_write', {
            kind: 'working',
            content: 'Owner prefers dark mode',
            baseRevision: 0,
            reason: 'owner said so',
            key: 'w1',
          });
          assert.equal(write.isError, false, write.text);
          assert.ok(
            (await toolNames(spec)).every((name) => name === 'doc_read' || name === 'doc_write'),
            'reviewer tools only'
          );
        }
        return {
          exitCode: exhausted ? 1 : 0,
          signal: null,
          sessionId: 's',
          reason: exhausted ? 'out_of_tokens' : 'success',
        };
      })();
      return {
        // The reviewer reads only tool.use / error events; this CLI emits none.
        events: (async function* () {
          await completed;
          yield* [];
        })(),
        completed,
        stop: () => undefined,
      };
    }) as never,
  });
  try {
    reviewer.start();
    reviewer.enqueue({
      attemptId: 'a1',
      conversationId: 'chat',
      context: { buddyId: lead.id, workspaceId: ws, coordinationRunId: 'run-chat' },
      completedAt: new Date().toISOString(),
      messages: [
        { role: 'user', body: { t: 'text', text: 'I prefer dark mode' } },
        {
          role: 'assistant',
          body: {
            t: 'parts',
            parts: [{ t: 'tool', name: 'Read', input: `agent_notes/theme.md ${'y'.repeat(600)}` }],
          },
        },
        { role: 'assistant', body: { t: 'parts', parts: [{ t: 'tool', name: 'exec_command' }] } },
      ],
    });
    const receipt = await until(
      async () =>
        (await core.listEvents(lead.id, Number.MAX_SAFE_INTEGER, 20)).find(
          (e) => e.op === 'memory_review'
        ),
      'the review receipt'
    );
    const body = JSON.parse(receipt.payload);
    assert.deepEqual(harnesses, ['codex', 'cursor'], 'each rung bills a different provider');
    assert.equal(body.status, 'complete');
    assert.equal(body.model, 'grok-4.7-low');
    assert.equal(body.fallbackFrom, 'gpt-6-luna');
    assert.equal(body.writes.working, 1);
    const prompt = requests[1].prompt;
    assert.match(prompt, /\[tool call\] Read agent_notes\/theme\.md y+…\[truncated 221 chars\]/);
    assert.ok(!prompt.includes('y'.repeat(401)), 'tool input is bounded');
    assert.match(prompt, /\[tool call\] exec_command"/, 'an input-less call is its name');
    assert.deepEqual(
      requests.map((r) => r.cwd),
      [scratch, scratch],
      'every rung runs in the workspace root'
    );
    const working = await core.readDoc(OWNER, {
      buddyId: lead.id,
      scope: { kind: 'buddy' },
      kind: 'working',
      name: '',
    });
    assert.equal(working?.content, 'Owner prefers dark mode');
    assert.equal(await probe(spec), 401, "the reviewer's grant dies with its attempt");
  } finally {
    reviewer.stop();
    await endpoint.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});

// Required MCP discovery can succeed while a separate CLI tool host fails. Keep that evidence.
test('a reviewer with no memory reads retains bounded, redacted CLI failure evidence', async () => {
  const w = await world();
  const warnings: string[] = [];
  let token = '';
  let launches = 0;
  const reviewer = createMemoryReviewer({
    core: w.core,
    grants: w.grants,
    spec: w.endpoint.spec,
    logger: { warn: (...args: unknown[]) => void warnings.push(args.map(String).join(' ')) },
    execute: ((request: ProviderRequest) => {
      launches += 1;
      const spec = request.mcpServers!.unleashd_memory;
      assert.equal(spec.kind, 'http');
      if (spec.kind !== 'http') throw new Error('unreachable');
      token = spec.headers!.Authorization.replace('Bearer ', '');
      // Startup discovery works; the CLI's separate tool host fails before any memory call.
      const completed = (async () => {
        assert.deepEqual((await toolNames(spec)).sort(), ['doc_read', 'doc_write']);
        return { exitCode: 0, signal: null, sessionId: 'no-tools-session', reason: 'success' };
      })();
      return {
        child: { exitCode: 0 },
        events: (async function* () {
          await completed;
          yield { type: 'stderr', text: 'x'.repeat(9000) };
          yield {
            type: 'stderr',
            text: `\nERROR failed to spawn code-mode host: No such file; Bearer ${token.slice(0, 10)}`,
          };
          yield { type: 'stderr', text: `${token.slice(10)}; api_key=pri` };
          yield { type: 'stderr', text: 'vate-key' };
          yield { type: 'text.delta', text: `Tool host unavailable. Grant ${token.slice(0, 10)}` };
          yield { type: 'text.delta', text: token.slice(10) };
          yield { type: 'turn.complete', reason: 'success' };
        })(),
        completed,
        stop: () => undefined,
      };
    }) as never,
  });
  try {
    reviewer.start();
    reviewer.enqueue({
      attemptId: 'missing-host',
      conversationId: 'chat',
      context: { buddyId: w.lead.id, workspaceId: w.ws, coordinationRunId: 'run-chat' },
      completedAt: new Date().toISOString(),
      messages: [{ role: 'user', body: { t: 'text', text: 'hello' } }],
    });
    const event = await until(
      async () =>
        (await w.core.listEvents(w.lead.id, Number.MAX_SAFE_INTEGER, 20)).find(
          (event) => event.op === 'memory_review'
        ),
      'failed review receipt'
    );
    const receipt = JSON.parse(event.payload);
    assert.equal(receipt.status, 'failed');
    assert.match(receipt.error, /without reading memory/);
    assert.equal(launches, 1, 'no silent fallback after a tool-host failure');
    const warning = warnings.join('\n');
    const diagnostics = JSON.parse(warning.split('Reviewer diagnostics: ')[1]);
    assert.equal(diagnostics.sessionId, 'no-tools-session');
    assert.equal(diagnostics.exitCode, 0);
    assert.equal(diagnostics.toolUses, 0);
    assert.match(diagnostics.stderr, /failed to spawn code-mode host/);
    assert.match(diagnostics.report, /Tool host unavailable/);
    assert.ok(diagnostics.stderr.length <= 4000);
    assert.ok(diagnostics.report.length <= 1000);
    assert.ok(!warning.includes(token), 'grant tokens never enter failure diagnostics');
    assert.ok(!warning.includes('private-key'), 'common credential assignments are redacted');
  } finally {
    reviewer.stop();
    await w.close();
  }
});

// One 120 s budget used to cover the whole ladder, so a slow first rung starved the rest
// (41 timed-out reviews). The budget is per rung, and a rung that times out climbs.
test('a reviewer rung that outlives its timeout climbs to the next rung, which completes', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'buddies-review-timeout-'));
  const core = await BuddiesCore.open(join(scratch, 'db.sqlite'));
  const ws = (await core.createWorkspace(OWNER, { name: 'Team', rootPath: scratch })).id;
  const lead = await core.createBuddy(OWNER, {
    workspaceId: ws,
    slug: 'lead',
    name: 'Lead',
    role: 'r',
    manager: { kind: 'nobody' },
    key: 'lead',
  });
  const grants = createGrants({ ttlMs: 60_000 });
  const endpoint = await startMcpEndpoint({
    core,
    events: createBuddyEvents(),
    grants,
    uploadsRoot: () => scratch,
    portFile: join(scratch, 'buddy-mcp.json'),
  });
  const reviewer = createMemoryReviewer({
    core,
    grants,
    spec: endpoint.spec,
    timeoutMs: 200,
    logger: { warn: () => undefined },
    execute: ((request: ProviderRequest) => {
      const spec = request.mcpServers!.unleashd_memory;
      let stopped!: () => void;
      const killed = new Promise<void>((resolve) => {
        stopped = resolve;
      });
      const completed = (async () => {
        // The first rung hangs until the reviewer stops it; the second does the work.
        if (request.harness === 'codex') await killed;
        else await call(spec, 'doc_read', { kind: 'working' });
        return { exitCode: 0, signal: null, sessionId: 's', reason: 'success' };
      })();
      return {
        events: (async function* () {
          await completed;
          yield* [];
        })(),
        completed,
        stop: () => stopped(),
      };
    }) as never,
  });
  try {
    reviewer.start();
    reviewer.enqueue({
      attemptId: 'a1',
      conversationId: 'chat',
      context: { buddyId: lead.id, workspaceId: ws, coordinationRunId: 'run-chat' },
      completedAt: new Date().toISOString(),
      messages: [{ role: 'user', body: { t: 'text', text: 'hello' } }],
    });
    const receipt = await until(
      async () =>
        (await core.listEvents(lead.id, Number.MAX_SAFE_INTEGER, 20)).find(
          (e) => e.op === 'memory_review'
        ),
      'the review receipt'
    );
    const body = JSON.parse(receipt.payload);
    assert.equal(body.status, 'complete', body.error);
    assert.equal(body.model, 'grok-4.7-low');
    assert.equal(body.fallbackFrom, 'gpt-6-luna');
  } finally {
    reviewer.stop();
    await endpoint.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});

// A missing new-schema file means two different things (core.ts `buddiesLocation`): the owner
// still has the v33 file (import it, never run empty over it), or this is a first-time install
// (nothing to import; before 2026-09-26 it was told to import anyway and never got Buddies).
test('a missing Buddies database with the v33 file present names the import command', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'buddies-location-'));
  try {
    const legacy = join(scratch, 'buddies.sqlite');
    writeFileSync(legacy, '');
    const file = join(scratch, 'buddies-v3.sqlite');
    await assert.rejects(
      openBuddiesCore(buddiesLocation(file, legacy)),
      /one-time v33\/v34 import[\s\S]*archive\/t15-importer-93367be/
    );
    assert.equal(existsSync(file), false, 'no empty database is created over an unimported one');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('a first-time install with no Buddies database at all opens an empty one', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'buddies-location-'));
  try {
    const file = join(scratch, 'nested', 'buddies-v3.sqlite');
    const core = await openBuddiesCore(buddiesLocation(file, join(scratch, 'buddies.sqlite')));
    assert.deepEqual(await core.listWorkspaces(), []);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

// Regression (final review 2026-09-26): the v33 package kept its file under BUDDIES_HOME. Looking
// only at ~/.buddies classified such an owner as `fresh` and ran an empty DB over their data.
test('an unimported v33 file under BUDDIES_HOME is still found', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'buddies-location-'));
  try {
    writeFileSync(join(scratch, 'buddies.sqlite'), '');
    const legacy = legacyBuddiesDatabasePath({ BUDDIES_HOME: scratch });
    const file = join(scratch, 'buddies-v3.sqlite');
    assert.equal(buddiesLocation(file, legacy).t, 'unimported');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

// Regression (2026-09-26): memory the reviewer saved after a chat never reached the next chat.
// Owner chats carried an owner_thread scope, so each chat read and wrote its own working and
// long-term memory; a new chat opened on "(No working memory yet.)" while 519 per-chat copies
// piled up. This uses the real shape end to end: an owner chat turn's context, the reviewer
// writing through its own grant, then a DIFFERENT chat's briefing and the owner's Memory tab row.
test("memory the reviewer saves after one chat is in the next chat's briefing", async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'buddies-carry-'));
  const core = await BuddiesCore.open(join(scratch, 'db.sqlite'));
  const ws = (await core.createWorkspace(OWNER, { name: 'Team', rootPath: scratch })).id;
  const lead = await core.createBuddy(OWNER, {
    workspaceId: ws,
    slug: 'lead',
    name: 'Lead',
    role: 'r',
    manager: { kind: 'nobody' },
    key: 'lead',
  });
  const grants = createGrants({ ttlMs: 60_000 });
  const reviewEndpoint = await startMcpEndpoint({
    core,
    events: createBuddyEvents(),
    grants,
    uploadsRoot: () => scratch,
    portFile: join(scratch, 'buddy-mcp.json'),
  });
  // An owner chat turn's context: the conversation's, plus its admitted chat run.
  const chat = (conversationId: string): BuddyContext => ({
    buddyId: lead.id,
    workspaceId: ws,
    coordinationRunId: `run-${conversationId}`,
  });
  const reviewer = createMemoryReviewer({
    core,
    grants,
    spec: reviewEndpoint.spec,
    logger: { warn: () => undefined },
    execute: ((request: ProviderRequest) => {
      const spec = request.mcpServers!.unleashd_memory;
      const completed = (async () => {
        for (const [kind, content] of [
          ['working', 'Mid-migration: step 2 of 3 done, waiting on the owner for step 3'],
          ['long_term', 'Owner prefers restrained UI'],
        ]) {
          const read = await call(spec, 'doc_read', { kind });
          assert.equal(read.isError, false, read.text);
          const write = await call(spec, 'doc_write', {
            kind,
            content,
            baseRevision: 0,
            reason: 'from the chat',
            key: kind,
          });
          assert.equal(write.isError, false, write.text);
        }
        return { exitCode: 0, signal: null, sessionId: 's', reason: 'success' };
      })();
      return {
        events: (async function* () {
          await completed;
          yield* [];
        })(),
        completed,
        stop: () => undefined,
      };
    }) as never,
  });
  try {
    reviewer.start();
    reviewer.enqueue({
      attemptId: 'a1',
      conversationId: 'chat-A',
      context: chat('chat-A'),
      completedAt: new Date().toISOString(),
      messages: [
        {
          role: 'user',
          body: { t: 'text', text: 'Do steps 1 and 2 of the migration; I will approve step 3.' },
        },
        { role: 'assistant', body: { t: 'text', text: 'Steps 1 and 2 are done.' } },
      ],
    });
    const receipt = await until(
      async () =>
        (await core.listEvents(lead.id, Number.MAX_SAFE_INTEGER, 20)).find(
          (e) => e.op === 'memory_review'
        ),
      'the review receipt'
    );
    assert.equal(JSON.parse(receipt.payload).status, 'complete');

    const next = await composeBriefing(core, chat('chat-B'));
    assert.match(next.briefing, /step 2 of 3 done/, 'working memory reaches the next chat');
    assert.match(next.briefing, /Owner prefers restrained UI/, 'long-term memory reaches it');
    const ownerTab = await core.readDoc(OWNER, {
      buddyId: lead.id,
      scope: { kind: 'buddy' },
      kind: 'working',
      name: '',
    });
    assert.match(ownerTab?.content ?? '', /step 2 of 3 done/, "the owner's Memory tab row");
  } finally {
    reviewer.stop();
    await reviewEndpoint.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('the briefing tool guide stays inside its budget', () => {
  // A runtime throw on this budget failed every owner-thread turn on 2026-09-21; it is a test now.
  assert.ok(BUDDY_TOOL_GUIDE.length <= 3_000, `${BUDDY_TOOL_GUIDE.length} chars`);
});

test('briefing generation tracks its MCP guide and scope identity', async () => {
  const w = await world();
  const context = { buddyId: w.lead.id, workspaceId: w.ws };
  try {
    const before = await composeBriefing(w.core, context);
    assert.match(before.briefing, new RegExp(`Your ids: buddyId ${w.lead.id}`));
    const identity = createHash('sha256')
      .update(JSON.stringify([w.lead.name, w.lead.role, 0, w.lead.id, w.ws, BUDDY_TOOL_GUIDE]))
      .digest('hex');
    assert.equal(before.memoryGeneration, `memory:0:0:identity:${identity}`);
  } finally {
    await w.close();
  }
});

// 2026-09-25 (92e8692): Claude reports a session-limit 429 as a successful
// result with no text. The gate read the empty answer as `unparseable` and an
// untagged owner follow-up stayed quiet instead of showing "Couldn't reply".
// Only the CLI process is stubbed.
test('a reply gate with no answer, or out of tokens, fails with the provider message', async () => {
  assert.deepEqual(parseGateVerdict('  \n'), { kind: 'failed', reason: 'no answer' });
  assert.equal(parseGateVerdict('<yes> because I own it').kind, 'unparseable');
  const gate = createCliReplyGate({
    resolveExecution: async () => ({ provider: 'claude', modelId: 'claude-opus-5-5' }),
    execute: (() => {
      async function* events() {
        yield {
          type: 'out_of_tokens',
          message: "Out of tokens: You've hit your session limit · resets 2am (Asia/Makassar)",
        };
        yield { type: 'turn.complete', reason: 'out_of_tokens' };
      }
      return {
        events: events(),
        completed: Promise.resolve({ reason: 'out_of_tokens', sessionId: 'gate-session' }),
        stop: () => undefined,
      };
    }) as never,
  });
  const verdict = await gate({ config: createDefaultConversationConfig('claude'), prompt: 'p' });
  assert.equal(verdict.kind, 'failed');
  assert.match(verdict.kind === 'failed' ? verdict.reason : '', /out_of_tokens.*session limit/);
});

test('native child events cannot bypass restricted Buddy runs', async () => {
  const w = await world();
  let stops = 0;
  let launches = 0;
  const execute = (() => {
    launches += 1;
    return {
      events: (async function* () {
        // No item.started: the canonical state alone must trigger the guard.
        yield* createParser('codex')({
          type: 'item.completed',
          item: {
            type: 'collab_tool_call',
            tool: 'spawn_agent',
            id: 'spawn',
            receiver_thread_ids: ['child'],
            agents_states: { child: { status: 'pending_init' } },
          },
        });
        yield { type: 'text.delta', text: '<yes>' };
      })(),
      completed: Promise.resolve({ reason: 'success', exitCode: 0, signal: null, sessionId: 's' }),
      stop: () => {
        stops += 1;
      },
    };
  }) as never;
  const reviewer = createMemoryReviewer({
    core: w.core,
    grants: w.grants,
    spec: w.endpoint.spec,
    execute,
    logger: { warn: () => undefined },
  });
  try {
    const gate = createCliReplyGate({
      resolveExecution: async () => ({ provider: 'codex', modelId: 'gpt-6-luna' }),
      execute,
    });
    const verdict = await gate({ config: createDefaultConversationConfig('codex'), prompt: 'p' });
    assert.equal(verdict.kind, 'unparseable', 'a yes after tool activity is not admitted');
    reviewer.start();
    reviewer.enqueue({
      attemptId: 'native-child-violation',
      conversationId: 'chat',
      context: { buddyId: w.lead.id, workspaceId: w.ws },
      completedAt: new Date().toISOString(),
      messages: [{ role: 'user', body: { t: 'text', text: 'hello' } }],
    });
    const receipt = await until(
      async () =>
        (await w.core.listEvents(w.lead.id, Number.MAX_SAFE_INTEGER, 20)).find(
          (event) => event.op === 'memory_review'
        ),
      'failed review receipt'
    );
    const body = JSON.parse(receipt.payload);
    assert.equal(body.status, 'failed');
    assert.match(body.error, /sub-agent operation/);
    assert.equal(launches, 2, 'one gate and one review; violations do not climb the ladder');
    assert.equal(stops, 2);
  } finally {
    reviewer.stop();
    await w.close();
  }
});

// Review R2 (2026-09-28): the crate replays a post's idempotency key by returning the first post,
// and the tool announced it again, so a retried tool call re-ran every mention it held.
// 2026-09-30: the dispatch returned on every non-public channel, so the owner's four replies (two
// of them @mentions) in a DM thread under a Buddy's request started nothing and showed no error.
test('an owner reply in a DM thread wakes the Buddy; its request, its answer and Buddy informs do not', async () => {
  const w = await world();
  try {
    const dm = { kind: 'direct' as const, members: [buddyActor(w.lead.id), OWNER] };
    const announce = async (post: Post) =>
      w.emit({
        kind: 'posted',
        post,
        channel: await w.core.openChannel(OWNER, { kind: 'id', id: post.channelId }),
        picks: NO_PICKS,
      });
    const thread = async (rootId: string) =>
      (await w.core.listPosts(OWNER, { kind: 'thread', rootId }, null, 50)).posts.reverse();
    const directTurns = () =>
      w.turns.filter((turn) => /in your direct messages/.test(turn.request.prompt));
    const ask = await w.post(buddyActor(w.lead.id), dm, {
      kind: 'request',
      body: 'Approve the plan?',
      evidence: [],
      broadcast: false,
      key: 'ask',
    });
    await announce(ask);
    const nudge = await w.post(OWNER, dm, {
      kind: 'inform',
      body: "what's next?",
      replyToId: ask.id,
      evidence: [],
      broadcast: false,
      key: 'nudge',
    });
    w.answers.set(1, 'Next: the plan');
    await announce(nudge);
    await until(
      async () => (await thread(ask.id)).some((post) => post.body === 'Next: the plan'),
      "Lead's reply in the DM thread"
    );
    assert.equal(directTurns().length, 1);
    await until(() => w.channels.responding(ask.channelId).length === 0, 'the turn ends');

    await announce(
      await w.post(buddyActor(w.lead.id), dm, {
        kind: 'inform',
        body: 'FYI',
        replyToId: ask.id,
        evidence: [],
        broadcast: false,
        key: 'fyi',
      })
    );
    await announce(
      await w.core.answer(OWNER, { requestId: ask.id, body: 'Approved', evidence: [], key: 'yes' })
    );
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.equal(directTurns().length, 1, 'a Buddy inform and an answer start no DM reply');
  } finally {
    await w.close();
  }
});

test('a retried post (same key) wakes its mentioned Buddy once', async () => {
  const w = await world();
  try {
    const grant = w.grants.issueBuddy({
      role: 'worker',
      buddyId: w.lead.id,
      workspaceId: w.ws,
      conversationId: 'lead-chat',
      runId: null,
      returns: INBOX,
    });
    const mention = {
      channel: { id: w.general.id },
      body: `[@Designer](buddy:${w.designer.id}) the banner, please`,
      key: 'retried-call',
    };
    const first = await call(w.endpoint.spec(grant), 'post', mention);
    await until(() => w.turns.length === 1, "Designer's turn");
    // Retry once that turn is over: a queued duplicate is absorbed by the pair's queue anyway.
    await until(() => w.channels.responding(w.general.id).length === 0, 'the turn ends');
    const again = await call(w.endpoint.spec(grant), 'post', mention);
    assert.equal(again.value.id, first.value.id, 'the replay returns the first post');
    // A second turn would open the seat and poll it idle first: give it well over that.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.equal(w.turns.length, 1, 'the replay started no second turn');
  } finally {
    await w.close();
  }
});

test('a failed gate on an owner post is shown', async () => {
  const w = await world();
  try {
    const say = (author: 'owner' | string, body: string, replyToId?: string) =>
      w.post(
        author === 'owner' ? OWNER : buddyActor(author),
        { kind: 'id', id: w.general.id },
        {
          kind: 'inform',
          body,
          replyToId,
          evidence: [],
          broadcast: false,
          key: `${author}:${body}`,
        }
      );
    const root = await say(
      'owner',
      `[@Lead](buddy:${w.lead.id}) [@Designer](buddy:${w.designer.id}) who owns the launch?`
    );
    w.gate.verdict = { kind: 'respond' };
    w.announce(root);
    await until(async () => w.turns.length >= 2, 'both Buddies answer');
    w.gate.verdict = { kind: 'pass' };
    await new Promise((resolve) => setTimeout(resolve, 400));

    // The owner waits on an answer, so a gate that could not run is posted in the thread
    // (2026-09-24: every gate failed on a Codex usage limit and the thread stayed silent).
    w.gate.verdict = { kind: 'failed', reason: 'usage limit' };
    w.announce(await say('owner', 'Is Friday final?', root.id));
    const notices = await until(async () => {
      const thread = await w.core.listPosts(OWNER, { kind: 'thread', rootId: root.id }, null, 50);
      const failed = thread.posts.filter((p) => p.purpose === 'reply_failed');
      return failed.length === 2 && failed;
    }, 'one failure notice per Buddy in the thread');
    for (const notice of notices)
      assert.match(notice.body, /could not decide whether to reply \(usage limit\)/);
  } finally {
    await w.close();
  }
});

/** The owner routes over real HTTP on a world's crate. */
async function ownerHttp(w: Awaited<ReturnType<typeof world>>) {
  const app = express();
  app.use(express.json());
  const builderDirectories: Array<string | undefined> = [];
  registerBuddyRoutes(app, {
    core: w.core,
    events: { emit: w.emit, on: () => () => undefined },
    runner: w.runner,
    channels: w.channels,
    uploadsRoot: () => join(w.scratch, 'uploads'),
    channelChanged: () => undefined,
    onBuddyArchived: () => undefined,
    createBuilderConversation: async (workingDirectory) => {
      builderDirectories.push(workingDirectory);
      return { conversationId: 'builder' };
    },
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const http = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return {
      status: response.status,
      body: (await response.json()) as { error: string; requests: Post[] },
    };
  };
  return { server, http, builderDirectories };
}

test('builder opened from a workspace uses that workspace root', async () => {
  const w = await world();
  const { server, http, builderDirectories } = await ownerHttp(w);
  try {
    const root = (await w.core.listWorkspaces()).find((item) => item.id === w.ws)?.rootPath;
    const opened = await http('POST', '/api/buddies/builder', { workspaceId: w.ws });
    assert.equal(opened.status, 201, JSON.stringify(opened.body));
    assert.deepEqual(builderDirectories, [root]);
    const missing = await http('POST', '/api/buddies/builder', {
      workspaceId: 'workspace_missing',
    });
    assert.equal(missing.status, 404);
    const sidebar = await http('POST', '/api/buddies/builder', {});
    assert.equal(sidebar.status, 201);
    assert.deepEqual(builderDirectories, [root, undefined]);
  } finally {
    server.close();
    await w.close();
  }
});

test('owner routes: a DM request is answered over HTTP, typed errors keep their status, and literal paths are never read as a buddy id', async () => {
  const w = await world();
  const { server, http } = await ownerHttp(w);
  try {
    // /api/buddies/tasks and /runs are registered before /api/buddies/:buddyId (it would swallow them).
    assert.equal((await http('GET', `/api/buddies/tasks?buddyId=${w.lead.id}`)).status, 200);
    assert.equal((await http('GET', `/api/buddies/runs?buddyId=${w.lead.id}`)).status, 200);
    assert.deepEqual((await http('GET', '/api/buddies/buddy_missing')).status, 404);
    // The Buddy's request to the owner lands in the owner's inbox; the owner answers over HTTP.
    const ask = await w.post(
      buddyActor(w.lead.id),
      { kind: 'direct', members: [buddyActor(w.lead.id), OWNER] },
      { kind: 'request', body: 'May I deploy?', evidence: [], broadcast: false, key: 'ask' }
    );
    const inbox = await http('GET', `/api/buddies/workspaces/${w.ws}/inbox`);
    assert.deepEqual(
      inbox.body.requests.map((p: Post) => p.id),
      [ask.id]
    );
    const answered = await http('POST', `/api/buddies/posts/${ask.id}/answer`, {
      body: 'Yes',
      key: 'yes',
    });
    assert.equal(answered.status, 201, JSON.stringify(answered.body));
    assert.equal((await w.core.getPost(OWNER, ask.id)).request.state, 'answered');
    const again = await http('POST', `/api/buddies/posts/${ask.id}/answer`, {
      body: 'Yes again',
      key: 'yes-2',
    });
    assert.equal(again.status, 400, 'one answer per request');
    assert.match(again.body.error, /^\[invalid\]/);
    // A stale soul write is a conflict the editor can reconcile, not a 500.
    const first = await http('PUT', `/api/buddies/${w.lead.id}/docs/soul`, {
      content: 'v1',
      baseRevision: 0,
      reason: 'r',
      key: 's1',
    });
    assert.equal(first.status, 200);
    const stale = await http('PUT', `/api/buddies/${w.lead.id}/docs/soul`, {
      content: 'v2',
      baseRevision: 0,
      reason: 'r',
      key: 's2',
    });
    assert.equal(stale.status, 409);
    assert.match(stale.body.error, /^\[revision_conflict\]/);

    // The owner posts a standup AS a Buddy (the pre-T11 Messages tab did). Search finds it, over
    // HTTP and through the channel_read tool.
    const asBuddy = await http('POST', `/api/buddies/channels/${w.general.id}/posts`, {
      asBuddyId: w.designer.id,
      purpose: 'standup',
      body: 'Shipped the quarterly logo',
      key: 'standup-as-designer',
    });
    assert.equal(asBuddy.status, 201, JSON.stringify(asBuddy.body));
    const written = asBuddy.body as unknown as { post: Post };
    assert.deepEqual(written.post.author, buddyActor(w.designer.id));
    const found = await http('GET', `/api/buddies/workspaces/${w.ws}/search?q=quarterly%20LOGO`);
    assert.deepEqual(
      (found.body as unknown as Post[]).map((post) => post.id),
      [written.post.id]
    );
    const grant = w.grants.issueBuddy({
      role: 'worker',
      buddyId: w.lead.id,
      workspaceId: w.ws,
      conversationId: 'c',
      runId: null,
      returns: INBOX,
    });
    const searched = await call(w.endpoint.spec(grant), 'channel_read', {
      read: { search: 'quarterly' },
    });
    assert.deepEqual(
      searched.value.posts.map((post: Post) => post.id),
      [written.post.id]
    );
    // Search pages like a channel: `before` once went unforwarded, so a Buddy saw only the
    // newest hits forever (2026-09-27). Nothing older than the only hit remains.
    const older = await call(w.endpoint.spec(grant), 'channel_read', {
      read: { search: 'quarterly' },
      before: { ord: written.post.ord },
    });
    assert.deepEqual(older.value.posts, []);

    // The Builder saves a new hire's first task (it has no Buddy of its own: ownerId is required).
    const builder = w.endpoint.spec(w.grants.issueBuilder('builder-chat'));
    assert.ok((await toolNames(builder)).includes('task_write'));
    const task = await call(builder, 'task_write', {
      write: { kind: 'create', ownerId: w.designer.id, title: 'Logo v2', doneCriteria: 'Shipped' },
      key: 'builder-task',
    });
    assert.equal(task.isError, false, task.text);
    assert.equal(task.value.ownerId, w.designer.id);
    const ownerless = await call(builder, 'task_write', {
      write: { kind: 'create', title: 'Nobody', doneCriteria: 'x' },
      key: 'builder-task-2',
    });
    assert.equal(ownerless.isError, true);

    // Task lists hold open tasks unless asked: the CEO's 109 tasks (92 closed) overflowed a
    // tool result on 2026-09-27. A closed task must still be reachable with include 'all'.
    const closed = await w.core.upsertTask(OWNER, {
      kind: 'create',
      ownerId: w.designer.id,
      title: 'Logo v1',
      doneCriteria: 'Shipped',
      key: 'closed-task',
    });
    await w.core.upsertTask(OWNER, {
      kind: 'update',
      taskId: closed.id,
      baseRevision: closed.revision,
      changes: { status: 'done' },
      key: 'close-closed-task',
    });
    const designerGrant = w.endpoint.spec(
      w.grants.issueBuddy({
        role: 'worker',
        buddyId: w.designer.id,
        workspaceId: w.ws,
        conversationId: 'c',
        runId: null,
        returns: INBOX,
      })
    );
    const ids = (listed: { value: Array<{ id: string }> }) => listed.value.map((t) => t.id).sort();
    assert.deepEqual(
      ids(
        await call(designerGrant, 'tasks', {
          action: { kind: 'list', scope: { buddyId: w.designer.id } },
        })
      ),
      [task.value.id]
    );
    assert.deepEqual(
      ids(
        await call(designerGrant, 'tasks', {
          action: { kind: 'list', scope: { buddyId: w.designer.id }, include: 'all' },
        })
      ),
      [task.value.id, closed.id].sort()
    );
    // A Buddy pins its own top-level Task for the workspace Home through the ordinary task_write
    // update (2026-09-30); the slim task row then carries `pin` so the next writer can append.
    const pinned = await call(designerGrant, 'task_write', {
      write: {
        kind: 'update',
        taskId: task.value.id,
        baseRevision: task.value.revision,
        changes: { pin: 1 },
      },
      key: 'pin-task',
    });
    assert.equal(pinned.isError, false, pinned.text);
    assert.equal(pinned.value.pin, 1);
    const pinRows = await call(designerGrant, 'tasks', {
      action: { kind: 'list', scope: { buddyId: w.designer.id } },
    });
    assert.equal(pinRows.value.find((item: { id: string }) => item.id === task.value.id).pin, 1);
    // A retried pin replays its first result instead of failing on its now-stale baseRevision.
    const retried = await call(designerGrant, 'task_write', {
      write: {
        kind: 'update',
        taskId: task.value.id,
        baseRevision: task.value.revision,
        changes: { pin: 1 },
      },
      key: 'pin-task',
    });
    assert.equal(retried.isError, false, retried.text);
    assert.equal(retried.value.revision, pinned.value.revision);
    // Pinning grants nothing new: a peer's Task stays out of reach, and a todo cannot be pinned.
    const leads = await w.core.upsertTask(OWNER, {
      kind: 'create',
      ownerId: w.lead.id,
      title: 'Lead plan',
      doneCriteria: 'x',
      key: 'lead-task',
    });
    const todo = await w.core.upsertTask(OWNER, {
      kind: 'create',
      ownerId: w.designer.id,
      parentId: task.value.id,
      title: 'Sketch',
      doneCriteria: 'x',
      key: 'designer-todo',
    });
    for (const [target, key] of [
      [leads, 'pin-peer'],
      [todo, 'pin-todo'],
    ] as const) {
      const refused = await call(designerGrant, 'task_write', {
        write: {
          kind: 'update',
          taskId: target.id,
          baseRevision: target.revision,
          changes: { pin: 2 },
        },
        key,
      });
      assert.equal(refused.isError, true, key);
      assert.equal((await w.core.getTask(target.id)).pin, 0, key);
    }
    const taskRows = await call(builder, 'tasks', {
      action: { kind: 'list', scope: { workspace: w.ws } },
    });
    const taskRow = taskRows.value.find((item: { id: string }) => item.id === task.value.id);
    assert.equal('doneCriteria' in taskRow, false);
    assert.equal('evidence' in taskRow, false);
    const taskBody = await call(builder, 'tasks', {
      action: { kind: 'get', taskId: task.value.id },
    });
    assert.equal(taskBody.value.task.doneCriteria, 'Shipped');

    const teamRows = await call(builder, 'team', {
      action: { kind: 'list', workspace: w.ws },
    });
    const buddyRow = teamRows.value.buddies.find(
      (item: { id: string }) => item.id === w.designer.id
    );
    assert.equal('model' in buddyRow, false);
    const buddyBody = await call(builder, 'team', {
      action: { kind: 'get', target: { buddyId: w.designer.id } },
    });
    assert.equal(buddyBody.value.id, w.designer.id);

    const comment = await call(designerGrant, 'post', {
      channel: { task: task.value.id },
      body: 'New path',
      key: 'new-comment',
    });
    assert.equal(comment.isError, false, comment.text);
    const taskPosts = await w.core.taskPosts(OWNER, task.value.id, null, 20);
    assert.ok(
      taskPosts.posts.some((post) => post.body === 'New path' && post.taskId === task.value.id),
      'a post written to a task channel keeps the task identity for task feeds'
    );

    const schedule = await w.core.putSchedule(OWNER, {
      buddyId: w.designer.id,
      taskId: task.value.id,
      name: 'Logo check',
      cron: '0 9 * * *',
      timezone: 'UTC',
      prompt: 'Check the logo',
      limits: '{}',
      enabled: true,
      key: 'logo-check',
    });
    for (const scope of [
      { buddyId: w.designer.id },
      { taskId: task.value.id },
      { workspace: w.ws },
    ]) {
      const schedules = await call(designerGrant, 'schedule', {
        action: { kind: 'list', scope },
      });
      assert.ok(schedules.value.some((item: { id: string }) => item.id === schedule.id));
    }
  } finally {
    server.close();
    await w.close();
  }
});

test('owner routes restore what the T11 client migration dropped: reply stats, the read cursor, reply permalinks, the Task filter, clearing a profile field and directory task counts', async () => {
  const w = await world();
  const { server, http } = await ownerHttp(w);
  const json = async <T>(method: string, path: string, body?: unknown) => {
    const answer = await http(method, path, body);
    assert.ok(
      answer.status < 300,
      `${method} ${path}: ${answer.status} ${JSON.stringify(answer.body)}`
    );
    return answer.body as unknown as T;
  };
  try {
    const task = await w.core.upsertTask(OWNER, {
      kind: 'create',
      ownerId: w.lead.id,
      title: 'Launch',
      doneCriteria: 'Shipped',
      key: 'launch',
    });
    const say = (body: string, replyToId?: string, taskId?: string) =>
      w.post(
        buddyActor(w.lead.id),
        { kind: 'id', id: w.general.id },
        { kind: 'inform', body, replyToId, taskId, evidence: [], broadcast: false, key: body }
      );
    const root = await say('Launch plan', undefined, task.id);
    const replies = [];
    for (let i = 0; i < 4; i += 1) replies.push(await say(`step ${i}`, root.id));
    // 1. A channel page carries each root's reply count and newest reply.
    type Page = { posts: Post[]; next?: { ord: string }; threads: ThreadStat[] };
    const page = await json<Page>('GET', `/api/buddies/channels/${w.general.id}/posts?limit=50`);
    assert.deepEqual(
      page.threads.map((t) => [t.rootId, t.replies, t.lastReplyOrd]),
      [[root.id, 4, replies[3].ord]]
    );
    // 2. The inbox names the owner's read cursor, which "New messages" is drawn against.
    await json('POST', `/api/buddies/channels/${w.general.id}/read`, { postId: replies[1].id });
    const inbox = await json<Inbox>('GET', `/api/buddies/workspaces/${w.ws}/inbox`);
    const general = inbox.channels.find((entry) => entry.channel.id === w.general.id);
    assert.equal(general?.lastReadOrd, replies[1].ord);
    // 3. A reply permalink's page starts at the reply, however many replies are newer.
    const linked = await json<Page & { root: Post }>(
      'GET',
      `/api/buddies/posts/${root.id}/thread?from=${replies[0].id}&limit=2`
    );
    assert.deepEqual(
      linked.posts.map((post) => post.id),
      [replies[1].id, replies[0].id]
    );
    assert.equal(
      (await http('GET', `/api/buddies/posts/${root.id}/thread?from=${root.id}`)).status,
      400,
      'a root is not one of its own replies'
    );
    // 4. The Task filter reads one Task's posts across channels.
    const about = await json<Page>('GET', `/api/buddies/tasks/${task.id}/posts?limit=50`);
    assert.deepEqual(
      about.posts.map((post) => post.id),
      [root.id]
    );
    // 9. Settings can put a profile field back to the default; absent fields stay.
    const set = await json<Buddy>('PATCH', `/api/buddies/${w.lead.id}`, {
      provider: 'codex',
      model: 'gpt-x',
      key: 'profile-set',
    });
    assert.equal(set.model, 'gpt-x');
    const cleared = await json<Buddy>('PATCH', `/api/buddies/${w.lead.id}`, {
      model: null,
      key: 'profile-clear',
    });
    assert.equal(cleared.model, undefined);
    assert.equal(cleared.provider, 'codex');
    // 8. Directory cards: the overview counts each Buddy's unfinished top-level tasks.
    await w.core.upsertTask(OWNER, {
      kind: 'update',
      taskId: task.id,
      baseRevision: task.revision,
      changes: { status: 'blocked', blockedReason: 'waiting on design' },
      key: 'launch-blocked',
    });
    await w.core.upsertTask(OWNER, {
      kind: 'create',
      ownerId: w.lead.id,
      parentId: task.id,
      title: 'A todo is not a task on the card',
      doneCriteria: 'd',
      key: 'launch-todo',
    });
    type Roster = { id: string; taskCounts: { buddyId: string; open: number; blocked: number }[] };
    const overview = await json<Roster[]>('GET', '/api/buddies/overview');
    assert.deepEqual(overview.find((ws) => ws.id === w.ws)?.taskCounts, [
      { buddyId: w.lead.id, open: 1, blocked: 1 },
    ]);
  } finally {
    server.close();
    await w.close();
  }
});

test('owner channel replies stay in threads and reject old broadcast requests', async () => {
  const w = await world();
  const { server, http } = await ownerHttp(w);
  try {
    const root = await w.post(
      OWNER,
      { kind: 'id', id: w.general.id },
      { kind: 'inform', body: 'Thread root', evidence: [], broadcast: false, key: 'broadcast-root' }
    );
    const reply = await http('POST', `/api/buddies/channels/${w.general.id}/posts`, {
      body: 'Do not broadcast this reply',
      replyToId: root.id,
      broadcast: true,
      key: 'broadcast-reply',
    });
    assert.equal(reply.status, 400, JSON.stringify(reply.body));

    const normal = await http('POST', `/api/buddies/channels/${w.general.id}/posts`, {
      body: 'A thread reply',
      replyToId: root.id,
      key: 'thread-reply',
    });
    assert.equal(normal.status, 201, JSON.stringify(normal.body));
    const posted = (normal.body as unknown as { post: Post }).post;
    assert.equal(posted.broadcast, false);

    const feed = await http('GET', `/api/buddies/channels/${w.general.id}/posts?limit=50`);
    assert.equal(feed.status, 200, JSON.stringify(feed.body));
    assert.ok(
      !(feed.body as unknown as { posts: Post[] }).posts.some((post) => post.id === posted.id),
      'a thread reply is absent from the channel feed'
    );
  } finally {
    server.close();
    await w.close();
  }
});

// Port of 6d04860 (workspace home "New workspace"): the crate reuses a workspace only on an
// IDENTICAL root_path string, so a trailing slash or a symlink used to register the same folder
// twice. A file, a missing folder or `/` must be a 400, never a workspace.
// 493c1c7: the mention chip opened on the PROFILE default even in a thread whose seat runs an
// earlier pick, so a later "change the model" started from the wrong baseline.
test('a thread read names each Buddy’s current seat, so the mention chip opens on it', async () => {
  const w = await world();
  const { server, http } = await ownerHttp(w);
  try {
    const pick = {
      provider: 'claude' as const,
      model: { mode: 'default' as const },
      reasoning: { mode: 'explicit' as const, effort: 'high' },
    };
    const posted = await http('POST', `/api/buddies/channels/${w.general.id}/posts`, {
      body: `[@Lead](buddy:${w.lead.id}) plan it`,
      mentionConfigs: [{ buddyId: w.lead.id, config: pick }],
      key: 'seat-pick',
    });
    assert.equal(posted.status, 201, JSON.stringify(posted.body));
    const root = (posted.body as unknown as { post: Post }).post;
    const replied = async () =>
      (await w.core.listPosts(OWNER, { kind: 'thread', rootId: root.id }, null, 50)).posts.some(
        (post) => post.author.kind === 'buddy'
      );
    await until(replied, "Lead's reply");
    assert.equal(w.turns.length, 1, 'the reply ran in a seat');
    // Designer posts too, but has no seat of its own: it is left out (its profile applies).
    await w.post(
      buddyActor(w.designer.id),
      { kind: 'id', id: w.general.id },
      {
        kind: 'inform',
        body: 'noted',
        replyToId: root.id,
        evidence: [],
        broadcast: false,
        key: 'designer-noted',
      }
    );
    const thread = await http('GET', `/api/buddies/posts/${root.id}/thread`);
    assert.equal(thread.status, 200);
    assert.deepEqual((thread.body as unknown as { seats: unknown }).seats, [
      { buddyId: w.lead.id, config: pick },
    ]);
  } finally {
    server.close();
    await w.close();
  }
});

test('New workspace from a folder: the name defaults to the folder, any spelling of it reuses one workspace', async () => {
  const w = await world();
  const { server, http } = await ownerHttp(w);
  try {
    const folder = join(w.scratch, 'Atlas');
    mkdirSync(folder);
    symlinkSync(folder, join(w.scratch, 'atlas-link'));
    writeFileSync(join(w.scratch, 'notes.txt'), 'x');
    const created = await http('POST', '/api/buddies/workspaces', { rootPath: `${folder}/` });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const workspace = created.body as unknown as { id: string; name: string };
    assert.equal(workspace.name, 'Atlas');
    const again = await http('POST', '/api/buddies/workspaces', {
      rootPath: join(w.scratch, 'atlas-link'),
      name: 'Other name',
    });
    assert.equal((again.body as unknown as { id: string }).id, workspace.id);
    for (const rootPath of [join(w.scratch, 'notes.txt'), join(w.scratch, 'missing'), '/', 'rel'])
      assert.equal(
        (await http('POST', '/api/buddies/workspaces', { rootPath })).status,
        400,
        rootPath
      );
  } finally {
    server.close();
    await w.close();
  }
});

test('owner HTTP and Buddy MCP archive a channel while retaining readable history', async () => {
  const w = await world();
  const { server, http } = await ownerHttp(w);
  try {
    const post = await w.post(
      buddyActor(w.lead.id),
      { kind: 'id', id: w.general.id },
      {
        kind: 'inform',
        body: 'Keep this archive evidence',
        evidence: [],
        broadcast: false,
        key: 'archive-history',
      }
    );
    const grant = w.grants.issueBuddy({
      role: 'worker',
      buddyId: w.lead.id,
      workspaceId: w.ws,
      conversationId: 'archive-test',
      runId: null,
      returns: INBOX,
    });
    const archived = await call(w.endpoint.spec(grant), 'channel_admin', {
      channelId: w.general.id,
      change: { kind: 'archive' },
      key: 'archive',
    });
    assert.equal(archived.isError, false, archived.text);
    assert.ok(archived.value.archivedAt);
    const listed = await http('GET', `/api/buddies/workspaces/${w.ws}/channels/archived`);
    assert.equal(listed.status, 200);
    assert.equal((listed.body as unknown as { id: string }[])[0].id, w.general.id);
    const inbox = await w.core.inbox(OWNER, w.ws);
    assert.equal(
      inbox.channels.some((entry) => entry.channel.id === w.general.id),
      false
    );
    const history = await call(w.endpoint.spec(grant), 'channel_read', {
      read: { channelId: w.general.id },
    });
    assert.equal(history.value.posts[0].id, post.id);
    assert.equal(
      (
        await http('POST', `/api/buddies/channels/${w.general.id}/posts`, {
          body: 'blocked',
          key: 'blocked',
        })
      ).status,
      400
    );
    const restored = await call(w.endpoint.spec(grant), 'channel_admin', {
      channelId: w.general.id,
      change: { kind: 'restore' },
      key: 'restore',
    });
    assert.equal(restored.isError, false, restored.text);
    assert.equal(
      (
        await http('POST', `/api/buddies/channels/${w.general.id}/posts`, {
          body: 'restored',
          key: 'restored',
        })
      ).status,
      201
    );
  } finally {
    server.close();
    await w.close();
  }
});

test('Buddy MCP renames a public channel without changing its identity or history', async () => {
  const w = await world();
  const { server, http } = await ownerHttp(w);
  try {
    const post = await w.post(
      buddyActor(w.lead.id),
      { kind: 'id', id: w.general.id },
      {
        kind: 'inform',
        body: 'Keep this rename evidence',
        evidence: [],
        broadcast: false,
        key: 'rename-history',
      }
    );
    const grant = w.grants.issueBuddy({
      role: 'worker',
      buddyId: w.lead.id,
      workspaceId: w.ws,
      conversationId: 'rename-test',
      runId: null,
      returns: INBOX,
    });
    const renamed = await call(w.endpoint.spec(grant), 'channel_admin', {
      channelId: w.general.id,
      change: { kind: 'rename', name: 'features' },
      key: 'rename',
    });
    assert.equal(renamed.isError, false, renamed.text);
    assert.equal(renamed.value.id, w.general.id);
    assert.equal(renamed.value.kind.name, 'features');
    assert.equal(
      (
        (await http('GET', `/api/buddies/channels/${w.general.id}`)).body as unknown as {
          kind: { name: string };
        }
      ).kind.name,
      'features'
    );
    const history = await call(w.endpoint.spec(grant), 'channel_read', {
      read: { channelId: w.general.id },
    });
    assert.equal(history.value.posts[0].id, post.id);
  } finally {
    server.close();
    await w.close();
  }
});

// Task comments shared the post store but skipped the channel dispatch, silently losing mentions.
test('task comment mentions wake a Buddy and preserve replies in the task discussion', async () => {
  const w = await world();
  try {
    const task = await w.core.upsertTask(OWNER, {
      kind: 'create',
      ownerId: w.lead.id,
      title: 'Review task',
      doneCriteria: 'Reviewed',
      key: 'task-comment',
    });
    const root = await w.post(
      OWNER,
      { kind: 'task', taskId: task.id },
      {
        kind: 'inform',
        body: `[@Designer](buddy:${w.designer.id}) review this task`,
        evidence: [],
        broadcast: false,
        key: 'task-mention',
      }
    );
    w.answers.set(1, 'Task reviewed');
    w.emit({
      kind: 'posted',
      post: root,
      channel: await w.core.openChannel(OWNER, { kind: 'id', id: root.channelId }),
      picks: NO_PICKS,
    });
    await until(
      async () =>
        (await w.core.taskPosts(OWNER, task.id, null, 50)).posts.some(
          (post) => post.body === 'Task reviewed'
        ),
      'task mention reply'
    );
    const posts = (await w.core.taskPosts(OWNER, task.id, null, 50)).posts;
    const reply = posts.find((post) => post.body === 'Task reviewed');
    assert.equal(reply?.rootId, root.id);
    assert.equal(reply?.taskId, task.id);
    assert.equal(reply?.channelId, root.channelId);
    assert.equal(w.turns.length, 1);
  } finally {
    await w.close();
  }
});
