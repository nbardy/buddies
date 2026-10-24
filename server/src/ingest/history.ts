/**
 * Message bodies read from the ingest store (crates/unleashd-ingest), in the shape the client
 * pages (`Message`).
 *
 * Why this exists (T13b S2): bodies used to be parsed by the TS loader into every hydrated
 * runtime, capped at the newest 500 transcripts, and re-parsed by a 5 s poller. The store already
 * holds every session's visible history by `seq`, so a conversation's history is read on demand:
 * its bound sessions' messages merged with the live-turn overlay by the existing dedupe
 * (`mergeSessionMessages`). Guards: server/test/ingest-history.test.ts.
 */

import type { Ingest, Message as NativeMessage, SessionRow } from '@unleashd/ingest';
import { type Message, legacyToolInput, toolContentPart } from '@unleashd/shared';
import { nativeBody } from './content';

const READ_PAGE = 5_000;

/** A native message as the client shows it. `at` is absent on a few formats: keep the previous. */
function toMessage(native: NativeMessage, previousAt: number): Message {
  const at = native.at ?? previousAt;
  return {
    role: native.role,
    body: native.partsJson
      ? nativeBody(native.partsJson, native.content)
      : native.toolCall
        ? {
            t: 'parts',
            parts: [toolContentPart(native.toolCall.name, legacyToolInput(native.toolCall.input))],
          }
        : native.role === 'assistant'
          ? nativeBody(undefined, native.content)
          : { t: 'text', text: native.content },
    timestamp: new Date(at),
    ...(native.completedAt !== undefined ? { completedAt: new Date(native.completedAt) } : {}),
  };
}

/** The first `count` messages of one session (its settled prefix). */
export async function sessionMessages(
  ingest: Pick<Ingest, 'messages'>,
  session: Pick<SessionRow, 'sessionId' | 'createdAt'>,
  count: number
): Promise<Message[]> {
  const out: Message[] = [];
  let previousAt = session.createdAt;
  let afterSeq = -1;
  while (out.length < count) {
    const page = await ingest.messages(session.sessionId, {
      afterSeq,
      limit: Math.min(READ_PAGE, count - out.length),
    });
    for (const native of page) {
      const message = toMessage(native, previousAt);
      previousAt = message.timestamp.getTime();
      out.push(message);
    }
    if (page.length === 0) break;
    afterSeq = page[page.length - 1].seq;
  }
  return out;
}

/**
 * The length `mergeSessionMessages(sessions' prefixes, [])` would produce, without building it.
 *
 * Pattern: one-store-one-index (docs/patterns.md) — boot only needs a COUNT, so it is computed by
 * the ingest crate over the stored rows (`Reader::merged_count`): one row per (timestamp, role,
 * body) occurrence, at the maximum occurrence count over sessions. No message crosses napi.
 * Fix-guard: converting + merging 618 histories at boot cost ~2 s of main thread (2026-10-23:
 * toMessage 727 ms, nativeBody 590 ms, merge 417 ms); the first fix still paged every message
 * through napi and SHA-1'd it here (~270 ms of main thread plus the page round trips).
 * Guards: server/test/ingest-history.test.ts (parity with the real merge) and
 * `merged_count_counts_an_inherited_prefix_once` in crates/unleashd-ingest/tests/engine.rs.
 */
export async function mergedCount(
  ingest: Pick<Ingest, 'mergedCounts'>,
  sessions: readonly MergeInput[]
): Promise<number> {
  return (await mergedCounts(ingest, [sessions]))[0];
}

/** One bound session's settled prefix: the first `count` messages of `sessionId`. */
export type MergeInput = Pick<SessionRow, 'sessionId' | 'createdAt'> & { count: number };

/**
 * `mergedCount` for many records in ONE crate call (boot settles 614 at once). One napi round trip
 * and one reader-queue slot replace one per record: with the per-record call the same 20k messages
 * took ~3.5 s of wall on a loaded machine, all of it queueing (2026-10-23).
 */
export async function mergedCounts(
  ingest: Pick<Ingest, 'mergedCounts'>,
  groups: readonly (readonly MergeInput[])[]
): Promise<number[]> {
  return ingest.mergedCounts(
    groups.map((group) => group.map(({ sessionId, createdAt, count }) => ({ sessionId, createdAt, count })))
  );
}

/**
 * `next` keeps every message of `previous` except possibly the last (a streamed reply that grew),
 * so a client may keep its prefix and refetch the tail. The last message is exempt because
 * clients always re-read it.
 */
export function extendsHistory(previous: readonly Message[], next: readonly Message[]): boolean {
  if (next.length < previous.length) return false;
  for (let index = 0; index < previous.length - 1; index += 1) {
    const a = previous[index];
    const b = next[index];
    if (a !== b && (a.role !== b.role || JSON.stringify(a.body) !== JSON.stringify(b.body)))
      return false;
  }
  return true;
}
