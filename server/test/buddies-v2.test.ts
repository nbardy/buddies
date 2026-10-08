import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { type McpServerSpec, createParser, executeCommand } from '@nbardy/agent-cli';
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
  type MessagePage,
  bodyText,
  createDefaultConversationConfig,
} from '@unleashd/shared';
import express from 'express';
import { buddyWrite, retryFailedReply } from '../../client/src/components/buddies/api';
import { choiceLabel, mentionChoice } from '../../client/src/components/buddies/channel-text';
import { scheduleFieldsOf } from '../../client/src/components/buddies/schedule-fields';
import { reorderTasks } from '../../client/src/components/buddies/task-actions';
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
  taskDetail,
} from '../src/buddies/core';
import { type BuddyEvent, createBuddyEvents } from '../src/buddies/events';
import { createGrants } from '../src/buddies/grants';
import { FOLLOW_GRACE_MS, startMcpEndpoint } from '../src/buddies/mcp';
import { createMemoryReviewer } from '../src/buddies/memory-review';
import { wakes } from '../src/buddies/mentions';
import { createBuddyPolicyPort } from '../src/buddies/policy-port';
import { registerBuddyRoutes } from '../src/buddies/routes';
import { ENVELOPE_CHARS, createRunner } from '../src/buddies/runner';
import { providerDefaultModel, workerConversationConfig } from '../src/buddies/worker-config';
import { BUDDY_RUN_LEASE_MS, TURN_MAX_RUNTIME_MS } from '../src/constants/timeouts';
import { createBuddyCreationService } from '../src/conversations/buddy-creation-service';
import { ConversationConfigService } from '../src/conversations/config-service';
import {
  type ConversationRuntime,
  type ConversationRuntimeDependencies,
  createConversationRuntime,
} from '../src/conversations/runtime';
import { replaceRuntimeConfig } from '../src/conversations/runtime-config';
import { registerFilesystemRoutes } from '../src/http/filesystem-routes';
import { resolveConfigAgainstProviderCatalog } from '../src/providers/catalog-service';
import { installedAgent } from '../src/providers/installed-agent';
import { bootstrapUnleashdHome } from '../src/upstream/unleashd-home';
import { testExecutions } from './fixtures/fake-turn';
import { recordStore } from './fixtures/records';
import { tempDir } from './fixtures/temp';

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
    return { isError, text, content: result.content, value: isError ? null : JSON.parse(text) };
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

