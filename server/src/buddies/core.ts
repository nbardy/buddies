import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  type Actor,
  BuddiesCore,
  type BuddyChanges,
  type ManagerRef,
  type Setting,
} from '@unleashd/buddies-core';
import { z } from 'zod';

export type { BuddiesCore } from '@unleashd/buddies-core';

export const OWNER: Actor = { kind: 'owner' };
export const buddyActor = (id: string): Actor => ({ kind: 'buddy', id });

/**
 * κ for a profile field on the wire: absent = unchanged, `null` = back to the default, a string =
 * that value. The crate's `Setting` names the clear, which `Option<String>` could not (T22).
 */
export const settingOf = (value: string | null | undefined): Setting | undefined =>
  value === undefined ? undefined : value === null ? { kind: 'default' } : { kind: 'set', value };

// ---- κ shared by the owner routes and the Buddy tools: one definition of each write's fields ----

export const key = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .describe('Idempotency key: the same key replays the first result');
export const ChannelArchiveSchema = z.object({ archived: z.boolean(), key }).strict();
export const ChannelRenameSchema = z
  .object({ name: z.string().trim().min(1).max(80), key })
  .strict();

export const evidence = z.array(z.string().min(1).max(4000)).max(32).default([]);

export const TaskChangesSchema = z.object({
  title: z.string().optional(),
  doneCriteria: z.string().optional(),
  status: z.enum(['open', 'in_progress', 'blocked', 'review', 'done', 'cancelled']).optional(),
  nextAction: z.string().optional(),
  blockedReason: z.string().optional(),
  evidence: z.array(z.string()).optional(),
  paused: z.boolean().optional(),
  position: z.number().int().optional(),
  // Home pin: 0 unpins, N > 0 pins at order N (lower = earlier); top-level Tasks only (the crate refuses others).
  pin: z.number().int().min(0).optional(),
  ownerId: z.string().optional(),
});

export const ScheduleFieldsSchema = z.object({
  taskId: z.string().min(1).optional(),
  name: z.string().min(1).max(120),
  cron: z.string().min(1),
  timezone: z.string().min(1),
  prompt: z.string().min(1).max(16_000),
  enabled: z.boolean(),
});

const profile = z.string().min(1).nullable().optional().describe('null: back to the default');
export const BuddyCreateFieldsSchema = z.object({
  workspaceId: z.string().min(1),
  slug: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string().min(1),
  role: z.string().min(1),
  managerId: z.string().min(1).nullable().optional(),
  provider: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  reasoningEffort: z.string().min(1).optional(),
});
export const BuddyChangesSchema = z.object({
  name: z.string().min(1).optional(),
  role: z.string().min(1).optional(),
  managerId: z.string().min(1).nullable().optional().describe('null: reports to nobody'),
  provider: profile,
  model: profile,
  reasoningEffort: profile,
  maxActiveRuns: z.number().int().positive().optional(),
  status: z.enum(['active', 'archived']).optional(),
});

export const managerRef = (id: string | null): ManagerRef =>
  id === null ? { kind: 'nobody' } : { kind: 'buddy', id };

/** A parsed buddy change as the crate names it: its manager and profile `Setting`s. */
export function buddyChanges(input: z.infer<typeof BuddyChangesSchema>): BuddyChanges {
  const { managerId, provider, model, reasoningEffort, ...rest } = input;
  return {
    ...rest,
    manager: managerId === undefined ? undefined : managerRef(managerId),
    provider: settingOf(provider),
    model: settingOf(model),
    reasoningEffort: settingOf(reasoningEffort),
  };
}

/** One task with its subtasks and latest comments (its task channel), read as `reader`. */
export async function taskDetail(
  core: BuddiesCore,
  reader: Actor,
  taskId: string,
  comments: number
) {
  const task = await core.getTask(taskId);
  const channel = await core.openChannel(reader, { kind: 'task', taskId: task.id });
  const [children, page] = await Promise.all([
    core.listTasks({ kind: 'children', parentId: task.id }),
    core.listPosts(reader, { kind: 'channel', channelId: channel.id }, null, comments),
  ]);
  return { task, channel, children, comments: page.posts };
}

/**
 * The crate's error codes (a rejection's message is `[code] detail`, crate README), each with its
 * HTTP status: the owner's request was wrong (400/403/404), the data moved under it (409), or the
 * store failed (500).
 */
// Pattern: table-driven (docs/patterns.md#table-driven)
const HTTP_STATUS = {
  denied: 403,
  not_found: 404,
  revision_conflict: 409,
  idempotency_conflict: 409,
  conversation_busy: 409,
  lease_lost: 409,
  invalid: 400,
  corrupt: 500,
  wrong_database: 500,
  sqlite: 500,
  json: 500,
  io: 500,
} as const;
export type CoreErrorCode = keyof typeof HTTP_STATUS;

