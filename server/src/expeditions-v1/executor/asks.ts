import type { Post } from '@unleashd/buddies-core';
import type { keyed } from '@unleashd/shared';
import { type BuddiesCore, OWNER, buddyActor } from '../../buddies/core';
import { type BuddyEvents, announcePost } from '../../buddies/events';
import { type OwnerThread, createOwnerThread } from '../../buddies/owner-thread';
import type { RawOutcome, RunSpec } from '../../expedition-kernel/ports';
import { type Observing, observeBuddyEvents } from '../observe';
import type { OwnerBook } from '../owner/book';
import { ASK_PURPOSE, STATUS_PURPOSE, evidenceOf, leaderDm } from '../owner/thread';
import { yesNo } from '../owner/words';
import { parseRunId } from './address';
import type { ExecutorSide, Located } from './calls';
import { settleAtStart } from './calls';
import {
  type Asked,
  type Asking,
  type Last,
  type RunRecord,
  readRecord,
  recordsUnder,
  writeRecord,
} from './records';
import { putRef } from './refs';
import { NOTHING } from './usage';

// Owner asks (CONNECT_PLAN §1 "ask", §2): each ask is its own root post in the owner↔leader DM,
// written by the leader and keyed `xk:<runId>`, carrying the question. The answer is the owner's
// reply in that thread, read from the thread itself whenever the ask is observed, so the record
// plus the thread are the whole state: a restart loses nothing, and there is no deadline (an ask
// is answerable after the expedition's deadline, like a judge).
//   text:    the first owner reply is the answer.
//   confirm: the first owner reply that is a clear yes or no (owner/words.ts `yesNo`). Each reply
//            that is neither gets ONE reply from the host (keyed by that reply), and it waits on.
// An ask reserves nothing and is never cancelled (`cancel` is a no-op); `close` tombstones it. An
// owner reply in the thread is consumed (owner/book.ts): it wakes no leader turn.
// Pattern: idempotency-keys (docs/patterns.md#idempotency-keys): the question's key is
// `xk:<runId>`, a re-ask's is `xk:<runId>:unclear:<reply id>`, a direct answer's `xk:<runId>:answer`.

export type AskSpec = Extract<RunSpec, { t: 'ask' }>;
type Live = Asking | Asked;

/** An answer given directly (the future HTTP route), not typed into the thread. */
export type AskAnswer =
  | { readonly t: 'text'; readonly text: string }
  | { readonly t: 'confirm'; readonly yes: boolean };
export type Answered = { readonly t: 'answered' } | { readonly t: 'refused'; readonly why: string };

/** How the executor runs the ask kind. Every per-run method runs inside the run's queue. */
export interface Asks {
  start(at: Located, spec: AskSpec): Promise<void>;
  /** A live ask as it stands: an `asking` one is posted first. */
  current(at: Located, r: Live): Promise<RunRecord>;
  close(at: Located, r: Live): Promise<Last>;
  answer(at: Located, r: RunRecord, a: AskAnswer): Promise<Answered>;
  watch(): Promise<() => void>;
}

export type AskDeps = {
  readonly core: BuddiesCore;
  readonly events: BuddyEvents;
  readonly book: OwnerBook;
  readonly timing: Observing;
  readonly logger: Pick<Console, 'warn'>;
};

/** A host with no owner to ask (the host-only executor tests): an ask settles `errored(why)`. */
export class NoAsks implements Asks {
  constructor(
    private readonly side: ExecutorSide,
    private readonly why: string
  ) {}
  start(at: Located, spec: AskSpec): Promise<void> {
    return settleAtStart(this.side, at, spec.t, { t: 'errored', why: this.why });
  }
  current(at: Located): Promise<RunRecord> {
    throw new Error(`${at.address.runId} is an owner ask, and ${this.why}`);
  }
  close(at: Located): Promise<Last> {
    throw new Error(`${at.address.runId} is an owner ask, and ${this.why}`);
  }
  async answer(): Promise<Answered> {
    return { t: 'refused', why: this.why };
  }
  async watch(): Promise<() => void> {
    return () => {};
  }
}