/** `reopen`: a scratch dir an earlier world used, as a restarted backend finds its stores. */
async function world(reopen?: string, realProvider = false) {
  const scratch = reopen ?? tempDir('buddies-v2-');
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
  // Every workspace is born with #general (createWorkspace); creating it again would collide.
  const general = (await core.inbox(OWNER, ws)).channels.find(
    ({ channel }) => channel.kind.type === 'public' && channel.kind.name === 'general'
  )!.channel;

  const events = createBuddyEvents();
  const seen: BuddyEvent[] = [];
  events.on((event) => seen.push(event));
  const grants = createGrants({ ttlMs: TURN_MAX_RUNTIME_MS });
  // The install's PATH, as real files: an unpinned Buddy runs what is here (installed-agent.ts).
  // Codex by default, the behaviour every older test was written against.
  const agentBin = join(scratch, 'agent-bin');
  mkdirSync(agentBin, { recursive: true });
  writeFileSync(join(agentBin, 'codex'), '#!/bin/sh\n', { mode: 0o755 });
  const installed = () => installedAgent({ PATH: agentBin });
  const briefings = createBriefings(core, installed);
  // A transcript per conversation id, read through the same MessageSource shape production uses.
  const transcripts = new Map<string, MessagePage['messages']>();
  const endpoint = await startMcpEndpoint({
    core,
    events,
    grants,
    uploadsRoot: () => join(scratch, 'uploads'),
    messages: async (id, { afterSeq, limit }) => {
      const all = transcripts.get(id);
      if (!all) return null;
      return {
        epoch: 0,
        total: all.length,
        afterSeq,
        messages: all.slice(afterSeq + 1, afterSeq + 1 + limit),
      };
    },
    openBranch: (chat) => creation.openBranch(chat),
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
  const providerErrors = new Map<number, string>();
  // Turns whose provider process was told to stop.
  const stopped = new Set<number>();
  // A delivery prompt ends each post with `(post id[, thread root], channel id)`; the fake Buddy
  // answers the NEWEST one in its thread, as a real Buddy would (`silent` turns post nothing).
  // The fake Buddy answers an owner post or a post that @mentions someone; a plain Buddy post or a
  // notice it was merely delivered gets no answer (a real Buddy may end its turn silently).
  const answersLastPost = (prompt: string) =>
    /^\[[^\]]+\] (the owner:|[^:]+: .*\[@)/s.test(prompt.slice(prompt.lastIndexOf('\n[20') + 1));
  const deliveredPost = (prompt: string) => {
    const lines = [
      ...prompt.matchAll(/\((post_[\w-]+)(?:, thread (post_[\w-]+))?, channel ([\w-]+)\)/g),
    ];
    const last = lines.at(-1);
    return last ? [last[0], last[3], last[2] ?? last[1]] : null;
  };
  const executeTurn = ((request: ProviderRequest) => {
    if (realProvider) {
      turns.push({ n: turns.length + 1, request, mcp: request.mcpServers!.unleashd_buddy });
      return executeCommand(request);
    }
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
        const error = providerErrors.get(turn.n);
        if (error) {
          yield { type: 'error' as const, message: error };
          yield { type: 'turn.complete' as const, reason: 'error' as const };
          finish({ exitCode: 0, signal: null, sessionId, reason: 'success' });
          return;
        }
        if (outOfTokens.has(turn.n)) {
          yield { type: 'out_of_tokens' as const, message: 'You have hit your usage limit' };
          yield { type: 'turn.complete' as const, reason: 'out_of_tokens' as const };
          finish({ exitCode: 0, signal: null, sessionId, reason: 'success' });
          return;
        }
        const answer = answers.get(turn.n) ?? `Answer ${turn.n}`;
        const seat = answersLastPost(request.prompt) ? deliveredPost(request.prompt) : null;
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
  // The thread follow-up gate, scripted: each call takes the next verdict (default `<no>`).
  const gate = { asked: [] as string[], verdicts: [] as GateVerdict[] };
  const runner = createRunner({
    core,
    grants,
    events,
    briefings,
    leaseMs: BUDDY_RUN_LEASE_MS,
    chatDeadlineMs: TURN_MAX_RUNTIME_MS,
    backgroundTurnMs: 60_000,
    backstopMs: 200,
    logger: { warn: () => undefined, log: () => undefined },
    host: {
      admitChat: ({ conversationId, turnId, body, run }) =>
        conversations.get(conversationId)!.admitChatClaim(turnId, body, run),
      registered: (id) => conversations.has(id),
      defaultModel: providerDefaultModel,
      reconfigure: async (conversationId, config) =>
        replaceRuntimeConfig(
          configService,
          conversations.get(conversationId)!,
          workerConversationConfig(config)
        ),
      askGate: (input) => channels.askGate(input),
      openSeat: ({ buddyId, workspaceId, rootId, pick }) =>
        channels.openSeat({
          buddyId,
          workspaceId,
          rootId,
          pick: pick && workerConversationConfig(pick),
        }),
      openBranch: (chat) => creation.openBranch(chat),
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
      runTurn: async ({ conversationId, context, prompt, leaseToken, deadline, owner }) =>
        conversations
          .get(conversationId)!
          .runCoordinationMessage(prompt, context, leaseToken, deadline, owner),
      stop: (id) => conversations.get(id)?.stop(),
    },
  });
  const port = createBuddyPolicyPort({
    runner,
    grants,
    briefings,
    reviewer,
    spec: endpoint.spec,
    steering: () => ({ postToolHookUrl: endpoint.postToolHookUrl }),
  });
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
    installedAgent: installed,
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
    reconfigure: (conversation, config, provenance) =>
      replaceRuntimeConfig(configService, conversation, config, provenance),
  };
  const picks = new Map<string, ConversationConfig>();
  const channels = createChannels({
    core,
    events,
    installedAgent: installed,
    conversations: stable,
    channelChanged: () => undefined,
    gate: async ({ prompt }) => {
      gate.asked.push(prompt);
      return gate.verdicts.shift() ?? { kind: 'pass' };
    },
  });
  await runner.start([]);
  return {
    core,
    transcripts,
    /**
     * A crate post, unwrapped from its PostWrite, with the wakes every production writer attaches
     * (mentions.ts `wakes`): an @mention or the owner's DM post is a `deliver` run written with
     * the post. `picks` are the owner's mention-chip picks, set before the post.
     */
    post: async (...[author, ref, input]: Parameters<typeof core.post>) => {
      const channel = await core.openChannel(author, ref);
      const mentions = wakes(channel, author, input.kind, input.body, picks);
      picks.clear(); // a chip pick belongs to the one post it was made on
      return (
        await core.post(author, ref, { ...input, mentions: [...input.mentions, ...mentions] })
      ).post;
    },
    picks,
    /** Announce a post in #general, as every post writer does. */
    announce: (post: Post) => events.emit({ kind: 'posted', post, channel: general }),
    ws,
    agentBin,
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
    providerErrors,
    stopped,
    gate,
    channels,
    stable,
    creation,
    conversations,
    runner,
    scratch,
    runs: (buddyId: string) => core.listRuns({ kind: 'buddy', buddyId }, 50),
    /** The backend dies: nothing in memory survives, the stores stay for `world(scratch)`. */
    async stop() {
      runner.stop();
      await endpoint.close();
    },
    async close() {
      runner.stop();
      await endpoint.close();
      rmSync(scratch, { recursive: true, force: true });
    },
  };
}

// Rewritten for owner decision A (2026-10-06, delivery design D0/D9, task_01a11013-9072): the
// answer used to be an Inbox read with no run. Since 2026-10-07 (task_01a1153f) it runs in the
// asking chat's background branch, never in the chat itself (a).
test('one full chat turn: an owner chat asks another Buddy, it answers, the return is delivered; grants die with their turns', async () => {
  const w = await world();
  try {
    let request!: Post;
    // What turn 3 (the return, in the owner chat) could do: it must not hold the owner grant (d).
    let returnTurn!: { names: string[]; write: Awaited<ReturnType<typeof call>> };
    w.during.set(3, async (turn) => {
      returnTurn = {
        names: await toolNames(turn.mcp),
        write: await call(turn.mcp, 'doc_write', {
          buddyId: w.designer.id,
          kind: 'soul',
          scope: 'buddy',
          content: 'rewritten by a worker answer',
          baseRevision: 0,
          reason: 'x',
          key: 'return-turn',
        }),
      };
    });
    w.during.set(1, async (turn) => {
      // Owner-authored input: the grant is the owner's, so team_admin is listed.
      const names = await toolNames(turn.mcp);
      assert.equal(names.length, 12);
      assert.ok(names.includes('team_admin'));
      assert.ok(names.includes('channel'));
      // The merged names are gone (their legacy forms were deleted after the adoption window).
      for (const removed of [
        'answer',
        'channel_archive',
        'channel_rename',
        'channel_admin',
        'channel_create',
      ])
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

    // (a) The request was sent from Lead's owner chat, so the chat's BRANCH is subscribed to its
    // thread and the answer is delivered there: a `deliver` run bound to the branch, a child of the
    // chat (the chat lists it as a background worker), and the owner chat gains no turn.
    const leadRuns = await until(async () => {
      const runs = await w.runs(w.lead.id);
      return runs.length === 2 && runs.every((r) => r.status === 'complete') && runs;
    }, "Lead's chat run and its return");
    const returned = leadRuns.find((r) => r.input.kind === 'deliver')!;
    const branch = w.conversations.get(returned.conversationId!)!;
    assert.notEqual(branch.id, 'owner-chat', 'the answer never runs in the owner chat');
    assert.equal(branch.parentConversationId, 'owner-chat');
    assert.equal(branch.kind.t === 'buddy' && branch.kind.visibility, 'background');
    assert.equal(chat.messages.filter((m) => m.role === 'user').length, 1, 'no turn in the chat');
    assert.equal(w.turns.length, 3);
    assert.match(w.turns[2].request.prompt, /New posts in threads you follow/);
    assert.match(w.turns[2].request.prompt, /Logo drawn/);
    // (d) The branch forks the chat's provider session, so it has the lead's context, and it is a
    // Buddy-authored turn: a worker's answer never runs with the owner's grant (B1, D9).
    assert.equal(w.turns[2].request.forkSessionId, 'native-1', "a fork of the chat's session");
    assert.equal(returnTurn.names.includes('team_admin'), false, 'no owner tools');
    assert.equal(returnTurn.write.isError, true);
    assert.match(returnTurn.write.text, /^\[denied\]/, 'no owner document authority');

    // A chat run's deadline is exactly TURN_MAX_RUNTIME_MS (the 2026-09-10 incident killed healthy
    // owner chats at an inherited 600 s). Until 2026-10-01 this read `leaseExpiresAt`, because the
    // lease WAS the deadline; the lease is now a separate short heartbeat (Pattern: lease-heartbeat).
    const chatRun = leadRuns.find((r) => r.input.kind === 'chat')!;
    const budget = Date.parse(chatRun.deadline!) - Date.parse(chatRun.startedAt!);
    assert.ok(Math.abs(budget - TURN_MAX_RUNTIME_MS) < 1_000, `deadline ${budget} ms`);

    // Tokens are readable by the agent's shell, so a settled turn's grant must be dead.
    for (const turn of w.turns)
      assert.equal(await probe(turn.mcp), 401, `turn ${turn.n}'s grant outlived its turn`);
    assert.equal(w.grants.size(), 0);
  } finally {
    await w.close();
  }
});

// Pattern: fix-guards (docs/patterns.md#fix-guards). Owner decision 2026-10-07 (task_01a1153f,
// #case-studies post_01a1153e-e5f3): deliveries stay "out of our chats", shown "as background
// worker". Under decision A the answer ran as a turn IN the owner chat (rendered as a "You"
// message with the raw envelope) and waited for the owner's turn and messages (owner_first). Now
// it runs at once in the chat's branch, beside the owner's still-running turn, and the chat's
// transcript gains nothing. Fails if the owner chat subscribes itself again.
test("a worker's answer runs in the owner chat's background branch while the owner's turn still runs", async () => {
  const w = await world();
  try {
    let branchTurnDuringOwnerTurn = false;
    w.during.set(1, async (turn) => {
      const posted = await call(turn.mcp, 'post', {
        channel: { direct: [w.designer.id] },
        kind: 'request',
        body: 'Draw the logo',
        key: 'ask-logo',
      });
      assert.equal(posted.isError, false, posted.text);
      await until(
        async () =>
          (await w.runs(w.lead.id)).some(
            (r) => r.input.kind === 'deliver' && r.status === 'complete'
          ),
        'the answer delivered while the owner turn runs'
      );
      branchTurnDuringOwnerTurn = true;
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
    const runs = await until(async () => {
      const all = await w.runs(w.lead.id);
      return all.length === 2 && all.every((r) => r.status === 'complete') && all;
    }, 'the owner turn and the delivery');
    assert.ok(branchTurnDuringOwnerTurn, 'the delivery did not wait for the owner turn');
    const delivery = runs.find((r) => r.input.kind === 'deliver')!;
    assert.equal(w.conversations.get(delivery.conversationId!)?.parentConversationId, 'owner-chat');
    const userText = chat.messages.flatMap((m) => (m.role === 'user' ? [bodyText(m.body)] : []));
    assert.deepEqual(userText, ['Get Designer to draw the logo'], 'no delivery in the owner chat');
  } finally {
    await w.close();
  }
});

// (e) A failed worker's notice also arrives for the chat that asked, in its branch.
test("a failed worker run reaches the owner chat's branch", async () => {
  const w = await world();
  try {
    w.during.set(1, async (turn) => {
      const posted = await call(turn.mcp, 'post', {
        channel: { direct: [w.designer.id] },
        kind: 'request',
        body: 'Draw the logo',
        key: 'ask-logo',
      });
      assert.equal(posted.isError, false, posted.text);
    });
    w.providerErrors.set(2, 'provider exploded');
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
    const notice = await until(
      async () =>
        (await w.runs(w.lead.id)).find(
          (r) => r.input.kind === 'deliver' && r.status === 'complete'
        ),
      'the failure notice turn'
    );
    // The failure notice is a `run_failed` post by the worker in the request's thread, delivered
    // to the subscribed branch like an answer.
    assert.equal(w.conversations.get(notice.conversationId!)?.parentConversationId, 'owner-chat');
    assert.match(w.turns[2].request.prompt, /failed \(execution_failed\)/);
    assert.equal(w.turns[2].request.forkSessionId, 'native-1');
  } finally {
    await w.close();
  }
});

// (g) Follow from a foreground chat subscribes its branch, which wakes without owner authority.
test("follow from an owner chat registers and wakes the chat's branch", async () => {
  const w = await world();
  try {
    let rootId = '';
    let read!: Awaited<ReturnType<typeof call>>;
    w.during.set(1, async (turn) => {
      const root = await call(turn.mcp, 'post', {
        channel: { id: w.general.id },
        body: 'Designer, send the mockups when ready',
        key: 'ask-mockups',
      });
      rootId = root.value.id;
      read = await call(turn.mcp, 'channel_read', { read: { threadId: rootId, follow: {} } });
    });
    let woken!: { names: string[] };
    w.during.set(2, async (turn) => {
      woken = { names: await toolNames(turn.mcp) };
    });
    w.silent.add(2);
    const chat = await w.creation.createServerBuddyConversation({
      context: { buddyId: w.lead.id, workspaceId: w.ws },
      conversationId: 'owner-chat',
      commandId: 'owner-chat',
      deferInitialMessage: true,
    });
    chat.sendMessage('Wait for the mockups', { origin: 'owner_input', inputId: 'owner-1' });
    await until(
      async () =>
        (await w.runs(w.lead.id)).some((r) => r.input.kind === 'chat' && r.status === 'complete'),
      'the owner turn'
    );
    assert.equal(read.value.kind, 'subscribed', read.text);
    assert.equal(
      (
        await call(asBuddy(w, w.designer.id), 'post', {
          channel: { id: w.general.id },
          replyToId: rootId,
          body: 'Mockups are in /tmp/mockups',
          key: 'mockups',
        })
      ).isError,
      false
    );
    const turn = await until(() => w.turns[1], 'the branch woken by the follow');
    assert.match(turn.request.prompt, /Mockups are in \/tmp\/mockups/);
    assert.equal(turn.request.forkSessionId, 'native-1', "the branch forks the chat's session");
    assert.equal(chat.messages.filter((m) => m.role === 'user').length, 1, 'no turn in the chat');
    await until(() => woken, 'the wake turn');
    assert.equal(woken.names.includes('team_admin'), false, 'a wake never holds the owner grant');
  } finally {
    await w.close();
  }
});

// Pattern: fix-guards (docs/patterns.md#fix-guards). Owner decision 2026-10-06
// (agent_notes/2026-10-06_dm-is-one-to-one-decision.md): a DM is one-to-one, so a request has one
// possible owner. Through the real MCP endpoint a Buddy's group `direct:[a, b]` is a typed error
// naming the alternative, starts no run and creates no channel; one DM per recipient works.
// Crate guard: `a_dm_is_one_to_one_and_a_legacy_group_dm_is_read_only`.
// Regression (core review I2, 2026-10-07): pause() is the reload boundary ("nothing new is
// claimed"), but a drain already in its claim loop kept claiming until the queue was empty.
test('pausing the runner mid-drain stops further claims', async () => {
  const w = await world();
  try {
    w.runner.pause();
    for (const buddy of [w.lead, w.designer])
      await w.post(
        OWNER,
        { kind: 'direct', members: [buddyActor(buddy.id), OWNER] },
        {
          kind: 'inform',
          body: 'hello',
          evidence: [],
          mentions: [],
          broadcast: false,
          key: `hello-${buddy.slug}`,
        }
      );
    const claim = w.core.claimRun.bind(w.core);
    let claims = 0;
    w.core.claimRun = async (...args) => {
      claims += 1;
      const claimed = await claim(...args);
      w.runner.pause(); // the reload arrives while this claim's turn starts
      return claimed;
    };
    w.runner.resume();
    await w.runner.settled();
    assert.equal(claims, 1);
    const queued = [...(await w.runs(w.lead.id)), ...(await w.runs(w.designer.id))];
    assert.equal(queued.filter((run) => run.status === 'queued').length, 1);
  } finally {
    await w.close();
  }
});

test('a group DM is refused through MCP; one DM per recipient is the alternative', async () => {
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
    const grant = w.grants.issueBuddy({
      role: 'worker',
      buddyId: w.lead.id,
      workspaceId: w.ws,
      conversationId: 'c',
      runId: null,
      subscribes: 'self',
    });
    const spec = w.endpoint.spec(grant);
    const group = await call(spec, 'post', {
      channel: { direct: [w.designer.id, reviewer.id] },
      kind: 'request',
      body: 'Both of you: review the logo',
      key: 'ask-group',
    });
    assert.equal(group.isError, true);
    assert.match(group.text, /public channel/);
    assert.match(group.text, /one direct message per recipient/);
    assert.equal((await w.runs(w.designer.id)).length, 0, 'no run started for the refused request');
    for (const recipient of [w.designer, reviewer]) {
      const one = await call(spec, 'post', {
        channel: { direct: [recipient.id] },
        kind: 'request',
        body: 'Review the logo',
        key: `ask-${recipient.id}`,
      });
      assert.equal(one.isError, false, one.text);
    }
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
      subscribes: 'self',
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
        mentions: [],
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
        subscribes: 'self',
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
    assert.equal((await w.core.claimRun(w.runner.budgets, []))?.run.id, row.id);

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
        mentions: [],
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

    // Designer (a Buddy) posts in the thread; Lead's seat follows it, so the post is delivered
    // there and Lead runs a follow-up turn (the follow-up gate it replaced is gone, step 5).
    w.during.set(2, async (turn) => {
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
        body: `[@Lead](buddy:${w.lead.id}) which date?`,
        replyToId: root.id,
        evidence: [],
        mentions: [],
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
      /New posts in threads you follow[\s\S]*which date\?/,
      'a resumed seat is sent only what is new'
    );
    assert.doesNotMatch(w.turns[1].request.prompt, /plan the launch/, 'not the whole thread again');
  } finally {
    await w.close();
  }
});

// 2026-10-06: a Buddy wrote plain `@Wave Simulation Lead` and nobody was mentioned (no chip, no
// wake) while `post` reported success. `post` now stores the link form and reports whom it woke.
test('plain @Name mentions: a Buddy post stores the link form, wakes that Buddy, reports unresolved', async () => {
  const w = await world();
  try {
    const root = await w.post(
      OWNER,
      { kind: 'id', id: w.general.id },
      {
        kind: 'inform',
        body: `[@Lead](buddy:${w.lead.id}) kickoff`,
        evidence: [],
        broadcast: false,
        mentions: [],
        key: 'plain-root',
      }
    );
    let result: { body: string; mentioned: unknown; unresolved: unknown } | undefined;
    w.during.set(1, async (turn) => {
      const posted = await call(turn.mcp, 'post', {
        channel: { id: w.general.id },
        body: `@${w.designer.name.toUpperCase()} please review; ask @Nobody Here, mail a@${w.lead.name}.com, \`@${w.lead.name}\` stays code`,
        key: 'plain-mention',
      });
      assert.equal(posted.isError, false, posted.text);
      result = posted.value as typeof result;
    });
    w.announce(root);
    await until(async () => result !== undefined, 'the plain-mention post');
    const link = `[@${w.designer.name}](buddy:${w.designer.id})`;
    assert.ok(result?.body.startsWith(`${link} please review`), result?.body);
    assert.ok(result?.body.includes(`\`@${w.lead.name}\` stays code`), 'code span untouched');
    assert.deepEqual(result?.mentioned, [{ id: w.designer.id, name: w.designer.name }]);
    assert.deepEqual(result?.unresolved, ['@Nobody']);
    await until(async () => w.turns.length >= 2, 'the mentioned Buddy woke');
  } finally {
    await w.close();
  }
});

// 2026-10-08: the owner route stored a pasted plain `@Name` literally (no chip, no wake) and trusted
// stale ids as written, while the Buddy tool resolved names. Both now store what the one shared
// `resolveReferences` returns: current name for a renamed Buddy, foreign ids dissolved, exact unique
// names resolved, code and e-mail untouched; and the owner's post wakes the Buddy exactly once.
test('owner and Buddy posts store the same canonical mentions, and wake once even on replay', async () => {
  const w = await world();
  const { server, http } = await ownerHttp(w);
  try {
    await w.core.updateBuddy(OWNER, {
      buddyId: w.lead.id,
      changes: { name: 'Chief' },
      key: 'rename-lead',
    });
    const body = `@chief look; again [@Lead](buddy:${w.lead.id}); mail a@chief.com; \`@Chief\` is code`;
    const canonical = `[@Chief](buddy:${w.lead.id}) look; again [@Chief](buddy:${w.lead.id}); mail a@chief.com; \`@Chief\` is code`;

    let viaTool: string | undefined;
    w.during.set(1, async (turn) => {
      const posted = await call(turn.mcp, 'post', {
        channel: { id: w.general.id },
        body,
        key: 'same-body-by-tool',
      });
      assert.equal(posted.isError, false, posted.text);
      viaTool = (posted.value as { body: string }).body;
    });
    const sent = await http('POST', `/api/buddies/channels/${w.general.id}/posts`, {
      body,
      key: 'owner-stale-mentions',
    });
    assert.equal(sent.status, 201, JSON.stringify(sent.body));
    const post = (sent.body as unknown as { post: Post }).post;
    assert.equal(post.body, canonical, 'the owner route stores the canonical body');
    await until(async () => viaTool !== undefined, 'the woken Buddy posted the same text');
    assert.equal(viaTool, canonical, 'the Buddy tool stores the identical body');

    // A retried request replays the first post and creates no second delivery.
    const replay = await http('POST', `/api/buddies/channels/${w.general.id}/posts`, {
      body,
      key: 'owner-stale-mentions',
    });
    assert.equal(replay.status, 201, JSON.stringify(replay.body));
    assert.equal((replay.body as unknown as { post: Post }).post.id, post.id);
    await until(
      async () => (await w.runs(w.lead.id)).every((r) => r.status === 'complete'),
      'the delivery settles'
    );
    const deliveries = (await w.runs(w.lead.id)).filter(
      (r) => r.input.kind === 'deliver' && r.input.postId === post.id
    );
    assert.equal(deliveries.length, 1, 'one delivery for the owner post, replay included');
    assert.equal((await w.runs(w.designer.id)).length, 0, 'nobody else was woken');
  } finally {
    server.close();
    await w.close();
  }
});

// Fix-guard 2026-10-08: an explicit `buddy:<id>` the workspace does not hold (another workspace's
// Buddy, an archived one) dissolved to `@Label` and was then read BY NAME, so a pasted foreign
// `@Lead` woke the local Lead. It is now refused at the one write boundary (owner post, owner
// answer, Buddy tool): no post, no delivery, and a replay of the same key stays refused.
test('an explicit id that is not on the roster is refused, never retargeted to a same-named Buddy', async () => {
  const w = await world();
  const { server, http } = await ownerHttp(w);
  try {
    const elsewhere = await w.core.createWorkspace(OWNER, {
      name: 'Elsewhere',
      rootPath: tempDir('elsewhere-'),
    });
    const foreignLead = await w.core.createBuddy(OWNER, {
      workspaceId: elsewhere.id,
      slug: 'lead',
      name: 'Lead',
      role: 'Their lead',
      manager: { kind: 'nobody' },
      provider: 'codex',
      key: 'foreign-lead',
    });
    await w.core.updateBuddy(OWNER, {
      buddyId: w.designer.id,
      changes: { status: 'archived' },
      key: 'archive-designer',
    });
    const before = (
      await w.core.listPosts(OWNER, { kind: 'channel', channelId: w.general.id }, null, 50)
    ).posts.length;
    const attempts = [
      ['foreign', `look [@Lead](buddy:${foreignLead.id}) here`, 'Lead'],
      ['archived', `look [@Designer](buddy:${w.designer.id}) here`, 'Designer'],
    ];
    for (const [name, body, label] of attempts) {
      for (const round of [1, 2]) {
        const sent = await http('POST', `/api/buddies/channels/${w.general.id}/posts`, {
          body,
          key: `refused-${name}`,
        });
        assert.equal(sent.status, 400, `${name} round ${round}: ${JSON.stringify(sent.body)}`);
        assert.match(String(sent.body.error), new RegExp(`@${label} names a Buddy that is not`));
      }
    }
    // The Buddy tool shares the boundary: a woken Lead cannot post the foreign token either.
    let viaTool: { isError: boolean; text: string } | undefined;
    w.during.set(1, async (turn) => {
      viaTool = await call(turn.mcp, 'post', {
        channel: { id: w.general.id },
        body: `[@Lead](buddy:${foreignLead.id}) hi`,
        key: 'tool-foreign',
      });
    });
    const woke = await http('POST', `/api/buddies/channels/${w.general.id}/posts`, {
      body: `[@Lead](buddy:${w.lead.id}) go`,
      key: 'wake-lead',
    });
    assert.equal(woke.status, 201, JSON.stringify(woke.body));
    await until(async () => viaTool !== undefined, 'the woken Lead tried to post');
    assert.equal(viaTool?.isError, true, viaTool?.text);
    assert.match(viaTool?.text ?? '', /not in this workspace/);
    await until(
      async () => (await w.runs(w.lead.id)).every((r) => r.status === 'complete'),
      'the delivery settles'
    );
    const posts = (
      await w.core.listPosts(OWNER, { kind: 'channel', channelId: w.general.id }, null, 50)
    ).posts;
    assert.equal(posts.length, before + 1, 'only the legitimate wake post exists');
    assert.equal(
      (await w.runs(w.lead.id)).length,
      1,
      'the local Lead ran once, for its own mention'
    );
    assert.equal((await w.runs(w.designer.id)).length, 0);
  } finally {
    server.close();
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
        mentions: [],
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
      assert.match(turn.request.prompt, /your turn/, 'the mention is delivered to Designer');
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
        { kind: 'inform', body, replyToId, evidence: [], mentions: [], broadcast: false, key: body }
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
// replies and none of its own. Only a provider change needs a new seat. Step 5 (2026-10-06): that
// seat is sent the posts it has not read and a pointer to channel_read, not a pasted history.
test("an effort pick keeps the seat's session; a provider pick opens a new seat", async () => {
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
        {
          kind: 'inform',
          body,
          replyToId,
          evidence: [],
          mentions: [],
          broadcast: false,
          key: `say-${++n}`,
        }
      );
    const replies = async () =>
      (await w.core.listPosts(OWNER, { kind: 'thread', rootId: root.id }, null, 100)).posts.filter(
        (post) => post.purpose === 'reply'
      ).length;
    const mention = async (text: string, config: ConversationConfig, expected: number) => {
      w.picks.set(w.lead.id, config);
      await say(`[@Lead](buddy:${w.lead.id}) ${text}`, root.id);
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
    assert.match(w.turns[1].request.prompt, /New posts in threads you follow/);
    assert.doesNotMatch(w.turns[1].request.prompt, /Plan the barrel solver/, 'only what is new');

    await mention('now on claude', createDefaultConversationConfig('claude'), 3);
    const fresh = w.turns[2].request;
    assert.equal(fresh.harness, 'claude');
    assert.equal(fresh.resumeSessionId, undefined, 'a provider pick is a new seat');
    assert.match(fresh.prompt, /now on claude/);
    assert.doesNotMatch(
      fresh.prompt,
      /Lead finding one/,
      'history is read with channel_read, not pasted'
    );
  } finally {
    await w.close();
  }
});

// 493c1c7: a reply that failed on its harness (here out of tokens) had no way forward but to
// re-mention and hope. The owner can rerun it with a selected harness/model.
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
        mentions: [],
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
        mentions: [],
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

// A stale derived seat must not override the Buddy's latest actual model in this thread.
test('latest thread reply model drives the picker and the next delivery; explicit picks win', async () => {
  const w = await world();
  try {
    let n = 0;
    const say = (body: string, replyToId?: string) =>
      w.post(
        OWNER,
        { kind: 'id', id: w.general.id },
        {
          kind: 'inform',
          body,
          replyToId,
          evidence: [],
          mentions: [],
          broadcast: false,
          key: `priority-${++n}`,
        }
      );
    // The mention is a run the moment it is written, so the profile is set first.
    await w.core.updateBuddy(OWNER, {
      buddyId: w.lead.id,
      changes: { provider: { kind: 'set', value: 'claude' } },
      key: 'initial-profile',
    });
    const root = await say(`[@Lead](buddy:${w.lead.id}) start`);
    const thread = async () =>
      (await w.core.listPosts(OWNER, { kind: 'thread', rootId: root.id }, null, 50)).posts;
    await until(async () => (await thread()).some((p) => p.purpose === 'reply'), 'first reply');

    const sol: ConversationConfig = {
      ...createDefaultConversationConfig('codex'),
      model: { mode: 'explicit', modelId: 'gpt-6.1-sol' },
    };
    const latest = await w.creation.createServerBuddyConversation({
      context: { buddyId: w.lead.id, workspaceId: w.ws },
      conversationId: 'external-sol-reply',
      commandId: 'external-sol-reply',
      config: sol,
      deferInitialMessage: true,
    });
    await w.post(
      buddyActor(w.lead.id),
      { kind: 'id', id: w.general.id },
      {
        kind: 'inform',
        body: 'Latest work on Sol',
        purpose: 'reply',
        replyToId: root.id,
        fromConversationId: latest.id,
        evidence: [],
        mentions: [],
        broadcast: false,
        key: 'external-reply',
      }
    );
    assert.deepEqual(
      (await w.channels.threadSeats(root.id)).find((s) => s.buddyId === w.lead.id)?.config,
      sol
    );
    // Posting subscribes nothing in a public thread (owner decision 2026-10-07): the owner's next
    // post is a follow-up for Lead's SEAT, which the gate admits, and the seat runs on Sol.
    w.gate.verdicts.push({ kind: 'respond' });
    await w.post(
      OWNER,
      { kind: 'id', id: w.general.id },
      {
        kind: 'inform',
        body: 'What next?',
        replyToId: root.id,
        evidence: [],
        mentions: [],
        broadcast: false,
        key: 'what-next',
      }
    );
    await until(() => w.turns.length === 2, 'follow-up reply');
    assert.equal(w.turns[1].request.model, 'gpt-6.1-sol');
    await until(
      async () => (await thread()).filter((p) => p.purpose === 'reply').length === 3,
      'follow-up post'
    );
    const explicit = createDefaultConversationConfig('claude');
    w.picks.set(w.lead.id, explicit);
    await say(`[@Lead](buddy:${w.lead.id}) switch back`, root.id);
    await until(
      async () => (await thread()).filter((p) => p.purpose === 'reply').length === 4,
      'explicit reply'
    );
    assert.equal(w.turns[2].request.harness, 'claude', 'a pick on another provider opens a seat');
    w.gate.verdicts.push({ kind: 'respond' });
    await say('Continue without repeating the model', root.id);
    await until(
      async () => (await thread()).filter((p) => p.purpose === 'reply').length === 5,
      'remembered follow-up'
    );
    assert.equal(w.turns[3].request.harness, 'claude', 'the pick is what the thread now runs on');
  } finally {
    await w.close();
  }
});

test('explicit thread choice survives a failed attempt and records reopen; picker and invocation agree', async () => {
  const w = await world();
  const { server, http } = await ownerHttp(w);
  try {
    // Written without its wake: this test wants no turn until the owner's pick.
    const root = (
      await w.core.post(
        OWNER,
        { kind: 'id', id: w.general.id },
        {
          kind: 'inform',
          body: `[@Lead](buddy:${w.lead.id}) start`,
          evidence: [],
          mentions: [],
          broadcast: false,
          key: 'selection-root',
        }
      )
    ).post;
    const old = await w.creation.createServerBuddyConversation({
      context: { buddyId: w.lead.id, workspaceId: w.ws },
      conversationId: 'old-claude',
      commandId: 'old-claude',
      config: createDefaultConversationConfig('claude'),
      deferInitialMessage: true,
    });
    await w.post(
      buddyActor(w.lead.id),
      { kind: 'id', id: w.general.id },
      {
        kind: 'inform',
        body: 'Earlier Claude work',
        purpose: 'reply',
        replyToId: root.id,
        fromConversationId: old.id,
        evidence: [],
        mentions: [],
        broadcast: false,
        key: 'old-work',
      }
    );
    const threadRead = async () => {
      const response = await http('GET', `/api/buddies/posts/${root.id}/thread`);
      assert.equal(response.status, 200);
      return response.body as unknown as {
        posts: Post[];
        seats: { buddyId: string; config: ConversationConfig }[];
      };
    };
    const buddy = {
      kind: 'buddy' as const,
      id: w.lead.id,
      label: 'Lead',
      detail: '',
      execution: { kind: 'profile' as const, config: createDefaultConversationConfig('codex') },
    };
    const before = mentionChoice(buddy, new Map(), {
      kind: 'loaded',
      seats: (await threadRead()).seats,
    });
    assert.equal(
      ('config' in before ? before.config : null)?.provider,
      'claude',
      'old thread displays its actual next model'
    );
    const explicit: ConversationConfig = {
      provider: 'codex',
      model: { mode: 'explicit', modelId: 'gpt-6.1-sol' },
      reasoning: { mode: 'explicit', effort: 'high' },
    };
    w.providerErrors.set(1, "You've hit your weekly limit · resets 7pm (Asia/Makassar)");
    const response = await http('POST', `/api/buddies/channels/${w.general.id}/posts`, {
      body: `[@Lead](buddy:${w.lead.id}) use the changed picker`,
      replyToId: root.id,
      mentionConfigs: [{ buddyId: w.lead.id, config: explicit }],
      key: 'failed-choice',
    });
    assert.equal(response.status, 201);
    const failed = await until(
      async () => (await threadRead()).posts.find((p) => p.purpose === 'reply_failed'),
      'chosen attempt fails'
    );
    assert.match(failed.body, /You've hit your weekly limit/);
    await until(
      async () => (await w.channels.responding(w.general.id)).length === 0,
      'failed pair idle'
    );
    const shown = mentionChoice(buddy, new Map(), {
      kind: 'loaded',
      seats: (await threadRead()).seats,
    });
    assert.equal(
      choiceLabel(shown, null),
      `${w.turns[0].request.model} · high`,
      'display equals failed invocation'
    );
    assert.deepEqual(
      'config' in shown ? shown.config : null,
      explicit,
      'failure does not revert to old Claude history'
    );

    // Reopen the real records store and a fresh responder; no in-memory selection survives.
    const reopened = new ConversationConfigService({
      store: recordStore(join(w.scratch, 'config')),
      resolver: { resolve: async (config) => resolveConfigAgainstProviderCatalog(config) },
    });
    const events = createBuddyEvents();
    const reloaded = createChannels({
      core: w.core,
      events,
      installedAgent: () => installedAgent({ PATH: w.agentBin }),
      conversations: { ...w.stable, slot: async (id) => slotOf(await reopened.getRecord(id)) },
      channelChanged: () => undefined,
      gate: async () => ({ kind: 'pass' }),
    });
    assert.deepEqual(
      (await reloaded.threadSeats(root.id)).find((s) => s.buddyId === w.lead.id)?.config,
      explicit
    );
    w.gate.verdicts.push({ kind: 'respond' });
    const next = await w.post(
      OWNER,
      { kind: 'id', id: w.general.id },
      {
        kind: 'inform',
        body: 'Continue after failure',
        replyToId: root.id,
        evidence: [],
        mentions: [],
        broadcast: false,
        key: 'next-after-failure',
      }
    );
    events.emit({ kind: 'posted', post: next, channel: w.general });
    await until(() => w.turns.length === 2, 'reloaded follow-up invokes');
    assert.equal(w.turns[1].request.harness, explicit.provider);
    assert.equal(w.turns[1].request.model, 'gpt-6.1-sol');
    assert.equal(w.turns[1].request.reasoningEffort, 'high');
    await until(
      async () => (await reloaded.responding(w.general.id)).length === 0,
      'reloaded reply idle'
    );
    const retry = await http('POST', `/api/buddies/posts/${failed.id}/retry`, {
      config: explicit,
      key: 'retry-explicit',
    });
    assert.equal(retry.status, 202, JSON.stringify(retry.body));
    await until(() => w.turns.length === 3, 'plain weekly-limit retry invokes');
    assert.equal(w.turns[2].request.model, 'gpt-6.1-sol');
    await until(
      async () => (await w.channels.responding(w.general.id)).length === 0,
      'weekly retry idle'
    );
  } finally {
    server.close();
    await w.close();
  }
});

test('same-value picks become durable overrides, independent of another Buddy and deleted history', async () => {
  const w = await world();
  try {
    let n = 0;
    const say = (body: string, replyToId?: string) =>
      w.post(
        OWNER,
        { kind: 'id', id: w.general.id },
        {
          kind: 'inform',
          body,
          replyToId,
          evidence: [],
          mentions: [],
          broadcast: false,
          key: `scope-${++n}`,
        }
      );
    const root = await say(`[@Lead](buddy:${w.lead.id}) start`);
    w.announce(root);
    await until(
      async () => w.turns.length === 1 && (await w.channels.responding(w.general.id)).length === 0,
      'default reply'
    );
    const initial = (await w.channels.threadSeats(root.id)).find(
      (s) => s.buddyId === w.lead.id
    )!.config;
    assert.deepEqual(
      initial,
      createDefaultConversationConfig('codex'),
      'empty thread uses profile'
    );
    // The config is unchanged: only its origin changes, before the failed attempt.
    w.outOfTokens.add(2);
    w.picks.set(w.lead.id, initial);
    await say(`[@Lead](buddy:${w.lead.id}) keep this model`, root.id);
    await until(
      async () => w.turns.length === 2 && (await w.channels.responding(w.general.id)).length === 0,
      'same-value pick fails'
    );
    const external = await w.creation.createServerBuddyConversation({
      context: { buddyId: w.lead.id, workspaceId: w.ws },
      conversationId: 'later-external-claude',
      commandId: 'later-external-claude',
      config: createDefaultConversationConfig('claude'),
      deferInitialMessage: true,
    });
    await w.post(
      buddyActor(w.lead.id),
      { kind: 'id', id: w.general.id },
      {
        kind: 'inform',
        body: 'Newer external Claude work',
        replyToId: root.id,
        fromConversationId: external.id,
        evidence: [],
        mentions: [],
        broadcast: false,
        key: 'newer-external',
      }
    );
    assert.deepEqual(
      (await w.channels.threadSeats(root.id)).find((s) => s.buddyId === w.lead.id)?.config,
      initial,
      'explicit intent beats newer inferred history'
    );
    // Lead's external conversation follows the thread now (it posted there), so the owner's post
    // reaches Lead too; the turns are counted by harness, not by number.
    w.picks.set(w.designer.id, createDefaultConversationConfig('claude'));
    await say(`[@Designer](buddy:${w.designer.id}) use your own model`, root.id);
    await until(
      async () =>
        w.turns.some((turn) => turn.request.harness === 'claude') &&
        (await w.channels.responding(w.general.id)).length === 0,
      'independent Designer reply'
    );
    const seats = await w.channels.threadSeats(root.id);
    assert.equal(seats.find((s) => s.buddyId === w.designer.id)?.config.provider, 'claude');
    assert.equal(seats.find((s) => s.buddyId === w.lead.id)?.config.provider, 'codex');

    // A different, unseated thread falls back past a deleted latest reference.
    const other = await say('A thread without an override');
    await w.post(
      buddyActor(w.lead.id),
      { kind: 'id', id: w.general.id },
      {
        kind: 'inform',
        body: 'History',
        replyToId: other.id,
        fromConversationId: external.id,
        evidence: [],
        mentions: [],
        broadcast: false,
        key: 'history-other',
      }
    );
    assert.equal((await w.channels.threadSeats(other.id))[0].config.provider, 'claude');
    const records = recordStore(join(w.scratch, 'config'));
    await records.delete(external.id);
    assert.deepEqual(
      await w.channels.threadSeats(other.id),
      [],
      'deleted historical config is skipped; composer uses profile'
    );
    const unavailable: ConversationConfig = {
      provider: 'codex',
      model: { mode: 'explicit', modelId: 'retired-model' },
      reasoning: { mode: 'default' },
    };
    await records.create({
      conversationId: 'retired-history',
      kind: {
        t: 'buddy',
        context: { buddyId: w.lead.id, workspaceId: w.ws },
        visibility: 'foreground',
      },
      config: unavailable,
      provenance: 'external_discovered',
    });
    await w.post(
      buddyActor(w.lead.id),
      { kind: 'id', id: w.general.id },
      {
        kind: 'inform',
        body: 'Work on a now-retired model',
        replyToId: other.id,
        fromConversationId: 'retired-history',
        evidence: [],
        mentions: [],
        broadcast: false,
        key: 'retired-history',
      }
    );
    assert.deepEqual(
      (await w.channels.threadSeats(other.id))[0].config,
      unavailable,
      'unavailable history is shown, not silently replaced'
    );
    const turnsBefore = w.turns.length;
    await say(`[@Lead](buddy:${w.lead.id}) continue here`, other.id);
    await until(
      async () =>
        (await w.core.listPosts(OWNER, { kind: 'thread', rootId: other.id }, null, 50)).posts.some(
          (p) => p.purpose === 'reply_failed' && /Model is unavailable/.test(p.body)
        ),
      'unavailable model fails visibly'
    );
    assert.equal(w.turns.length, turnsBefore, 'no provider substitution after resolution failure');
  } finally {
    await w.close();
  }
});

test('keyed retry over owner HTTP recovers a capacity-failed reply on the same harness', async () => {
  const w = await world();
  const { server, withClient } = await ownerHttp(w);
  try {
    const root = await w.post(
      OWNER,
      { kind: 'id', id: w.general.id },
      {
        kind: 'inform',
        body: `[@Lead](buddy:${w.lead.id}) start`,
        evidence: [],
        mentions: [],
        broadcast: false,
        key: 'gate-start',
      }
    );
    w.announce(root);
    const thread = async () =>
      (await w.core.listPosts(OWNER, { kind: 'thread', rootId: root.id }, null, 50)).posts;
    await until(async () => (await thread()).some((p) => p.purpose === 'reply'), 'first reply');
    // The gate (restored 2026-10-07) says yes; the delivered turn itself hits the capacity error.
    w.gate.verdicts.push({ kind: 'respond' });
    w.providerErrors.set(2, 'Selected model is at capacity. Please try a different model.');
    const trigger = await w.post(
      OWNER,
      { kind: 'id', id: w.general.id },
      {
        kind: 'inform',
        body: 'What next?',
        replyToId: root.id,
        evidence: [],
        mentions: [],
        broadcast: false,
        key: 'gate-next',
      }
    );
    w.announce(trigger);
    const notice = await until(
      async () => (await thread()).find((p) => p.purpose === 'reply_failed'),
      'failure notice'
    );
    assert.match(notice.body, /Selected model is at capacity/);
    const sol: ConversationConfig = {
      ...createDefaultConversationConfig('codex'),
      model: { mode: 'explicit', modelId: 'gpt-6.1-sol' },
    };
    const retry = await withClient(() =>
      buddyWrite('reply.retry', { postId: notice.id }, { config: sol })
    );
    assert.deepEqual(retry, { buddyId: w.lead.id, status: 'started' });
    const answer = await until(
      async () =>
        (await thread()).find(
          (p) => p.id !== notice.id && p.purpose === 'reply' && p.body === 'Answer 3'
        ),
      'retry answer'
    );
    assert.equal(w.turns[2].request.harness, 'codex');
    assert.equal(w.turns[2].request.model, 'gpt-6.1-sol');
    assert.equal(answer.rootId, root.id);
    assert.match(w.turns[2].request.prompt, /What next\?/, 'a retry shows its trigger again');
    await w.core.updateBuddy(OWNER, {
      buddyId: w.lead.id,
      changes: { status: 'archived' },
      key: 'archive-after-retry',
    });
    await assert.rejects(
      withClient(() => retryFailedReply(notice.id, sol)),
      /not active/
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await w.close();
  }
});

// 493c1c7: "New chat" in a DM starts the next generation and keeps the earlier ones, which the DM
// shows above a divider; the out-of-tokens retry is a new chat on another harness that resends.
test("a model-only Buddy profile opens its DM on the model's harness", async () => {
  const w = await world();
  const { server, http } = await ownerHttp(w);
  try {
    const designer = await w.core.createBuddy(OWNER, {
      workspaceId: w.ws,
      slug: 'model-only-designer',
      name: 'Product Designer',
      role: 'Design the product',
      manager: { kind: 'nobody' },
      model: 'claude-opus-5-5',
      key: 'model-only-designer',
    });
    const opened = await http('POST', `/api/buddies/${designer.id}/direct`, {});
    assert.equal(opened.status, 200, JSON.stringify(opened.body));
    const id = (opened.body as unknown as { conversationId: string }).conversationId;
    const conversation = w.conversations.get(id)!;
    assert.equal(conversation.config.provider, 'claude');
    assert.deepEqual(conversation.config.model, { mode: 'explicit', modelId: 'claude-opus-5-5' });
    const reopened = await http('POST', `/api/buddies/${designer.id}/direct`, {});
    assert.equal((reopened.body as unknown as { conversationId: string }).conversationId, id);
    const explicit = await w.core.createBuddy(OWNER, {
      workspaceId: w.ws,
      slug: 'explicit-mismatch',
      name: 'Explicit mismatch',
      role: 'Test explicit harness authority',
      manager: { kind: 'nobody' },
      provider: 'codex',
      model: 'claude-opus-5-5',
      key: 'explicit-mismatch',
    });
    await assert.rejects(w.channels.openDirect(explicit.id), /Model is unavailable for codex/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await w.close();
  }
});

// Fresh-install trial 2026-10-05 (todo_57268f4b): with only Claude installed, the bootstrap's
// Product Dev ran a hardcoded Codex fallback, `spawn codex ENOENT`, and the owner saw an empty
// bubble. An unpinned Buddy now runs what is on PATH, read per open (the first-boot install is
// async), refuses visibly when nothing is, and an owner's pin is never replaced.
// Design: agent_notes/2026-10-05_installed-provider-default-design.md.
test('an unpinned Buddy runs the installed agent; a pinned one never moves', async () => {
  const w = await world();
  const { server, http } = await ownerHttp(w);
  const install = (name: string) =>
    writeFileSync(join(w.agentBin, name), '#!/bin/sh\n', { mode: 0o755 });
  try {
    rmSync(join(w.agentBin, 'codex'));
    const home = await bootstrapUnleashdHome(w.core, w.scratch);
    const upstream = await w.core.openChannel(OWNER, { kind: 'id', id: home.channelId });
    const mention = async (key: string) => {
      const post = await w.post(
        OWNER,
        { kind: 'id', id: upstream.id },
        {
          kind: 'inform',
          body: `[@Product Dev](buddy:${home.productDevId}) status?`,
          evidence: [],
          mentions: [],
          broadcast: false,
          key,
        }
      );
      w.emit({ kind: 'posted', post, channel: upstream });
      return post;
    };
    const dmConfig = async (buddyId: string) => {
      const opened = await http('POST', `/api/buddies/${buddyId}/direct`, {});
      assert.equal(opened.status, 200, JSON.stringify(opened.body));
      const id = (opened.body as unknown as { conversationId: string }).conversationId;
      return { id, config: w.conversations.get(id)!.config };
    };

    // 1. Nothing installed: no spawn, and both entry points say why.
    const refused = await http('POST', `/api/buddies/${home.productDevId}/direct`, {});
    assert.notEqual(refused.status, 200);
    assert.match(JSON.stringify(refused.body), /No agent is installed/);
    const asked = await mention('no-agent');
    const notice = await until(
      async () =>
        (await w.core.listPosts(OWNER, { kind: 'thread', rootId: asked.id }, null, 20)).posts.find(
          (post) => post.purpose === 'reply_failed'
        ),
      'a visible reply_failed notice'
    );
    assert.match(notice.body, /No agent is installed/);
    assert.equal(w.turns.length, 0, 'nothing was spawned');
    // The thread still reads: its seats never consult the profile (it failed every read in the
    // fresh-install trial, "Thread could not refresh: No agent is installed").
    const read = await http('GET', `/api/buddies/posts/${asked.id}/thread`);
    assert.equal(read.status, 200, JSON.stringify(read.body));

    // 2. Claude lands after startup: the next open and the next mention run it, no restart.
    install('claude');
    const productDm = await dmConfig(home.productDevId);
    assert.equal(productDm.config.provider, 'claude');
    await mention('claude-installed');
    await until(() => w.turns.length === 1, 'the mention reply runs');
    assert.equal(w.turns[0].request.harness, 'claude');

    // 3. The owner pins the Release Manager to Codex while only Claude is installed. A bootstrap
    // re-run and an open both keep the pin: it is the owner's, never the install's to replace.
    const pinned = await http('PATCH', `/api/buddies/${home.releaseManagerId}`, {
      provider: 'codex',
      reasoningEffort: 'high',
      key: 'pin-release-manager',
    });
    assert.equal(pinned.status, 200, JSON.stringify(pinned.body));
    await bootstrapUnleashdHome(w.core, w.scratch);
    const manager = await w.core.getBuddy(home.releaseManagerId);
    assert.equal(manager.provider, 'codex');
    assert.equal(manager.reasoningEffort, 'high');
    const managerDm = await dmConfig(home.releaseManagerId);
    assert.equal(managerDm.config.provider, 'codex');
    assert.deepEqual(managerDm.config.reasoning, { mode: 'explicit', effort: 'high' });

    // 4. Codex is installed later: the existing DM keeps the model it ran (owner rule step 1).
    install('codex');
    assert.deepEqual(await dmConfig(home.productDevId), productDm);
  } finally {
    server.close();
    await w.close();
  }
});

test('a DM new chat opens the next generation; the chain keeps every earlier one', async () => {
  const w = await world();
  const { server, http } = await ownerHttp(w);
  try {
    const first = (await w.channels.openDirect(w.lead.id)).conversationId;
    const created = await http('POST', `/api/buddies/${w.lead.id}/direct/new-chat`, {
      key: 'new-direct-chat',
    });
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

// Owner, 2026-10-07 ("stay simple, don't overload DMs"): a schedule fire and the Wake button post
// nothing. 2026-10-06 made each a post in a DM or thread, which the owner did not want.
test('a schedule fire runs silently: one chat run, a background turn, no post anywhere', async () => {
  const w = await world();
  try {
    const schedule = await w.core.putSchedule(OWNER, {
      buddyId: w.lead.id,
      name: 'quiet',
      cron: '0 9 * * *',
      timezone: 'UTC',
      prompt: 'Check the board',
      enabled: true,
      key: 'quiet',
    });
    await w.core.fireSchedule(OWNER, schedule.id);
    w.emit({ kind: 'changed' });
    const [run] = await until(async () => {
      const runs = await w.runs(w.lead.id);
      return runs.length === 1 && runs[0].status === 'complete' && runs;
    }, 'the fire settles');
    assert.equal(run.input.kind, 'chat');
    assert.ok(run.input.kind === 'chat' && run.input.turnId.startsWith(`schedule:${schedule.id}:`));
    assert.match(w.turns[0].request.prompt, /Scheduled run "quiet"[\s\S]*Check the board/);
    const own = await w.core.openChannel(OWNER, {
      kind: 'direct',
      members: [buddyActor(w.lead.id), buddyActor(w.lead.id)],
    });
    for (const channel of [own, w.general])
      assert.deepEqual(
        (await w.core.listPosts(OWNER, { kind: 'channel', channelId: channel.id }, null, 50)).posts,
        [],
        'a fire posts nothing'
      );
  } finally {
    await w.close();
  }
});

test('Wake starts one turn in the Buddy chat and posts nothing to its DM channel', async () => {
  const w = await world();
  const { server, http } = await ownerHttp(w);
  try {
    const woken = await http('POST', `/api/buddies/${w.lead.id}/wake`);
    assert.equal(woken.status, 202, JSON.stringify(woken.body));
    await until(() => w.turns.length === 1, 'the wake turn');
    assert.match(w.turns[0].request.prompt, /Wake-up check/);
    const dm = await w.core.openChannel(OWNER, {
      kind: 'direct',
      members: [OWNER, buddyActor(w.lead.id)],
    });
    assert.deepEqual(
      (await w.core.listPosts(OWNER, { kind: 'channel', channelId: dm.id }, null, 50)).posts,
      [],
      'the instruction lives in the chat, not the DM channel'
    );
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
      enabled: true,
      key: 'daily',
    });
    await w.core.fireSchedule(OWNER, schedule.id);
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
      if (delivered(turn, a().id)) {
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
      enabled: true,
      key: 'sweep',
    });
    await w.core.fireSchedule(OWNER, schedule.id);
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
    const returned = w.turns.find((t) => delivered(t, a().id))!;
    assert.equal(
      returned.request.resumeSessionId,
      'native-1',
      'the answer wakes the spawning call'
    );
  } finally {
    await w.close();
  }
});

// Regression: 0fef9d4 (lean rewrite) dropped `buddy.new_list` and `buddy.retry_run`, and a tool-count
// assertion (13) never noticed which CAPABILITIES went with them. This checks what a worker turn can
// DO, through the real MCP endpoint's tool schemas, so a rewrite that reshapes tools but drops a
// capability fails here by name. Do not replace it with a count.
test('a worker turn can still create channels, search and follow, spawn and retry runs, write tasks and memory', async () => {
  const w = await world();
  try {
    const spec = w.endpoint.spec(
      w.grants.issueBuddy({
        role: 'worker',
        buddyId: w.lead.id,
        workspaceId: w.ws,
        conversationId: 'capability-guard',
        runId: null,
        subscribes: 'self',
      })
    );
    const client = await connect(spec);
    let schemas: Map<string, string>;
    try {
      schemas = new Map(
        (await client.listTools()).tools.map((t) => [t.name, JSON.stringify(t.inputSchema)])
      );
    } finally {
      await client.close();
    }
    const schema = (tool: string) => {
      const found = schemas.get(tool);
      assert.ok(found, `worker lost the ${tool} tool`);
      return found;
    };
    const capabilities: Array<[string, string, RegExp[]]> = [
      ['create a channel', 'channel', [/"create"/, /"name"/, /"purpose"/]],
      ['search by channel and author', 'channel_read', [/"search"/, /"channels"/, /"from"/]],
      ['follow a thread', 'channel_read', [/"follow"/, /"wait"/]],
      ['request a worker on a chosen model', 'post', [/"worker"/, /"request"/, /"answers"/]],
      ['cancel a run', 'runs', [/"cancel"/]],
      ['retry a run on another model', 'runs', [/"retry"/, /"worker"/]],
      ['write a task', 'task_write', [/"changes"|"title"/]],
      ['read memory', 'doc_read', [/"memory"|"working"|"kind"/]],
      ['write memory', 'doc_write', [/"baseRevision"/]],
    ];
    for (const [what, tool, needs] of capabilities)
      for (const need of needs)
        assert.match(schema(tool), need, `worker can no longer ${what}: ${tool} lacks ${need}`);
  } finally {
    await w.close();
  }
});

// A Buddy whose worker failed could only re-ask from scratch once `buddy.retry_run` was dropped.
// End to end through the real runner and MCP endpoint: the worker fails, the failure notice wakes
// the spawner, it retries on another model, and the retry's answer wakes the same conversation.
test('runs retry re-runs a failed worker as attempt 2 on another model and wakes the requester with its answer', async () => {
  const w = await world();
  try {
    const luna = { provider: 'codex', model: 'gpt-6-luna', reasoningEffort: 'low' };
    const sol = { provider: 'codex', model: 'gpt-6-sol' };
    let spawned!: Post;
    const results: Array<{ isError: boolean; text: string }> = [];
    w.during.set(1, async (turn) => {
      const posted = await call(turn.mcp, 'post', {
        channel: { direct: [] },
        kind: 'request',
        body: 'Sweep the repo',
        worker: luna,
        key: 'sweep',
      });
      assert.equal(posted.isError, false, posted.text);
      spawned = posted.value;
    });
    const route = async (turn: Turn) => {
      const prompt = turn.request.prompt;
      if (prompt.includes(`Request ${spawned.id}`)) {
        // Attempt 1 dies on the provider; attempt 2 answers.
        const attempts = w.turns.filter((t) => t.request.prompt.includes(`Request ${spawned.id}`));
        if (attempts.length === 1) return void w.providerErrors.set(turn.n, 'provider fell over');
        const answered = await call(turn.mcp, 'post', {
          answers: spawned.id,
          body: 'Swept',
          key: 'swept',
        });
        assert.equal(answered.isError, false, answered.text);
      } else if (prompt.includes('for this request failed')) {
        const failed = (await w.runs(w.lead.id)).find(
          (r) => r.input.kind === 'post' && r.status === 'failed'
        )!;
        const key = 'retry-sweep';
        const args = { action: { kind: 'retry', runId: failed.id, worker: sol, key } };
        // A run already retried is a typed error, not a silent no-op; the same key replays.
        const first = await call(turn.mcp, 'runs', args);
        const replay = await call(turn.mcp, 'runs', args);
        const stale = await call(turn.mcp, 'runs', {
          action: { kind: 'retry', runId: failed.id, key: 'again' },
        });
        results.push(first, replay, stale);
      }
    };
    for (let n = 2; n <= 6; n++) w.during.set(n, route);

    const schedule = await w.core.putSchedule(OWNER, {
      buddyId: w.lead.id,
      name: 'sweep',
      cron: '0 9 * * *',
      timezone: 'UTC',
      prompt: 'Run the sweep',
      enabled: true,
      key: 'sweep',
    });
    await w.core.fireSchedule(OWNER, schedule.id);
    w.emit({ kind: 'changed' });

    const retried = await until(async () => {
      const run = (await w.runs(w.lead.id)).find((r) => r.input.kind === 'post' && r.attempt === 2);
      return run?.status === 'complete' && run;
    }, 'attempt 2 complete');
    assert.deepEqual(retried.config, sol, 'the retry runs on the model it was moved to');
    const returned = await until(
      () =>
        w.turns.find(
          (t) =>
            t.request.prompt.includes('New posts in threads') && t.request.prompt.includes('Swept')
        ),
      "the requester's wake with the retry's answer"
    );
    assert.equal(
      returned.request.resumeSessionId,
      'native-1',
      'the answer returns to the conversation that asked'
    );
    assert.equal((await w.core.getPost(OWNER, spawned.id)).request.state, 'answered');
    const [first, replay, stale] = results;
    assert.equal(first.isError, false, first.text);
    assert.equal(JSON.parse(first.text).id, JSON.parse(replay.text).id);
    assert.equal(stale.isError, true, 'attempt 1 is no longer the latest');
    const attempts = (await w.runs(w.lead.id)).filter((r) => r.input.kind === 'post');
    assert.deepEqual(attempts.map((r) => r.attempt).sort(), [1, 2]);
  } finally {
    await w.close();
  }
});

// Pattern: fix-guards (docs/patterns.md#fix-guards). 2026-10-01 (task_01a0f7ff-bbd6): a background
// requester read its answer in the turn still running, yet the queued `reply` run stayed to resume
// that turn with the same answer (cancelled by hand 17 minutes later). Reading the answer settles
// the return with no model turn, while the original turn is still running. The unread case is
// "runs retry ... wakes the requester with its answer" above.
test('an answer the requester already read settles its return run with no model turn', async () => {
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
      await until(
        async () => (await w.core.getPost(OWNER, request.id)).request.state === 'answered',
        'the answer while the requester turn runs'
      );
      const read = await call(turn.mcp, 'channel_read', { read: { threadId: request.id } });
      assert.equal(read.isError, false, read.text);
      whileRunning = await w.runs(w.lead.id);
    });
    w.answers.set(2, 'Logo drawn');
    const schedule = await w.core.putSchedule(OWNER, {
      buddyId: w.lead.id,
      name: 'logo',
      cron: '0 9 * * *',
      timezone: 'UTC',
      prompt: 'Get the logo drawn',
      enabled: true,
      key: 'logo',
    });
    await w.core.fireSchedule(OWNER, schedule.id);
    w.emit({ kind: 'changed' });

    const leadRuns = await until(async () => {
      const runs = await w.runs(w.lead.id);
      return (
        runs.length === 2 &&
        runs.every((r) => r.status !== 'queued' && r.status !== 'running') &&
        runs
      );
    }, "the requester's schedule run and its settled return");
    // Newest first: the answer's delivery, then the schedule fire's own run.
    const returned = leadRuns.find((r) => r.input.kind === 'deliver')!;
    assert.equal(returned.status, 'cancelled');
    assert.equal(returned.errorCode, 'consumed');
    assert.equal(
      whileRunning.find((r) => r.input.kind === 'deliver')?.status,
      'cancelled',
      'settled by the read itself, not after the turn ended'
    );
    // Turn 1 is itself the schedule fire's (chat) run; no later turn carries the answer.
    assert.equal(
      w.turns.some((t) => t.request.prompt.includes('Logo drawn')),
      false,
      'no model turn repeated the answer'
    );
  } finally {
    await w.close();
  }
});

/** A PATH of real executables: what the reviewer's harness probe walks (providers/installed-agent). */
function binPath(dir: string, ...names: string[]): NodeJS.ProcessEnv {
  const bin = join(dir, 'review-bin');
  mkdirSync(bin, { recursive: true });
  for (const name of names) writeFileSync(join(bin, name), '#!/bin/sh\n', { mode: 0o755 });
  return { PATH: bin };
}

// The reviewer used to see prose only (tool calls dropped) in a private temp cwd, so it tried to
// verify claims with file tools and the guard killed it (12 failed reviews, 2026-09 audit).
test('the reviewer climbs the ladder on credit exhaustion, sees tool calls, runs in the workspace, and curates memory on the same endpoint', async () => {
  const scratch = tempDir('buddies-review-');
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
    messages: async () => null,
    openBranch: async () => {
      throw new Error('no owner chats in this test');
    },
    portFile: join(scratch, 'buddy-mcp.json'),
  });
  const harnesses: string[] = [];
  const requests: ProviderRequest[] = [];
  let spec!: McpServerSpec;
  const reviewer = createMemoryReviewer({
    core,
    grants,
    spec: endpoint.spec,
    env: binPath(scratch, 'codex'),
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
          // A write that fails (stale revision) must not count on the receipt (core review I3:
          // receipts counted attempted writes, so this one made it 2).
          const stale = await call(spec, 'doc_write', {
            kind: 'working',
            content: 'stale',
            baseRevision: 7,
            reason: 'stale read',
            key: 'w0',
          });
          assert.equal(stale.isError, true, stale.text);
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

// Fresh-install trial 2026-10-05: on a Claude-only machine every turn ended in `spawn codex ENOENT`.
// The owner directs the reviewer model, so a missing harness is a recorded skip, never a swap.
async function reviewOnce(dir: string, env: NodeJS.ProcessEnv) {
  const core = await BuddiesCore.open(join(dir, 'db.sqlite'));
  const ws = (await core.createWorkspace(OWNER, { name: 'Team', rootPath: dir })).id;
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
    uploadsRoot: () => dir,
    messages: async () => null,
    openBranch: async () => {
      throw new Error('no owner chats in this test');
    },
    portFile: join(dir, 'buddy-mcp.json'),
  });
  const launches: Array<{ harness: string; model: string }> = [];
  const reviewer = createMemoryReviewer({
    core,
    grants,
    spec: endpoint.spec,
    env,
    logger: { warn: () => undefined },
    execute: ((request: ProviderRequest) => {
      launches.push({ harness: request.harness, model: request.model! });
      const spec = request.mcpServers!.unleashd_memory;
      const completed = (async () => {
        await call(spec, 'doc_read', { kind: 'working' });
        return { exitCode: 0, signal: null, sessionId: 's', reason: 'success' };
      })();
      return {
        child: { exitCode: 0 },
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
      messages: [{ role: 'user', body: { t: 'text', text: 'hello' } }],
    });
    const receipt = await until(
      async () =>
        (await core.listEvents(lead.id, Number.MAX_SAFE_INTEGER, 20)).find(
          (e) => e.op === 'memory_review'
        ),
      'the review receipt'
    );
    return { launches, receipt: JSON.parse(receipt.payload) };
  } finally {
    reviewer.stop();
    await endpoint.close();
  }
}

test('a reviewer whose harness is not installed records a skip and spawns nothing', async () => {
  const scratch = tempDir('buddies-review-claude-only-');
  try {
    const { launches, receipt } = await reviewOnce(scratch, binPath(scratch, 'claude'));
    assert.deepEqual(launches, []);
    assert.equal(receipt.status, 'skipped');
    assert.deepEqual(receipt.skipReason, { kind: 'harness_missing', harness: 'codex' });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('a reviewer on a codex install still runs the owner-directed gpt-6-luna', async () => {
  const scratch = tempDir('buddies-review-codex-');
  try {
    const { launches, receipt } = await reviewOnce(scratch, binPath(scratch, 'codex', 'claude'));
    assert.deepEqual(launches, [{ harness: 'codex', model: 'gpt-6-luna' }]);
    assert.equal(receipt.status, 'complete');
  } finally {
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
    env: { PATH: w.agentBin },
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
  const scratch = tempDir('buddies-review-timeout-');
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
    messages: async () => null,
    openBranch: async () => {
      throw new Error('no owner chats in this test');
    },
    portFile: join(scratch, 'buddy-mcp.json'),
  });
  const reviewer = createMemoryReviewer({
    core,
    grants,
    spec: endpoint.spec,
    timeoutMs: 200,
    env: binPath(scratch, 'codex'),
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
  const scratch = tempDir('buddies-location-');
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
  const scratch = tempDir('buddies-location-');
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
  const scratch = tempDir('buddies-location-');
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
  const scratch = tempDir('buddies-carry-');
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
    messages: async () => null,
    openBranch: async () => {
      throw new Error('no owner chats in this test');
    },
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
    env: binPath(scratch, 'codex'),
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

    const next = await composeBriefing(core, chat('chat-B'), { kind: 'agent', provider: 'codex' });
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

// F2 (agent_notes/2026-10-06_ceo-feedback-retrospective.md): CEO feedback said workers answered
// with prose and no progress. The nudge lives in the briefing, so it must reach a WORKER's turn.
test('a spawned worker is told to post progress notes and answer with evidence paths', async () => {
  const w = await world();
  try {
    const worker = { provider: 'codex', model: 'gpt-6-luna', reasoningEffort: 'low' };
    w.during.set(1, async (turn) => {
      const posted = await call(turn.mcp, 'post', {
        channel: { direct: [] },
        kind: 'request',
        body: 'Sweep progress-line',
        worker,
        key: 'progress-line',
      });
      assert.equal(posted.isError, false, posted.text);
    });
    const schedule = await w.core.putSchedule(OWNER, {
      buddyId: w.lead.id,
      name: 'progress-line',
      cron: '0 9 * * *',
      timezone: 'UTC',
      prompt: 'Spawn one worker',
      enabled: true,
      key: 'progress-line',
    });
    await w.core.fireSchedule(OWNER, schedule.id);
    w.emit({ kind: 'changed' });
    const turn = await until(
      () => w.turns.find((t) => t.request.prompt.includes('Sweep progress-line')),
      'the worker turn'
    );
    assert.match(turn.request.prompt, /progress note on the Task at each milestone/);
    assert.match(turn.request.prompt, /evidence paths/);
  } finally {
    await w.close();
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
    const before = await composeBriefing(w.core, context, { kind: 'agent', provider: 'codex' });
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

// Owner decision 2026-10-07 (items 6-8): in a public or task thread a participant that follows no
// conversation there is asked one yes/no question per new post before it gets a turn. Through the
// real crate, runner and channels: only the model call is scripted.
test('a thread follow-up is gated: <no> runs no turn, <yes> replies in the seat, a mention skips the gate', async () => {
  const w = await world();
  try {
    const say = async (body: string, replyToId?: string) => {
      const post = await w.post(
        OWNER,
        { kind: 'id', id: w.general.id },
        { kind: 'inform', body, replyToId, evidence: [], mentions: [], broadcast: false, key: body }
      );
      w.announce(post);
      return post;
    };
    const thread = async (rootId: string) =>
      (await w.core.listPosts(OWNER, { kind: 'thread', rootId }, null, 50)).posts.reverse();
    const lead = (await w.core.listBuddies(w.ws)).find((b) => b.id === w.lead.id)!;
    w.answers.set(1, 'Shipped');
    const root = await say(`[@Lead](buddy:${lead.id}) status?`);
    await until(async () => (await thread(root.id)).length === 1, 'the mention reply');
    assert.deepEqual(w.gate.asked, [], 'a mention is never gated');

    // <no>: the gate is asked and no turn starts.
    w.gate.verdicts.push({ kind: 'pass' });
    const quiet = await say('thanks, nice', root.id);
    await until(async () => w.gate.asked.length === 1, 'the gate was asked');
    const turnsBefore = w.turns.length;
    const passed = await until(
      async () =>
        (await w.runs(lead.id)).find(
          (r) =>
            r.input.kind === 'deliver' && r.input.postId === quiet.id && r.status === 'cancelled'
        ),
      'the gated run settles with no turn'
    );
    assert.equal(w.turns.length, turnsBefore, 'a <no> starts no turn');
    assert.match(w.gate.asked[0], /Should you respond/);
    assert.ok(passed);

    // <yes>: the seat answers, and posting did not subscribe it (the next post is gated again).
    w.gate.verdicts.push({ kind: 'respond' });
    w.answers.set(2, 'On it');
    await say('Lead, what is the ETA?', root.id);
    await until(
      async () => (await thread(root.id)).some((p) => p.body === 'On it'),
      'the follow-up reply'
    );
    assert.equal(w.gate.asked.length, 2);
    w.gate.verdicts.push({ kind: 'pass' });
    await say('ok', root.id);
    await until(
      async () => w.gate.asked.length === 3,
      'a seat that posted is still gated, not subscribed'
    );

    // A gate that cannot decide is a visible notice, never silence.
    w.gate.verdicts.push({ kind: 'failed', reason: 'no answer' });
    await say('and the budget?', root.id);
    const notice = await until(
      async () => (await thread(root.id)).find((p) => p.purpose === 'reply_failed'),
      'the gate failure notice'
    );
    assert.match(notice.body, /could not decide whether to reply/);
  } finally {
    await w.close();
  }
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
    env: { PATH: w.agentBin },
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
test('an owner reply in a DM thread wakes the Buddy; its own inform wakes nobody and the owner’s answer is delivered', async () => {
  const w = await world();
  try {
    const dm = { kind: 'direct' as const, members: [buddyActor(w.lead.id), OWNER] };
    const announce = async (post: Post) =>
      w.emit({
        kind: 'posted',
        post,
        channel: await w.core.openChannel(OWNER, { kind: 'id', id: post.channelId }),
      });
    const thread = async (rootId: string) =>
      (await w.core.listPosts(OWNER, { kind: 'thread', rootId }, null, 50)).posts.reverse();
    const turnsAbout = (text: RegExp) => w.turns.filter((turn) => text.test(turn.request.prompt));
    const directTurns = () => turnsAbout(/what's next/);
    const ask = await w.post(buddyActor(w.lead.id), dm, {
      kind: 'request',
      body: 'Approve the plan?',
      evidence: [],
      mentions: [],
      broadcast: false,
      key: 'ask',
    });
    await announce(ask);
    const nudge = await w.post(OWNER, dm, {
      kind: 'inform',
      body: "what's next?",
      replyToId: ask.id,
      evidence: [],
      mentions: [],
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
    await until(
      async () => (await w.channels.responding(ask.channelId)).length === 0,
      'the turn ends'
    );

    await announce(
      await w.post(buddyActor(w.lead.id), dm, {
        kind: 'inform',
        body: 'FYI',
        replyToId: ask.id,
        evidence: [],
        mentions: [],
        broadcast: false,
        key: 'fyi',
      })
    );
    await announce(
      await w.core.answer(OWNER, { requestId: ask.id, body: 'Approved', evidence: [], key: 'yes' })
    );
    // Step 5: the owner's answer reaches the conversation that asked (the seat the nudge opened),
    // as a delivery. Lead's own inform wakes nobody: a Buddy's post is never delivered to itself.
    await until(
      () => turnsAbout(/Approved/).length === 1,
      'the answer is delivered to the conversation that follows the thread'
    );
    assert.equal(directTurns().length, 1, 'no second reply to the nudge');
    assert.equal(turnsAbout(/FYI/).length, 0, 'a Buddy inform starts no DM reply');
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
      subscribes: 'self',
    });
    const mention = {
      channel: { id: w.general.id },
      body: `[@Designer](buddy:${w.designer.id}) the banner, please`,
      key: 'retried-call',
    };
    // Designer says nothing: an answer would be delivered to Lead's conversation (it posted the
    // mention, so it follows the thread), and that second turn is not what this test counts.
    w.silent.add(1);
    const first = await call(w.endpoint.spec(grant), 'post', mention);
    await until(() => w.turns.length === 1, "Designer's turn");
    // Retry once that turn is over: the replayed key writes no post, so it wakes nobody.
    await until(
      async () => (await w.channels.responding(w.general.id)).length === 0,
      'the turn ends'
    );
    const again = await call(w.endpoint.spec(grant), 'post', mention);
    assert.equal(again.value.id, first.value.id, 'the replay returns the first post');
    // A second turn would open the seat first: give it well over that.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.equal(w.turns.length, 1, 'the replay started no second turn');
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
  registerFilesystemRoutes(app, {
    uploadsDirectory: join(w.scratch, 'uploads'),
    isUnderKnownProject: () => false,
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
  // Resolve browser-relative URLs onto this real HTTP server. No response is mocked.
  const withClient = async <T>(work: () => Promise<T>): Promise<T> => {
    const original = globalThis.fetch;
    globalThis.fetch = (input, init) =>
      original(typeof input === 'string' && input.startsWith('/api/') ? base + input : input, init);
    try {
      return await work();
    } finally {
      globalThis.fetch = original;
    }
  };
  return { server, http, withClient, builderDirectories };
}

test('client Buddy JSON mutations use the server contracts; task reorder reaches the store', async () => {
  const w = await world();
  const { server, http, withClient } = await ownerHttp(w);
  try {
    await withClient(async () => {
      const workspace = await buddyWrite('workspace.create', {}, { rootPath: w.scratch });
      assert.equal(workspace.rootPath, realpathSync(w.scratch));
      assert.equal(
        (await buddyWrite('workspace.create', {}, { rootPath: w.scratch })).id,
        workspace.id
      );
      const builder = await buddyWrite('builder.open', {}, { workspaceId: w.ws });
      assert.equal(builder.conversationId, 'builder');
      const buddy = await buddyWrite(
        'buddy.create',
        {},
        {
          workspaceId: w.ws,
          slug: 'contract',
          name: 'Contract',
          role: 'Check requests',
        }
      );
      const updated = await buddyWrite(
        'buddy.update',
        { buddyId: buddy.id },
        {
          model: 'gpt-6.1-sol',
          provider: 'codex',
          reasoningEffort: null,
        }
      );
      assert.equal(updated.model, 'gpt-6.1-sol');
      assert.equal(updated.reasoningEffort, undefined);
      const first = await buddyWrite(
        'task.create',
        {},
        {
          ownerId: w.lead.id,
          title: 'First',
          doneCriteria: 'First done',
          key: undefined,
        }
      );
      const second = await buddyWrite(
        'task.create',
        {},
        {
          ownerId: w.lead.id,
          title: 'Second',
          doneCriteria: 'Second done',
        }
      );
      await reorderTasks([first, second], 1, -1);
      assert.equal((await w.core.getTask(first.id)).position, 1);
      assert.equal((await w.core.getTask(second.id)).position, 0);

      const doc = await buddyWrite(
        'doc.write',
        { buddyId: buddy.id, kind: 'soul' },
        {
          content: 'Contract soul',
          baseRevision: 0,
          reason: 'Contract test',
        }
      );
      assert.equal(doc.content, 'Contract soul');
      const schedule = await buddyWrite(
        'schedule.create',
        { buddyId: w.lead.id },
        {
          taskId: first.id,
          name: 'Check',
          cron: '0 9 * * *',
          timezone: 'UTC',
          prompt: 'Check',
          enabled: false,
        }
      );
      const saved = await buddyWrite(
        'schedule.update',
        { buddyId: w.lead.id, scheduleId: schedule.id },
        {
          ...scheduleFieldsOf(schedule),
          name: 'Updated',
        }
      );
      assert.equal(saved.name, 'Updated');
      assert.equal(saved.taskId, first.id, 'editing a linked schedule preserves its Task');
      const channel = await buddyWrite(
        'channel.create',
        { workspaceId: w.ws },
        {
          name: 'contract',
          purpose: 'Check HTTP contracts',
        }
      );
      const post = await buddyWrite(
        'channel.post',
        { channelId: channel.id },
        {
          body: 'Hello',
          key: 'contract-post',
        }
      );
      const replay = await buddyWrite(
        'channel.post',
        { channelId: channel.id },
        {
          body: 'Hello',
          key: 'contract-post',
        }
      );
      assert.equal(replay.post.id, post.post.id, 'the client preserves caller keys');
      await buddyWrite('read', {}, { channelId: channel.id, postId: post.post.id });
      await buddyWrite('read', {}, { rootId: post.post.id, postId: post.post.id });
      const renamed = await buddyWrite(
        'channel.rename',
        { channelId: channel.id },
        { name: 'renamed' }
      );
      assert.equal(renamed.kind.type === 'public' && renamed.kind.name, 'renamed');
      await buddyWrite('channel.archive', { channelId: channel.id }, { archived: true });
      // A variable with extra fields passes TS structural assignability; strict shared parsing
      // refuses it before a request can mutate the store.
      const badChanges = { position: 2, task: first };
      await assert.rejects(
        buddyWrite(
          'task.update',
          { taskId: first.id },
          {
            baseRevision: 2,
            changes: badChanges,
          }
        ),
        /Unrecognized key.*task/
      );
      assert.equal((await w.core.getTask(first.id)).position, 1);
      const malformed = await http('PATCH', `/api/buddies/tasks/${first.id}`, {
        baseRevision: 2,
        changes: badChanges,
        key: 'malformed-changes',
      });
      assert.equal(malformed.status, 400);
      assert.match(malformed.body.error, /Unrecognized key.*task/);
      const direct = await buddyWrite('direct.open', { buddyId: buddy.id });
      const next = await buddyWrite('direct.new', { buddyId: buddy.id }, {});
      assert.notEqual(next.conversationId, direct.conversationId);
      const archived = await buddyWrite('buddy.archive', { buddyId: buddy.id });
      assert.equal(archived.status, 'archived');
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await w.close();
  }
});

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
      {
        kind: 'request',
        body: 'May I deploy?',
        evidence: [],
        mentions: [],
        broadcast: false,
        key: 'ask',
      }
    );
    const inbox = await http('GET', `/api/buddies/workspaces/${w.ws}/inbox`);
    assert.deepEqual(
      inbox.body.requests.map((p: Post) => p.id),
      [ask.id]
    );
    const answered = await http('POST', `/api/buddies/channels/${ask.channelId}/posts`, {
      body: 'Yes',
      answers: ask.id,
      key: 'yes',
    });
    assert.equal(answered.status, 201, JSON.stringify(answered.body));
    assert.equal((await w.core.getPost(OWNER, ask.id)).request.state, 'answered');
    const again = await http('POST', `/api/buddies/channels/${ask.channelId}/posts`, {
      body: 'Yes again',
      answers: ask.id,
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
      (found.body as unknown as { posts: Post[] }).posts.map((post) => post.id),
      [written.post.id]
    );
    // Fuzzy matching, @author and channel-name rows, through the real route.
    type Found = { posts: Post[]; channels: Array<{ id: string }> };
    const byAuthor = await http(
      'GET',
      `/api/buddies/workspaces/${w.ws}/search?q=${encodeURIComponent('@Designer logos')}`
    );
    assert.deepEqual(
      (byAuthor.body as unknown as Found).posts.map((post) => post.id),
      [written.post.id],
      '@Name filters to the author, and "logos" reaches "logo" by stem'
    );
    const authorOnly = await http(
      'GET',
      `/api/buddies/workspaces/${w.ws}/search?q=${encodeURIComponent('@designer')}`
    );
    assert.ok(
      (authorOnly.body as unknown as Found).posts.some((post) => post.id === written.post.id)
    );
    const unknownAuthor = await http(
      'GET',
      `/api/buddies/workspaces/${w.ws}/search?q=${encodeURIComponent('@Nobody logo')}`
    );
    assert.equal(unknownAuthor.status, 400);
    assert.match(unknownAuthor.body.error, /no Buddy named "Nobody"/);
    const named = await http('GET', `/api/buddies/workspaces/${w.ws}/search?q=gener`);
    assert.deepEqual(
      (named.body as unknown as Found).channels.map((c) => c.id),
      [w.general.id],
      'a channel the words name leads the results'
    );
    const grant = w.grants.issueBuddy({
      role: 'worker',
      buddyId: w.lead.id,
      workspaceId: w.ws,
      conversationId: 'c',
      runId: null,
      subscribes: 'self',
    });
    const searched = await call(w.endpoint.spec(grant), 'channel_read', {
      read: { search: { text: 'quarterly' } },
    });
    assert.deepEqual(
      searched.value.posts.map((post: Post) => post.id),
      [written.post.id]
    );
    // Search pages like a channel: `before` once went unforwarded, so a Buddy saw only the
    // newest hits forever (2026-09-27). Nothing older than the only hit remains.
    const older = await call(w.endpoint.spec(grant), 'channel_read', {
      read: { search: { text: 'quarterly' } },
      before: { ord: written.post.ord },
    });
    assert.deepEqual(older.value.posts, []);
    // Typed filters and a typed error cross the real MCP boundary: a malformed query is refused
    // loudly, never matched as literal words (the old behaviour).
    const byDesigner = await call(w.endpoint.spec(grant), 'channel_read', {
      read: {
        search: { text: '"quarterly logo" -draft', from: [w.designer.id], after: '2020-01-01' },
      },
    });
    assert.deepEqual(
      byDesigner.value.posts.map((post: Post) => post.id),
      [written.post.id]
    );
    const byOwner = await call(w.endpoint.spec(grant), 'channel_read', {
      read: { search: { text: 'quarterly', from: ['owner'] } },
    });
    assert.deepEqual(byOwner.value.posts, []);
    const malformed = await call(w.endpoint.spec(grant), 'channel_read', {
      read: { search: { text: '"quarterly' } },
    });
    assert.equal(malformed.isError, true);
    assert.match(malformed.text, /unclosed quote/);

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
        subscribes: 'self',
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
        {
          kind: 'inform',
          body,
          replyToId,
          taskId,
          evidence: [],
          mentions: [],
          broadcast: false,
          key: body,
        }
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
    await json('POST', '/api/buddies/read', { channelId: w.general.id, postId: replies[1].id });
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
      {
        kind: 'inform',
        body: 'Thread root',
        evidence: [],
        mentions: [],
        broadcast: false,
        key: 'broadcast-root',
      }
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
        mentions: [],
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
        mentions: [],
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
      subscribes: 'self',
    });
    const archived = await call(w.endpoint.spec(grant), 'channel', {
      action: { kind: 'archive', channelId: w.general.id },
      key: 'archive',
    });
    assert.equal(archived.isError, false, archived.text);
    assert.ok(archived.value.archivedAt);
    const listed = await http('GET', `/api/buddies/workspaces/${w.ws}/channels?archived=1`);
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
    const restored = await call(w.endpoint.spec(grant), 'channel', {
      action: { kind: 'restore', channelId: w.general.id },
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
        mentions: [],
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
      subscribes: 'self',
    });
    const renamed = await call(w.endpoint.spec(grant), 'channel', {
      action: { kind: 'rename', name: 'features', channelId: w.general.id },
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

// Regression: 0fef9d4 (lean rewrite) dropped buddy.new_list, so no Buddy turn could create a channel.
test('Buddy MCP creates a channel, posts in it, and a replayed key returns the same channel', async () => {
  const w = await world();
  const { server, http } = await ownerHttp(w);
  try {
    const grant = w.grants.issueBuddy({
      role: 'worker',
      buddyId: w.lead.id,
      workspaceId: w.ws,
      conversationId: 'create-channel-test',
      runId: null,
      subscribes: 'self',
    });
    const spec = w.endpoint.spec(grant);
    const input = { name: 'launch-prep', purpose: 'Launch checklist', key: 'mk-launch' };
    const created = await call(spec, 'channel', {
      action: { kind: 'create', name: input.name, purpose: input.purpose },
      key: input.key,
    });
    assert.equal(created.isError, false, created.text);
    assert.equal(created.value.kind.name, 'launch-prep');
    const replay = await call(spec, 'channel', {
      action: { kind: 'create', name: input.name, purpose: input.purpose },
      key: input.key,
    });
    assert.equal(replay.value.id, created.value.id);

    const posted = await call(spec, 'post', {
      channel: { id: created.value.id },
      body: 'First post',
      key: 'first',
    });
    assert.equal(posted.isError, false, posted.text);
    const owner = await http('GET', `/api/buddies/channels/${created.value.id}`);
    assert.equal(owner.status, 200);
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
        mentions: [],
        broadcast: false,
        key: 'task-mention',
      }
    );
    w.answers.set(1, 'Task reviewed');
    w.emit({
      kind: 'posted',
      post: root,
      channel: await w.core.openChannel(OWNER, { kind: 'id', id: root.channelId }),
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

// Thread follows (2026-10-04, crates/unleashd-buddies/src/follows.rs). Before them a worker waiting
// on someone else's work in a thread had no wake: posts start only mentions and gated participants,
// and the gate's in-memory pairs die with the backend.
type World = Awaited<ReturnType<typeof world>>;

/** A delivery turn (runner.ts `deliveryPrompt`) that shows a post of the thread rooted at `rootId`. */
const delivered = (turn: { request: { prompt: string } }, rootId: string) =>
  turn.request.prompt.includes('New posts in threads') &&
  turn.request.prompt.includes(`thread ${rootId}`);

/** A Buddy's own tool endpoint, as its turn would hold it. */
const asBuddy = (w: World, buddyId: string) =>
  w.endpoint.spec(
    w.grants.issueBuddy({
      role: 'worker',
      buddyId,
      workspaceId: w.ws,
      conversationId: `elsewhere-${buddyId}`,
      runId: null,
      subscribes: 'self',
    })
  );

type ToolCall = Awaited<ReturnType<typeof call>>;

/**
 * Lead's scheduled (background) turn 1 starts a thread, runs `before(rootId)` (other Buddies'
 * posts), then reads it with `follow` (a subscription plus a bounded wait, delivery design Task 3),
 * and `after(read)` runs inside the same turn. Resolves once turn 1's run completed.
 */
async function leadFollows(
  w: World,
  follow: unknown,
  hooks: {
    before?: (rootId: string, turn: Turn) => Promise<void>;
    during?: (rootId: string) => Promise<void>;
    after?: (rootId: string, turn: Turn) => Promise<void>;
  } = {}
): Promise<{ rootId: string; read: ToolCall; ms: number }> {
  const out = { rootId: '', read: null as unknown as ToolCall, ms: 0 };
  w.during.set(1, async (turn) => {
    const root = await call(turn.mcp, 'post', {
      channel: { id: w.general.id },
      body: 'Designer, send the mockups when ready',
      key: 'ask-mockups',
    });
    await hooks.before?.(root.value.id, turn);
    const started = Date.now();
    const [read] = await Promise.all([
      call(turn.mcp, 'channel_read', { read: { threadId: root.value.id, follow } }),
      hooks.during?.(root.value.id),
    ]);
    assert.equal(read.isError, false, read.text);
    Object.assign(out, { rootId: root.value.id, read, ms: Date.now() - started });
    await hooks.after?.(root.value.id, turn);
  });
  const schedule = await w.core.putSchedule(OWNER, {
    buddyId: w.lead.id,
    name: 'mockups',
    cron: '0 9 * * *',
    timezone: 'UTC',
    prompt: 'Get the mockups',
    enabled: true,
    key: 'mockups',
  });
  await w.core.fireSchedule(OWNER, schedule.id);
  w.emit({ kind: 'changed' });
  await until(
    async () => out.rootId && (await w.runs(w.lead.id)).at(-1)?.status === 'complete',
    "Lead's following turn ends"
  );
  return out;
}

const designerReplies = (w: World, rootId: string, body: string) =>
  call(asBuddy(w, w.designer.id), 'post', {
    channel: { id: w.general.id },
    replyToId: rootId,
    body,
    key: body,
  });
/** Lead's deliveries; its scheduled turn (a silent chat run) is not one. */
const deliveries = async (w: World) =>
  (await w.runs(w.lead.id)).filter((r) => r.input.kind === 'deliver');

test('follow (a): posts the caller has not read come back at once', async () => {
  const w = await world();
  try {
    const { read, ms } = await leadFollows(
      w,
      {},
      {
        before: async (rootId) => {
          assert.equal((await designerReplies(w, rootId, 'Mockups v1 attached')).isError, false);
        },
      }
    );
    assert.equal(read.value.kind, 'unread', read.text);
    assert.deepEqual(
      read.value.posts.map((p: { body: string }) => p.body),
      ['Mockups v1 attached'],
      'only the post Lead had not read: not its own root'
    );
    assert.ok(ms < FOLLOW_GRACE_MS, `returned without the wait (${ms} ms)`);
    // Lead's own root subscribes nothing in a public thread (owner decision 2026-10-07), so the
    // designer's post is a gate-bound follow-up for Lead, and the scripted gate says no: no model
    // turn, and the follow still returned the post. (The read fence is the crate's own test.)
    assert.deepEqual(
      (await deliveries(w)).map((r) => [r.conversationId ?? null, r.error]),
      [[null, 'the follow-up gate said no']],
      'posted before the follow: gated, not run'
    );
  } finally {
    await w.close();
  }
});

test('follow (b): a post inside the wait comes back inline and its delivery is consumed', async () => {
  const w = await world();
  try {
    const { read } = await leadFollows(
      w,
      {},
      {
        during: async (rootId) => {
          await new Promise((resolve) => setTimeout(resolve, FOLLOW_GRACE_MS / 4));
          assert.equal((await designerReplies(w, rootId, 'Chiming in quickly')).isError, false);
        },
      }
    );
    assert.equal(read.value.kind, 'unread', read.text);
    assert.deepEqual(
      read.value.posts.map((p: { body: string }) => p.body),
      ['Chiming in quickly']
    );
    const [delivery] = await until(async () => {
      const found = await deliveries(w);
      return found.length === 1 && found[0].status === 'cancelled' && found;
    }, 'the inline post fenced its delivery');
    assert.equal(delivery.errorCode, 'consumed');
    assert.equal(w.turns.length, 1, 'and no second turn repeats it');
  } finally {
    await w.close();
  }
});

test('follow (c): a post after the wait is delivered to the conversation that followed, not a gated reply', async () => {
  const w = await world();
  try {
    const { rootId, read, ms } = await leadFollows(w, {});
    assert.equal(read.value.kind, 'subscribed', read.text);
    assert.deepEqual(read.value.posts, []);
    assert.ok(ms >= FOLLOW_GRACE_MS - 50, `held the read open for the default wait (${ms} ms)`);
    // The delivered turn does not reply, so a gate call could only be one asking Lead.
    w.silent.add(2);
    assert.equal((await designerReplies(w, rootId, 'Mockups are in /tmp/mockups')).isError, false);
    const woken = await until(() => w.turns[1], 'Lead woken by the delivery');
    assert.match(woken.request.prompt, /New posts in threads you follow/);
    assert.match(woken.request.prompt, /Mockups are in \/tmp\/mockups/);
    assert.doesNotMatch(woken.request.prompt, /send the mockups when ready/, 'only unread posts');
    assert.equal(
      woken.request.resumeSessionId,
      'native-1',
      'it resumes the conversation that followed'
    );
  } finally {
    await w.close();
  }
});

test("follow (c, mid-turn): a post during the follower's own turn is delivered only once that turn ends", async () => {
  const w = await world();
  try {
    let postedAt = 0;
    await leadFollows(
      w,
      {},
      {
        after: async (rootId) => {
          assert.equal((await designerReplies(w, rootId, 'Already done')).isError, false);
          postedAt = w.turns.length;
          // Still inside turn 1: the delivery must wait, never run beside it.
          await new Promise((resolve) => setTimeout(resolve, 300));
          assert.equal(w.turns.length, 1, 'no concurrent turn in the busy conversation');
        },
      }
    );
    assert.equal(postedAt, 1);
    const woken = await until(() => w.turns[1], 'Lead woken after its turn');
    assert.match(woken.request.prompt, /Already done/);
    assert.equal(woken.request.resumeSessionId, 'native-1');
  } finally {
    await w.close();
  }
});

test('follow (d): a delivery whose posts the caller already read settles with no turn', async () => {
  const w = await world();
  try {
    await leadFollows(
      w,
      {},
      {
        after: async (rootId, turn) => {
          assert.equal((await designerReplies(w, rootId, 'Read me yourself')).isError, false);
          const plain = await call(turn.mcp, 'channel_read', { read: { threadId: rootId } });
          assert.equal(plain.isError, false, plain.text);
        },
      }
    );
    const [settled] = await until(async () => {
      const found = await deliveries(w);
      return found.length === 1 && found[0].status !== 'queued' && found;
    }, 'the delivery settles');
    assert.equal(settled.status, 'cancelled');
    assert.match(settled.error ?? '', /already read/);
    assert.equal(w.turns.length, 1, 'no model turn for posts already read');
  } finally {
    await w.close();
  }
});

// Delivery design Task 3 criterion: the bounded wait is real, up to 30 s (owner, "wait for a
// message in thread"). 25 s of wait, a post at 20 s: returned inline, no extra turn.
test('follow (g): a 25 s wait returns a post that arrives at 20 s', async () => {
  const w = await world();
  try {
    const { read, ms } = await leadFollows(
      w,
      { wait: 25 },
      {
        during: async (rootId) => {
          await new Promise((resolve) => setTimeout(resolve, 20_000));
          assert.equal((await designerReplies(w, rootId, 'Twenty seconds in')).isError, false);
        },
      }
    );
    assert.equal(read.value.kind, 'unread', read.text);
    assert.deepEqual(
      read.value.posts.map((p: { body: string }) => p.body),
      ['Twenty seconds in']
    );
    assert.ok(ms >= 19_900 && ms < 25_000, `returned when the post arrived (${ms} ms)`);
  } finally {
    await w.close();
  }
});

test('follow (h): follow:false unsubscribes, so later posts are not delivered', async () => {
  const w = await world();
  try {
    await leadFollows(
      w,
      { wait: 0 },
      {
        after: async (rootId, turn) => {
          const off = await call(turn.mcp, 'channel_read', {
            read: { threadId: rootId, follow: false },
          });
          assert.equal(off.value.kind, 'unsubscribed', off.text);
        },
      }
    );
    const root = (
      await w.core.listPosts(OWNER, { kind: 'channel', channelId: w.general.id }, null, 5)
    ).posts[0];
    assert.equal((await designerReplies(w, root.id, 'Nobody is listening')).isError, false);
    await new Promise((resolve) => setTimeout(resolve, 600));
    // Not delivered to the unsubscribed conversation: Lead (a participant) is only asked the gate.
    assert.deepEqual(
      (await deliveries(w)).map((r) => [r.conversationId ?? null, r.error]),
      [[null, 'the follow-up gate said no']]
    );
    assert.equal(w.turns.length, 1);
  } finally {
    await w.close();
  }
});

// The subscription is durable (a `thread_read` row), so a restart loses nothing: the next post is
// delivered even though the conversation that followed is not loaded in the new process, which
// takes the fresh-turn fallback (runner.ts `deliverJob`).
test('follow (f): a subscription survives a backend restart and still delivers the next post', async () => {
  const before = await world();
  const { rootId, read } = await leadFollows(before, { wait: 0 });
  assert.equal(read.value.kind, 'subscribed', read.text);
  await before.stop();
  const w = await world(before.scratch);
  try {
    assert.equal((await designerReplies(w, rootId, 'Mockups after the restart')).isError, false);
    const woken = await until(() => w.turns[0], 'Lead woken after the restart');
    assert.match(woken.request.prompt, /Mockups after the restart/);
  } finally {
    await w.close();
  }
});

// Fix-guard: the slim read surface (Step 7, decision S1). Until 2026-10-06 `tasks get` returned
// 60-95k chars (20 full comments + every child + uncapped evidence), `inbox` carried each owed
// request's full body and `runs list` rows could not say what a run was for. The raw crate reads
// below ARE the old tool results, so the printed SIZES line is a before/after on one seeded store.
test('slim read surface: tasks get, inbox and runs list stay small and runs say what they are for', async () => {
  const w = await world();
  try {
    w.runner.stop();
    const task = await w.core.upsertTask(OWNER, {
      kind: 'create',
      ownerId: w.designer.id,
      title: 'Big task',
      doneCriteria: 'Read it cheaply',
      key: 'slim-task',
    });
    for (let i = 0; i < 12; i++)
      await w.core.upsertTask(OWNER, {
        kind: 'create',
        ownerId: w.designer.id,
        parentId: task.id,
        title: `Child ${i}`,
        doneCriteria: 'x'.repeat(2000),
        key: `slim-child-${i}`,
      });
    const withEvidence = await w.core.upsertTask(OWNER, {
      kind: 'update',
      taskId: task.id,
      baseRevision: task.revision,
      changes: { evidence: Array.from({ length: 32 }, (_, i) => `${i}:${'e'.repeat(495)}`) },
      key: 'slim-evidence',
    });
    for (let i = 0; i < 20; i++)
      await w.post(
        buddyActor(w.lead.id),
        { kind: 'task', taskId: task.id },
        {
          kind: 'inform',
          body: 'c'.repeat(5000),
          evidence: [],
          mentions: [],
          broadcast: false,
          key: `slim-c-${i}`,
        }
      );
    for (let i = 0; i < 6; i++)
      await w.post(
        buddyActor(w.lead.id),
        { kind: 'direct', members: [buddyActor(w.lead.id), buddyActor(w.designer.id)] },
        {
          kind: 'request',
          body: 'r'.repeat(20_000),
          purpose: `Purpose ${i}`,
          taskId: task.id,
          evidence: [],
          mentions: [],
          broadcast: false,
          key: `slim-req-${i}`,
        }
      );
    const spec = w.endpoint.spec(
      w.grants.issueBuddy({
        role: 'worker',
        buddyId: w.designer.id,
        workspaceId: w.ws,
        conversationId: 'slim-view',
        runId: null,
        subscribes: 'self',
      })
    );
    const size = (value: unknown) => JSON.stringify(value).length;

    const got = await call(spec, 'tasks', { action: { kind: 'get', taskId: task.id } });
    const oldGet = await taskDetail(w.core, buddyActor(w.designer.id), task.id, 20);
    const inbox = await call(spec, 'inbox', {});
    const oldInbox = await w.core.inbox(buddyActor(w.designer.id), w.ws);
    const runs = await call(spec, 'runs', { action: { kind: 'list', scope: { workspace: w.ws } } });
    const oldRuns = await w.core.listRunRows(OWNER, { kind: 'workspace', workspaceId: w.ws }, 101);
    console.log(
      `SIZES tasks.get ${size(oldGet)} -> ${size(got.value)}; inbox ${size(oldInbox)} -> ${size(inbox.value)}; runs.list ${size(oldRuns)} -> ${size(runs.value)}`
    );

    // Worst case by construction: the evidence cap alone allows 16k, the 20 previews about 8k.
    assert.ok(size(got.value) < 32_000, `tasks get is ${size(got.value)} chars`);
    assert.equal(got.value.children.length, 12);
    assert.equal(got.value.comments.length, 20);
    assert.equal(got.value.comments[0].bodyChars, 5000, 'a preview says how much it left out');
    assert.ok(size(inbox.value) < 6_000, `inbox is ${size(inbox.value)} chars`);
    assert.equal(inbox.value.requests.length, 6);
    // F8: only channels with unread posts are listed; the rest are a count.
    assert.ok(
      inbox.value.channels.every((row: { unread: number }) => row.unread > 0),
      'a read channel is not listed'
    );
    assert.equal(
      inbox.value.channels.length + inbox.value.readChannels,
      oldInbox.channels.length,
      'every channel is listed or counted'
    );
    assert.ok(inbox.value.readChannels > 0, 'the seeded workspace has read channels');
    const rows = runs.value.runs.filter(
      (row: { taskTitle: string | null }) => row.taskTitle === 'Big task'
    );
    assert.equal(rows.length, 6);
    assert.ok(
      rows.every((row: { purpose: string }) => /^Purpose \d$/.test(row.purpose)),
      'rows carry the request purpose'
    );

    // Evidence is capped where it is written, with a typed error naming the entry.
    const tooMany = await call(spec, 'task_write', {
      write: {
        kind: 'update',
        taskId: task.id,
        baseRevision: withEvidence.revision,
        changes: { evidence: Array.from({ length: 33 }, () => 'x') },
      },
      key: 'ev-33',
    });
    assert.match(tooMany.text, /^\[invalid\] task evidence takes at most 32/);
    const tooLong = await call(spec, 'task_write', {
      write: {
        kind: 'update',
        taskId: task.id,
        baseRevision: withEvidence.revision,
        changes: { evidence: ['ok', 'y'.repeat(501)] },
      },
      key: 'ev-long',
    });
    assert.match(tooLong.text, /^\[invalid\] task evidence entry 1 is 501 chars/);

    // The merged channel tool.
    const made = await call(spec, 'channel', {
      action: { kind: 'create', name: 'slim-merged', purpose: 'the one channel tool' },
      key: 'merged-create',
    });
    assert.equal(made.isError, false, made.text);
    const renamed = await call(spec, 'channel', {
      action: { kind: 'rename', channelId: made.value.id, name: 'slim-renamed' },
      key: 'merged-rename',
    });
    assert.equal(renamed.value.kind.name, 'slim-renamed');
  } finally {
    await w.close();
  }
});

// `runs get {tail}` reads the run's conversation through MessageSource, bounded by n.
test('runs get {tail:n} returns the last n assistant entries with tool names and clipped args', async () => {
  const w = await world();
  try {
    const request = await w.post(
      buddyActor(w.lead.id),
      { kind: 'direct', members: [buddyActor(w.lead.id), buddyActor(w.designer.id)] },
      {
        kind: 'request',
        body: 'Work',
        evidence: [],
        mentions: [],
        broadcast: false,
        key: 'tail-req',
      }
    );
    const run = await until(
      async () => (await w.runs(w.designer.id)).find((r) => r.conversationId),
      'the designer run gets a conversation'
    );
    const at = new Date('2026-10-06T08:00:00Z');
    w.transcripts.set(
      run.conversationId!,
      Array.from({ length: 40 }, (_, i) => ({
        role: 'assistant' as const,
        timestamp: new Date(at.getTime() + i * 1000),
        body:
          i % 2 === 0
            ? { t: 'text' as const, text: `step ${i}` }
            : {
                t: 'parts' as const,
                parts: [
                  ...(i === 37 ? [] : [{ t: 'text' as const, text: `think ${i}` }]),
                  { t: 'tool' as const, name: 'Bash', input: { command: 'z'.repeat(2000) } },
                ],
              },
      }))
    );
    const spec = w.endpoint.spec(
      w.grants.issueBuddy({
        role: 'worker',
        buddyId: w.lead.id,
        workspaceId: w.ws,
        conversationId: 'tail-view',
        runId: null,
        subscribes: 'self',
      })
    );
    const got = await call(spec, 'runs', { action: { kind: 'get', runId: run.id, tail: 3 } });
    assert.equal(got.isError, false, got.text);
    assert.equal(got.value.tail.length, 3);
    assert.equal(got.value.tail[2].text, 'think 39');
    assert.equal(got.value.tail[2].tools[0].name, 'Bash');
    assert.ok(got.value.tail[2].tools[0].args.length <= 201, 'args are clipped');
    // F8: each entry carries its own row's timestamp, and a text-less entry has no empty `text`.
    assert.deepEqual(
      got.value.tail.map((entry: { at: string }) => entry.at),
      [37, 38, 39].map((i) => new Date(at.getTime() + i * 1000).toISOString())
    );
    assert.equal(got.value.tail[0].text, undefined);
    assert.equal(got.value.tail[0].tools[0].name, 'Bash');
    void request;
  } finally {
    await w.close();
  }
});

// F3 (2026-10-06 CEO feedback, token acceptance): a resumed seat or delivery turn is sent only the
// posts past its conversation's mark plus a fixed envelope, INCLUDING right after a backend
// restart. Until step 5 the mark lived in the pair machine's memory, so every restart cost each
// seat one full-context prompt (the last ten posts plus a 700-char instruction block). The mark is
// a run column now. A reload is the in-memory conversation registry and the runner's claim state
// gone while the crate's file stays. Guard: this test fails if a delivery re-sends the thread.
test('a delivery after a backend restart sends one post, not the thread', async () => {
  const w = await world();
  try {
    const say = (body: string, replyToId?: string, mention = false) =>
      w.post(
        OWNER,
        { kind: 'id', id: w.general.id },
        {
          kind: 'inform',
          body: mention ? `[@Lead](buddy:${w.lead.id}) ${body}` : body,
          replyToId,
          evidence: [],
          mentions: [],
          broadcast: false,
          key: `f3-${body}`,
        }
      );
    const root = await say('Plan the launch', undefined, true);
    await until(
      async () => w.turns.length === 1 && (await w.channels.responding(w.general.id)).length === 0,
      'the first turn'
    );
    // The gate admits the burst; only the newest post is asked (runner.ts `followUpGate`).
    w.gate.verdicts.push(...Array.from({ length: 12 }, () => ({ kind: 'respond' }) as const));
    for (let i = 0; i < 6; i++) await say(`filler ${i}`, root.id);
    await until(
      async () => w.turns.length >= 2 && (await w.channels.responding(w.general.id)).length === 0,
      'the burst is answered'
    );
    const before = w.turns.length;
    w.conversations.clear(); // the backend reloads: no conversation is in memory
    w.gate.verdicts.push({ kind: 'respond' });
    await say('the one new post', root.id);
    await until(() => w.turns.length === before + 1, 'the delivery after the reload');
    const prompt = w.turns[before].request.prompt;
    assert.match(prompt, /the one new post/);
    assert.doesNotMatch(prompt, /Plan the launch|filler/, 'only the post past the mark');
    // The briefing the runtime prepends is not the delivery's own text.
    const envelope = prompt
      .slice(prompt.indexOf('New posts in threads you follow'))
      .split('\n')
      .filter((line) => !/^\[20/.test(line))
      .join('\n');
    assert.ok(
      envelope.length <= ENVELOPE_CHARS,
      `the envelope is ${envelope.length} chars, over ${ENVELOPE_CHARS}`
    );
  } finally {
    await w.close();
  }
});

test('new thread messages steer the live reply once, without a second run or busy failure', async () => {
  const w = await world();
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let arrived!: () => void;
  const started = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  try {
    w.during.set(1, async () => {
      arrived();
      await blocked;
    });
    const say = async (body: string, replyToId?: string) => {
      const post = await w.post(
        OWNER,
        { kind: 'id', id: w.general.id },
        {
          kind: 'inform',
          body,
          replyToId,
          evidence: [],
          mentions: [],
          broadcast: false,
          key: body,
        }
      );
      w.announce(post);
      return post;
    };
    const root = await say(`[@Lead](buddy:${w.lead.id}) implement the fix`);
    await started;
    const turn = w.turns[0];
    // Subscribe the running seat, then send a bound delivery and an unbound one
    // (unfollowing changes the route while the seat's first run is still live).
    await call(turn.mcp, 'channel_read', { read: { threadId: root.id, follow: { wait: 0 } } });
    const first = await say('Keep the existing work and add a regression', root.id);
    await call(turn.mcp, 'channel_read', { read: { threadId: root.id, follow: false } });
    const second = await say(`[@Lead](buddy:${w.lead.id}) also check repeated requests`, root.id);
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(w.turns.length, 1);
    const tool = await call(turn.mcp, 'doc_read', { kind: 'working' });
    assert.equal(tool.isError, false, tool.text);
    const steering = tool.content
      .slice(1)
      .map((c) => c.text)
      .join('\n');
    assert.match(steering, /While you were working/);
    assert.match(steering, /preserving the current task/);
    assert.ok(steering.includes(second.body));
    // first was read by the explicit unfollow read; it must not be injected again.
    assert.ok(!steering.includes(first.body));
    const again = await call(turn.mcp, 'doc_read', { kind: 'working' });
    assert.equal(again.content.length, 1);
    for (const post of [first, second]) {
      const delivery = (await w.runs(w.lead.id)).find(
        (r) => r.input.kind === 'deliver' && r.input.postId === post.id
      )!;
      assert.equal(delivery.status, 'cancelled');
      assert.equal(delivery.errorCode, 'consumed');
    }
    release();
    await until(
      async () => (await w.runs(w.lead.id)).every((r) => r.status !== 'running'),
      'reply settled'
    );
    assert.equal(w.turns.length, 1);
    const page = await w.core.listPosts(OWNER, { kind: 'thread', rootId: root.id }, null, 50);
    assert.ok(!page.posts.some((p) => p.purpose === 'reply_failed'));
  } finally {
    release();
    await w.close();
  }
});

// Owner report 2026-10-08: channel upload silently filtered everything except images/videos.
test('channel files: arbitrary uploads post durable links and download without executing', async () => {
  const w = await world();
  const { server, withClient } = await ownerHttp(w);
  try {
    await withClient(async () => {
      const { buddyUpload } = await import('../../client/src/components/buddies/api');
      const { mediaMarkdown, mediaUrl } = await import(
        '../../client/src/components/buddies/channel-text'
      );
      const form = new FormData();
      const names = [
        'report.pdf',
        'bundle.zip',
        'unknown.blob',
        'README',
        'active.html',
        'active.svg',
        'photo.png',
        'clip.mp4',
      ];
      for (const name of names) form.append('files', new Blob([`bytes of ${name}`]), name);
      const uploaded = await buddyUpload(w.general.id, form);
      assert.deepEqual(
        uploaded.files.map((f) => f.originalName),
        names
      );
      const body = `${uploaded.files.map(mediaMarkdown).join('\n')}\n[Open chat](/chat/c1)`;
      const result = await buddyWrite(
        'channel.post',
        { channelId: w.general.id },
        { body, key: 'files-post' }
      );
      assert.equal(result.post.body, body);
      for (const file of uploaded.files) {
        const response = await fetch(mediaUrl(file.absolutePath));
        assert.equal(response.status, 200);
        assert.equal(await response.text(), `bytes of ${file.originalName}`);
        if (['photo.png', 'clip.mp4'].includes(file.originalName)) {
          assert.equal(response.headers.get('content-disposition'), null);
        } else {
          assert.match(response.headers.get('content-disposition') ?? '', /^attachment;/);
          assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
        }
      }
      const { writeFileSync, unlinkSync } = await import('node:fs');
      const source = join(w.scratch, 'local report.pdf');
      writeFileSync(source, 'survives source removal');
      const linked = await buddyWrite(
        'channel.post',
        { channelId: w.general.id },
        {
          body: `[Local report](<${source}>)`,
          key: 'local-file-post',
        }
      );
      const stored = linked.post.body;
      assert.ok(!stored.includes(source));
      unlinkSync(source);
      const target = /\]\(([^)]+)\)/.exec(stored)![1];
      const downloaded = await fetch(mediaUrl(target));
      assert.equal(await downloaded.text(), 'survives source removal');
      const replay = await buddyWrite(
        'channel.post',
        { channelId: w.general.id },
        {
          body: stored,
          key: 'local-file-replay',
        }
      );
      assert.equal(replay.post.body, stored);
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await w.close();
  }
});

// Cross-root seat busy (2026-10-07, task_01a117e5): a seat that is mid-turn on a delivery from
// ANOTHER thread. The follow-up in this thread is queued with no conversation (a public seat is
// unsubscribed, 5d75897), so the claim gate cannot see the collision; the runner finds out at
// bind. It must wait for the seat, never post "Couldn't reply: conversation_busy".
// The setup: Lead's seat of thread A follows thread B (a tool follow), so a B post runs in A's seat.
async function busyCrossRootSeat(w: Awaited<ReturnType<typeof world>>) {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let arrived!: () => void;
  const started = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  const say = async (body: string, replyToId?: string) => {
    const post = await w.post(
      OWNER,
      { kind: 'id', id: w.general.id },
      { kind: 'inform', body, replyToId, evidence: [], mentions: [], broadcast: false, key: body }
    );
    w.announce(post);
    return post;
  };
  const rootB = await say('Thread B: unrelated work');
  w.during.set(1, async (turn) => {
    // Unfollow A (the seat must stay unsubscribed there) and follow B: B's posts run in this seat.
    await call(turn.mcp, 'channel_read', { read: { threadId: rootA.id, follow: false } });
    await call(turn.mcp, 'channel_read', { read: { threadId: rootB.id, follow: { wait: 0 } } });
  });
  // Turn 2 makes no Buddy tool call (a reply post would be one), so nothing steers it.
  w.silent.add(2);
  w.during.set(2, async () => {
    arrived();
    await blocked;
  });
  const rootA = await say(`[@Lead](buddy:${w.lead.id}) thread A first ask`);
  await until(
    async () => w.turns.length === 1 && (await w.channels.responding(w.general.id)).length === 0,
    'turn 1'
  );
  const fromB = await say('news in thread B', rootB.id);
  await started;
  const followUp = await say(`[@Lead](buddy:${w.lead.id}) thread A follow-up`, rootA.id);
  return { rootA, fromB, followUp, release, wait: blocked };
}

const runOf = async (w: Awaited<ReturnType<typeof world>>, postId: string) =>
  (await w.runs(w.lead.id)).find((r) => r.input.kind === 'deliver' && r.input.postId === postId)!;

test('a follow-up whose seat is busy on another thread waits, then runs, with no failure notice', async () => {
  const w = await world();
  let release = () => {};
  try {
    const s = await busyCrossRootSeat(w);
    release = s.release;
    const rows = await until(async () => {
      const id = (await runOf(w, s.followUp.id)).id;
      const found = await w.core.listRunRows(OWNER, { kind: 'workspace', workspaceId: w.ws }, 50);
      return found.find((r) => r.id === id && r.waiting) ?? false;
    }, 'the follow-up to wait');
    assert.deepEqual(rows.waiting, { kind: 'conversation_busy' });
    assert.equal(w.turns.length, 2, 'it did not start a second turn in the busy seat');
    release();
    await until(async () => (await runOf(w, s.followUp.id)).status === 'complete', 'it runs after');
    assert.equal(w.turns.length, 3);
    assert.match(w.turns[2].request.prompt, /thread A follow-up/);
    const page = await w.core.listPosts(OWNER, { kind: 'thread', rootId: s.rootA.id }, null, 50);
    assert.ok(!page.posts.some((p) => p.purpose === 'reply_failed'));
  } finally {
    release();
    await w.close();
  }
});

test('a follow-up waiting on a busy seat is consumed when the busy turn reads its thread', async () => {
  const w = await world();
  let release = () => {};
  try {
    const s = await busyCrossRootSeat(w);
    release = s.release;
    await until(
      async () => (await runOf(w, s.followUp.id)).status === 'queued',
      'the follow-up to wait'
    );
    // The busy turn now reads thread A through a Buddy tool: it has seen the post.
    await call(w.turns[1].mcp, 'channel_read', { read: { threadId: s.rootA.id, follow: false } });
    release();
    await until(
      async () => (await w.runs(w.lead.id)).every((r) => r.status !== 'running'),
      'the busy turn to end'
    );
    const run = await runOf(w, s.followUp.id);
    assert.equal(run.status, 'cancelled');
    assert.match(run.error ?? '', /already read/);
    assert.equal(w.turns.length, 2, 'no second turn for a post already read');
  } finally {
    release();
    await w.close();
  }
});

// Native hooks use the same loopback grant and durable read fence as Buddy tool responses.
for (const child of [false, true]) {
  test(`an owner post steers a live turn at a native tool boundary${child ? ' while its parent waits' : ''}`, async () => {
    const w = await world();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let arrived!: () => void;
    const started = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    try {
      w.during.set(1, async () => {
        arrived();
        await blocked;
      });
      const say = async (author: typeof OWNER, body: string, replyToId?: string) => {
        const post = await w.post(
          author,
          { kind: 'id', id: w.general.id },
          {
            kind: 'inform',
            body,
            replyToId,
            evidence: [],
            mentions: [],
            broadcast: false,
            key: body,
          }
        );
        w.announce(post);
        return post;
      };
      const root = await say(OWNER, `[@Lead](buddy:${w.lead.id}) build the board`);
      await started;
      const turn = w.turns[0];
      assert.equal(turn.mcp.kind, 'http');
      if (turn.mcp.kind !== 'http') throw new Error('expected HTTP');
      const httpSpec = turn.mcp;
      const hook = async (agent_id?: string) => {
        const response = await fetch(w.endpoint.postToolHookUrl, {
          method: 'POST',
          headers: { ...httpSpec.headers, 'content-type': 'application/json' },
          body: JSON.stringify({
            hook_event_name: child ? 'PostToolUse' : 'PostToolUseFailure',
            ...(agent_id ? { agent_id } : {}),
          }),
        });
        assert.equal(response.status, 200);
        return response.text();
      };
      // Chatter alone never triggers the new native steering surface.
      const chatter = (
        await w.core.post(
          buddyActor(w.designer.id),
          { kind: 'id', id: w.general.id },
          {
            kind: 'inform',
            body: 'designer chatter',
            replyToId: root.id,
            evidence: [],
            mentions: [],
            broadcast: false,
            key: 'chatter',
          }
        )
      ).post;
      w.announce(chatter);
      assert.equal(await hook(child ? 'native-child' : undefined), '');
      const correction = await say(
        OWNER,
        `[@Lead](buddy:${w.lead.id}) Use a 3×3×3 board, keep the current task.`,
        root.id
      );
      const shown = JSON.parse(await hook(child ? 'native-child' : undefined));
      assert.match(shown.hookSpecificOutput.additionalContext, /While you were working/);
      assert.ok(shown.hookSpecificOutput.additionalContext.includes(correction.body));
      assert.equal(await hook(child ? 'native-child' : undefined), '');
      const delivery = async () =>
        (await w.runs(w.lead.id)).find(
          (r) => r.input.kind === 'deliver' && r.input.postId === correction.id
        )!;
      if (child) {
        // A child's peek must NOT consume the parent's delivery or claim that the parent read it.
        assert.equal((await delivery()).status, 'queued');
        const parent = JSON.parse(await hook());
        assert.ok(parent.hookSpecificOutput.additionalContext.includes(correction.body));
      }
      assert.equal((await delivery()).errorCode, 'consumed');
      assert.equal(w.turns.length, 1);
      assert.equal(w.stopped.size, 0);
      assert.equal(await hook(), '');
      release();
      await until(
        async () => (await w.runs(w.lead.id)).every((r) => r.status !== 'running'),
        'settled'
      );
      assert.equal(w.turns.length, 1);
      const denied = await fetch(w.endpoint.postToolHookUrl, {
        method: 'POST',
        headers: turn.mcp.headers,
        body: JSON.stringify({ hook_event_name: 'PostToolUse' }),
      });
      assert.equal(denied.status, 401, 'settlement revokes native hooks with the MCP grant');
    } finally {
      release();
      await w.close();
    }
  });
}

test('a queued model pick waits for its own turn at every tool boundary', async () => {
  const w = await world();
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let arrived!: () => void;
  const started = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  try {
    w.during.set(1, async () => {
      arrived();
      await blocked;
    });
    const say = async (body: string, replyToId?: string) => {
      const post = await w.post(
        OWNER,
        { kind: 'id', id: w.general.id },
        {
          kind: 'inform',
          body,
          replyToId,
          evidence: [],
          mentions: [],
          broadcast: false,
          key: body,
        }
      );
      w.announce(post);
      return post;
    };
    const root = await say(`[@Lead](buddy:${w.lead.id}) build the board`);
    await started;
    const pick = createDefaultConversationConfig('claude');
    w.picks.set(w.lead.id, pick);
    const correction = await say(
      `[@Lead](buddy:${w.lead.id}) Use a 3×3×3 board on the picked model`,
      root.id
    );
    const mcp = w.turns[0].mcp;
    assert.equal(mcp.kind, 'http');
    if (mcp.kind !== 'http') throw new Error('expected HTTP');
    const hook = await fetch(w.endpoint.postToolHookUrl, {
      method: 'POST',
      headers: mcp.headers,
      body: JSON.stringify({ hook_event_name: 'PostToolUse' }),
    });
    assert.equal(await hook.text(), '');
    const tool = await call(mcp, 'doc_read', { kind: 'working' });
    assert.equal(tool.content.length, 1);
    const delivery = (await w.runs(w.lead.id)).find(
      (r) => r.input.kind === 'deliver' && r.input.postId === correction.id
    )!;
    assert.equal(delivery.status, 'queued');
    const waiting = await w.channels.responding(w.general.id);
    assert.equal(waiting.find((r) => r.state === 'queued')?.waiting?.kind, 'conversation_busy');
    release();
    await until(() => w.turns.length === 2, 'the picked turn');
    assert.equal(w.turns[1].request.harness, 'claude');
    assert.ok(w.turns[1].request.prompt.includes(correction.body));
    await until(
      async () => (await w.runs(w.lead.id)).every((r) => r.status !== 'running'),
      'picked turn settles'
    );
  } finally {
    release();
    await w.close();
  }
});

// Opt-in paid CLI evidence; all stores and the CLI cwd are temporary. No shell-out to agent
// binaries: this drives the same executeCommand boundary as a production conversation.
for (const provider of ['codex', 'claude'] as const) {
  for (const child of [false, true]) {
    test(
      `real CLI ${provider}: owner steering ${child ? 'during native child work' : 'after Bash'}`,
      {
        skip: process.env.UNLEASHD_REAL_STEERING !== '1',
        timeout: 180_000,
      },
      async () => {
        const w = await world(undefined, true);
        const marker = join(w.scratch, 'tool-started');
        const release = join(w.scratch, 'tool-release');
        const result = join(w.scratch, 'steered-result');
        try {
          const config = createDefaultConversationConfig(provider);
          config.model = {
            mode: 'explicit',
            modelId: provider === 'claude' ? 'claude-sonnet-5-5' : 'gpt-5.6-luna',
          };
          w.picks.set(w.lead.id, config);
          const commands = `First use a shell tool to run: touch ${marker}; while [ ! -f ${release} ]; do sleep 0.2; done; echo ready. Then, in a SECOND shell tool call, write the board dimensions specified by the newest owner message to ${result}. Default dimensions are 2×2×2. Keep working after any owner correction.`;
          const root = await w.post(
            OWNER,
            { kind: 'id', id: w.general.id },
            {
              kind: 'inform',
              body: `[@Lead](buddy:${w.lead.id}) ${child ? `Delegate these exact steps to one native sub-agent in the foreground, wait for it, and then confirm its result: ${commands}` : commands}`,
              evidence: [],
              mentions: [],
              broadcast: false,
              key: 'real-root',
            }
          );
          w.announce(root);
          await until(() => existsSync(marker), 'real native shell running');
          const correction = await w.post(
            OWNER,
            { kind: 'id', id: w.general.id },
            {
              kind: 'inform',
              body: `[@Lead](buddy:${w.lead.id}) Correction: use a 3×3×3 board. Preserve the current task and keep the worker running.`,
              replyToId: root.id,
              evidence: [],
              mentions: [],
              broadcast: false,
              key: 'real-correction',
            }
          );
          w.announce(correction);
          writeFileSync(release, 'continue');
          await until(() => existsSync(result), 'the corrected native tool result');
          assert.match(readFileSync(result, 'utf8'), /3[×x]3[×x]3/);
          assert.equal(w.turns.length, 1);
          assert.equal(w.stopped.size, 0);
          await until(
            async () => (await w.runs(w.lead.id)).every((r) => r.status !== 'running'),
            'real turn settles'
          );
          const delivery = (await w.runs(w.lead.id)).find(
            (r) => r.input.kind === 'deliver' && r.input.postId === correction.id
          )!;
          assert.equal(delivery.errorCode, 'consumed');
          const seat = [...w.conversations.values()].find((c) => c.id !== 'owner-chat')!;
          const transcript = seat.messages.map((m) => bodyText(m.body)).join('\n');
          console.log(`REAL_STEERING ${provider} child=${child}: ${transcript}`);
          if (process.env.UNLEASHD_STEERING_EVIDENCE_DIR) {
            mkdirSync(process.env.UNLEASHD_STEERING_EVIDENCE_DIR, { recursive: true });
            writeFileSync(
              join(
                process.env.UNLEASHD_STEERING_EVIDENCE_DIR,
                `${provider}-${child ? 'child' : 'bash'}.txt`
              ),
              transcript
            );
          }
        } finally {
          writeFileSync(release, 'continue');
          await w.close();
        }
      }
    );
  }
}
