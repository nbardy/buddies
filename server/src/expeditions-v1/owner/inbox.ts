import type { Post } from '@unleashd/buddies-core';
import type { OwnerThread, Thread } from '../../buddies/owner-thread';
import type { Expedition, OwnerResult } from '../../expedition-kernel/kernel';
import type { Approvals, Decided } from './approvals';
import type { OwnerBook } from './book';
import { type OwnerWord, ownerWord } from './words';

// The owner's replies in an expedition's thread (CONNECT_PLAN §2, D7). Each was consumed when it
// was posted (owner/book.ts): it woke nobody, and the host reads it here, oldest first, after the
// thread's `seen` mark in owner.json:
//   a bare command (pause, resume, stop, extend Nh, retry <key>): applied through the kernel's
//     owner acts and answered with one status line;
//   approve / decline: the rewrite waiting for the owner (owner/approvals.ts);
//   anything else: a note, kept durably and shown at the leader's next wake. It wakes no one: a
//     paid wake for a remark would be spend the owner did not ask for (D7).
// At most once: the mark moves past a command BEFORE it is applied, so a crash in between loses
// that command (no acknowledgement appears; the owner repeats it) instead of applying it twice
// (2026-11-03, old host: a repeated `extend 2h` added 4 h). A note is kept in the same write as
// the mark, so it is exactly once. Acknowledgements are keyed by the owner's post: never twice.

/** An open expedition, as the inbox steers it. */
export type Steered = {
  readonly kernel: Pick<
    Expedition,
    'id' | 'state' | 'pause' | 'resume' | 'stop' | 'extend' | 'retry'
  >;
  readonly thread: Thread;
};

export type InboxDeps = {
  readonly book: OwnerBook;
  readonly thread: OwnerThread;
  readonly approvals: Pick<Approvals, 'decide'>;
};

/** What one owner reply asks of the host. */
type Heard =
  | {
      readonly t: 'act';
      readonly act: (k: Steered['kernel']) => Promise<OwnerResult>;
      readonly done: (k: Steered['kernel']) => string;
    }
  | { readonly t: 'approval'; readonly approved: boolean }
  | { readonly t: 'note'; readonly text: string };

const act = (
  run: (k: Steered['kernel']) => Promise<OwnerResult>,
  done: (k: Steered['kernel']) => string
): Heard => ({ t: 'act', act: run, done });
const note = (text: string): Heard => ({ t: 'note', text });
const deadlineOf = (k: Steered['kernel']) => new Date(k.state().deadlineMs).toISOString();

const HEARD: {
  readonly [K in OwnerWord['t']]: (w: Extract<OwnerWord, { t: K }>, body: string) => Heard;
} = {
  pause: () =>
    act(
      (k) => k.pause(),
      () => 'Paused · no new call starts until you resume.'
    ),
  resume: () =>
    act(
      (k) => k.resume(),
      () => 'Resumed.'
    ),
  stop: () =>
    act(
      (k) => k.stop(),
      () => 'Stopped · the expedition is finished.'
    ),
  extend: (w) =>
    act(
      (k) => k.extend(w.hours),
      (k) => `Extended ${w.hours} h · the deadline is now ${deadlineOf(k)}.`
    ),
  retry: (w) =>
    act(
      (k) => k.retry(w.key),
      () => `Retrying ${w.key}.`
    ),
  approve: () => ({ t: 'approval', approved: true }),
  decline: () => ({ t: 'approval', approved: false }),
  note: (w) => note(w.text),
  talk: (_w, body) => note(body.trim()),
};
const heardOf = (body: string): Heard => {
  const w = ownerWord(body);
  return (HEARD[w.t] as (w: OwnerWord, body: string) => Heard)(w, body);
};

const quoted = (body: string) => `"${body.trim().slice(0, 80)}"`;
/** The status line for an act's result. */
const ACTED: {
  readonly [K in OwnerResult['t']]: (
    r: Extract<OwnerResult, { t: K }>,
    done: () => string,
    body: string
  ) => string;
} = {
  done: (_r, done) => done(),
  refused: (r, _done, body) => `${quoted(body)}: not done, ${r.why}.`,
};
const DECIDED: {
  readonly [K in Decided['t']]: (i: Inbox, x: Steered, p: Post) => Promise<void>;
} = {
  // Approvals.decide posted the decision's own line.
  decided: async () => {},
  'nothing-pending': (i, x, p) => i.ack(x, p, 'Nothing is waiting for your approval.'),
};

const HANDLE: {
  readonly [K in Heard['t']]: (
    i: Inbox,
    x: Steered,
    p: Post,
    h: Extract<Heard, { t: K }>
  ) => Promise<void>;
} = {
  note: (i, x, p, h) => i.note(x, p, h.text),
  act: (i, x, p, h) => i.act(x, p, h),
  approval: (i, x, p, h) => i.approval(x, p, h.approved),
};

export class Inbox {
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(private readonly d: InboxDeps) {}

  /** Read the owner's new replies in one expedition's thread. One read per expedition at a time. */
  read(x: Steered): Promise<void> {
    const id = x.kernel.id;
    const previous = this.queues.get(id) ?? Promise.resolve();
    const run = previous.then(() => this.readNow(x));
    this.queues.set(
      id,
      run.catch(() => {})
    );
    return run;
  }

  private async readNow(x: Steered): Promise<void> {
    const id = x.kernel.id;
    const f = await this.d.book.read(id);
    if (f.thread.t !== 'posted') return;
    const fresh = (
      await this.d.thread.pageAfter({ kind: 'thread', rootId: f.thread.rootId }, f.seen)
    )
      .filter((p) => p.author.kind === 'owner')
      .sort((a, b) => (a.ord < b.ord ? -1 : 1));
    for (const p of fresh) await this.heard(x, p, heardOf(p.body));
  }

  private heard(x: Steered, p: Post, h: Heard): Promise<void> {
    return (HANDLE[h.t] as (i: Inbox, x: Steered, p: Post, h: Heard) => Promise<void>)(
      this,
      x,
      p,
      h
    );
  }

  async note(x: Steered, p: Post, text: string): Promise<void> {
    await this.d.book.update(x.kernel.id, (f) => ({
      ...f,
      seen: p.ord,
      notes: [...f.notes, { at: p.createdAt, postId: p.id, text }],
    }));
    await this.ack(x, p, 'Noted · the leader reads it at its next wake.');
  }

  async act(x: Steered, p: Post, h: Extract<Heard, { t: 'act' }>): Promise<void> {
    await this.markSeen(x.kernel.id, p);
    const r = await h.act(x.kernel);
    const line = (ACTED[r.t] as (r: OwnerResult, done: () => string, body: string) => string)(
      r,
      () => h.done(x.kernel),
      p.body
    );
    await this.ack(x, p, line);
  }

  async approval(x: Steered, p: Post, approved: boolean): Promise<void> {
    await this.markSeen(x.kernel.id, p);
    const decided = await this.d.approvals.decide(x.kernel.id, approved);
    await DECIDED[decided.t](this, x, p);
  }

  private markSeen(id: string, p: Post) {
    return this.d.book.update(id, (f) => ({ ...f, seen: p.ord }));
  }

  /** One status line answering the owner's post `p`, keyed by it: never posted twice. */
  async ack(x: Steered, p: Post, line: string): Promise<void> {
    await this.d.thread.postStatus(x.thread, `xk:${x.kernel.id}:ack:${p.id}`, line);
  }
}
