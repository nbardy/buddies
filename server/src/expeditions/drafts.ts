import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { BuddiesCore, ChannelRef } from '@unleashd/buddies-core';
import type { ExpeditionDraftView } from '@unleashd/shared';
import { z } from 'zod';
import { OWNER, buddyActor } from '../buddies/core';
import type { BuddyEvents } from '../buddies/events';
import { announcePost } from '../buddies/events';
import type { LaunchInput, Launched } from './host';
import { CHARTER_DEFAULT_KEYS, Charter, type CharterDefault, type Origin } from './model';
import { charterView } from './view';

// Expedition drafts (design.md R10): the `draft` action persists a validated charter and the host
// posts ONE card for it in the chat the draft came from. The owner launches from the card (HTTP,
// routes.ts) through the same launch path and refusal list as the tool's `launch`.
// Pattern: idempotency-keys (docs/patterns.md#idempotency-keys) — the card post's key is
// `exp-draft:<draftId>`, so a replayed post is a no-op.
// Pattern: sum-types (docs/patterns.md#sum-types) — a draft is open, launched or superseded.

const DRAFT_ID = /^draft-[0-9a-f]{8}$/;

const Strings = z.array(z.string());

/** A draft as stored at `<appData>/expeditions/drafts/<draftId>.json` (one atomic write each).
 * Also κ for boot: a file read back is parsed by this schema, so a malformed or stale-schema
 * draft is named in the log at boot, never met later inside a view or a launch. */
const DraftRecord = z
  .object({
    id: z.string().regex(DRAFT_ID),
    createdAt: z.string(),
    /** `<conversation>:<name>`: the launch key, and what a newer draft supersedes by. */
    key: z.string().min(1),
    charter: Charter,
    /** As checked when drafted; an open draft's view re-checks them on every read. */
    issues: Strings,
    advice: Strings,
    /** The charter fields the request left out (the view marks each value as a default). */
    defaulted: z.array(z.enum(CHARTER_DEFAULT_KEYS as [CharterDefault, ...CharterDefault[]])),
    resolved: Strings,
    origin: z.discriminatedUnion('t', [
      z.object({ t: z.literal('thread'), channelId: z.string(), rootId: z.string() }).strict(),
      z.object({ t: z.literal('direct') }).strict(),
    ]),
    launcherId: z.string(),
    workspaceId: z.string(),
    state: z.discriminatedUnion('t', [
      z.object({ t: z.literal('open') }).strict(),
      z.object({ t: z.literal('launched'), expeditionId: z.string() }).strict(),
      z.object({ t: z.literal('superseded'), by: z.string() }).strict(),
    ]),
  })
  .strict();
export type DraftRecord = z.infer<typeof DraftRecord>;

export type DraftInput = Omit<DraftRecord, 'id' | 'createdAt' | 'state'>;

/** A launch through the host: its result, or every reason the preflight refused it. */
export type LaunchOutcome = Launched | { t: 'refused'; reasons: string[] };

/** What a Launch click got. `already_running`: an expedition of this name launched from the same
 * conversation is still open (the draft stays open); `missing` covers another workspace's draft. */
export type DraftLaunch =
  | { t: 'launched'; expeditionId: string }
  | { t: 'already_running'; expeditionId: string; name: string }
  | { t: 'refused'; reasons: string[] }
  | { t: 'superseded'; by: string }
  | { t: 'missing' };

export type DraftLookup = { t: 'present'; view: ExpeditionDraftView } | { t: 'missing' };

export interface DraftStoreOptions {
  core: BuddiesCore;
  events: BuddyEvents;
  dir: string;
  launch(input: LaunchInput): Promise<LaunchOutcome>;
  issues(workspaceId: string, charter: Charter): Promise<string[]>;
  /** Every expedition launched so far: its launch key and when (each ledger's `launched` entry). */
  launches(): { key: string; id: string; at: string }[];
  now(): string;
}