export class CoreError extends Error {
  constructor(
    readonly code: CoreErrorCode,
    readonly detail: string
  ) {
    super(`[${code}] ${detail}`);
    this.name = 'CoreError';
  }
  get httpStatus(): number {
    return HTTP_STATUS[this.code];
  }
}

/** Parse a crate rejection once, at the boundary. Anything else is not a core error. */
export function coreError(error: unknown): CoreError | null {
  if (error instanceof CoreError) return error;
  const match = error instanceof Error ? /^\[([a-z_]+)\] ([\s\S]*)$/.exec(error.message) : null;
  return match ? new CoreError(match[1] as CoreErrorCode, match[2]) : null;
}

/**
 * The new-schema database. It is never the v33 `~/.buddies/buddies.sqlite`: the swap is the
 * owner-gated import (crates/unleashd-buddies/README.md, "Deploy").
 */
export function buddiesDatabasePath(env: NodeJS.ProcessEnv = process.env): string {
  return env.UNLEASHD_BUDDIES_DB ?? path.join(os.homedir(), '.buddies', 'buddies-v3.sqlite');
}

/**
 * Where the Buddies database stands on this machine, decided once at boot. Mirrors
 * `recordsLocation` (conversations/config-records.ts): `fresh` is a first-time install with no
 * v33 file either, and gets an empty database. Until 2026-09-26 a missing file was always
 * "import first", so a new user, with nothing to import, never had working Buddies.
 */
export type BuddiesLocation =
  | { t: 'database'; file: string }
  | { t: 'fresh'; file: string }
  | { t: 'unimported'; file: string; legacy: string };

/**
 * The v33 file the old Buddies package used: `$BUDDIES_HOME/buddies.sqlite`, default
 * `~/.buddies` (the package's store.js). Ignoring BUDDIES_HOME classified an owner who had set it
 * as a `fresh` install and opened an EMPTY database next to their unimported data.
 */
export function legacyBuddiesDatabasePath(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.BUDDIES_HOME?.trim() || path.join(os.homedir(), '.buddies');
  return path.join(home, 'buddies.sqlite');
}

export function buddiesLocation(
  file: string,
  legacy: string = legacyBuddiesDatabasePath()
): BuddiesLocation {
  if (fs.existsSync(file)) return { t: 'database', file };
  if (fs.existsSync(legacy)) return { t: 'unimported', file, legacy };
  return { t: 'fresh', file };
}

/**
 * Pattern: fix-guards (docs/patterns.md#fix-guards) — no silent fallback.
 * `BuddiesCore.open` creates an EMPTY database at a missing path, so a machine that still holds
 * the v33 file would run with no buddies instead of the owner's; that case fails loudly with
 * the import command (and never falls back to opening the old file). Guard: the
 * "missing Buddies database" tests in server/test/buddies-v2.test.ts.
 */
export async function openBuddiesCore(location: BuddiesLocation): Promise<BuddiesCore> {
  switch (location.t) {
    case 'database':
      return BuddiesCore.open(location.file);
    case 'fresh':
      fs.mkdirSync(path.dirname(location.file), { recursive: true });
      return BuddiesCore.open(location.file);
    case 'unimported': {
      const { file, legacy } = location;
      throw new Error(
        `Buddies database ${file} does not exist, but ${legacy} does. It needs the one-time v33/v34 import, whose tools
(crates/unleashd-buddies-import) were deleted after the 2026-09-27 swap: check out archive/t15-importer-93367be and follow
agent_notes/2026-09-25_lean-rewrite/T15-RUNBOOK.md (or set UNLEASHD_BUDDIES_DB).`
      );
    }
  }
}

/**
 * The core behind a promise, so routes and modules can be built while it opens. Every method is
 * async already; a failed open rejects every call with the open error (the import command).
 */
export function lateBoundCore(ready: Promise<BuddiesCore>): BuddiesCore {
  return new Proxy({} as BuddiesCore, {
    // Not a thenable: `await lateBoundCore(...)` must not treat the proxy as a promise.
    get: (_target, name) =>
      name === 'then'
        ? undefined
        : (...args: unknown[]) =>
            ready.then((core) =>
              (core[name as keyof BuddiesCore] as (...a: unknown[]) => unknown).apply(core, args)
            ),
  });
}

export async function archivedBuddyIds(core: BuddiesCore): Promise<Set<string>> {
  const workspaces = await core.listWorkspaces();
  const buddies = (await Promise.all(workspaces.map((w) => core.listBuddies(w.id)))).flat();
  return new Set(buddies.filter((buddy) => buddy.status === 'archived').map((buddy) => buddy.id));
}
