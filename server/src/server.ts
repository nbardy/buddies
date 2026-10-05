import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { ProviderSchema, encodeRows } from '@unleashd/shared';

import { executeCommand } from '@nbardy/agent-cli';
import compression from 'compression';
import express, { type ErrorRequestHandler } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { WebSocketServer } from 'ws';
import { appDataDirectory, uploadsDirectory } from './app-data';
import { createConversationApplicationContext } from './application/context';
import { registerAuthRoutes } from './auth/express';
import { authorizeUpgrade } from './auth/gate';
import { TAILSCALE_CANDIDATES, registerMobileAccessRoutes } from './auth/mobile-access';
import { describePolicy, keyLocation, resolveAuthPolicy } from './auth/policy';
import { setIgnorePatterns, shouldIgnoreWorkingDirectory } from './config';
import {
  BUDDY_BACKGROUND_TURN_MS,
  BUDDY_RUNNER_BACKSTOP_MS,
  EXTERNAL_GRACE_MS,
  HOT_RELOAD_FORCE_EXIT_GRACE_MS,
  LOCAL_COMPLETION_SUPPRESS_MS,
  PALETTE_GENERATION_TIMEOUT_MS,
  SHUTDOWN_FLUSH_GRACE_MS,
  SWARM_CONTEXT_COMMAND_TIMEOUT_MS,
  TURN_MAX_RUNTIME_MS,
} from './constants/timeouts';
import {
  type BuddyCreationService,
  createBuddyCreationService,
} from './conversations/buddy-creation-service';
import {
  ConversationRecordStore,
  openRecords,
  recordsLocation,
} from './conversations/config-records';
import { ConversationConfigService } from './conversations/config-service';
import { ConversationTombstonedError } from './conversations/config-service';
import {
  type ConversationRuntime,
  createConversationRuntime,
  overlayHistoryFields,
} from './conversations/runtime';
import { replaceRuntimeConfig } from './conversations/runtime-config';
import { registerConversationRoutes } from './http/conversation-routes';
import { registerCoreRoutes } from './http/core-routes';
import { registerErrorDiagnosticsRoutes } from './http/error-diagnostics-routes';
import { registerFilesystemRoutes } from './http/filesystem-routes';
import { createKnownProjectAuthorizer } from './http/known-projects';
import { resolveDefaultWorkingDirectory, resolveWorkingDirectoryInput } from './http/path-utils';
import { PersistedServerState } from './http/persisted-state';
import { registerSearchRoutes } from './http/search-routes';
import { registerTurnDiagnosticsRoutes } from './http/turn-diagnostics-routes';
import { registerUploadRoutes } from './http/upload-routes';
import { registerUsageRoutes } from './http/usage-routes';
import { type BootedIngest, bootIngest } from './ingest/boot';
import type { ConversationList } from './ingest/conversation-list';
import { currentIngest } from './ingest/instance';
import { createRuntimeBuilder } from './ingest/runtimes';
import { type ShutdownController, registerShutdownHandlers } from './lifecycle/shutdown';
import { runServerStartup } from './lifecycle/startup';
import { registerStaticClient } from './lifecycle/static-client';
import { resolveListenHost } from './network';
import {
  ErrorJournal,
  TurnAttemptJournal,
  createJournalTurnAttemptObserver,
  installConsoleErrorCapture,
  noteActivity,
  reportBackendExits,
  startEventLoopStallMonitor,
} from './observability';
import { createPaletteService } from './palettes/palette-service';
import { buildPalettePrompt } from './palettes/prompt';
import { resolveConfigAgainstProviderCatalog } from './providers/catalog-service';
import { createDependencyChecks, registerDependencyRoutes } from './providers/dependencies';
import { installedAgent } from './providers/installed-agent';
import { readLatestSwarmRuntime, registerSwarmRoutes } from './swarm';
import { registerConversationWebSocket } from './transport/conversation-websocket';
import { WS_LIVENESS_INTERVAL_MS, superviseLiveness } from './transport/websocket';
import { createUpstreamService } from './upstream/routes';

