// Pattern: fix-guards (docs/patterns.md#fix-guards)
// Sigils render in ONE module worker, never on the main thread. Until
// 2026-09-26 every avatar on screen rendered inline in one passive-effect
// flush (12 on a thread deep link: WebGL draw + readPixels + canvas strokes
// each). Measured on a copy of the owner's data: a 0.8–3.5 s main-thread
// block under software GL (60–250 ms on a GPU), sitting BEFORE the thread
// pane mounted, so "Loading thread…" waited on avatars. Guard:
// client/test/sigil-off-main-thread.test.ts.

/** Render styles: patterned surround (sigil), or glowing kernel (emblem). */
export type SigilKind = 'sigil' | 'emblem';
export type SigilRequest = { id: number; kind: SigilKind; name: string };
export type SigilReply =
  | { kind: 'png'; id: number; png: Blob }
  | { kind: 'failed'; id: number; error: string };

type Waiter = { resolve(url: string): void; reject(error: Error): void };

const waiting = new Map<number, Waiter>();
let nextId = 0;
let worker: Worker | null = null;

function settle(reply: SigilReply): void {
  const waiter = waiting.get(reply.id);
  waiting.delete(reply.id);
  switch (reply.kind) {
    case 'png':
      waiter?.resolve(URL.createObjectURL(reply.png));
      return;
    case 'failed':
      waiter?.reject(new Error(reply.error));
      return;
  }
}

function start(): Worker {
  const started = new Worker(new URL('./sigil.worker.ts', import.meta.url), { type: 'module' });
  started.onmessage = (event: MessageEvent<SigilReply>) => settle(event.data);
  // The worker itself failed (no module workers, a load error): every render
  // still waiting fails, and the avatar keeps its ground colour.
  started.onerror = (event) => {
    for (const waiter of waiting.values())
      waiter.reject(new Error(`Sigil worker: ${event.message}`));
    waiting.clear();
  };
  return started;
}

/** A sigil or emblem as a PNG object URL, rendered off the main thread. */
export function renderSigilUrl(kind: SigilKind, name: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    waiting.set(id, { resolve, reject });
    worker ??= start();
    worker.postMessage({ id, kind, name } satisfies SigilRequest);
  });
}
