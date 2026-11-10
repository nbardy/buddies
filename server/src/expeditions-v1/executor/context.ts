import { open } from 'node:fs/promises';
import path from 'node:path';
import { keyed } from '@unleashd/shared';
import { expandHome } from '../../expedition-kernel/contract';

// The context registry: expedition id → where its runs happen. Read lazily from the `launched`
// line of the kernel's log (expedition-kernel/launch.ts writes it first and never again), so the
// executor needs no registration step and a restarted host finds every expedition it ran.
// Known limit: an owner `contract` entry that moves `repo` is not seen; v1 has no such route.

export type ExpeditionContext = {
  readonly id: string;
  /** The kernel's directory for it: `<root>/<id>`. */
  readonly dir: string;
  /** `contract.repo`, `~` expanded: where checkouts are made and commands run. */
  readonly repo: string;
  /** What a `{ t: 'launch' }` base names. */
  readonly baseSha: string;
  /** The Buddy workspace its agent calls run in (its seat Buddy's). */
  readonly workspace: keyed.LaunchWorkspace;
  /** Σ of the contract's pool caps: the most calls it may run at once, so the least run slots
   * its seat Buddy needs (seat.ts). */
  readonly poolSlots: number;
};

export class ContextRegistry {
  private readonly known = new Map<string, Promise<ExpeditionContext>>();

  constructor(
    private readonly root: string,
    private readonly home: string
  ) {}

  get(id: string): Promise<ExpeditionContext> {
    const cached = this.known.get(id);
    if (cached) return cached;
    const loading = this.load(id);
    this.known.set(id, loading);
    // A failed read is not remembered: the log may be readable on the next call.
    loading.catch(() => this.known.delete(id));
    return loading;
  }

  private async load(id: string): Promise<ExpeditionContext> {
    const dir = path.join(this.root, id);
    const file = path.join(dir, 'log.jsonl');
    const line = await firstLine(file);
    const entry = keyed.Entry.parse(JSON.parse(line));
    if (entry.t !== 'launched' || entry.id !== id)
      throw new Error(`${file}: the first entry is not the launch of ${id}`);
    return {
      id,
      dir,
      repo: expandHome(entry.contract.repo, this.home),
      baseSha: entry.baseSha,
      workspace: entry.workspace,
      poolSlots: Object.values(entry.contract.pools).reduce((n, cap) => n + cap, 0),
    };
  }
}

/** The log's first line, read without loading the whole log. */
async function firstLine(file: string): Promise<string> {
  const fh = await open(file, 'r');
  try {
    // Bytes, not text: a multi-byte character may straddle two reads.
    let bytes = Buffer.alloc(0);
    for (;;) {
      const chunk = Buffer.alloc(64 * 1024);
      const { bytesRead } = await fh.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) throw new Error(`${file}: no complete first line`);
      bytes = Buffer.concat([bytes, chunk.subarray(0, bytesRead)]);
      const end = bytes.indexOf(0x0a);
      if (end >= 0) return bytes.subarray(0, end).toString('utf8');
    }
  } finally {
    await fh.close();
  }
}
