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
import type { LaunchInput, Launched } from './launch';
import { CHARTER_DEFAULT_KEYS, Charter, type CharterDefault, Origin } from './model';
import { charterView } from './view';

// Expedition drafts (design.md R10): `draft` persists a validated charter and posts ONE card
// (key `exp-draft:<draftId>`, so a replay is a no-op) in its chat; the owner launches from the
// card (routes.ts) through the tool's own launch path. A draft is open, launched or superseded.

const DRAFT_ID = /^draft-[0-9a-f]{8}$/;
const Strings = z.array(z.string());

/** A draft at `<appData>/expeditions/drafts/<draftId>.json`; also κ for boot, so a malformed
 * draft is named in the log then, never met later inside a view or a launch. */
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
    defaulted: z.array(z.enum(CHARTER_DEFAULT_KEYS as [CharterDefault, ...CharterDefault[]])),
    resolved: Strings,
    origin: Origin,
    launcherId: z.string(),
    workspaceId: z.string(),
    state: z.discriminatedUnion('t', [
      z.object({ t: z.literal('open') }).strict(),
      z.object({ t: z.literal('launched'), expeditionId: z.string() }).strict(),
      z.object({ t: z.literal('superseded'), by: z.string() }).strict(),
    ]),
  })
  .strict();
type DraftRecord = z.infer<typeof DraftRecord>;

export type DraftInput = Omit<DraftRecord, 'id' | 'createdAt' | 'state'>;

/** A launch through the host: its result, or every reason the preflight refused it. */
export type LaunchOutcome = Launched | { t: 'refused'; reasons: string[] };

/** What a Launch click got. `already_running`: an earlier launch of this name from the same
 * conversation is still open; `missing` covers another workspace's draft. */
export type DraftLaunch =
  | { t: 'launched'; expeditionId: string }
  | { t: 'already_running'; expeditionId: string; name: string }
  | { t: 'refused'; reasons: string[] }
  | { t: 'superseded'; by: string }
  | { t: 'missing' };

type LaunchRow = { key: string; id: string; at: string };

interface DraftStoreOptions {
  core: BuddiesCore;
  events: BuddyEvents;
  dir: string;
  launch(input: LaunchInput): Promise<LaunchOutcome>;
  issues(workspaceId: string, charter: Charter): Promise<string[]>;
  /** Every expedition launched so far: its launch key and when (each ledger's `launched` entry). */
  launches(): LaunchRow[];
  now(): string;
}

/**
 * An open draft whose key launched at or after it was made is launched (2026-11-01 review: a
 * crash between the launch and the draft's save left it open, and a later click launched a
 * second expedition). Recomputed on every boot, so it holds without a write.
 */
function reconciled(draft: DraftRecord, launches: LaunchRow[]): DraftRecord {
  if (draft.state.t !== 'open') return draft;
  const launch = launches
    .filter((l) => l.key === draft.key && l.at >= draft.createdAt)
    .sort((a, b) => a.at.localeCompare(b.at))[0];
  return launch ? { ...draft, state: { t: 'launched', expeditionId: launch.id } } : draft;
}

/** Where a post for this origin goes: the launch thread, or the owner↔launcher DM. */
export function placementOf(
  origin: Origin,
  launcherId: string
): { channel: ChannelRef; replyToId?: string } {
  return origin.t === 'thread'
    ? { channel: { kind: 'id', id: origin.channelId }, replyToId: origin.rootId }
    : { channel: { kind: 'direct', members: [OWNER, buddyActor(launcherId)] } };
}

export function createDraftStore(options: DraftStoreOptions) {
  const { core, events, dir } = options;
  const drafts = new Map<string, DraftRecord>();
  // Boot reads every draft once; an unreadable one is logged and left (its card reads 404). A
  // leftover `.tmp` is skipped, and nothing is written here: a copied store must write nothing.
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

  /** Atomic: a whole new file renamed over the old. */
  async function save(draft: DraftRecord): Promise<void> {
    const file = path.join(dir, `${draft.id}.json`);
    const tmp = `${file}.${randomUUID().slice(0, 8)}.tmp`;
    await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
    await fsp.writeFile(tmp, JSON.stringify(draft), { mode: 0o600 });
    await fsp.rename(tmp, file);
    drafts.set(draft.id, draft);
  }
  const markLaunched = (draft: DraftRecord, expeditionId: string) =>
    save({ ...draft, state: { t: 'launched', expeditionId } });

  /** One chain for every write: two Launch clicks, or a launch racing a re-draft, never interleave. */
  let chain: Promise<unknown> = Promise.resolve();
  function serialized<T>(work: () => Promise<T>): Promise<T> {
    const next = chain.then(work);
    chain = next.catch(() => undefined);
    return next;
  }

  /** The draft, only from the workspace it was drafted in. */
  const draftIn = (id: string, workspaceId: string) => {
    const draft = drafts.get(id);
    return draft?.workspaceId === workspaceId ? draft : undefined;
  };

  async function launchOpen(draft: DraftRecord): Promise<DraftLaunch> {
    const outcome = await options.launch({
      key: draft.key,
      charter: draft.charter,
      origin: draft.origin,
      launcherId: draft.launcherId,
      workspaceId: draft.workspaceId,
    });
    if (outcome.t === 'refused') return outcome;
    const { state } = outcome;
    // Running since this draft was made (the tool, or this card before a crash): that is its launch.
    if (outcome.t === 'already_running' && state.launchedAt < draft.createdAt)
      return { t: 'already_running', expeditionId: state.id, name: state.charter.name };
    await markLaunched(draft, state.id);
    return { t: 'launched', expeditionId: state.id };
  }

  return {
    /** Persists a draft, supersedes the open one under its key, and posts its one card. */
    draft: (input: DraftInput): Promise<DraftRecord> =>
      serialized(async () => {
        const draft: DraftRecord = {
          ...input,
          id: `draft-${randomUUID().replaceAll('-', '').slice(0, 8)}`,
          createdAt: options.now(),
          state: { t: 'open' },
        };
        // Older drafts close BEFORE the new one is written: a crash never leaves two Launches.
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

    async view(
      id: string,
      workspaceId: string
    ): Promise<{ t: 'present'; view: ExpeditionDraftView } | { t: 'missing' }> {
      const draft = draftIn(id, workspaceId);
      if (!draft) return { t: 'missing' };
      // An open draft's issues are re-checked (an installed binary clears one); a closed one's
      // are history.
      const issues =
        draft.state.t === 'open'
          ? await options.issues(draft.workspaceId, draft.charter)
          : draft.issues;
      const { workspaceId: ws, createdAt, state, advice, defaulted, resolved } = draft;
      const charter = charterView(draft.charter);
      return {
        t: 'present',
        view: { id, workspaceId: ws, createdAt, state, charter, issues, advice, defaulted, resolved },
      };
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