const HOW_TO_ANSWER: { readonly [K in keyed.AskCall['answer']]: string } = {
  text: 'Reply in this thread: your first reply is the answer.',
  confirm: 'Reply in this thread with yes or no.',
};
/** The question post: a pure function of the run (its key replays only this exact body). */
function askBody(at: Located, call: keyed.AskCall): string {
  return [
    `❓ ${call.question}`,
    '',
    HOW_TO_ANSWER[call.answer],
    `(expedition ${at.address.expedition} · ${call.key})`,
  ].join('\n');
}
const UNCLEAR =
  'I could not read that as a yes or a no, so the question is still open. Reply yes or no.';

/** What the owner's replies in an ask's thread say, oldest first. */
type Reading =
  | { readonly t: 'answered'; readonly out: string | boolean }
  /** No answer yet; `unclear`: replies that were neither yes nor no (a confirm ask's). */
  | { readonly t: 'waiting'; readonly unclear: readonly Post[] };
const READ: { readonly [K in keyed.AskCall['answer']]: (replies: readonly Post[]) => Reading } = {
  text: (replies) => {
    const first = replies[0];
    return first ? { t: 'answered', out: first.body } : { t: 'waiting', unclear: [] };
  },
  confirm: (replies) => {
    const unclear: Post[] = [];
    for (const reply of replies) {
      const said = yesNo(reply.body);
      if (said.t !== 'unclear') return { t: 'answered', out: said.t === 'yes' };
      unclear.push(reply);
    }
    return { t: 'waiting', unclear };
  },
};
/** A direct answer's text in the thread, checked against the ask's kind. */
type Direct =
  | { readonly t: 'body'; readonly body: string }
  | { readonly t: 'refused'; readonly why: string };
const DIRECT: { readonly [K in keyed.AskCall['answer']]: (a: AskAnswer) => Direct } = {
  text: (a) =>
    a.t === 'text'
      ? { t: 'body', body: a.text }
      : { t: 'refused', why: 'this ask takes a text answer' },
  confirm: (a) =>
    a.t === 'confirm'
      ? { t: 'body', body: a.yes ? 'yes' : 'no' }
      : { t: 'refused', why: 'this ask takes yes or no' },
};

export class OwnerAsks implements Asks {
  private readonly thread: OwnerThread;
  private readonly watched = new Set<string>();
  private readonly dms = new Map<string, Promise<string>>();

  constructor(
    private readonly side: ExecutorSide,
    private readonly d: AskDeps
  ) {
    this.thread = createOwnerThread({ core: d.core, events: d.events });
  }

  async start(at: Located, spec: AskSpec): Promise<void> {
    const asking: Asking = {
      t: 'asking',
      runId: at.address.runId,
      buddyId: at.ctx.leader,
      body: askBody(at, spec.call),
      answer: spec.call.answer,
    };
    await writeRecord(at.paths.record, asking);
    await this.post(at, asking);
  }

  async current(at: Located, r: Live): Promise<RunRecord> {
    const now = r.t === 'asking' ? await this.post(at, r) : r;
    this.watched.add(now.runId);
    // An observation, never a settle here: `status` runs in the kernel's boot queue.
    this.observe(now.runId);
    return now;
  }

  async close(_at: Located, r: Live): Promise<Last> {
    this.watched.delete(r.runId);
    return { t: 'never-settled' };
  }

  async answer(at: Located, r: RunRecord, a: AskAnswer): Promise<Answered> {
    if (r.t !== 'asking' && r.t !== 'asked')
      return { t: 'refused', why: `the ask is ${r.t === 'closed' ? 'closed' : 'answered'}` };
    const asked = r.t === 'asking' ? await this.post(at, r) : r;
    const direct = DIRECT[asked.answer](a);
    if (direct.t === 'refused') return direct;
    const write = await this.d.core.post(
      OWNER,
      { kind: 'id', id: asked.channelId },
      {
        kind: 'inform',
        body: direct.body,
        // A host command wakes nobody (the crate's fan-out skips it): this is the owner's answer.
        purpose: 'host_command',
        evidence: [],
        replyToId: asked.postId,
        mentions: [],
        broadcast: false,
        key: `xk:${asked.runId}:answer`,
      }
    );
    if (write.created) await announcePost(this.d, OWNER, write.post);
    await this.step(at, asked);
    return { t: 'answered' };
  }