import { type SessionRow, defaultRoots } from '@unleashd/ingest';
import { validate as isUuid } from 'uuid';
import { auditLocalAgents } from './audit.js';
import { createBriefings } from './buddies/briefing';
import { type StableConversationPorts, slotOf } from './buddies/buddy-conversation-slots';
import { createCliReplyGate } from './buddies/channel-reply-gate';
import { createChannels } from './buddies/channels';
import {
  OWNER,
  archivedBuddyIds,
  buddiesDatabasePath,
  buddiesLocation,
  lateBoundCore,
  openBuddiesCore,
} from './buddies/core';
import { createBuddyEvents } from './buddies/events';
import { createGrants } from './buddies/grants';
import { type McpEndpoint, startMcpEndpoint } from './buddies/mcp';
import { createMemoryReviewer } from './buddies/memory-review';
import { createBuddyPolicyPort } from './buddies/policy-port';
import { registerBuddyRoutes } from './buddies/routes';
import { type RunnerHost, createRunner } from './buddies/runner';
import { workerConversationConfig } from './buddies/worker-config';
import { UPLOADS_RETENTION_MS, startUploadsGc } from './uploads/gc';

let startupAuditResults: ReturnType<typeof auditLocalAgents> = [];

const app = express();
const server = http.createServer(app);
const APP_DATA_DIR = appDataDirectory();
const LISTEN_HOST = resolveListenHost();

const DEV_CLIENT_PORT = 7489;
const DEV_API_PORT = 7499;
const PORT =
  process.env.PORT || (process.env.NODE_ENV === 'development' ? DEV_API_PORT : DEV_CLIENT_PORT);
const portNumber = typeof PORT === 'string' ? Number.parseInt(PORT, 10) : PORT;

const authResolution = resolveAuthPolicy({
  env: process.env,
  listenHost: LISTEN_HOST,
  dataDirectory: APP_DATA_DIR,
});
if (!authResolution.ok) {
  console.error(`[auth] ${authResolution.error}`);
  process.exit(1);
}
const AUTH_POLICY = authResolution.policy;
console.log(`[auth] ${describePolicy(AUTH_POLICY)}`);

