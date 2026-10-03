import { randomUUID } from 'node:crypto';
import type { Actor, Buddy, Channel, Cursor, Post } from '@unleashd/buddies-core';
import { type ConversationConfig, isHarnessRetryFailure } from '@unleashd/shared';
import { awaitTurn } from '../conversations/await-turn';
import {
  buddyExecutionPreferences,
  configFromProviderPreferences,
} from '../conversations/config-mapping';
import type {
  ConversationRuntime,
  SeatTurnInput,
  SessionRelativePrompt,
} from '../conversations/runtime';
import {
  type LiveConversation,
  type StableConversationPorts,
  openConversation,
  scanGenerations,
  stableConversationId,
} from './buddy-conversation-slots';
import { type Job, NOTHING_READ, type Pair, type PairEvent, idlePair, step } from './channel-pair';
import type { ReplyGate } from './channel-reply-gate';
import { type BuddiesCore, OWNER, buddyActor } from './core';
import type { BuddyEvents, MentionPicks } from './events';

// Channel replies: the host policy that turns a post into a Buddy turn (a post wakes nobody in
// the core). ONE entry: the `posted` event, which every writer (MCP tool, owner route, runner)
// emits once per CREATED post — a replayed idempotency key announces nothing (the crate's
// `PostWrite.created`; until 2026-09-29 a retried tool call re-ran every mention and gate). Two
// causes, on public channels, the same whoever wrote the post (owner or Buddy), plus one in DMs:
//   mention   — a post @mentions a Buddy; it must answer (the owner's chip picks ride the event).
//   follow_up — a new reply in a thread asks each OTHER Buddy who posted there one gate question
//               (channel-reply-gate.ts); only a strict <yes> starts a reply.
//   direct    — the owner's plain post in a DM wakes the DM's Buddies (requests/answers excepted).
// NO HOP BOUND (owner decision 2026-10-03, #bugfixes): Buddies may mention and follow each other
// without pause and stop when they decide to. Until then a counter (3 hand-offs since the owner
// last spoke) posted a "reply failed" notice and killed a live Designer/Engineer review thread.
// The only brakes now are the reply gate's own "no", the per-pair queue and the run limits.
// SEATS: every reply goes to the Buddy's seat in that thread, ONE resumed conversation per
// (thread, Buddy) (buddy-conversation-slots.ts). The owner's mention-chip pick is applied to the
// seat, which keeps its provider session; only a pick on another PROVIDER opens a new seat
// generation (a started session cannot change provider). Until 2026-09-29 any differing pick, an
// effort change included, opened a new seat and dropped hours of resumed context (wave_sim thread,
// 2026-09-28). The Buddy posts its own reply with the
// `post` tool; its text output is a private scratchpad and never reaches the channel (493c1c7: the
// server used to paste the final text, tool transcript and all, or "(no reply text)"). A turn that
// posts nothing, or fails, leaves a visible reply_failed notice.
// Per (thread, Buddy) PAIR the queue, gate and read mark are ONE pure machine (channel-pair.ts);
// this file applies its effects. Known gaps: pairs live in memory, so a restart costs each
// resumed seat one full-context prompt, and a turn in flight at restart leaves neither its post
// nor the notice.

const CONTEXT_POSTS = 10;
/** A fresh seat's own earlier replies, beyond the recent tail: newest first up to this budget. */
const OWN_HISTORY_CHARS = 8000;
const THREAD_PAGE = 200;

const MENTION = /\[@([^\]]+)\]\(buddy:([A-Za-z0-9_-]+)\)/g;
const TASK_REFERENCE = /\[([^\]]+)\]\(task:([A-Za-z0-9_-]+)\)/g;

export function mentionedBuddyIds(body: string): string[] {
  return [...new Set([...body.matchAll(MENTION)].map((match) => match[2]))];
}

export function readableChannelText(body: string): string {
  return body
    .replace(MENTION, (_whole, name: string) => `@${name}`)
    .replace(TASK_REFERENCE, (_whole, title: string, id: string) => `${title} (task ${id})`);
}

