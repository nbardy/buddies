import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type {
  ConfigError,
  ConfigResolution,
  ConversationConfig,
  ConversationConfigState,
  Result,
} from '@unleashd/shared';
import type { ConfigProvenance } from './config-records';
import type { ConfigUpdateCommand, ConversationConfigService } from './config-service';

// The slice of a live conversation a configuration change reads and writes.
export interface ConfigurableRuntime {
  readonly id: string;
  readonly config: ConversationConfig;
  readonly configRevision: number;
  readonly configResolution: ConfigResolution;
  readonly isRunning: boolean;
  readonly queue: { readonly length: number };
  hasStartedSession(): boolean;
  applyConfigState(state: ConversationConfigState): void;
}

/**
 * The one path that changes a live conversation's configuration: validate the
 * patch against the runtime's state (a started session locks the provider),
 * persist the next revision, then apply it to the runtime. The owner's
 * `set_conversation_config` command and a channel mention's model choice both
 * go through here, so both enforce the same lock and the same resolution.
 */
export async function updateRuntimeConfig(
  configService: Pick<ConversationConfigService, 'update'>,
  conversation: ConfigurableRuntime,
  command: ConfigUpdateCommand
): Promise<Result<ConversationConfigState, ConfigError>> {
  const result = await configService.update(
    {
      config: conversation.config,
      revision: conversation.configRevision,
      resolution: conversation.configResolution,
    },
    {
      isRunning: conversation.isRunning,
      queueDepth: conversation.queue.length,
      hasStartedSession: conversation.hasStartedSession(),
    },
    command
  );
  if (!result.ok) return result;
  conversation.applyConfigState(result.value.next);
  return { ok: true, value: result.value.next };
}

/**
 * Run a live conversation on `config` from its next turn (a channel mention's model pick). A no-op
 * when it already does; a refused change (a started session's provider) throws its reason.
 */
export async function replaceRuntimeConfig(
  configService: Pick<ConversationConfigService, 'update' | 'getRecord'>,
  conversation: ConfigurableRuntime,
  config: ConversationConfig,
  provenance?: ConfigProvenance
): Promise<void> {
  // An explicit same-value pick must still persist its origin. Otherwise an older reply
  // replaces that intent after reload. Guard: explicit thread choice survives a failed attempt.
  if (isDeepStrictEqual(conversation.config, config)) {
    if (provenance === undefined) return;
    const record = await configService.getRecord(conversation.id);
    if (record?.provenance === provenance) return;
  }
  const result = await updateRuntimeConfig(configService, conversation, {
    conversationId: conversation.id,
    commandId: `pick-${randomUUID()}`,
    expectedRevision: conversation.configRevision,
    patch: { kind: 'replace', config },
    provenance,
  });
  if (!result.ok) throw new Error(result.error.message);
}
