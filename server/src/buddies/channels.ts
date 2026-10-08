import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Buddy, Cursor, Post } from '@unleashd/buddies-core';
import {
  type ChannelResponse,
  type ConversationConfig,
  type InstalledAgent,
  type ReplyRetryResult,
  isHarnessRetryFailure,
} from '@unleashd/shared';
import {
  NO_AGENT_INSTALLED,
  WAKE_MESSAGE,
  configFromProviderPreferences,
  mentionedIds,
} from '@unleashd/shared';
import type { ConversationRuntime } from '../conversations/runtime';
import type { BackgroundWork, TurnActivity } from '../turns/background-work';
import { profileExecution } from './briefing';
import {
  type LiveConversation,
  type StableConversationPorts,
  openConversation,
  scanGenerations,
  stableConversationId,
} from './buddy-conversation-slots';
import type { ReplyGate } from './channel-reply-gate';
import { type BuddiesCore, OWNER } from './core';
import type { BuddyEvents } from './events';
import { runConfigOfPick } from './worker-config';

// Thread seats and DM chats choose WHERE a delivery replies; the crate owns waking/admission.
// Public/task follow-ups use runner.ts followUpGate (owner restored 2026-10-07); mentions,
// subscriptions, DMs and retries are not gated. A seat is one resumed conversation per thread
// and Buddy; only changing PROVIDER opens a new generation, preserving same-provider context
// (2026-09-29 fix). The Buddy posts its reply with `post`; private output stays private. An
// owner-facing silent/error turn leaves reply_failed (runner.ts, design D10).
// NO HOP BOUND (owner 2026-10-03): conversations continue until the Buddies decide to stop,
// subject to existing run limits, read coalescing, follow:false and owner Stop.

const THREAD_PAGE = 200;

const buddyAuthor = (post: Post): string[] =>
  post.author.kind === 'buddy' ? [post.author.id] : [];
/**
 * A thread as its members wrote it: without failure notices. A notice is not announced, so it
 * must not decide dispatch either (review R11, R13).
 */
const talkOf = (thread: Post[]) => thread.filter((post) => post.purpose !== 'reply_failed');

export type ThreadSeat = { buddyId: string; config: ConversationConfig };
type SeatRequest = { kind: 'keep' } | { kind: 'chosen'; config: ConversationConfig };
export type { ChannelResponse } from '@unleashd/shared';

const RUNNING_STATE = { working: 'replying', background: 'background' } as const satisfies Record<
  TurnActivity['t'],
  ChannelResponse['state']
>;

export const threadConversationId = (rootId: string, buddyId: string, generation: number) =>
  stableConversationId(`channel-thread:${rootId}:${buddyId}:${generation}`);
export const directConversationId = (workspaceId: string, buddyId: string, generation: number) =>
  stableConversationId(`dm:${workspaceId}:${buddyId}:${generation}`);

export interface ChannelsPorts {
  core: BuddiesCore;
  events: BuddyEvents;
  /** Which seats are idle on background work, for the status line (turns/background-work.ts). */
  backgroundWork: BackgroundWork;
  conversations: StableConversationPorts;
  /** The agent an unpinned Buddy runs (providers/installed-agent.ts), read per resolution. */
  installedAgent(): InstalledAgent;
  /** A post landed or who is replying changed: push `channel_changed`. */
  channelChanged(channelId: string): void;
  /** The thread follow-up gate (runner.ts `followUpGate`), resolved like the seat's own turn. */
  gate: ReplyGate;
}

export type Channels = ReturnType<typeof createChannels>;

