/**
 * API Tests for Claude Multi-Chat
 *
 * Spins up the server and tests WebSocket communication
 * Run with: npm test
 */

const WebSocket = require('ws');
const { PROTOCOL_VERSION, WS_PATH } = require('@unleashd/shared');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Overridable: another local process (a Remotion render, 2026-09-26) held 3001 and failed the gate.
const PORT = Number(process.env.API_TEST_PORT ?? 3001);
const SERVER_URL = `ws://localhost:${PORT}${WS_PATH}`;

let serverProcess = null;
let testDataDir = null;

/**
 * Start the server on test port
 */
function startServer({ reuseDataDir = false } = {}) {
  return new Promise((resolve, reject) => {
    if (!reuseDataDir || !testDataDir) {
      testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unleashd-api-'));
    }
    const shimDir = path.join(testDataDir, 'bin');
    fs.mkdirSync(shimDir, { recursive: true });
    const claudeShim = path.join(shimDir, 'claude');
    fs.writeFileSync(claudeShim, '#!/bin/sh\nexit 0\n', 'utf8');
    fs.chmodSync(claudeShim, 0o755);
    const env = {
      ...process.env,
      HOME: testDataDir,
      PATH: `${shimDir}${path.delimiter}${process.env.PATH ?? ''}`,
      PORT: PORT,
      UNLEASHD_DATA_DIR: testDataDir,
    };
    // Use the installed loader directly. `npx tsx` may perform package
    // resolution/update checks and exhaust the startup timeout before Node is
    // even spawned, especially on a cold or offline machine.
    serverProcess = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
      cwd: path.join(__dirname, '..', 'server'),
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let started = false;
    const startupTimeout = setTimeout(() => {
      if (!started) reject(new Error('Server failed to start within 15 seconds'));
    }, 15_000);

    serverProcess.stdout.on('data', (data) => {
      const output = data.toString();
      console.log('[Server]', output.trim());
      if (output.includes('Server running') && !started) {
        started = true;
        clearTimeout(startupTimeout);
        setTimeout(resolve, 500); // Give server async init time (7000+ files parsed)
      }
    });

    serverProcess.stderr.on('data', (data) => {
      console.error('[Server Error]', data.toString().trim());
    });

    serverProcess.on('error', (error) => {
      clearTimeout(startupTimeout);
      reject(error);
    });
  });
}

/**
 * Stop the server
 */
async function stopServer({ preserveDataDir = false } = {}) {
  const processToStop = serverProcess;
  serverProcess = null;
  if (processToStop) {
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 3000);
      processToStop.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      processToStop.kill('SIGTERM');
    });
  }
  if (!preserveDataDir && testDataDir) {
    fs.rmSync(testDataDir, { recursive: true, force: true });
    testDataDir = null;
  }
}

// Protocol v3 (T09, shared/src/index.ts): the server greets with `hello`, answers
// every correlated command with one `ack` (created | accepted | rejected), and
// moves state with `rows` / `patch` / `removed`. Config, queue and session live
// in GET /api/conversations/:id, not on the wire rows. This file spoke v2
// (`init`, `conversation_created`, `command_rejected`, ...) until 2026-09-26 and
// failed 14 of 16 from T09 on; every wait timed out on a message that no longer
// exists. Waits are predicate-based so a test names WHICH ack/patch it expects.

/**
 * Create WebSocket connection
 */
function createConnection() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(SERVER_URL);
    ws._messageQueue = [];
    ws._messageWaiters = [];
    ws.on('message', (data) => {
      let message;
      try {
        message = JSON.parse(data.toString());
      } catch (_error) {
        return; // Ignore malformed server output in this protocol-level helper.
      }
      const index = ws._messageWaiters.findIndex((waiter) => waiter.matches(message));
      if (index >= 0) ws._messageWaiters.splice(index, 1)[0].resolve(message);
      else ws._messageQueue.push(message);
    });
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
    setTimeout(() => reject(new Error('Connection timeout')), 3000);
  });
}

/** Wait for the first message (queued or future) that `matches`. */
function waitFor(ws, label, matches, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const queuedIndex = ws._messageQueue.findIndex(matches);
    if (queuedIndex >= 0) {
      resolve(ws._messageQueue.splice(queuedIndex, 1)[0]);
      return;
    }
    const waiter = {
      matches,
      resolve: (message) => {
        clearTimeout(timer);
        resolve(message);
      },
    };
    const timer = setTimeout(() => {
      const index = ws._messageWaiters.indexOf(waiter);
      if (index >= 0) ws._messageWaiters.splice(index, 1);
      reject(new Error(`Timeout waiting for ${label}`));
    }, timeout);
    ws._messageWaiters.push(waiter);
  });
}

