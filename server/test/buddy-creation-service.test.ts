import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { type BuddyContext, createDefaultConversationConfig } from '@unleashd/shared';
import {
  type BuddyCreationServicePorts,
  createBuddyCreationService,
} from '../src/conversations/buddy-creation-service';
import { installedAgent } from '../src/providers/installed-agent';
import { creationFingerprint } from '../src/conversations/creation-service';
import type { ConversationOptions, ConversationRuntime } from '../src/conversations/runtime';

const context = {
  buddyId: 'buddy-1',
  workspaceId: 'workspace-1',
  buddyProjectId: null,
};

test('creation fingerprint is stable and covers message intent', () => {
  const base = {
    workingDirectory: '/workspace',
    config: createDefaultConversationConfig('codex'),
    buddyContext: context,
  };
  assert.equal(creationFingerprint(base), creationFingerprint({ ...base }));
  assert.notEqual(
    creationFingerprint(base),
    creationFingerprint({ ...base, initialMessage: 'Ship it' })
  );
});

test('server Buddy creation persists, registers, broadcasts, links, and dispatches once', async () => {
  const registered: ConversationRuntime[] = [];
  const broadcasts: unknown[] = [];
  const linked: string[] = [];
  const queued: string[] = [];
  const creates: unknown[] = [];
  const conversationOptions: ConversationOptions[] = [];
  let claimed = false;
  let nextId = 0;

  class FakeConversation extends EventEmitter {
    readonly id: string;
    readonly sessionId: string;
    readonly provider = 'codex' as const;
    readonly config = createDefaultConversationConfig('codex');
    readonly buddyContext = context;
    readonly messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];

    constructor(options: ConversationOptions) {
      super();
      this.id = options.id;
      this.sessionId = options.id;
    }

    enqueueMessage(message: string): void {
      queued.push(message);
    }

    publishRow(): void {
      broadcasts.push({ type: 'rows', id: this.id });
    }
  }

  const config = createDefaultConversationConfig('codex');
  const ports = {
    getConversation: (id: string) => registered.find((c) => c.id === id),
    configService: {
      async createOrReplay(input: unknown) {
        creates.push(input);
        return {
          record: {},
          state: {
            config,
            revision: 0,
            resolution: {
              status: 'resolved',
              value: { provider: 'codex', model: 'gpt-5.6-sol' },
            },
          },
        };
      },
      async claimInitialMessageDispatch() {
        if (claimed) return undefined;
        claimed = true;
        return {
          creation: {
            initialMessage: 'Start here',
            initialMessageDispatchClaimedAt: new Date().toISOString(),
            initialMessageDispatchClaimToken: 'claim-1',
          },
        };
      },
      async completeInitialMessageDispatch() {
        return {
          creation: {
            initialMessage: 'Start here',
            initialMessageDispatchedAt: new Date().toISOString(),
          },
        };
      },
      async getRecord() {
        return {
          creation: {
            initialMessage: 'Start here',
            initialMessageDispatchedAt: claimed ? new Date().toISOString() : undefined,
          },
        };
      },
      async setCurrentSession() {},
    },
    installedAgent: () => ({ kind: 'agent' as const, provider: 'codex' as const }),
    resolveBuddyConversation: async (requested: BuddyContext) => ({
      context: { ...context, ...requested },
      briefing: 'briefing',
      workingDirectory: '/workspace',
      execution: {
        kind: 'run' as const,
        provider: 'codex' as const,
        model: 'gpt-5.6-sol',
        reasoningEffort: undefined,
      },
    }),
    resolveWorkingDirectory: (directory: string) => directory,
    createId: () => `conversation-${++nextId}`,
    createConversation: (options: ConversationOptions) => {
      conversationOptions.push(options);
      return new FakeConversation(options) as unknown as ConversationRuntime;
    },
    registerConversation: (conversation: ConversationRuntime) => registered.push(conversation),
    createConversationLink: async (conversation: ConversationRuntime) => {
      linked.push(conversation.id);
    },
    updateConversationStatus: () => undefined,
    broadcast: (message: unknown) => broadcasts.push(message),
  } as unknown as BuddyCreationServicePorts;

  const service = createBuddyCreationService(ports);
  const conversation = await service.createServerBuddyConversation({
    context,
    initialMessage: 'Start here',
    commandId: 'command-1',
  });
  await service.dispatchInitialMessageIfPending(conversation);

  assert.equal(conversation.id, 'conversation-1');
  assert.equal(creates.length, 1);
  assert.deepEqual(registered, [conversation]);
  assert.deepEqual(linked, ['conversation-1']);
  assert.equal(broadcasts.length, 1);
  assert.deepEqual(queued, ['Start here']);

  claimed = false;
  const queuedBeforeDormantCreate = queued.length;
  const dormant = await service.createServerBuddyConversation({
    context,
    initialMessage: 'Must remain dormant',
    commandId: 'deferred-command',
    deferInitialMessage: true,
  });
  assert.equal(queued.length, queuedBeforeDormantCreate);
  await assert.rejects(
    service.dispatchInitialMessageIfPending(dormant, {
      enqueueAuthorized: () => {
        throw new Error('automation run is not active: cancelled');
      },
    }),
    /automation run is not active: cancelled/
  );
  assert.equal(queued.length, queuedBeforeDormantCreate, 'lost authority never starts the child');
});