type Names = ReadonlyMap<string, string>;
const label = (author: Actor, names: Names) =>
  author.kind === 'owner' ? 'Owner' : (names.get(author.id) ?? author.id);

function transcriptLine(post: Post, names: Names): string {
  const text = readableChannelText(post.body);
  const clipped = text.length > 4000 ? `${text.slice(0, 4000)}… [truncated]` : text;
  return `[${post.createdAt}] ${label(post.author, names)} (${post.id}): ${clipped}`;
}

const rootOf = (post: Post) => post.rootId ?? post.id;
const buddyAuthor = (post: Post): string[] =>
  post.author.kind === 'buddy' ? [post.author.id] : [];
/** Buddies a post wakes by @mention: never its own author. */
const mentionedByPost = (post: Post): string[] =>
  mentionedBuddyIds(post.body).filter((id) => !buddyAuthor(post).includes(id));
/**
 * A thread as its members wrote it: without failure notices. A notice is not announced, so it
 * must not decide dispatch either — as the newest post it hid the owner's post from the gates,
 * and it counted as a participant (review R11, R13).
 */
const talkOf = (thread: Post[]) => thread.filter((post) => post.purpose !== 'reply_failed');

// Owner authority for a seat turn follows the author of its trigger post, read back from the
// store by id — never from the prompt, which quotes Buddy text. B1 (2026-09-25): every seat turn
// was sent as 'owner_input', so a follow-up gated on ANOTHER BUDDY's post held owner authority.
// Guard: buddies-v2.test.ts "B1: a seat turn holds owner authority only when …".
export function seatTurnInput(trigger: Post): SeatTurnInput {
  switch (trigger.author.kind) {
    case 'owner':
      return { origin: 'owner_input', inputId: trigger.id };
    case 'buddy':
      return { origin: 'buddy_post', inputId: trigger.id };
  }
}

export type ThreadSeat = { buddyId: string; config: ConversationConfig };
export type SeatRequest = { kind: 'keep' } | { kind: 'chosen'; config: ConversationConfig };
export type MentionDispatch =
  | { buddyId: string; status: 'started' }
  | { buddyId: string; status: 'rejected'; reason: string };
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

export const WAKE_MESSAGE = [
  'Wake-up check: catch up on the workspace channels and act on what matters to you.',
  '1. Call inbox: requests you owe, and every channel with your unread count.',
  '2. Read each channel with unread posts with channel_read (reading from the top marks it read); open threads with channel_read({read:{threadId}}).',
  '3. For each thing that concerns you: answer it in its thread (post with replyToId) when a reply helps, create/update the work (task_write) and comment via post {channel:{task}}, hand it to its owner (post a request in a DM), or leave it.',
  '4. Finish with a short summary: what you read, what you replied to, what work you started (with ids).',
].join('\n');

export interface ChannelsPorts {
  core: BuddiesCore;
  events: BuddyEvents;
  conversations: StableConversationPorts;
  uploadsRoot(): string;
  gate: ReplyGate;
  /** Who is replying changed, or a failure notice landed: push `channel_changed`. */
  channelChanged(channelId: string): void;
  logger?: Pick<Console, 'warn'>;
}

// mention: must answer. direct: the owner wrote in a DM with the Buddy; must answer.
// follow_up: the gate said yes; runs only if the pair has not read the post.
// retry: the owner reran a failed reply on another harness; must answer.
type Cause = 'mention' | 'direct' | 'follow_up' | 'retry';
type Reply = {
  channel: Channel;
  cause: Cause;
  request: SeatRequest;
  trigger: Post;
  rootId: string;
  buddyId: string;
  /** The idempotency key of its failure notice. */
  noticeKey: string;
};
type FollowUp = {
  channel: Channel;
  trigger: Post;
  root: Post;
  buddyId: string;
  others: string[];
};
/** One pair: its machine, plus what "X is replying…" shows. */
type PairEntry = Omit<ChannelResponse, 'state'> & {
  machine: Pair<FollowUp, Reply>;
  waitingForSlot: boolean;
};