const waitForMessage = (ws, type) => waitFor(ws, `message type: ${type}`, (m) => m.type === type);
const waitForAck = (ws, commandId, t) =>
  waitFor(
    ws,
    `ack ${t} for ${commandId}`,
    (m) => m.type === 'ack' && m.commandId === commandId && m.result.t === t
  );
const waitForPatch = (ws, id, t) =>
  waitFor(ws, `patch ${t} for ${id}`, (m) => m.type === 'patch' && m.id === id && m.patch.t === t);
const waitForRemoved = (ws, id) =>
  waitFor(ws, `removed ${id}`, (m) => m.type === 'removed' && m.ids.includes(id));
const waitForRows = (ws, id) =>
  waitFor(ws, `rows with ${id}`, (m) => m.type === 'rows' && m.rows.some((row) => row.id === id));
const rowIds = (hello) => hello.rows.map((row) => row.id);

/** The detail route: config state (revision + resolution), queue, sessionId. */
async function detail(conversationId) {
  const response = await fetch(`http://localhost:${PORT}/api/conversations/${conversationId}`);
  if (!response.ok) throw new Error(`Detail ${conversationId}: HTTP ${response.status}`);
  return response.json();
}

/**
 * Send WebSocket message
 */
function send(ws, data) {
  ws.send(JSON.stringify(data));
}

function createConversationCommand(overrides = {}) {
  const provider = overrides.provider ?? 'claude';
  return {
    type: 'create_conversation',
    commandId: crypto.randomUUID(),
    conversationId: crypto.randomUUID(),
    workingDirectory: overrides.workingDirectory ?? process.cwd(),
    kind: { t: 'chat' },
    config: {
      provider,
      model: overrides.model ? { mode: 'explicit', modelId: overrides.model } : { mode: 'default' },
      reasoning:
        overrides.reasoningEffort === null
          ? { mode: 'disabled' }
          : overrides.reasoningEffort
            ? { mode: 'explicit', effort: overrides.reasoningEffort }
            : { mode: 'default' },
    },
  };
}

/** Send a create and return its `created` ack's row. */
async function createConversation(ws, overrides) {
  const command = createConversationCommand(overrides);
  send(ws, command);
  const ack = await waitForAck(ws, command.commandId, 'created');
  const row = ack.result.rows.rows[0];
  if (row?.id !== command.conversationId) throw new Error('Created ack carried the wrong row');
  return { command, row, cwd: ack.result.rows.cwds[row.cwd] };
}

async function deleteConversation(ws, conversationId) {
  send(ws, { type: 'delete_conversation', conversationId });
  await waitForRemoved(ws, conversationId);
}