/**
 * An open draft whose key launched at or after the draft was made is launched (2026-11-01
 * review: a crash between host.launch's ledger append and the draft's save left it open, and
 * once that expedition finished a click launched a second one from the same draft). Recomputed
 * from the ledgers on every boot, so it holds without a write (a copied store writes nothing).
 * A tool launch of the same name from the same conversation after the draft counts too, as
 * launchedByTool already records.
 */
function reconciled(
  draft: DraftRecord,
  launches: { key: string; id: string; at: string }[]
): DraftRecord {
  if (draft.state.t !== 'open') return draft;
  const launch = launches
    .filter((l) => l.key === draft.key && l.at >= draft.createdAt)
    .sort((a, b) => a.at.localeCompare(b.at))[0];
  return launch ? { ...draft, state: { t: 'launched', expeditionId: launch.id } } : draft;
}

/** Where a post for this origin goes: the launch thread, or the owner↔launcher DM (the badge's
 * and the draft card's one placement rule). */
export function placementOf(
  origin: Origin,
  launcherId: string
): { channel: ChannelRef; replyToId?: string } {
  switch (origin.t) {
    case 'thread':
      return { channel: { kind: 'id', id: origin.channelId }, replyToId: origin.rootId };
    case 'direct':
      return { channel: { kind: 'direct', members: [OWNER, buddyActor(launcherId)] } };
  }
}

export type DraftStore = ReturnType<typeof createDraftStore>;