/** A reply turn for the machine. One job per id is queued: a double-clicked retry runs once (R3). */
const replyJob = (reply: Reply, id: string, mustAnswer: boolean): Job<Reply> => ({
  id,
  ord: reply.trigger.ord,
  mustAnswer,
  reply,
});
const noticeKey = (trigger: Post, buddyId: string) => `thread-reply:${trigger.id}:${buddyId}`;

export type Channels = ReturnType<typeof createChannels>;

export function createChannels(ports: ChannelsPorts) {
  const { core } = ports;
  const logger = ports.logger ?? console;
  const pairs = new Map<string, PairEntry>();
  const pairKey = (rootId: string, buddyId: string) => `${rootId}:${buddyId}`;
  // Read synchronously as the post is announced, while the turn that wrote it still runs.

  async function names(workspaceId: string): Promise<Names> {
    return new Map((await core.listBuddies(workspaceId)).map((buddy) => [buddy.id, buddy.name]));
  }

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

  function tail(thread: Post[], trigger: Post) {
    const replies = thread.slice(1).filter((post) => post.id !== trigger.id);
    const shown = replies.slice(-CONTEXT_POSTS);
    return { root: thread[0], earlier: replies.slice(0, replies.length - shown.length), shown };
  }

  function headline(cause: Cause, where: string, author: string): string {
    switch (cause) {
      case 'mention':
        return `${author} mentioned you in ${where}`;
      case 'direct':
        return `${author} wrote ${where} in your direct messages`;
      case 'follow_up':
        return `A new message arrived in ${where} you have posted in, and you chose to reply`;
      case 'retry':
        return `Your earlier reply to ${author} failed; the owner asked you to retry it on another harness. The message is in ${where}`;
    }
  }

  function prompt(input: Reply, context: string[], nameMap: Names): string {
    return [
      ...context,
      '',
      'Each line shows its post id. Read more with channel_read({read:{threadId}}) or channel_read({read:{channelId}, before}) only when the reply needs it.',
      '',
      `Reply to the latest message, from ${label(input.trigger.author, nameMap)}:`,
      readableChannelText(input.trigger.body),
      '',
      `Nobody reads your text output: it is a private scratchpad, use it to think. People only see what you post in this thread. Post with post({ channel: { id: "${input.channel.id}" }, replyToId: "${input.rootId}", purpose: "reply", body, key }). You may post more than once: a short progress note, then the result. Write posts direct and concise, as markdown. Embed media as ![alt](/absolute/path); reference a task as [title](task:<id>). Put anything long in a file or a Task and link it. If this turn ends without a post, the thread gets a failure notice, not your scratchpad. If it needs real work, do it or hand it off, then post what you did.`,
    ].join('\n');
  }

  // A fresh seat of a Buddy that already spoke here (a provider switch, a deleted seat) sees its
  // own earlier replies, not only the recent tail: at 08:37 on 2026-09-28 Wave Sim Lead's new seat
  // got 10 of ~50 replies and none of its own three hours of work.
  function ownHistory(input: Reply, earlier: Post[]): { kept: Post[]; dropped: number } {
    const own = talkOf(earlier).filter((post) => buddyAuthor(post).includes(input.buddyId));
    const kept: Post[] = [];
    let budget = OWN_HISTORY_CHARS;
    for (const post of [...own].reverse()) {
      budget -= post.body.length;
      if (budget < 0) break;
      kept.unshift(post);
    }
    return { kept, dropped: own.length - kept.length };
  }

  // A resumed seat already holds every post through the mark of its last completed turn, so it
  // gets only what arrived since; a fresh session gets the whole context. The runtime picks between
  // them as it admits the turn (a changed audience starts a fresh session there). 2026-09-25: a
  // delta reached a fresh session, which then saw "Replies since then (0)" and no thread at all.
  // `through` is the newest post this prompt was composed from: the pair's mark once it completes.
  async function seatPrompt(
    input: Reply,
    seatId: string
  ): Promise<{ prompt: SessionRelativePrompt; through: string }> {
    const nameMap = await names(input.channel.workspaceId);
    const { channel, trigger } = input;
    const where = `#${channel.kind.type === 'public' ? channel.kind.name : channel.id} (channel ${channel.id})`;
    const lines = (posts: Post[]) => posts.map((p) => transcriptLine(p, nameMap));
    const omitted = (count: number, what: string) =>
      count > 0 ? [`… ${count} ${what} omitted …`] : [];
    const compose = (subject: string, intro: string, context: string[]) =>
      prompt(
        input,
        [
          `${headline(input.cause, subject, label(trigger.author, nameMap))} in ${where}. ${intro}`,
          '',
          ...context,
        ],
        nameMap
      );
    if (trigger.rootId === undefined || trigger.rootId === null) {
      const page = await core.listPosts(
        OWNER,
        { kind: 'channel', channelId: channel.id },
        null,
        CONTEXT_POSTS + 1
      );
      const posts = page.posts.filter((post) => post.id !== trigger.id).slice(0, CONTEXT_POSTS);
      const text = compose(
        'a new message',
        `The ${posts.length} most recent top-level posts, oldest first:`,
        lines(posts.reverse())
      );
      return { prompt: { resumed: text, fresh: text }, through: trigger.ord };
    }
    const thread = await wholeThread(await core.getPost(OWNER, input.rootId));
    const through = thread[thread.length - 1].ord;
    const context = tail(thread, trigger);
    const own = ownHistory(input, context.earlier);
    const fresh = compose('a thread', 'The root, then its most recent replies, oldest first:', [
      transcriptLine(context.root, nameMap),
      ...(own.kept.length > 0
        ? [
            'Your own earlier replies here (an earlier session of yours), oldest first:',
            ...omitted(own.dropped, 'older replies of yours'),
            ...lines(own.kept),
            'The rest of the thread:',
          ]
        : []),
      ...omitted(context.earlier.length - own.kept.length, 'earlier replies'),
      ...lines(context.shown),
    ]);
    const mark =
      pairs.get(pairKey(input.rootId, input.buddyId))?.machine.readThrough ?? NOTHING_READ;
    if (mark === NOTHING_READ) return { prompt: { fresh, resumed: fresh }, through };
    const unseen = thread.filter(
      (post) => post.ord > mark && post.id !== trigger.id && post.conversationId !== seatId
    );
    const shown = unseen.slice(-CONTEXT_POSTS);
    const resumed = compose(
      'a thread',
      `You have seen this thread through your last turn. Replies since then, oldest first (${shown.length}):`,
      [...omitted(unseen.length - shown.length, 'earlier new replies'), ...lines(shown)]
    );
    return { prompt: { fresh, resumed }, through };
  }

  const profileConfig = (buddy: Buddy) =>
    configFromProviderPreferences(
      buddyExecutionPreferences({
        provider: buddy.provider ?? null,
        model: buddy.model ?? null,
        reasoning_effort: buddy.reasoningEffort ?? null,
      })
    );

  // A started session cannot change provider (config-service.ts), so only a pick on another
  // provider needs a new seat; a model or effort pick is applied to the current one, whose
  // session resumes. Guard: buddies-v2 "an effort pick keeps the seat's session …".
  function seatFor(
    request: SeatRequest,
    seats: { current: LiveConversation | null; next(): string },
    profile: ConversationConfig
  ): LiveConversation {
    switch (request.kind) {
      case 'keep':
        return seats.current ?? { conversationId: seats.next(), config: profile };
      case 'chosen':
        return seats.current?.config.provider === request.config.provider
          ? { conversationId: seats.current.conversationId, config: request.config }
          : { conversationId: seats.next(), config: request.config };
    }
  }

  async function seatConfig(
    rootId: string,
    buddyId: string,
    request: SeatRequest
  ): Promise<LiveConversation> {
    const seats = await scanGenerations(ports.conversations, (g) =>
      threadConversationId(rootId, buddyId, g)
    );
    return seatFor(request, seats, profileConfig(await core.getBuddy(buddyId)));
  }

  // A failure notice asks nobody to follow up, so it is pushed but not announced as a post.
  async function postFailure(
    input: Pick<Reply, 'channel' | 'trigger' | 'buddyId' | 'noticeKey'>,
    conversationId: string | null,
    reason: string
  ) {
    await core.post(
      buddyActor(input.buddyId),
      { kind: 'id', id: input.channel.id },
      {
        kind: 'inform',
        evidence: [],
        replyToId: input.trigger.id,
        fromConversationId: conversationId ?? undefined,
        broadcast: false,
        key: input.noticeKey,
        purpose: 'reply_failed',
        body: `Couldn’t reply: ${reason}`,
      }
    );
    ports.channelChanged(input.channel.id);
  }

  // The reply is what the seat posted in the thread after the post its prompt was composed from,
  // not its failure notices; the text output is not. Only this seat's posts count: any post by the
  // Buddy (another run of it, say) used to pass for the reply (review R9).
  async function repliedSince(input: Reply, seatId: string, through: string): Promise<boolean> {
    const thread = await wholeThread(await core.getPost(OWNER, input.rootId));
    return talkOf(thread).some((post) => post.conversationId === seatId && post.ord > through);
  }

  function trackRunSlot(entry: PairEntry, conversation: ConversationRuntime): () => void {
    const waiting = (value: boolean) => {
      if (entry.waitingForSlot === value) return;
      entry.waitingForSlot = value;
      ports.channelChanged(entry.channelId);
    };
    const started = () => waiting(false);
    waiting(conversation.waitingForRunSlot());
    conversation.once('buddy-turn-started', started);
    return () => {
      conversation.off('buddy-turn-started', started);
      started();
    };
  }

  // A turn ALWAYS ends in a reply or a visible reply_failed notice: every step, the thread reads
  // included, is inside the one try (review R4: a throwing read left neither). Resolves to the
  // newest post its prompt showed (the pair's read mark), or NOTHING_READ if it never composed one.
  async function runReply(input: Reply, entry: PairEntry): Promise<string> {
    let seatId: string | null = null;
    let shown = NOTHING_READ;
    let failure = 'the turn ended without a channel post';
    try {
      const seat = await seatConfig(input.rootId, input.buddyId, input.request);
      const conversation = await openConversation(ports.conversations, {
        context: { buddyId: input.buddyId, workspaceId: input.channel.workspaceId },
        conversationId: seat.conversationId,
        commandId: `channel-thread-${seat.conversationId}`,
        config: seat.config,
      });
      seatId = conversation.id;
      const trigger = await core.getPost(OWNER, input.trigger.id);
      // The prompt is composed once the seat is idle, and sent in the same tick as the last idle
      // check: an owner typing into the seat meanwhile would otherwise make the send drop and
      // this await never settle, wedging the pair's queue (review R5).
      let composed: Awaited<ReturnType<typeof seatPrompt>>;
      do {
        await untilIdle(conversation);
        await ports.conversations.reconfigure(conversation, seat.config);
        composed = await seatPrompt(input, conversation.id);
      } while (!idle(conversation));
      const { prompt, through } = composed;
      let untrack: () => void = () => undefined;
      await awaitTurn(
        conversation,
        () => {
          conversation.sendSessionRelativeMessage(prompt, seatTurnInput(trigger));
          untrack = trackRunSlot(entry, conversation);
        },
        'Buddy turn failed'
      ).finally(() => {
        untrack();
      });
      shown = through;
      if (await repliedSince(input, conversation.id, through)) return shown;
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    await postFailure(input, seatId, failure);
    return shown;
  }

  // The thin driver: step the pair's machine, then perform its effects, whose outcomes come back
  // as the next events.
  function apply(
    meta: Pick<Reply, 'channel' | 'rootId' | 'buddyId'>,
    event: PairEvent<FollowUp, Reply>
  ) {
    const key = pairKey(meta.rootId, meta.buddyId);
    const entry: PairEntry = pairs.get(key) ?? {
      channelId: meta.channel.id,
      threadRootId: meta.rootId,
      buddyId: meta.buddyId,
      startedAt: new Date().toISOString(),
      waitingForSlot: false,
      machine: idlePair(),
    };
    const was = entry.machine.queue.length;
    const { pair, effects } = step(entry.machine, event);
    entry.machine = pair;
    pairs.set(key, entry);
    if (was === 0 && pair.queue.length > 0) entry.startedAt = new Date().toISOString();
    if ((was === 0) !== (pair.queue.length === 0)) ports.channelChanged(entry.channelId);
    for (const effect of effects) {
      switch (effect.kind) {
        case 'gate':
          void followUp(effect.trigger.followUp)
            .catch((error): PairEvent<FollowUp, Reply> => {
              logger.warn(`[channels] follow-up for ${meta.buddyId} failed:`, error);
              return { kind: 'gate_no' };
            })
            .then((outcome) => apply(meta, outcome));
          break;
        case 'run':
          void runReply(effect.job.reply, entry)
            .catch((error) => {
              logger.warn(`[channels] reply to ${effect.job.reply.trigger.id} failed:`, error);
              return NOTHING_READ;
            })
            .then((through) => apply(meta, { kind: 'replied', through }));
          break;
      }
    }
  }

  async function followUp(input: FollowUp): Promise<PairEvent<FollowUp, Reply>> {
    const nameMap = await names(input.channel.workspaceId);
    const role = async (id: string) => {
      const buddy = await core.getBuddy(id);
      return `${buddy.name} (${buddy.role})`;
    };
    const thread = await wholeThread(input.root);
    const context = tail(thread, input.trigger);
    const followUpReply: Reply = {
      channel: input.channel,
      cause: 'follow_up',
      request: { kind: 'keep' },
      trigger: input.trigger,
      rootId: input.root.id,
      buddyId: input.buddyId,
      noticeKey: noticeKey(input.trigger, input.buddyId),
    };
    const verdict = await ports.gate({
      config: (await seatConfig(input.root.id, input.buddyId, { kind: 'keep' })).config,
      prompt: [
        `You are ${await role(input.buddyId)}, one member of a team in the channel ${input.channel.kind.type === 'public' ? `#${input.channel.kind.name}` : input.channel.id}.`,
        'A new message was just posted in a thread you have posted in. The root, then its most recent replies, oldest first:',
        '',
        transcriptLine(context.root, nameMap),
        ...context.shown.map((p) => transcriptLine(p, nameMap)),
        '',
        `New message, from ${label(input.trigger.author, nameMap)}:`,
        readableChannelText(input.trigger.body),
        '',
        `Also in this thread: the Owner, ${(await Promise.all(input.others.map(role))).join(', ')}.`,
        '',
        'Should you respond, or leave it to another team member? Say yes only when the thread needs something from you specifically: a question aimed at you or your role, a correction only you can make, or work you own. Do not reply just to acknowledge or agree.',
        '',
        'Answer with exactly <yes> or <no> and nothing else.',
      ].join('\n'),
    });
    switch (verdict.kind) {
      case 'respond':
        return {
          kind: 'gate_yes',
          job: replyJob(followUpReply, `${input.trigger.id}:${input.buddyId}`, false),
        };
      case 'pass':
        return { kind: 'gate_no' };
      case 'unparseable':
        logger.warn(
          `[channels] ${input.buddyId} gave no <yes>/<no> for post ${input.trigger.id}: ${JSON.stringify(verdict.output)}`
        );
        return { kind: 'gate_no' };
      // The owner waits on an answer, so a gate that could not run is shown in the thread
      // (2026-09-24: every gate failed on a Codex usage limit and threads just stayed quiet).
      case 'failed':
        logger.warn(
          `[channels] reply gate failed for ${input.buddyId} on post ${input.trigger.id}: ${verdict.reason}`
        );
        if (input.trigger.author.kind === 'owner')
          await postFailure(
            followUpReply,
            null,
            `could not decide whether to reply (${verdict.reason})`
          );
        return { kind: 'gate_no' };
    }
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

  /** Ask every other Buddy who posted in this post's thread whether to follow up. */
  async function followUps(channel: Channel, post: Post): Promise<void> {
    if (!post.rootId) return;
    const talk = talkOf(await wholeThread(await core.getPost(OWNER, post.rootId)));
    // Only the newest post is followed up: a burst is gated once, against the latest message.
    if (talk[talk.length - 1].id !== post.id) return;
    const skipped = new Set([...buddyAuthor(post), ...mentionedByPost(post)]);
    const replying = [...pairs.values()]
      .filter((entry) => entry.threadRootId === post.rootId && entry.machine.queue.length > 0)
      .map((entry) => entry.buddyId);
    const participants = [...new Set([...talk.flatMap(buddyAuthor), ...replying])];
    for (const buddyId of participants) {
      if (skipped.has(buddyId) || !(await eligible(buddyId, channel.workspaceId)).ok) continue;
      const followUp: FollowUp = {
        channel,
        trigger: post,
        root: talk[0],
        buddyId,
        others: participants.filter((other) => other !== buddyId),
      };
      apply(
        { channel, rootId: post.rootId, buddyId },
        { kind: 'posted', trigger: { ord: post.ord, followUp } }
      );
    }
  }

  /**
   * One reply per woken Buddy (a valid @mention, or a DM member), in its seat for this thread, on
   * the owner's chip pick when there is one.
   */
  async function wake(
    channel: Channel,
    post: Post,
    picks: MentionPicks,
    cause: 'mention' | 'direct',
    buddyIds: string[]
  ) {
    for (const buddyId of buddyIds) {
      const admitted = await eligible(buddyId, channel.workspaceId);
      if (!admitted.ok) {
        logger.warn(`[channels] mention of ${buddyId} in ${post.id}: ${admitted.reason}`);
        continue;
      }
      const config = picks.get(buddyId);
      const mention: Reply = {
        channel,
        cause,
        request: config ? { kind: 'chosen', config } : { kind: 'keep' },
        trigger: post,
        rootId: rootOf(post),
        buddyId,
        noticeKey: noticeKey(post, buddyId),
      };
      apply(mention, { kind: 'mentioned', job: replyJob(mention, `${post.id}:${buddyId}`, true) });
    }
  }

  /**
   * The owner's plain post in a DM, top-level or in a thread, wakes the DM's Buddies. Until
   * 2026-09-30 every DM post but a request was dropped, @mentions included, so owner replies in a
   * DM thread sat unanswered with no error (four in one thread). A request, or an answer to one,
   * is skipped: the core already queued that run. A Buddy's DM inform still wakes nobody, so two
   * Buddies cannot wake each other. Guard: buddies-v2.test.ts "an owner reply in a DM thread".
   */
  async function directPost(
    channel: Channel,
    members: Actor[],
    post: Post,
    picks: MentionPicks
  ): Promise<void> {
    if (post.author.kind !== 'owner' || post.request.state !== 'none') return;
    const parent = post.replyToId ? await core.getPost(OWNER, post.replyToId) : null;
    if (parent?.request.state === 'answered' && parent.request.answerId === post.id) return;
    const buddyIds = members.flatMap((member) => (member.kind === 'buddy' ? [member.id] : []));
    await wake(channel, post, picks, 'direct', buddyIds);
  }

  // Every created post, from any writer, pushes its channel. In a public channel it starts its
  // @mentions and asks the thread's other Buddies whether to follow up. In a DM the owner's post wakes the DM's Buddies (directPost).
  ports.events.on((event) => {
    if (event.kind !== 'posted') return;
    ports.channelChanged(event.channel.id);
    const { channel, post, picks } = event;
    switch (channel.kind.type) {
      // Task comments previously dropped @mentions entirely. Reuse the channel seat
      // dispatch; guard: buddies-v2.test.ts task comment mentions.
      // Pattern: one-write-path (docs/patterns.md#one-write-path)
      case 'task':
      case 'public': {
        void wake(channel, post, picks, 'mention', mentionedByPost(post)).catch((error) =>
          logger.warn(`[channels] mentions in post ${post.id} failed:`, error)
        );
        void followUps(channel, post).catch((error) =>
          logger.warn(`[channels] follow-up gating failed for post ${post.id}:`, error)
        );
        return;
      }
      case 'direct':
        void directPost(channel, channel.kind.members, post, picks).catch((error) =>
          logger.warn(`[channels] DM post ${post.id} failed to wake its Buddies:`, error)
        );
        return;
    }
  });

  return {
    /**
     * Each thread Buddy's latest seat (harness, model, reasoning): the one its next reply runs
     * on. The mention chip opens on it; until 493c1c7 it showed the profile default, which is
     * wrong once an earlier pick made the seat. A Buddy with no seat yet is omitted (its first
     * reply runs on the profile default, which the client already has).
     */
    async threadSeats(rootId: string): Promise<ThreadSeat[]> {
      const root = await core.getPost(OWNER, rootId);
      if (root.rootId) return [];
      const buddyIds = new Set<string>();
      for (const post of await wholeThread(root)) {
        for (const id of buddyAuthor(post)) buddyIds.add(id);
        for (const id of mentionedByPost(post)) buddyIds.add(id);
      }
      const seats: ThreadSeat[] = [];
      for (const buddyId of buddyIds) {
        const { current } = await scanGenerations(ports.conversations, (g) =>
          threadConversationId(rootId, buddyId, g)
        );
        if (current) seats.push({ buddyId, config: current.config });
      }
      return seats;
    },

    /** Buddies composing a reply in this channel, for "X is replying…". */
    responding(channelId: string): ChannelResponse[] {
      return [...pairs.values()]
        .filter((entry) => entry.channelId === channelId && entry.machine.queue.length > 0)
        .map(({ channelId, threadRootId, buddyId, startedAt, waitingForSlot }) => ({
          channelId,
          threadRootId,
          buddyId,
          startedAt,
          state: waitingForSlot ? 'queued' : 'replying',
        }));
    },

    /**
     * Rerun a reply whose HARNESS failed (out of tokens, a provider error) on the harness the owner
     * picks, in a new seat; the failure notice stays and the new attempt is a later reply. A started
     * session cannot change provider, so the harness that failed is refused (493c1c7). A second
     * click while the rerun is queued or running starts nothing.
     */
    async retryReply(failed: Post, config: ConversationConfig): Promise<MentionDispatch> {
      if (failed.purpose !== 'reply_failed' || failed.author.kind !== 'buddy' || !failed.replyToId)
        throw new Error('Only a failed Buddy reply can be retried');
      if (!isHarnessRetryFailure(failed.body))
        throw new Error('Only an out-of-tokens or provider-error failure can be retried');
      const buddyId = failed.author.id;
      const channel = await core.openChannel(OWNER, { kind: 'id', id: failed.channelId });
      const admitted = await eligible(buddyId, channel.workspaceId);
      if (!admitted.ok) return { buddyId, status: 'rejected', reason: admitted.reason };
      const trigger = await core.getPost(OWNER, failed.replyToId);
      const rootId = rootOf(trigger);
      // The harness that failed: the seat that wrote the notice, else (a gate failure) the seat.
      const slot = failed.conversationId
        ? await ports.conversations.slot(failed.conversationId)
        : ({ kind: 'absent' } as const);
      const failedProvider =
        slot.kind === 'live'
          ? slot.config.provider
          : (await seatConfig(rootId, buddyId, { kind: 'keep' })).config.provider;
      if (config.provider === failedProvider)
        throw new Error(`Pick a different harness. ${failedProvider} is the one that failed.`);
      const retry: Reply = {
        channel,
        cause: 'retry',
        request: { kind: 'chosen', config },
        trigger,
        rootId,
        buddyId,
        noticeKey: `thread-reply:${trigger.id}:${buddyId}:retry:${randomUUID()}`,
      };
      apply(retry, { kind: 'mentioned', job: replyJob(retry, `retry:${failed.id}`, true) });
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

// A seat is also an ordinary chat: the owner may be typing in it.
const idle = (conversation: ConversationRuntime) =>
  !conversation.isRunning && !conversation.hasActiveProcess() && conversation.queue.length === 0;

async function untilIdle(conversation: ConversationRuntime): Promise<void> {
  while (!idle(conversation)) {
    await conversation.waitForTurnDrain();
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}