export function createChannels(ports: ChannelsPorts) {
  const { core } = ports;

  // Every created post pushes its channel; so does a delivery starting or ending (runner.ts).
  ports.events.on((event) => {
    switch (event.kind) {
      case 'posted':
        return ports.channelChanged(event.channel.id);
      case 'responding':
        return ports.channelChanged(event.channelId);
      case 'changed':
      case 'cancelled':
        return;
    }
  });

  async function eligible(
    buddyId: string,
    workspaceId: string
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const buddy = (await core.listBuddies(workspaceId)).find((b) => b.id === buddyId);
    if (!buddy) return { ok: false, reason: 'Buddy is outside this workspace' };
    if (buddy.status !== 'active') return { ok: false, reason: 'Buddy is not active' };
    return { ok: true };
  }

  /** Every post in a thread, root first (keyset pages, newest first, reversed). */
  async function wholeThread(root: Post): Promise<Post[]> {
    const replies: Post[] = [];
    let before: Cursor | undefined;
    for (;;) {
      const page = await core.listPosts(
        OWNER,
        { kind: 'thread', rootId: root.id },
        before,
        THREAD_PAGE
      );
      replies.push(...page.posts);
      if (!page.next) return [root, ...replies.reverse()];
      before = page.next;
    }
  }

  // A `no-agent` profile throws inside runReply's try, so the thread gets a visible reply_failed
  // notice and nothing is spawned (fresh-install trial 2026-10-05: an empty bubble).
  const profileConfig = (buddy: Buddy): ConversationConfig => {
    const execution = profileExecution(buddy, ports.installedAgent());
    switch (execution.kind) {
      case 'run':
        return configFromProviderPreferences(execution);
      case 'no-agent':
        throw new Error(NO_AGENT_INSTALLED);
    }
  };

  // Pattern: one-definition (docs/patterns.md#one-definition)
  // A Buddy can post from a DM/worker rather than its derived thread seat. Following the stale
  // seat could query Claude while the latest reply used Sol. Guard: latest thread reply model.
  async function threadModel(thread: Post[], buddyId: string): Promise<ConversationConfig | null> {
    for (const post of talkOf(thread).slice().reverse()) {
      if (post.author.kind !== 'buddy' || post.author.id !== buddyId || !post.conversationId)
        continue;
      const slot = await ports.conversations.slot(post.conversationId);
      if (slot.kind === 'live') return slot.config;
    }
    return null;
  }

  // What this thread already decided for the Buddy: the owner's pick, an explicit override, the
  // model its latest reply ran, or its seat. `config: null` means nothing yet; only then does the
  // profile decide. threadSeats reads this alone: it used to resolve the profile too and discard
  // it, so a `no-agent` profile failed every thread read (fresh-install trial, 2026-10-05).
  async function threadChoice(
    rootId: string,
    buddyId: string,
    request: SeatRequest,
    thread?: Post[]
  ) {
    const seats = await scanGenerations(ports.conversations, (g) =>
      threadConversationId(rootId, buddyId, g)
    );
    // Pattern: one-write-path (docs/patterns.md#one-write-path)
    // Failed explicit picks used to lose to an older successful post (Claude weekly limit,
    // 2026-10-04). The record owns intent; guard: explicit thread choice survives a failed attempt.
    const override = seats.current?.provenance === 'user';
    const history =
      request.kind === 'keep' && !override
        ? await threadModel(
            thread ?? (await wholeThread(await core.getPost(OWNER, rootId))),
            buddyId
          )
        : null;
    const config: ConversationConfig | null =
      request.kind === 'chosen'
        ? request.config
        : override
          ? seats.current!.config
          : (history ?? seats.current?.config ?? null);
    return { seats, explicit: request.kind === 'chosen' || override, config };
  }

  async function seatConfig(
    buddyId: string,
    choice: Awaited<ReturnType<typeof threadChoice>>
  ): Promise<LiveConversation> {
    const { current, next } = choice.seats;
    const config = choice.config ?? profileConfig(await core.getBuddy(buddyId));
    return {
      conversationId:
        current?.config.provider === config.provider ? current.conversationId : next(),
      config,
      provenance: choice.explicit ? 'user' : 'legacy_inferred',
    };
  }

  /** The owner's DM generations with an active Buddy (the newest live one is the current chat). */
  async function directSeats(buddyId: string) {
    const buddy = await core.getBuddy(buddyId);
    const admitted = await eligible(buddyId, buddy.workspaceId);
    if (!admitted.ok) throw new Error(admitted.reason);
    const seats = await scanGenerations(ports.conversations, (g) =>
      directConversationId(buddy.workspaceId, buddyId, g)
    );
    const open = (conversationId: string, config: ConversationConfig | undefined) =>
      openConversation(ports.conversations, {
        context: { buddyId, workspaceId: buddy.workspaceId },
        conversationId,
        commandId: `buddy-dm-${conversationId}`,
        config,
      });
    return { ...seats, open };
  }

  async function directConversation(buddyId: string): Promise<ConversationRuntime> {
    const { current, next, open } = await directSeats(buddyId);
    return open(current?.conversationId ?? next(), current?.config);
  }

  return {
    /** Resolve a delivery on the thread choice; retain a matching subscribed context.
     * No-agent resolution fails visibly before anything spawns (fresh-install guard). */
    async openSeat(input: {
      buddyId: string;
      workspaceId: string;
      rootId: string;
      pick: ConversationConfig | undefined;
      subscribedConversationId?: string;
    }): Promise<string> {
      // Request returns keep their requester model (guard: tracked workers return to parent model).
      if (!input.pick && input.subscribedConversationId) {
        const root = await core.getPost(OWNER, input.rootId);
        if (root.request.state !== 'none') return input.subscribedConversationId;
      }
      const choice = await threadChoice(
        input.rootId,
        input.buddyId,
        input.pick ? { kind: 'chosen', config: input.pick } : { kind: 'keep' }
      );
      // Pattern: one-definition (docs/patterns.md#one-definition)
      // A stale subscribed Claude worker bypassed a saved Sol pick after quota failure (10-08).
      // Keep a matching follower's context; a different choice uses the thread's canonical seat.
      // Guard: a stale subscribed conversation cannot resurrect Claude after a Codex pick fails.
      if (!input.pick && input.subscribedConversationId) {
        const slot = await ports.conversations.slot(input.subscribedConversationId);
        if (
          slot.kind === 'live' &&
          (!choice.config || isDeepStrictEqual(slot.config, choice.config))
        )
          return input.subscribedConversationId;
      }
      const seat = await seatConfig(input.buddyId, choice);
      const conversation = await openConversation(ports.conversations, {
        context: { buddyId: input.buddyId, workspaceId: input.workspaceId },
        conversationId: seat.conversationId,
        commandId: `channel-thread-${seat.conversationId}`,
        config: seat.config,
        provenance: seat.provenance,
      });
      await ports.conversations.reconfigure(conversation, seat.config, seat.provenance);
      return conversation.id;
    },

    /** Gate on the same thread choice as its reply, even when the profile harness is down. */
    async askGate(input: { buddyId: string; rootId: string; prompt: string }) {
      const seat = await seatConfig(
        input.buddyId,
        await threadChoice(input.rootId, input.buddyId, { kind: 'keep' })
      );
      return ports.gate({ config: seat.config, prompt: input.prompt });
    },

    /** Picker/retry projection of the same choice that drives execution. */
    async threadSeats(rootId: string): Promise<ThreadSeat[]> {
      const root = await core.getPost(OWNER, rootId);
      if (root.rootId) return [];
      const thread = await wholeThread(root);
      const buddyIds = new Set<string>();
      for (const post of thread) {
        for (const id of buddyAuthor(post)) buddyIds.add(id);
        for (const id of mentionedIds(post.body)) buddyIds.add(id);
      }
      const seats: ThreadSeat[] = [];
      for (const buddyId of buddyIds) {
        const { config } = await threadChoice(rootId, buddyId, { kind: 'keep' }, thread);
        if (config) seats.push({ buddyId, config });
      }
      return seats;
    },

    /** Buddies replying in this channel, for "X is replying…": its queued and running deliveries. */
    async responding(channelId: string): Promise<ChannelResponse[]> {
      return (await core.responding(channelId)).map((delivery) => ({
        channelId,
        threadRootId: delivery.threadRootId,
        buddyId: delivery.buddyId,
        startedAt: delivery.startedAt,
        // A running seat whose model is idle on background jobs says so, never "replying".
        state: delivery.running
          ? RUNNING_STATE[
              ports.backgroundWork.activityOf({
                buddyId: delivery.buddyId,
                rootId: delivery.threadRootId,
              }).t
            ]
          : 'queued',
        waiting: delivery.waiting,
      }));
    },

    /** Retry a harness failure on the owner's pick; keep the notice. Same-provider retries
     * resume; provider changes open a seat. Duplicate clicks coalesce in retry_delivery. */
    async retryReply(failed: Post, config: ConversationConfig): Promise<ReplyRetryResult> {
      if (failed.purpose !== 'reply_failed' || failed.author.kind !== 'buddy' || !failed.replyToId)
        throw new Error('Only a failed Buddy reply can be retried');
      if (!isHarnessRetryFailure(failed.body))
        throw new Error('Only an out-of-tokens or provider-error failure can be retried');
      const buddyId = failed.author.id;
      const channel = await core.openChannel(OWNER, { kind: 'id', id: failed.channelId });
      const admitted = await eligible(buddyId, channel.workspaceId);
      if (!admitted.ok) return { buddyId, status: 'rejected', reason: admitted.reason };
      await core.retryDelivery(OWNER, failed.replyToId, buddyId, runConfigOfPick(config));
      return { buddyId, status: 'started' };
    },

    /** The owner's DM generations with a Buddy, oldest first; the newest is the current chat. */
    async directChain(buddyId: string): Promise<{ buddyId: string; generations: string[] }> {
      const buddy = await core.getBuddy(buddyId);
      const { live } = await scanGenerations(ports.conversations, (g) =>
        directConversationId(buddy.workspaceId, buddyId, g)
      );
      return { buddyId, generations: live };
    },

    /** New DM generation without handoff; earlier chats stay visible. A message retries on a
     * different harness; otherwise config defaults to the current chat's. */
    async newDirect(
      buddyId: string,
      input: { config?: ConversationConfig; message?: string }
    ): Promise<{ conversationId: string }> {
      const { current, next, open } = await directSeats(buddyId);
      if (input.message && input.config?.provider === current?.config.provider)
        throw new Error(
          `Pick a different harness. ${input.config?.provider} is the one that failed.`
        );
      const conversation = await open(next(), input.config ?? current?.config);
      if (input.message)
        conversation.enqueueMessage(input.message, {
          origin: 'owner_input',
          inputId: `retry-${randomUUID()}`,
        });
      return { conversationId: conversation.id };
    },

    /** The owner's ongoing chat with a Buddy (not a channel DM): open it. */
    async openDirect(buddyId: string): Promise<{ conversationId: string }> {
      return { conversationId: (await directConversation(buddyId)).id };
    },

    /** Queue the wake-up check in that chat, after any turn already running there. */
    async wake(buddyId: string): Promise<{ conversationId: string }> {
      const conversation = await directConversation(buddyId);
      conversation.enqueueMessage(WAKE_MESSAGE, {
        origin: 'owner_input',
        inputId: `wake-${randomUUID()}`,
      });
      return { conversationId: conversation.id };
    },
  };
}