export function createDraftStore(options: DraftStoreOptions) {
  const { core, events, dir } = options;
  const drafts = new Map<string, DraftRecord>();
  // Boot: read every draft once (sync fs, once, like the host's ledgers). An unreadable or
  // malformed file is named in the log and left on disk; its card then reads "no draft" (404),
  // never a guess. A leftover `<id>.json.<rand>.tmp` (a crash mid-save) is skipped, not removed:
  // a host on a copied store (execution gate disabled) must write nothing, so the directory is
  // also made by the first save, not here.
  for (const file of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    const id = file.replace(/\.json$/, '');
    if (!DRAFT_ID.test(id) || !file.endsWith('.json')) continue;
    try {
      const record = DraftRecord.parse(JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')));
      if (record.id !== id) throw new Error(`it records id ${record.id}`);
      drafts.set(id, reconciled(record, options.launches()));
    } catch (error) {
      console.warn(`[expeditions] draft ${id} unreadable: ${(error as Error).message}`);
    }
  }

  /** Atomic: a whole new file renamed over the old, so a crash leaves one or the other. */
  async function save(draft: DraftRecord): Promise<void> {
    const file = path.join(dir, `${draft.id}.json`);
    const tmp = `${file}.${randomUUID().slice(0, 8)}.tmp`;
    await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
    await fsp.writeFile(tmp, JSON.stringify(draft), { mode: 0o600 });
    await fsp.rename(tmp, file);
    drafts.set(draft.id, draft);
  }

  /** One chain for every write: two Launch clicks, or a launch racing a re-draft, never interleave. */
  let chain: Promise<unknown> = Promise.resolve();
  function serialized<T>(work: () => Promise<T>): Promise<T> {
    const next = chain.then(work);
    chain = next.catch(() => undefined);
    return next;
  }

  /** The draft, only from the workspace it was drafted in (another workspace sees none). */
  const draftIn = (id: string, workspaceId: string): DraftRecord | undefined => {
    const draft = drafts.get(id);
    return draft?.workspaceId === workspaceId ? draft : undefined;
  };

  async function viewOf(draft: DraftRecord): Promise<ExpeditionDraftView> {
    return {
      id: draft.id,
      workspaceId: draft.workspaceId,
      createdAt: draft.createdAt,
      state: draft.state,
      charter: charterView(draft.charter),
      issues: await currentIssues(draft),
      advice: draft.advice,
      defaulted: draft.defaulted,
      resolved: draft.resolved,
    };
  }

  /** An open draft's issues are re-checked (an installed binary clears one); a closed one's are
   * history. */
  function currentIssues(draft: DraftRecord): Promise<string[]> | string[] {
    switch (draft.state.t) {
      case 'open':
        return options.issues(draft.workspaceId, draft.charter);
      case 'launched':
      case 'superseded':
        return draft.issues;
    }
  }

  /** The draft is launched (by its card or by the tool): recorded once. */
  async function markLaunched(draft: DraftRecord, expeditionId: string): Promise<void> {
    await save({ ...draft, state: { t: 'launched', expeditionId } });
  }

  async function launchOpen(draft: DraftRecord): Promise<DraftLaunch> {
    const outcome = await options.launch({
      key: draft.key,
      charter: draft.charter,
      origin: draft.origin,
      launcherId: draft.launcherId,
      workspaceId: draft.workspaceId,
    });
    switch (outcome.t) {
      case 'refused':
        return outcome;
      case 'already_running':
        // Launched since this draft was made (the tool, or this card before a crash cut off its
        // markLaunched): that launch is this draft's, so the card answers it, not "stop it".
        if (outcome.state.launchedAt >= draft.createdAt) {
          await markLaunched(draft, outcome.state.id);
          return { t: 'launched', expeditionId: outcome.state.id };
        }
        return {
          t: 'already_running',
          expeditionId: outcome.state.id,
          name: outcome.state.charter.name,
        };
      case 'launched':
        await markLaunched(draft, outcome.state.id);
        return { t: 'launched', expeditionId: outcome.state.id };
    }
  }

  return {
    /**
     * Persists a draft, supersedes the open draft of the same name from the same conversation,
     * and posts the draft's one card where a launch's badge would go.
     */
    draft: (input: DraftInput): Promise<DraftRecord> =>
      serialized(async () => {
        const draft: DraftRecord = {
          ...input,
          id: `draft-${randomUUID().replaceAll('-', '').slice(0, 8)}`,
          createdAt: options.now(),
          state: { t: 'open' },
        };
        // The older open drafts are closed BEFORE the new one is written: a crash between the
        // writes leaves no open draft under the key (the Buddy re-drafts), never two Launches.
        for (const older of [...drafts.values()]) {
          if (older.key === draft.key && older.state.t === 'open')
            await save({ ...older, state: { t: 'superseded', by: draft.id } });
        }
        await save(draft);
        const target = placementOf(draft.origin, draft.launcherId);
        const write = await core.post(buddyActor(draft.launcherId), target.channel, {
          kind: 'inform',
          // Plain fallback text: the client renders this purpose as the card (Info, Launch).
          body: `⛺ Draft expedition: ${draft.charter.name}`,
          purpose: 'expedition_draft',
          evidence: [`expedition-draft:${draft.id}`],
          replyToId: target.replyToId,
          mentions: [],
          broadcast: false,
          key: `exp-draft:${draft.id}`,
        });
        if (write.created) await announcePost({ core, events }, OWNER, write.post);
        return draft;
      }),

    async view(id: string, workspaceId: string): Promise<DraftLookup> {
      const draft = draftIn(id, workspaceId);
      return draft ? { t: 'present', view: await viewOf(draft) } : { t: 'missing' };
    },

    /** The card's Launch: idempotent (a launched draft answers its expedition again). */
    launch: (id: string, workspaceId: string): Promise<DraftLaunch> =>
      serialized(async () => {
        const draft = draftIn(id, workspaceId);
        if (!draft) return { t: 'missing' };
        switch (draft.state.t) {
          case 'launched':
            return { t: 'launched', expeditionId: draft.state.expeditionId };
          case 'superseded':
            return { t: 'superseded', by: draft.state.by };
          case 'open':
            return launchOpen(draft);
        }
      }),

    /** The tool launched this key: its open draft (if any) now shows "Launched". */
    launchedByTool: (key: string, expeditionId: string): Promise<void> =>
      serialized(async () => {
        for (const draft of drafts.values()) {
          if (draft.key === key && draft.state.t === 'open')
            await markLaunched(draft, expeditionId);
        }
      }),
  };
}
