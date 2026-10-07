import { randomUUID } from 'node:crypto';
import type { Buddy, Cursor, Post } from '@unleashd/buddies-core';
import {
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

// Thread seats and DM chats: WHICH conversation a Buddy answers a thread in. A post wakes nobody
// here. Since step 5 (2026-10-06) a mention, a task-comment mention, the owner's DM post and a
// retry are all `deliver` runs (crate deliveries.rs `wake`, runner.ts `deliverJob`); the runner
// asks `openSeat` for the conversation of one that follows no thread yet. Step 5 deleted the pair
// machine (channel-pair.ts), which stays deleted. It also deleted the follow-up gate
// (channel-reply-gate.ts); the owner restored it on 2026-10-07 ("stay simple, don't overload
// DMs"): in a public or task thread a participant that did not subscribe is asked one yes/no
// question per new post before it gets a turn, now as a step of its `deliver` run (runner.ts
// `followUpGate`) instead of host memory. `askGate` below resolves the model it runs on.
// NO HOP BOUND (owner decision 2026-10-03, #bugfixes): Buddies may mention each other without
// pause and stop when they decide to. The brakes are the delivery's coalescing, `follow:false`,
// the run limits and the owner's Stop.
// SEATS: ONE resumed conversation per (thread, Buddy) (buddy-conversation-slots.ts). The owner's
// mention-chip pick is applied to the seat, which keeps its provider session; only a pick on
// another PROVIDER opens a new seat generation (a started session cannot change provider). Until
// 2026-09-29 any differing pick, an effort change included, opened a new seat and dropped hours of
// resumed context (wave_sim thread, 2026-09-28). The Buddy posts its own reply with the `post`
// tool; its text output is a private scratchpad and never reaches the channel (493c1c7). A turn
// the owner is waiting on that posts nothing, or fails, leaves a visible reply_failed notice
// (runner.ts, delivery design D10).

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
export type ChannelResponse = {
  channelId: string;
  threadRootId: string;
  buddyId: string;
  startedAt: string;
  state: 'replying' | 'queued';
};

export const threadConversationId = (rootId: string, buddyId: string, generation: number) =>
  stableConversationId(`channel-thread:${rootId}:${buddyId}:${generation}`);
export const directConversationId = (workspaceId: string, buddyId: string, generation: number) =>
  stableConversationId(`dm:${workspaceId}:${buddyId}:${generation}`);

export interface ChannelsPorts {
  core: BuddiesCore;
  events: BuddyEvents;
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
    rootId: string,
    buddyId: string,
    request: SeatRequest,
    thread?: Post[]
  ): Promise<LiveConversation> {
    const choice = await threadChoice(rootId, buddyId, request, thread);
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
    /**
     * The Buddy's seat in a thread, opened and running on the config this thread decided: the
     * owner's pick (a delivery's run config), an explicit override, the model its latest reply ran,
     * or its profile. A `no-agent` profile throws here, so the run fails and the thread gets a
     * visible reply_failed notice, with nothing spawned (fresh-install trial 2026-10-05).
     */
    async openSeat(input: {
      buddyId: string;
      workspaceId: string;
      rootId: string;
      pick: ConversationConfig | undefined;
    }): Promise<string> {
      const seat = await seatConfig(
        input.rootId,
        input.buddyId,
        input.pick ? { kind: 'chosen', config: input.pick } : { kind: 'keep' }
      );
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

    /**
     * The thread follow-up gate for one Buddy: asked on the config its seat would run (the thread's
     * decided model, else its profile), so a Buddy the owner moved to another harness is asked
     * there, not on a profile harness that may be down.
     */
    async askGate(input: { buddyId: string; rootId: string; prompt: string }) {
      const seat = await seatConfig(input.rootId, input.buddyId, { kind: 'keep' });
      return ports.gate({ config: seat.config, prompt: input.prompt });
    },

    /**
     * Each thread Buddy's latest seat (harness, model, reasoning): the one its next reply runs
     * on. The composer and retry share explicit intent, then thread history, then profile.
     */
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
        state: delivery.running ? 'replying' : 'queued',
      }));
    },

    /**
     * Rerun a reply whose HARNESS failed (out of tokens, a provider error) on the harness the owner
     * picks; the failure notice stays and the new attempt is a later reply. A model change resumes
     * the seat, while a provider change opens a new one. A second click while the rerun is queued
     * or running starts nothing (crate `retry_delivery`).
     */
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

    /**
     * "New chat" in a DM: the next generation, with no handoff. Earlier ones stay live, so the DM
     * shows them above a divider. `config` defaults to the current chat's; with `message` it is the
     * out-of-tokens retry, which must move to another harness and resends the owner's message.
     */
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
