import type { Post } from '@unleashd/buddies-core';
import {
  type BuddyMediaResult,
  type BuddyMutation,
  type BuddyMutationInput,
  type BuddyMutationParams,
  type BuddyMutationResults,
  type ConversationConfig,
  buddyMutations,
} from '@unleashd/shared';
import { newId } from '../../utils/ids';

export class BuddyApiError extends Error {
  readonly status: number;
  readonly payload: unknown;

  constructor(message: string, status: number, payload: unknown) {
    super(message);
    this.name = 'BuddyApiError';
    this.status = status;
    this.payload = payload;
  }
}

/** One request to the Buddy owner API; a non-2xx answer throws its `{error}` text. */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (!response.headers.get('content-type')?.includes('application/json')) {
    throw new BuddyApiError(
      'This feature is unavailable on the running server. It will retry after the server updates.',
      response.status,
      null
    );
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new BuddyApiError(
      (payload as { error?: string }).error ?? `Request failed (${response.status})`,
      response.status,
      payload
    );
  }
  return payload as T;
}

/** Read-only JSON fetch. Mutations must choose a shared operation, never a free-form body. */
export function buddyApi<T>(path: string, init?: Pick<RequestInit, 'signal'>): Promise<T> {
  return request<T>(path, init);
}

/** A named JSON mutation: one contract owns its params, body, method and success result. */
// Pattern: one-type-source (docs/patterns.md#one-type-source)
// Loose objects missed the retry key and a task reorder's extra `task` field. Shared parsing
// also catches extra fields in variables (TS structural assignability permits those).
// Guard: buddies-v2.test.ts (HTTP) and buddy-api-types.ts (compile-time).
export async function buddyWrite<K extends BuddyMutation>(
  operation: K,
  params: BuddyMutationParams<K>,
  ...args: undefined extends BuddyMutationInput<K>
    ? [body?: BuddyMutationInput<K>]
    : [body: BuddyMutationInput<K>]
): Promise<BuddyMutationResults[K]> {
  const { method, path, body: schema } = buddyMutations[operation];
  const url = path.replace(/:([a-zA-Z]+)/g, (_, name: string) =>
    encodeURIComponent((params as Record<string, string>)[name])
  );
  const input = args[0];
  const keyed = 'shape' in schema && 'key' in schema.shape;
  const body = schema.parse(
    keyed ? { ...input, key: (input as { key?: string } | undefined)?.key ?? newId() } : input
  );
  return request<BuddyMutationResults[K]>(url, {
    method,
    ...(body === undefined
      ? {}
      : {
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
  });
}

/**
 * One owner message to a Buddy's 1:1 DM: open the DM (idempotent), then write to its channel. This
 * is the only way to post "to a Buddy"; a wake is the same post with WAKE_MESSAGE as its body.
 */
export async function postToBuddyDm(
  buddyId: string,
  input: BuddyMutationInput<'channel.post'>
): Promise<{ channelId: string; post: Post }> {
  const { channelId } = await buddyWrite('direct.open', { buddyId });
  const { post } = await buddyWrite('channel.post', { channelId }, input);
  return { channelId, post };
}

/** Multipart media is the one non-JSON write in the Buddy UI. */
export function buddyUpload(channelId: string, files: FormData): Promise<BuddyMediaResult> {
  return request<BuddyMediaResult>(`/api/buddies/channels/${encodeURIComponent(channelId)}/media`, {
    method: 'POST',
    body: files,
  });
}

// A 202 retry can be refused by eligibility; treating it as success hid the reason from the UI.
// Guard: archived-Buddy retry through the real client (buddies-v2.test.ts).
export async function retryFailedReply(postId: string, config: ConversationConfig): Promise<void> {
  const result = await buddyWrite('reply.retry', { postId }, { config });
  if (result.status === 'rejected') throw new Error(result.reason);
}

export const errorText = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);
