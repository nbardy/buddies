import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { executeCommand, resolveBinary } from '@nbardy/agent-cli';
import { buddyKind, createDefaultConversationConfig } from '@unleashd/shared';
import { type ConversationOptions, createConversationRuntime } from '../src/conversations/runtime';
import { resolveConfigAgainstProviderCatalog } from '../src/providers/catalog-service';
import { fakeBuddyPort } from './fixtures/buddy-port';
import { testExecutions } from './fixtures/fake-turn';

// Owner-approved 2026-09-28: Claude's auto-memory (~/.claude/projects/<cwd>/memory) is the
// owner's, and Buddy turns read and wrote it (src/buddies/harness-memory.ts). The real runner and
// the real agent-cli spawn a fake `claude` from PATH; the argv that process receives is asserted.
// Its own file because agent-cli caches `which claude` per process: a runtime test that spawned
// the real binary first would make this one launch the real CLI.

const scratch = mkdtempSync(join(tmpdir(), 'harness-memory-'));
const argvLog = join(scratch, 'argv.jsonl');
const fakeClaude = join(scratch, 'claude');
writeFileSync(
  fakeClaude,
  `#!/usr/bin/env node
require('node:fs').appendFileSync(${JSON.stringify(argvLog)}, JSON.stringify(process.argv.slice(2)) + '\\n');
console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'fake-session' }));
console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 'fake-session' }));
`
);
chmodSync(fakeClaude, 0o755);
process.env.PATH = `${scratch}:${process.env.PATH}`;

/** What the spawned process was told about auto-memory: absent means the owner's settings rule. */
function autoMemorySetting(argv: string[]): unknown {
  const at = argv.indexOf('--settings');
  return at < 0 ? 'inherited' : JSON.parse(argv[at + 1]).autoMemoryEnabled;
}

test('Buddy turns run with harness auto-memory off; an owner chat keeps it', async (t) => {
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  assert.equal(resolveBinary('claude'), fakeClaude, 'never spawn the real CLI from a test');

  const config = createDefaultConversationConfig('claude');
  const Conversation = createConversationRuntime({
    executions: testExecutions(),
    broadcast: () => undefined,
    registerSessionAlias: () => undefined,
    unregisterSessionAlias: () => undefined,
    clearExternalRunningStatus: () => undefined,
    clearLocalCompletionSuppression: () => undefined,
    markLocalCompletionSuppression: () => undefined,
    persistCurrentSession: async () => undefined,
    getConversation: () => undefined,
    readLatestOompaRuntime: async () => ({ available: false, run: null, reason: 'fixture' }),
    createSessionId: () => 'rotated-session',
    executeTurn: executeCommand,
    buddies: fakeBuddyPort(),
  });
  const spawnedArgv = async (kind: ConversationOptions['kind'], id: string) => {
    const conversation = new Conversation({
      done: false,
      id,
      workingDirectory: scratch,
      configState: { config, revision: 0, resolution: resolveConfigAgainstProviderCatalog(config) },
      kind,
    });
    const spawns = () =>
      existsSync(argvLog) ? readFileSync(argvLog, 'utf8').trim().split('\n') : [];
    const before = spawns().length;
    conversation.sendMessage('hello', { origin: 'owner_input', inputId: id });
    const deadline = Date.now() + 20_000;
    while (spawns().length === before || conversation.isRunning) {
      if (Date.now() > deadline) throw new Error(`${id}: the fake claude turn never finished`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return JSON.parse(spawns()[before]) as string[];
  };

  const buddy = await spawnedArgv(
    buddyKind({ buddyId: 'buddy-1', workspaceId: 'workspace-1' }),
    'buddy-thread'
  );
  assert.equal(autoMemorySetting(buddy), false, 'a Buddy turn loads no harness memory');
  const chat = await spawnedArgv({ t: 'chat' }, 'owner-chat');
  assert.equal(autoMemorySetting(chat), 'inherited', "an owner chat keeps the owner's memory");
});