// noServer + an explicit upgrade handler is what makes the WebSocket gateable:
// `new WebSocketServer({ server })` accepts every upgrade before any of our
// code runs, so the socket — which carries the full command surface — would
// stay open to anyone who can reach the port.
//
// permessage-deflate: the `init` snapshot is ~2.4 MB of JSON for a real
// history (~190 KB deflated), which over a LAN/phone link was the dominant
// cost of opening the app. Browsers offer the extension on every WebSocket
// handshake, so enabling it here is the whole change; `handleUpgrade` does the
// negotiation, so noServer + the gated upgrade handler below are unaffected.
// Frames under `threshold` (streaming deltas, acks) are sent uncompressed.
// Context takeover stays ON: consecutive streaming deltas share most of their
// bytes, and the per-connection cost (~200 KB of zlib state at memLevel 7) is
// trivial for the handful of tabs this server ever has open.
const wss = new WebSocketServer({
  noServer: true,
  perMessageDeflate: {
    threshold: 1024,
    zlibDeflateOptions: { memLevel: 7 },
  },
});
server.on('upgrade', (request, socket, head) => {
  const gateRequest = {
    method: request.method ?? 'GET',
    url: request.url ?? '/',
    headers: request.headers,
  };
  if (!authorizeUpgrade(AUTH_POLICY, gateRequest)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(request, socket, head, (client) => {
    wss.emit('connection', client, request);
  });
});
wss.on('connection', (client) => superviseLiveness(client, WS_LIVENESS_INTERVAL_MS));
// Opened now, awaited first thing in `initialize`: a data dir whose JSON
// records were never imported fails boot there with the import command.
const conversationConfigStore = new ConversationRecordStore(
  openRecords(recordsLocation(APP_DATA_DIR))
);
const conversationConfigService = new ConversationConfigService({
  store: conversationConfigStore,
  resolver: {
    resolve: async (config) => resolveConfigAgainstProviderCatalog(config),
  },
});
const persistedServerState = new PersistedServerState(APP_DATA_DIR, setIgnorePatterns);
const turnAttemptJournal = new TurnAttemptJournal({
  directory: path.join(APP_DATA_DIR, 'observability'),
});
const errorJournal = new ErrorJournal({
  directory: path.join(APP_DATA_DIR, 'observability'),
  serverBootId: turnAttemptJournal.serverBootId,
});
const turnAttemptObserver = createJournalTurnAttemptObserver(turnAttemptJournal);
let shutdownController: ShutdownController | null = null;
const beginMutation = (options?: { allowDuringStartup?: boolean }) =>
  shutdownController?.beginMutation(options) ?? null;
const pauseBuddyScheduler = () => {
  buddyRunner.pause();
  memoryReviewer.pause();
};
const resumeBuddyScheduler = () => {
  buddyRunner.resume();
  memoryReviewer.start();
};
const stopBuddyScheduler = () => {
  memoryReviewer.stop();
  buddyRunner.stop();
};

const applicationContext = createConversationApplicationContext<ConversationRuntime>({
  webSocketServer: wss,
  completionSuppressionMs: LOCAL_COMPLETION_SUPPRESS_MS,
});
const conversations = applicationContext.registry;
turnAttemptJournal.subscribe((latestAttempt) => {
  applicationContext.broadcast({
    type: 'patch',
    id: latestAttempt.conversationId,
    patch: { t: 'attempt', latestAttempt },
  });
});

// The conversation list and every history, read from the ingest store (T13b). Until the store's
// initial scan commits nothing is listed, and a history request waits for it.
let conversationList: ConversationList | null = null;
let bootedIngest: Promise<BootedIngest> | null = null;
let resolveListReady: (list: ConversationList) => void = () => undefined;
const listReady = new Promise<ConversationList>((resolve) => {
  resolveListReady = resolve;
});

/**
 * A session no record binds: a CLI run outside the app (or before this server started). It
 * becomes a discovered record, as the old poller's hydration did. A session a runtime already
 * owns (its binding not yet persisted) or one deleted in this app is never re-created.
 */
async function discoverSession(session: SessionRow) {
  const sessions = applicationContext.sessions;
  if (session.cwd.t === 'unknown') return null;
  if (sessions.isKnown(session.sessionId) || sessions.isDeleted(session.sessionId)) return null;
  if (shouldIgnoreWorkingDirectory(session.cwd.path)) return null;
  const binding = { provider: session.provider, sessionId: session.sessionId };
  try {
    const hydrated = await conversationConfigService.hydrate({
      conversationId: isUuid(session.sessionId) ? session.sessionId : uuidv4(),
      sessionBindings: [binding],
      currentSession: binding,
      workingDirectory: session.cwd.path,
      // The oompa tag is the one classification a transcript may propose (disk-adapter did the
      // same); Buddy and Builder identity is never read from transcript text.
      discoveredKind:
        session.identity.t === 'worker'
          ? {
              t: 'worker',
              swarmId: session.identity.swarmId ?? null,
              workerId: session.identity.workerId ?? null,
              role: session.identity.role,
            }
          : { t: 'chat' },
      sessionEvidence: {
        provider: session.provider,
        reportedModel: session.observedModel ?? undefined,
        source: 'external_session',
      },
    });
    return hydrated.record;
  } catch (error) {
    if (error instanceof ConversationTombstonedError) return null;
    throw error;
  }
}

async function startIngestList(): Promise<void> {
  bootedIngest = bootIngest(
    { home: os.homedir(), appDataDir: APP_DATA_DIR },
    {
      records: conversationConfigStore,
      runtime: (id) => conversations.get(id),
      discover: discoverSession,
      externalActivity: applicationContext.externalActivity,
      completionSuppression: applicationContext.completionSuppression,
      externalGraceMs: EXTERNAL_GRACE_MS,
      broadcast: applicationContext.broadcast,
    }
  );
  const { list } = await bootedIngest;
  conversationList = list;
  resolveListReady(list);
  const rows = list.rows();
  if (rows.length > 0) applicationContext.broadcast({ type: 'rows', ...encodeRows(rows) });
}

// ---- Buddies: the crate (the new-schema DB) and the modules over it -------------------------
// The DB is never the v33 ~/.buddies/buddies.sqlite. A missing file while the v33 one exists fails
// every Buddy call with the import command (core.ts), while ordinary chats keep working; a
// first-time install (neither file) starts with an empty database.
const buddiesReady = openBuddiesCore(buddiesLocation(buddiesDatabasePath()));
buddiesReady.catch((error) => console.error('[buddies] Buddies are unavailable:', error.message));
const buddiesCore = lateBoundCore(buddiesReady);
const buddyEvents = createBuddyEvents();
// A grant lives as long as its run's lease at most; settle and turn end revoke it sooner.
const buddyGrants = createGrants({ ttlMs: TURN_MAX_RUNTIME_MS });
const buddyBriefings = createBriefings(buddiesCore, () => installedAgent());
let buddyMcp: McpEndpoint | null = null;
const buddyMcpSpec = (grant: Parameters<McpEndpoint['spec']>[0]) => {
  if (!buddyMcp) throw new Error('The Buddy MCP endpoint is not started');
  return buddyMcp.spec(grant);
};
const resolveBuddyConversation = (context: Parameters<typeof buddyBriefings.warm>[0]) =>
  buddyBriefings.warm(context);
// Chats must load without Buddies: when the Buddies DB is missing, hide no conversation (the
// error is logged each time, so it reaches the error journal) instead of failing `init`.
const archivedBuddyIdsOrNone = () =>
  archivedBuddyIds(buddiesCore).catch((error: Error) => {
    console.error('[buddies] archived-Buddy filter unavailable:', error.message);
    return new Set<string>();
  });
const createBuddyConversationLink = async (conversation: ConversationRuntime) => {
  const context = conversation.buddyContext;
  if (!context) return;
  await buddiesCore.bindConversation(OWNER, {
    id: conversation.id,
    buddyId: context.buddyId,
    taskId: context.buddyProjectId ?? undefined,
  });
};

// One hydration barrier governs both the authoritative initial snapshot and
// command admission. Disk state must be loaded before either can proceed.
//
// The barrier means "startup is no longer in progress", NOT "startup succeeded".
// Every terminal outcome must resolve it — see the `.finally` on runServerStartup
// below. A reload IPC arriving mid-startup makes completeStartup() return false,
// and before 2026-08-20 that path left this promise pending forever, so every
// non-create WS command awaited it with no reply and no error, and the client's
// load spinner never cleared. Waiters hold a command slot while they wait (so a
// reload queued during startup waits for them); one that resumes into a
// non-idle state is refused with a typed rejection, which the client can retry.
let resolveInitialLoad!: () => void;
const initialLoadComplete = new Promise<void>((resolve) => {
  resolveInitialLoad = resolve;
});

// =============================================================================
// Helper Functions
// =============================================================================

const AGENT_CLI_DEBUG_EVENTS = process.env.AGENT_CLI_DEBUG_EVENTS === '1';

const buddyCreationService: BuddyCreationService = createBuddyCreationService({
  configService: conversationConfigService,
  resolveBuddyConversation,
  resolveWorkingDirectory: resolveWorkingDirectoryInput,
  createId: uuidv4,
  getConversation: (id) => applicationContext.registry.get(id),
  createConversation: (options) => new Conversation(options),
  registerConversation: applicationContext.registry.set,
  createConversationLink: createBuddyConversationLink,
  updateConversationStatus: () => undefined,
  broadcast: applicationContext.broadcast,
});

// One background Buddy turn = one conversation runtime turn (runCoordinationMessage).
const buddyRunnerHost: RunnerHost = {
  registered: (id) => conversations.get(id) !== undefined,
  openBackground: async ({ conversationId, context, commandId, config }) => {
    await buddyCreationService.createServerBuddyConversation({
      context,
      conversationId,
      commandId,
      config: config && workerConversationConfig(config),
      deferInitialMessage: true,
      visibility: 'background',
    });
  },
  runTurn: async ({ conversationId, context, prompt, leaseToken, deadlineMs }) => {
    const registered = conversations.get(conversationId);
    if (!registered) throw new Error(`Run conversation ${conversationId} is not registered`);
    const conversation = await buddyCreationService.ensureConversationReady(registered);
    // Automatic expiry is max_runtime_timeout, never stop()/user_stop (AGENTS.md).
    const timer = setTimeout(() => conversation.expireCoordinationRun(), deadlineMs);
    try {
      return await conversation.runCoordinationMessage(prompt, context, leaseToken);
    } finally {
      clearTimeout(timer);
    }
  },
  stop: (id) => conversations.get(id)?.stop(),
};
const buddyRunner = createRunner({
  core: buddiesCore,
  host: buddyRunnerHost,
  grants: buddyGrants,
  events: buddyEvents,
  briefings: buddyBriefings,
  // Explicit: a foreground chat's deadline is its lease (runner.ts, 2026-09-10 incident).
  leaseMs: TURN_MAX_RUNTIME_MS,
  backgroundTurnMs: BUDDY_BACKGROUND_TURN_MS,
  backstopMs: BUDDY_RUNNER_BACKSTOP_MS,
});
const memoryReviewer = createMemoryReviewer({
  core: buddiesCore,
  grants: buddyGrants,
  spec: buddyMcpSpec,
});
const buddyPolicyPort = createBuddyPolicyPort({
  runner: buddyRunner,
  grants: buddyGrants,
  briefings: buddyBriefings,
  reviewer: memoryReviewer,
  spec: buddyMcpSpec,
});
const Conversation = createConversationRuntime({
  // BuddyTurnPolicy (buddies/turn-policy.ts) reaches the Buddy module only through this port.
  buddies: buddyPolicyPort,
  broadcast: applicationContext.broadcast,
  registerSessionAlias: applicationContext.sessions.registerAlias,
  unregisterSessionAlias: applicationContext.sessions.unregisterAlias,
  clearExternalRunningStatus: applicationContext.externalActivity.clear,
  clearLocalCompletionSuppression: applicationContext.completionSuppression.clear,
  markLocalCompletionSuppression: applicationContext.completionSuppression.mark,
  persistCurrentSession: (conversation, sessionId, buddyAudienceKey) =>
    buddyCreationService.persistCurrentSession(conversation, sessionId, buddyAudienceKey),
  persistSessionUsage: async (conversationId, sessionId, usage) => {
    await conversationConfigStore.setCurrentSessionUsage(conversationId, sessionId, usage);
  },
  getConversation: (id) => conversations.get(id),
  readLatestOompaRuntime: readLatestSwarmRuntime,
  createSessionId: uuidv4,
  turnAttempts: turnAttemptObserver,
  history: {
    fields: (conversation) =>
      conversationList?.historyFields(conversation) ?? overlayHistoryFields(conversation),
    idle: (conversationId) => conversationList?.idle(conversationId),
  },
});

registerConversationWebSocket(wss, {
  registry: applicationContext.registry,
  listedRows: () => conversationList?.rows() ?? [],
  materialize: (id) => runtimeBuilder.materialize(id),
  forgetListed: (id) => conversationList?.forget(id),
  sessions: applicationContext.sessions,
  externalActivity: applicationContext.externalActivity,
  completionSuppression: applicationContext.completionSuppression,
  initialLoadComplete,
  // Lifecycle: `starting` hydrates disk history, `idle` is the sole ready state
  // for mutations on existing history. WS `init` streams immediately with
  // `loading:true` + summaries; Phase 2 batches arrive via
  // `conversations_updated` and `conversation_load_complete` flips `idle`.
  // Every command is admitted (counted as active work) during `starting`.
  // Only `create_conversation` RUNS during `starting` (5d79890) — it mints a
  // fresh UUID/config record that cannot collide with disk hydration. All
  // other commands hold their slot and await `initialLoadComplete` in the WS
  // handler so they never race the authoritative restore.
  isInitialLoadComplete: () => shutdownController?.state === 'idle',
  beginCommand: () => beginMutation({ allowDuringStartup: true }),
  configService: conversationConfigService,
  isBuddyArchived: async (buddyId) => (await buddiesCore.getBuddy(buddyId)).status === 'archived',
  getArchivedBuddyIds: async () => [...(await archivedBuddyIdsOrNone())],
  getDefaultWorkingDirectory: () => resolveDefaultWorkingDirectory(),
  resolveWorkingDirectory: resolveWorkingDirectoryInput,
  resolveBuddyConversation,
  createConversation: (options) => new Conversation(options),
  createConversationLink: createBuddyConversationLink,
  cancelBuddyConversation: () => undefined,
  dispatchInitialMessage: buddyCreationService.dispatchInitialMessageIfPending,
  broadcast: applicationContext.broadcast,
  broadcastExcept: applicationContext.broadcastExcept,
});

// =============================================================================
// Express Routes
// =============================================================================

// Auth first: every route below (API, uploads, and the static app shell) is
// unreachable without the shared secret.
registerAuthRoutes(app, AUTH_POLICY);

// gzip/deflate every compressible response over 1 KB (JSON API, the app
// shell's JS/CSS). Mounted AFTER the gate so an unauthenticated caller costs
// no compression work. /api/conversations/:id reaches 1.36 MB for a long
// thread. There are no streaming (SSE / chunked res.write) routes; if one is
// added it must call `res.flush()` after each write or compression buffers it.
app.use(compression({ threshold: 1024 }));

// Event-loop stall attribution (observability/event-loop-stall.ts): a label and
// a timestamp per request, nothing else.
app.use((request, _response, next) => {
  noteActivity(`${request.method} ${request.path}`);
  next();
});

// JSON body parser for API routes.
// Default limit is 100kb which is far too small — queue-message and other
// endpoints routinely carry pasted content, inline images, or full
// conversation histories. Matches client uploads already sized in MB.
app.use(express.json({ limit: '50mb' }));
app.use((request, response, next) => {
  if (request.method === 'GET' || request.method === 'HEAD' || request.method === 'OPTIONS') {
    next();
    return;
  }
  const release = beginMutation();
  if (!release) {
    const draining = shutdownController?.state !== 'starting';
    response.status(503).json({
      error: draining ? 'server_draining' : 'server_starting',
      message: draining
        ? 'Backend reload is draining active turns; try again after reconnecting'
        : 'Backend is restoring persisted conversations; try again when startup completes',
      retryable: true,
    });
    return;
  }
  response.once('finish', release);
  response.once('close', release);
  next();
});

const UPLOADS_DIR = uploadsDirectory();
registerUploadRoutes(app, UPLOADS_DIR);
registerCoreRoutes(app, () => startupAuditResults);
const dependencyChecks = registerDependencyRoutes(
  app,
  createDependencyChecks(process.env, 45_000, path.join(APP_DATA_DIR, 'dependency-setup'))
);
registerMobileAccessRoutes(app, {
  tailscale: TAILSCALE_CANDIDATES,
  // A phone must reach the CLIENT: Vite's port in development, not the API's.
  uiPort: process.env.NODE_ENV === 'development' ? DEV_CLIENT_PORT : portNumber,
  auth: AUTH_POLICY,
  key: keyLocation(process.env, APP_DATA_DIR),
});
registerConversationRoutes(
  app,
  (id) => runtimeBuilder.materialize(id),
  async (id, page) => (await listReady).page(id, page),
  {
    getBranch: async (id) => (await conversationConfigService.getRecord(id))?.creation?.branch,
    ingest: currentIngest,
    latestAttempt: async (id) =>
      (await turnAttemptJournal.queryAttempts({ conversationId: id, limit: 1 }))[0] ?? null,
  }
);
registerTurnDiagnosticsRoutes(app, turnAttemptJournal);
registerErrorDiagnosticsRoutes(app, errorJournal);

persistedServerState.registerRoutes(app);

// Buddy change bus → one debounced `buddies_changed` per burst of writes (250 ms folds a
// multi-step action into one client refresh). Every write runs in this process now (B2).
let buddiesChangedTimer: NodeJS.Timeout | null = null;
const buddiesChanged = () => {
  if (buddiesChangedTimer) return;
  buddiesChangedTimer = setTimeout(() => {
    buddiesChangedTimer = null;
    applicationContext.broadcast({ type: 'buddies_changed' });
  }, 250);
  buddiesChangedTimer.unref();
};

// A Buddy's stable conversations (DM, thread seats): owner-origin creation.
const buddyConversations: StableConversationPorts = {
  slot: async (conversationId) => slotOf(await conversationConfigService.getRecord(conversationId)),
  getConversation: (id) => applicationContext.registry.get(id),
  ensureConversationReady: buddyCreationService.ensureConversationReady,
  createConversation: (input) => buddyCreationService.createServerBuddyConversation(input),
  reconfigure: (conversation, config, provenance) =>
    replaceRuntimeConfig(conversationConfigService, conversation, config, provenance),
};

// One channel's posts or responders changed: clients refresh only that channel's views.
const channelChanged = (channelId: string) =>
  applicationContext.broadcast({ type: 'channel_changed', channelId });
const buddyChannels = createChannels({
  installedAgent: () => installedAgent(),
  core: buddiesCore,
  events: buddyEvents,
  channelChanged,
  conversations: buddyConversations,
  uploadsRoot: () => UPLOADS_DIR,
  // Resolved by the same authority as conversations, so the gate runs exactly the
  // harness/model the Buddy's reply would.
  gate: createCliReplyGate({
    resolveExecution: async (config) => {
      const resolution = await conversationConfigService.resolve(config);
      if (resolution.status !== 'resolved') throw new Error(resolution.error.message);
      return resolution.value;
    },
  }),
});
buddyEvents.on((event) => {
  if (event.kind === 'changed') buddiesChanged();
});

registerBuddyRoutes(app, {
  core: buddiesCore,
  events: buddyEvents,
  runner: buddyRunner,
  channels: buddyChannels,
  uploadsRoot: () => UPLOADS_DIR,
  channelChanged,
  onBuddyArchived: (buddyId) => {
    applicationContext.broadcast({ type: 'buddy_archived', buddyId });
    for (const conversation of conversations.values()) {
      if (conversation.buddyContext?.buddyId === buddyId) {
        conversation.clearQueue();
        conversation.stop();
      }
    }
  },
  createBuilderConversation: async (workingDirectory) => {
    const conversation = await buddyCreationService.createBuddyBuilderConversation({
      commandId: `buddy-builder-${uuidv4()}`,
      // A slack New Buddy passes that workspace's root. Sidebar New Buddy
      // passes nothing and stays on the install checkout.
      workingDirectory: workingDirectory ?? resolveDefaultWorkingDirectory(),
    });
    return { conversationId: conversation.id };
  },
});

// First-run "unleashd" workspace + fetch-only upstream check (upstream/routes.ts).
// The update action posts through the same owner-post path as the routes above.
const upstream = createUpstreamService({
  serverDirectory: __dirname,
  core: buddiesCore,
  events: buddyEvents,
  uploadsRoot: () => UPLOADS_DIR,
});
upstream.registerRoutes(app);

registerSearchRoutes(
  app,
  async (query, limit) => {
    const slot = currentIngest();
    if (slot.t !== 'ready') return [];
    const list = await listReady;
    return (await slot.ingest.search(query, limit)).flatMap((hit) => {
      const located = list.locate(hit.sessionId);
      return located
        ? [
            {
              ...located,
              messageIndex: hit.message.seq,
              role: hit.message.role,
              content: hit.message.content,
              timestamp: new Date(hit.message.at ?? 0),
            },
          ]
        : [];
    });
  },
  async () => {
    const archived = await archivedBuddyIdsOrNone();
    return (conversationId) => {
      const buddy = conversations.get(conversationId)?.buddyContext;
      return !buddy || !archived.has(buddy.buddyId);
    };
  }
);

// Every listed conversation's directory, not only the runtimes' (most listed ones have none).
const knownProjectRoots = () => [
  ...Array.from(conversations.values(), (conversation) => conversation.workingDirectory),
  ...(conversationList?.rows().map((row) => row.cwd) ?? []),
];
const isUnderKnownProject = createKnownProjectAuthorizer(knownProjectRoots);
registerFilesystemRoutes(app, {
  uploadsDirectory: UPLOADS_DIR,
  isUnderKnownProject,
});

registerSwarmRoutes(app, {
  isUnderKnownProject,
  listProjectRoots: knownProjectRoots,
  resolveWorkingDirectory: resolveWorkingDirectoryInput,
  commandTimeoutMs: SWARM_CONTEXT_COMMAND_TIMEOUT_MS,
});

const paletteService = createPaletteService({
  directory: path.join(APP_DATA_DIR, 'palettes'),
  generationTimeoutMs: PALETTE_GENERATION_TIMEOUT_MS,
  debugRawEvents: AGENT_CLI_DEBUG_EVENTS,
  cwd: process.cwd(),
  ports: {
    startGeneration: executeCommand,
    validateProvider: (provider) => {
      ProviderSchema.parse(provider);
    },
    buildPrompt: buildPalettePrompt,
  },
});
paletteService.registerRoutes(app);

registerUsageRoutes(app, ProviderSchema.options, currentIngest);
registerStaticClient(app, path.join(__dirname, '../../client/dist'));

const captureUnhandledHttpError: ErrorRequestHandler = (error, request, response, next) => {
  console.error(`[http] Unhandled ${request.method} ${request.path}:`, error);
  if (response.headersSent) {
    next(error);
    return;
  }
  response.status(500).json({ error: 'Internal server error' });
};
app.use(captureUnhandledHttpError);

shutdownController = registerShutdownHandlers(
  {
    forceExitGraceMs: HOT_RELOAD_FORCE_EXIT_GRACE_MS,
    flushGraceMs: SHUTDOWN_FLUSH_GRACE_MS,
  },
  {
    conversations: () => conversations.values(),
    activeSchedulerRuns: () => memoryReviewer.activeCount(),
    pauseScheduler: pauseBuddyScheduler,
    resumeScheduler: resumeBuddyScheduler,
    stopScheduler: stopBuddyScheduler,
    flushState: async () => {
      upstream.stop();
      dependencyChecks.close();
      await Promise.all([turnAttemptJournal.flush(), errorJournal.flush()]);
      await buddyMcp?.close();
      if (bootedIngest) {
        const { ingest, list } = await bootedIngest;
        list.stop();
        await ingest.stop();
      }
    },
    broadcastMessage: (conversationId, content) => {
      applicationContext.broadcast({ type: 'message', conversationId, role: 'system', content });
    },
    exit: (code = 0) => process.exit(code),
  }
);

const runtimeBuilder = createRuntimeBuilder({
  registry: applicationContext.registry,
  records: conversationConfigStore,
  configService: conversationConfigService,
  joined: (id) => conversationList?.joined(id),
  createConversation: (options) => new Conversation(options),
  resolveBuddyConversation,
  dispatchInitialMessage: buddyCreationService.dispatchInitialMessageIfPending,
  broadcast: applicationContext.broadcast,
});

void runServerStartup(
  {
    port: portNumber,
    host: LISTEN_HOST,
    development: process.env.NODE_ENV === 'development',
    developmentClientPort: DEV_CLIENT_PORT,
    // A TTY means a person ran `pnpm start`; tests and agent-launched servers
    // pipe stdout and must never open a browser window (see StartupOptions).
    browser: process.stdout.isTTY ? 'open' : 'none',
  },
  {
    server,
    initialize: async () => {
      await errorJournal.initialize();
      await conversationConfigStore.opened();
      installConsoleErrorCapture(errorJournal);
      startEventLoopStallMonitor(errorJournal);
      // Crashes the dev runner recorded while no backend was alive to journal them.
      void reportBackendExits(errorJournal, path.join(APP_DATA_DIR, 'observability')).catch(
        (error) => console.error('[backend-exits] Failed to journal recorded backend exits:', error)
      );
      // The one Buddy tool endpoint, on its own loopback listener (never the gated app).
      buddyMcp = await startMcpEndpoint({
        core: buddiesCore,
        events: buddyEvents,
        grants: buddyGrants,
        uploadsRoot: () => UPLOADS_DIR,
      });
      // Background, never awaited: bootstrap and the upstream fetch must not
      // hold startup, and their failures are logged after capture is installed.
      upstream.start();
      startupAuditResults = auditLocalAgents();
      await turnAttemptJournal.initialize();
      await persistedServerState.initialize();
      await paletteService.initialize();
      // Uploads retention: a worker-thread pass now and daily. Every place a message or post can
      // name an upload is a reference root; see uploads/gc.ts for the deletion rule.
      startUploadsGc(async () => ({
        uploadsDir: UPLOADS_DIR,
        referenceRoots: [
          // The transcript roots the ingest store watches, plus Codex's archive (not ingested).
          ...defaultRoots(os.homedir()).map((root) => root.path),
          path.join(os.homedir(), '.codex', 'archived_sessions'),
          APP_DATA_DIR,
          path.dirname(buddiesDatabasePath()),
        ],
        protectedNames: [
          ...(await conversationConfigStore.listSummaries()).map((record) => record.conversationId),
          ...conversations.keys(),
        ],
        maxAgeMs: UPLOADS_RETENTION_MS,
      }));
    },
    startOptionalScheduler: async () => {
      try {
        await buddiesReady;
        await buddyRunner.start();
        memoryReviewer.start();
        console.log('Buddy runner started');
      } catch (error) {
        console.warn('[buddies] Runner unavailable:', error);
      }
    },
    pauseOptionalScheduler: pauseBuddyScheduler,
    isStartupActive: () => shutdownController?.state === 'starting',
    markReady: () => {
      if (!shutdownController?.completeStartup()) return false;
      resolveInitialLoad();
      applicationContext.broadcast({
        type: 'ready',
        conversationIds: [
          ...new Set([...conversations.keys(), ...(conversationList?.ids() ?? [])]),
        ],
      });
      return true;
    },
    abortStartup: () => shutdownController?.abortStartup(),
    // The list (and every history) comes from the ingest store; app-created records then
    // become runtimes, joined with their sessions. `ready` names both.
    loadConversations: async () => {
      await startIngestList();
      await runtimeBuilder.recover();
    },
  }
)
  .catch((error) => {
    console.error('Server startup failed before authoritative state was ready:', error);
    shutdownController?.handleStartupFailure();
  })
  // Startup has three terminal outcomes — ready, aborted early, threw — and only
  // the first resolved this barrier. The other two left every non-create WS
  // command awaiting it forever with no reply (incident 2026-08-20). Resolving
  // here covers all three; it is idempotent with the call in markReady.
  .finally(() => resolveInitialLoad());
