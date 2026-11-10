import { readdir } from 'node:fs/promises';
import path from 'node:path';
import type { Post } from '@unleashd/buddies-core';
import { z } from 'zod';
import type { ReplyTarget } from '../../buddies/routes';
import { readJson, writeJsonAtomic } from '../executor/durable';

// The owner's side of each expedition (CONNECT_PLAN §2), durable at `<expDir>/owner.json`: the
// expedition's thread in the owner↔leader DM, every ask root it posted there, how far the host has
// read the owner's replies in the thread, and the notes the owner left for the leader (D7).
//
// It also answers `consumes` (buddies/routes.ts HostCommands), which is synchronous: the Buddy
// route asks it before it writes the owner's post, to decide whether that post wakes a Buddy turn.
// So every post id of a thread this host owns (the roots, the host's own replies, and any reply
// the bus announces under an owned root) is kept in memory, loaded from these files at start. An
// owner reply under one of them is consumed: it wakes nobody (purpose `host_command`), and the
// host reads it instead (an ask's answer, a command, or a note). Without this an owner reply in
// the leader's DM starts an unbudgeted leader turn (§7.5).

const v = <T extends string, S extends z.ZodRawShape>(t: T, shape: S) =>
  z.object({ t: z.literal(t), ...shape }).strict();

const Note = z.object({ at: z.string(), postId: z.string().min(1), text: z.string() }).strict();
export type Note = z.infer<typeof Note>;
const OwnerFile = z
  .object({
    thread: z.discriminatedUnion('t', [
      v('unposted', {}),
      v('posted', { channelId: z.string().min(1), rootId: z.string().min(1) }),
    ]),
    asks: z.array(
      z
        .object({
          runId: z.string().min(1),
          channelId: z.string().min(1),
          postId: z.string().min(1),
        })
        .strict()
    ),
    /** The ord of the newest owner reply in the thread already handled ('' = none). */
    seen: z.string(),
    notes: z.array(Note),
  })
  .strict();
export type OwnerFile = z.infer<typeof OwnerFile>;
const EMPTY: OwnerFile = { thread: { t: 'unposted' }, asks: [], seen: '', notes: [] };

/** What an owned post belongs to: an expedition's thread, or one of its asks. */
export type Owned = {
  readonly expedition: string;
  readonly channelId: string;
  readonly thread: { readonly t: 'expedition' } | { readonly t: 'ask'; readonly runId: string };
};

const REPLY: {
  readonly [K in ReplyTarget['t']]: (
    owned: ReadonlyMap<string, Owned>,
    channelId: string,
    t: Extract<ReplyTarget, { t: K }>
  ) => boolean;
} = {
  // A post at a channel's root is ordinary talk to the leader: several expeditions may share one
  // leader DM, and nothing says which one a root post is about.
  root: () => false,
  reply: (owned, channelId, t) => owned.get(t.to)?.channelId === channelId,
};

export class OwnerBook {
  private readonly owned = new Map<string, Owned>();
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(private readonly root: string) {}

  // ---- the synchronous index ----

  /** Whether an owner post at `thread` in `channelId` is this host's to read. */
  consumes(channelId: string, thread: ReplyTarget): boolean {
    return (REPLY[thread.t] as (o: Map<string, Owned>, c: string, t: ReplyTarget) => boolean)(
      this.owned,
      channelId,
      thread
    );
  }
  ownerOf(postId: string): Owned | undefined {
    return this.owned.get(postId);
  }
  /** A post the bus announced (the host's own replies included: they are announced too): a reply
   * under an owned root is owned too, so a reply to it is consumed like a reply to the root. */
  noticed(post: Post): void {
    const owner = post.rootId === undefined ? undefined : this.owned.get(post.rootId);
    if (owner) this.owned.set(post.id, owner);
  }
  // ---- the files ----

  /** Every expedition's file under the root, into the index. Returns what could not be read (a
   * corrupt file is reported, never taken as empty: its threads would wake the leader). */
  async loadAll(): Promise<string[]> {
    const failed: string[] = [];
    for (const id of await readdir(this.root).catch(() => [] as string[]))
      await this.read(id).then(
        (f) => this.index(id, f),
        (e: Error) => failed.push(`${id}: ${e.message}`)
      );
    return failed;
  }

  async read(expedition: string): Promise<OwnerFile> {
    const found = await readJson(this.fileOf(expedition), OwnerFile);
    return found.t === 'found' ? found.value : EMPTY;
  }

  /** One change to one expedition's file at a time, written whole. */
  update(expedition: string, change: (f: OwnerFile) => OwnerFile): Promise<OwnerFile> {
    const previous = this.queues.get(expedition) ?? Promise.resolve();
    const run = previous.then(async () => {
      const next = OwnerFile.parse(change(await this.read(expedition)));
      await writeJsonAtomic(this.fileOf(expedition), next);
      this.index(expedition, next);
      return next;
    });
    this.queues.set(
      expedition,
      run.catch(() => {})
    );
    return run;
  }

  threadPosted(expedition: string, channelId: string, rootId: string): Promise<OwnerFile> {
    return this.update(expedition, (f) =>
      f.thread.t === 'posted' ? f : { ...f, thread: { t: 'posted', channelId, rootId } }
    );
  }
  askPosted(
    expedition: string,
    ask: { runId: string; channelId: string; postId: string }
  ): Promise<OwnerFile> {
    return this.update(expedition, (f) =>
      f.asks.some((a) => a.postId === ask.postId) ? f : { ...f, asks: [...f.asks, ask] }
    );
  }

  private fileOf(expedition: string): string {
    return path.join(this.root, expedition, 'owner.json');
  }

  private index(expedition: string, f: OwnerFile): void {
    if (f.thread.t === 'posted')
      this.owned.set(f.thread.rootId, {
        expedition,
        channelId: f.thread.channelId,
        thread: { t: 'expedition' },
      });
    for (const a of f.asks)
      this.owned.set(a.postId, {
        expedition,
        channelId: a.channelId,
        thread: { t: 'ask', runId: a.runId },
      });
  }
}