// Test runner
async function runTests() {
  console.log('\n🧪 Starting API Tests\n');
  let passed = 0;
  let failed = 0;

  async function test(name, fn) {
    try {
      await fn();
      console.log(`✅ ${name}`);
      passed++;
    } catch (err) {
      console.log(`❌ ${name}`);
      console.log(`   Error: ${err.message}`);
      failed++;
    }
  }

  // Retry wrapper for tests that race against server async init (7000+ file parse).
  // A wait can time out if the server hasn't finished loading when the
  // test fires. Retrying with backoff is more robust than a single long timeout.
  async function testWithRetry(name, fn, retries = 2) {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        await fn();
        console.log(`✅ ${name}`);
        passed++;
        return;
      } catch (err) {
        if (attempt < retries) {
          console.log(`⚠️  ${name} (attempt ${attempt} failed, retrying...)`);
          await new Promise((r) => setTimeout(r, 500));
        } else {
          console.log(`❌ ${name}`);
          console.log(`   Error: ${err.message}`);
          failed++;
        }
      }
    }
  }

  try {
    // Start server
    console.log('Starting server...');
    await startServer();
    console.log('Server started on port', PORT);
    console.log('');

    await test('Connect and receive hello', async () => {
      const ws = await createConnection();
      const msg = await waitForMessage(ws, 'hello');
      if (!Array.isArray(msg.rows)) throw new Error('Missing rows array');
      if (!msg.defaultCwd) throw new Error('Missing defaultCwd');
      // The wire was already v4 at 4f16903; a literal v3 expectation failed this real hello.
      // Pattern: one-definition (docs/patterns.md#one-definition)
      if (msg.protocol?.version !== PROTOCOL_VERSION)
        throw new Error(`Missing protocol v${PROTOCOL_VERSION} capability`);
      ws.close();
    });

    await test('Provider catalog exposes Sol, Terra, and Luna', async () => {
      const response = await fetch(`http://localhost:${PORT}/api/provider-catalog`);
      if (!response.ok) throw new Error(`Catalog request failed: HTTP ${response.status}`);
      const catalog = await response.json();
      const codex = catalog.providers?.find((provider) => provider.id === 'codex');
      if (!codex) throw new Error('Missing Codex catalog entry');
      const modelIds = codex.models.map((model) => model.id);
      for (const expected of ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-6-astra']) {
        if (!modelIds.includes(expected)) throw new Error(`Missing catalog model ${expected}`);
      }
    });

    await test('Create and revisioned config update are authoritative', async () => {
      const ws = await createConnection();
      await waitForMessage(ws, 'hello');
      const { command } = await createConversation(ws, {
        workingDirectory: '/tmp',
        provider: 'codex',
        model: 'gpt-5.6-luna',
      });
      const conversationId = command.conversationId;
      const created = await detail(conversationId);
      if (created.config.revision !== 0) throw new Error('Expected revision 0');
      if (created.config.config.model.modelId !== 'gpt-5.6-luna') {
        throw new Error('Canonical config was not preserved');
      }

      // Idempotent retry: the same commandId + conversationId acks `created` again.
      send(ws, command);
      await waitForAck(ws, command.commandId, 'created');
      if ((await detail(conversationId)).config.revision !== 0) {
        throw new Error('Idempotent create retry changed authoritative state');
      }

      const updateCommandId = crypto.randomUUID();
      send(ws, {
        type: 'set_conversation_config',
        commandId: updateCommandId,
        conversationId,
        expectedRevision: 0,
        patch: { kind: 'set_model', model: { mode: 'explicit', modelId: 'gpt-5.6-terra' } },
      });
      // The config patch carrying this commandId is the requester's acknowledgement.
      const updated = await waitFor(
        ws,
        'config patch for the update',
        (m) => m.type === 'patch' && m.patch.t === 'config' && m.patch.commandId === updateCommandId
      );
      if (updated.patch.state.revision !== 1) throw new Error('Expected revision 1');

      const staleCommandId = crypto.randomUUID();
      send(ws, {
        type: 'set_conversation_config',
        commandId: staleCommandId,
        conversationId,
        expectedRevision: 0,
        patch: { kind: 'set_reasoning', reasoning: { mode: 'disabled' } },
      });
      const rollback = await waitForPatch(ws, conversationId, 'config');
      const rejected = await waitForAck(ws, staleCommandId, 'rejected');
      if (rejected.result.error.code !== 'revision_conflict') {
        throw new Error(`Expected revision_conflict, got ${rejected.result.error.code}`);
      }
      if (rollback.patch.state.revision !== 1) {
        throw new Error('Rejection was not preceded by the authoritative config patch');
      }

      await deleteConversation(ws, conversationId);
      ws.close();
    });

    // Test: Create conversation (retry — races with server async init)
    await testWithRetry('Create new conversation', async () => {
      const ws = await createConnection();
      await waitForMessage(ws, 'hello');
      const { cwd } = await createConversation(ws);
      if (!cwd) throw new Error('Missing working directory');
      ws.close();
    });

    await test('Create conversation with custom directory', async () => {
      const ws = await createConnection();
      await waitForMessage(ws, 'hello');
      const { cwd } = await createConversation(ws, { workingDirectory: '/tmp' });
      if (cwd !== '/tmp') throw new Error(`Expected /tmp, got ${cwd}`);
      ws.close();
    });

    await test('Codex model defaults and explicit no-reasoning stay distinct', async () => {
      const ws = await createConnection();
      await waitForMessage(ws, 'hello');

      const defaulted = await createConversation(ws, {
        workingDirectory: '/tmp',
        provider: 'codex',
        model: 'gpt-5.6-terra',
      });
      const defaultedEffort = (await detail(defaulted.row.id)).config.resolution.value
        .reasoningEffort;
      if (defaultedEffort !== 'medium') {
        throw new Error(`Expected Terra app default medium, got ${defaultedEffort}`);
      }

      const noReasoning = await createConversation(ws, {
        workingDirectory: '/tmp',
        provider: 'codex',
        model: 'gpt-5.6-sol',
        reasoningEffort: null,
      });
      const noEffort = (await detail(noReasoning.row.id)).config.resolution.value.reasoningEffort;
      if (noEffort !== undefined) {
        throw new Error(`Expected explicit no-reasoning to omit the flag, got ${noEffort}`);
      }

      ws.close();
    });

    await test('Conversation lifecycle and provider updates reach every client', async () => {
      const ws1 = await createConnection();
      await waitForMessage(ws1, 'hello');
      const ws2 = await createConnection();
      await waitForMessage(ws2, 'hello');

      const command = createConversationCommand({
        workingDirectory: '/tmp',
        provider: 'codex',
        model: 'gpt-5.6-sol',
        reasoningEffort: 'minimal',
      });
      const id = command.conversationId;
      const createdOnSecond = waitForRows(ws2, id);
      send(ws1, command);
      await Promise.all([waitForAck(ws1, command.commandId, 'created'), createdOnSecond]);

      const updateOnSecondClient = waitForPatch(ws2, id, 'config');
      send(ws1, {
        type: 'set_conversation_config',
        commandId: crypto.randomUUID(),
        conversationId: id,
        expectedRevision: 0,
        patch: { kind: 'set_provider', provider: 'claude' },
      });
      const resolved = (await updateOnSecondClient).patch.state.resolution.value;
      if (resolved.provider !== 'claude')
        throw new Error(`Expected claude, got ${resolved.provider}`);
      // The default is the catalog's to choose (it moved opus -> claude-opus-5-5); assert that
      // the switch resolved to it, not to the codex model the conversation carried.
      const catalog = await (await fetch(`http://localhost:${PORT}/api/provider-catalog`)).json();
      const claudeDefault = catalog.providers.find((p) => p.id === 'claude').defaultModelId;
      if (resolved.modelId !== claudeDefault) {
        throw new Error(`Expected Claude default ${claudeDefault}, got ${resolved.modelId}`);
      }
      if (resolved.reasoningEffort !== 'medium') {
        throw new Error(`Expected Claude app default effort medium, got ${resolved.reasoningEffort}`);
      }

      const deletedOnSecond = waitForRemoved(ws2, id);
      await deleteConversation(ws1, id);
      await deletedOnSecond;

      ws1.close();
      ws2.close();
    });

    await test('Invalid directory returns error', async () => {
      const ws = await createConnection();
      await waitForMessage(ws, 'hello');
      const command = createConversationCommand({ workingDirectory: '/nonexistent/path/12345' });
      send(ws, command);
      const msg = await waitForAck(ws, command.commandId, 'rejected');
      if (!msg.result.error.message.includes('No matching folder')) {
        throw new Error(`Expected 'No matching folder' error, got: ${msg.result.error.message}`);
      }
      ws.close();
    });

    await test('Delete conversation', async () => {
      const ws = await createConnection();
      await waitForMessage(ws, 'hello');
      const { row } = await createConversation(ws);
      await deleteConversation(ws, row.id);
      ws.close();
    });

    // Test: Multiple connections receive same state (retry — races with server async init)
    await testWithRetry('Multiple connections sync state', async () => {
      const ws1 = await createConnection();
      const hello1 = await waitForMessage(ws1, 'hello');
      const { row } = await createConversation(ws1);

      const ws2 = await createConnection();
      const hello2 = await waitForMessage(ws2, 'hello');
      if (!rowIds(hello2).includes(row.id) || hello2.rows.length !== hello1.rows.length + 1) {
        throw new Error('Second connection missing new conversation');
      }

      ws1.close();
      ws2.close();
    });

    // Test: Upload rejects path traversal in conversationId
    await test('Upload rejects path traversal in conversationId', async () => {
      const http = require('node:http');
      const boundary = `----TestBoundary${Date.now()}`;
      const body = [
        `--${boundary}`,
        'Content-Disposition: form-data; name="conversationId"',
        '',
        '../../etc',
        `--${boundary}`,
        'Content-Disposition: form-data; name="files"; filename="test.txt"',
        'Content-Type: text/plain',
        '',
        'hello',
        `--${boundary}--`,
      ].join('\r\n');

      const result = await new Promise((resolve, reject) => {
        const req = http.request(
          {
            hostname: 'localhost',
            port: PORT,
            path: '/api/upload',
            method: 'POST',
            headers: {
              'Content-Type': `multipart/form-data; boundary=${boundary}`,
              'Content-Length': Buffer.byteLength(body),
            },
          },
          (res) => {
            let data = '';
            res.on('data', (chunk) => {
              data += chunk;
            });
            res.on('end', () => resolve({ status: res.statusCode, body: data }));
          }
        );
        req.on('error', reject);
        req.write(body);
        req.end();
      });

      if (result.status < 400) {
        throw new Error(`Expected 4xx, got ${result.status}`);
      }
    });

    // Test: Malformed WS message returns error (not crash)
    await test('Malformed WS message returns error', async () => {
      const ws = await createConnection();
      await waitForMessage(ws, 'hello');

      // Missing commandId, conversationId and content: no command to reject, so a protocol error.
      send(ws, { type: 'queue_message' });
      await waitForMessage(ws, 'error');
      // Server should not crash — verify by sending a valid message after
      await createConversation(ws);

      ws.close();
    });

    await test('Malformed correlated command returns a structured rejection', async () => {
      const ws = await createConnection();
      await waitForMessage(ws, 'hello');
      const commandId = crypto.randomUUID();

      send(ws, {
        type: 'create_conversation',
        commandId,
        conversationId: crypto.randomUUID(),
        workingDirectory: '/tmp',
      });
      const rejected = await waitForAck(ws, commandId, 'rejected');
      if (rejected.result.error?.code !== 'invalid_message') {
        throw new Error(`Expected invalid_message, got ${rejected.result.error?.code}`);
      }

      ws.close();
    });

    // Test: interrupt_and_send is handled and preserves the interruption message
    await test('interrupt_and_send queues interruption message', async () => {
      const ws = await createConnection();
      await waitForMessage(ws, 'hello');
      const { row } = await createConversation(ws, { workingDirectory: '/tmp' });

      const commandId = crypto.randomUUID();
      send(ws, {
        type: 'interrupt_and_send',
        commandId,
        conversationId: row.id,
        content: 'follow-up after interrupt',
      });
      const queuePatch = await waitFor(
        ws,
        'non-empty queue patch',
        (m) =>
          m.type === 'patch' && m.id === row.id && m.patch.t === 'queue' && m.patch.queue.length
      );
      await waitForAck(ws, commandId, 'accepted');

      const queue = queuePatch.patch.queue;
      if (queue.length !== 1)
        throw new Error(`Expected 1 queued interruption, got ${queue.length}`);
      if (queue[0].content !== 'follow-up after interrupt') {
        throw new Error(`Expected raw interruption content, got: ${queue[0].content}`);
      }
      if (!['pending', 'sending'].includes(queue[0].status)) {
        throw new Error(`Expected status "pending" or "sending", got ${queue[0].status}`);
      }

      ws.close();
    });

    // Test: Deleted conversation does not reappear on new connection (retry — races with server async init)
    await testWithRetry('Deleted conversation stays deleted on reconnect', async () => {
      const ws1 = await createConnection();
      const hello1 = await waitForMessage(ws1, 'hello');
      const baseCount = hello1.rows.length;

      const { row } = await createConversation(ws1);
      await deleteConversation(ws1, row.id);
      ws1.close();

      const ws2 = await createConnection();
      const hello2 = await waitForMessage(ws2, 'hello');
      if (rowIds(hello2).includes(row.id)) throw new Error('Deleted conversation reappeared');
      if (hello2.rows.length !== baseCount) {
        throw new Error(`Expected ${baseCount} conversations, got ${hello2.rows.length}`);
      }

      ws2.close();
    });

    await test('Active lifecycle records recover and tombstones survive a server restart', async () => {
      const ws = await createConnection();
      await waitForMessage(ws, 'hello');
      const overrides = {
        workingDirectory: '/tmp',
        provider: 'codex',
        model: 'gpt-5.6-luna',
        reasoningEffort: null,
      };
      const active = (await createConversation(ws, overrides)).row.id;
      const deleted = (await createConversation(ws, overrides)).row.id;
      await deleteConversation(ws, deleted);
      ws.close();

      await stopServer({ preserveDataDir: true });
      await startServer({ reuseDataDir: true });

      const restarted = await createConnection();
      const hello = await waitForMessage(restarted, 'hello');
      if (!rowIds(hello).includes(active)) throw new Error('Active conversation was not recovered');
      if (rowIds(hello).includes(deleted)) {
        throw new Error('Tombstoned conversation resurrected after restart');
      }
      const recovered = await detail(active);
      if (recovered.sessionId !== active) {
        throw new Error(`Pristine conversation incorrectly resumed ${recovered.sessionId}`);
      }
      if (recovered.config.resolution.value.modelId !== 'gpt-5.6-luna') {
        throw new Error(`Recovered wrong model: ${recovered.config.resolution.value.modelId}`);
      }
      restarted.close();
    });

    console.log(`\n${'='.repeat(40)}`);
    console.log(`Results: ${passed} passed, ${failed} failed`);
    console.log(`${'='.repeat(40)}\n`);
  } finally {
    await stopServer();
  }

  process.exit(failed > 0 ? 1 : 0);
}

// Run tests
runTests().catch((err) => {
  console.error('Test runner error:', err);
  void stopServer().finally(() => process.exit(1));
});