  async watch(): Promise<() => void> {
    const stop = observeBuddyEvents(this.d.events, this.d.timing, 'expedition-asks', () =>
      this.pass()
    );
    for (const r of await recordsUnder(this.side.root))
      if (r.t === 'asking' || r.t === 'asked') this.watched.add(r.runId);
    this.pass();
    return stop;
  }

  // ---- posting ----

  private dmOf(leader: string): Promise<string> {
    const known = this.dms.get(leader);
    if (known) return known;
    const opening = leaderDm(this.d.core, leader);
    this.dms.set(leader, opening);
    opening.catch(() => this.dms.delete(leader));
    return opening;
  }

  /** asking → asked. The book learns the root before the record says `asked`, so an owner reply
   * is consumed from the moment the question can be seen. */
  private async post(at: Located, r: Asking): Promise<Asked> {
    const channelId = await this.dmOf(r.buddyId);
    const postId = await this.thread.inform(
      buddyActor(r.buddyId),
      { channel: { kind: 'id', id: channelId } },
      { body: r.body, purpose: ASK_PURPOSE, key: `xk:${r.runId}` },
      evidenceOf(at.address.expedition),
      'announce'
    );
    await this.d.book.askPosted(at.address.expedition, { runId: r.runId, channelId, postId });
    const asked: Asked = {
      ...r,
      t: 'asked',
      channelId,
      postId,
      postedAt: this.side.clock.now().toISOString(),
    };
    await writeRecord(at.paths.record, asked);
    this.watched.add(r.runId);
    return asked;
  }

  // ---- observing ----

  private pass(): void {
    for (const runId of this.watched) this.observe(runId);
  }

  private observe(runId: string): void {
    this.side
      .serial(runId, async () => {
        const at = await this.side.locate(runId);
        const found = await readRecord(at.paths.record);
        if (found.t === 'missing') return;
        const r = found.value;
        if (r.t === 'asking') return this.post(at, r);
        if (r.t !== 'asked') return this.watched.delete(runId);
        return this.step(at, r);
      })
      .catch((e: unknown) =>
        this.d.logger.warn(`[expeditions-v1] ask ${runId}: ${(e as Error).message}`)
      );
  }

  /** Read the thread; settle on an answer, or re-ask once per unclear reply. */
  private async step(at: Located, r: Asked): Promise<void> {
    const replies = (await this.thread.pageAfter({ kind: 'thread', rootId: r.postId }, ''))
      .filter((p) => p.author.kind === 'owner')
      .sort((a, b) => (a.ord < b.ord ? -1 : 1));
    const reading = READ[r.answer](replies);
    if (reading.t === 'waiting') {
      for (const reply of reading.unclear) await this.reAsk(r, reply);
      return;
    }
    await this.settle(at, r, { t: 'ok', out: reading.out });
  }

  private async reAsk(r: Asked, reply: Post): Promise<void> {
    await this.thread.inform(
      buddyActor(r.buddyId),
      { channel: { kind: 'id', id: r.channelId }, replyToId: r.postId },
      { body: UNCLEAR, purpose: STATUS_PURPOSE, key: `xk:${r.runId}:unclear:${reply.id}` },
      evidenceOf(parseRunId(r.runId).expedition),
      'announce'
    );
  }

  /** The answer is stored as the ask's ref before it is reported, like any call's output. */
  private async settle(at: Located, r: Asked, raw: Extract<RawOutcome, { t: 'ok' }>) {
    await putRef(at.ctx.dir, {
      ref: at.address.ref,
      out: raw.out,
      commit: at.ctx.baseSha,
      checkout: { t: 'none' },
      conversation: { t: 'none' },
    });
    await writeRecord(at.paths.record, {
      t: 'settled',
      runId: r.runId,
      kind: 'ask',
      deadlineAt: r.postedAt,
      tree: { t: 'none' },
      raw,
      spent: NOTHING,
      stop: { t: 'none' },
    });
    this.watched.delete(r.runId);
    this.side.report('ask', r.runId, raw, NOTHING);
  }
}