// Fresh-install trial 2026-10-05: the Builder was a literal codex, so a Claude-only install ran
// `spawn codex ENOENT` on open. The PATH here is real executables, read by the real resolver.
async function openBuilder(binaries: string[]) {
  const dir = mkdtempSync(join(tmpdir(), 'builder-path-'));
  for (const name of binaries) {
    writeFileSync(join(dir, name), '#!/bin/sh\n');
    chmodSync(join(dir, name), 0o755);
  }
  const configs: Array<{ provider: string; model: unknown }> = [];
  const conversations: string[] = [];
  const registry = new Map<string, ConversationRuntime>();
  const ports = {
    installedAgent: () => installedAgent({ PATH: dir }),
    resolveWorkingDirectory: (directory: string) => directory,
    createId: () => 'builder-1',
    getConversation: (id: string) => registry.get(id),
    configService: {
      async getRecord() {
        return { creation: {} };
      },
      async setCurrentSession() {},
      async createOrReplay(input: { config: { provider: string; model: unknown } }) {
        configs.push(input.config);
        return {
          record: {},
          state: {
            config: input.config,
            revision: 0,
            resolution: { status: 'resolved', value: {} },
          },
        };
      },
    },
    createConversation: (options: ConversationOptions) => {
      conversations.push(options.id);
      return { id: options.id, publishRow() {}, on() {} } as unknown as ConversationRuntime;
    },
    registerConversation: (conversation: ConversationRuntime) =>
      registry.set(conversation.id, conversation),
    createConversationLink: async () => undefined,
    updateConversationStatus: () => undefined,
    broadcast: () => undefined,
  } as unknown as BuddyCreationServicePorts;
  try {
    const opened = await createBuddyCreationService(ports)
      .createBuddyBuilderConversation({ commandId: 'c', workingDirectory: '/w' })
      .then(
        () => 'opened' as const,
        (error: Error) => error.message
      );
    return { opened, configs, conversations };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the Builder runs the installed agent: claude on a Claude-only install, codex when installed', async () => {
  const claudeOnly = await openBuilder(['claude']);
  assert.equal(claudeOnly.opened, 'opened');
  assert.equal(claudeOnly.configs[0].provider, 'claude');
  const codex = await openBuilder(['codex', 'claude']);
  assert.equal(codex.configs[0].provider, 'codex');
  assert.deepEqual(codex.configs[0].model, { mode: 'explicit', modelId: 'gpt-6-astra' });
});

test('the Builder with no agent installed refuses before creating anything', async () => {
  const none = await openBuilder([]);
  assert.match(none.opened, /No agent is installed/);
  assert.deepEqual(none.configs, []);
  assert.deepEqual(none.conversations, []);
});
