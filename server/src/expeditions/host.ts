import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { BuddiesCore, ChannelRef } from '@unleashd/buddies-core';
import type { ExpeditionView } from '@unleashd/shared';
import { OWNER, buddyActor } from '../buddies/core';
import type { BuddyEvents } from '../buddies/events';
import type { ExecutionGate } from '../buddies/execution-gate';
import { labelled } from '../observability/event-loop-stall';
import { CREW_ROLE, briefOf, parseOutcome, statusText } from './briefs';
import { branchHead, ensureBranch, ensureWorktree, preflight, releaseWorktree } from './git';
import {
  type Charter,
  type Clock,
  type Effect,
  type Entry,
  type Feedback,
  type Origin,
  type State,
  type WorkerSpec,
  attemptOf,
  badge,
  claimOf,
  configOf,
  decide,
  fold,
  live,
  pendingEffects,
  worktreeName,
  worktreeOf,
} from './model';
import { expeditionView } from './view';

// Pattern: wake-on-write (docs/patterns.md#wake-on-write) — ticks on the Buddy change bus
// (debounced) plus one slow backstop; no per-expedition timers.
// Pattern: idempotency-keys (docs/patterns.md#idempotency-keys) — every crate write carries a key
// derived from the expedition and attempt/status id, so replaying an effect after a crash is a no-op.

const BACKSTOP_MS = 60_000;
const DEBOUNCE_MS = 1_500;
/** Ticks re-run decide after effects (crew created → first manager); bounded per tick. */
const ROUNDS_PER_TICK = 4;

export interface LaunchInput {
  key: string;
  charter: Charter;
  origin: Origin;
  launcherId: string;
  workspaceId: string;
}

export interface ExpeditionHostOptions {
  core: BuddiesCore;
  events: BuddyEvents;
  root: string;
  gate: ExecutionGate;
  now?: () => Date;
}

export type ExpeditionHost = ReturnType<typeof createExpeditionHost>;

/** A launch the preflight refused (design.md R4), with every reason; nothing was written. */
export class LaunchRefused extends Error {
  constructor(readonly reasons: string[]) {
    super(`Expedition launch refused: ${reasons.join('; ')}.`);
  }
}

export function createExpeditionHost(options: ExpeditionHostOptions) {
  const { core, events, root, gate } = options;
  const now = () => (options.now ?? (() => new Date()))().toISOString();
  const ledgers = new Map<string, Entry[]>();
  const chains = new Map<string, Promise<void>>();
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });

  // Boot: read every ledger once; ticks resume what they explain.
  for (const id of fs.readdirSync(root)) {
    const file = path.join(root, id, 'ledger.jsonl');
    if (!fs.existsSync(file)) continue;
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    ledgers.set(
      id,
      lines.map((line) => JSON.parse(line) as Entry)
    );
  }

  const fileOf = (id: string) => path.join(root, id, 'ledger.jsonl');
  async function append(id: string, entries: Entry[]): Promise<void> {
    if (entries.length === 0) return;
    const ledger = ledgers.get(id);
    if (!ledger) throw new Error(`unknown expedition ${id}`);
    // One write per batch: a decide batch (actions + manager_applied) lands together.
    await fsp.appendFile(fileOf(id), entries.map((e) => `${JSON.stringify(e)}\n`).join(''), {
      mode: 0o600,
    });
    ledger.push(...entries);
  }
  const stateOf = (id: string): State => {
    const ledger = ledgers.get(id);
    if (!ledger) throw new Error(`unknown expedition ${id}`);
    return fold(ledger);
  };

  const clock = (): Clock => ({
    now: now(),
    nextId: (prefix) => `${prefix}${randomUUID().slice(0, 6)}`,
  });

  // ---------- Observation: settled requests become attempt_ended ----------

  async function observe(s: State): Promise<Entry[]> {
    const out: Entry[] = [];
    for (const attempt of s.attempts) {
      if (attempt.phase.t !== 'posted') continue;
      const request = await core.getPost(OWNER, attempt.phase.requestId);
      switch (request.request.state) {
        case 'awaiting':
        case 'none':
          continue;
        case 'answered': {
          const answer = await core.getPost(OWNER, request.request.answerId);
          out.push({
            t: 'attempt_ended',
            at: now(),
            attemptId: attempt.id,
            outcome: parseOutcome(attempt.spec.kind, answer.body),
          });
          continue;
        }
        case 'failed':
        case 'cancelled':
          out.push({
            t: 'attempt_ended',
            at: now(),
            attemptId: attempt.id,
            outcome: { t: 'failed', status: request.request.state },
          });
          continue;
      }
    }
    return out;
  }

  // ---------- Effects ----------

  function originRef(s: State): { channel: ChannelRef; replyToId?: string } {
    switch (s.origin.t) {
      case 'thread':
        return { channel: { kind: 'id', id: s.origin.channelId }, replyToId: s.origin.rootId };
      case 'direct':
        return { channel: { kind: 'direct', members: [OWNER, buddyActor(s.launcherId)] } };
    }
  }

  async function run(s: State, effect: Effect): Promise<Entry[]> {
    switch (effect.t) {
      case 'create_branch':
        await ensureBranch(s.repo);
        return [{ t: 'branch_ready', at: now() }];
      case 'admit': {
        // Intent first: the slot, custody and Cambium name are on disk before `cambium add` runs.
        const { attempt } = effect;
        await append(s.id, [
          {
            t: 'worktree_creating',
            at: now(),
            attemptId: attempt.id,
            name: worktreeName(s.id, attempt.id),
            path: path.join(root, s.id, 'worktrees', attempt.id),
            branch: `exp/${s.id}/${attempt.id}`,
            baseSha: await treeBase(s, attempt.spec),
          },
        ]);
        return createWorktree(stateOf(s.id), attempt.id);
      }
      case 'create_worktree':
        return createWorktree(s, effect.attemptId);
      case 'release_worktree': {
        const tree = worktreeOf(s, effect.attemptId);
        const release = await releaseWorktree(s.repo.root, tree.name, tree, effect.keepCommits);
        return [{ t: 'worktree_released', at: now(), attemptId: effect.attemptId, release }];
      }
      case 'create_crew': {
        const crew = await core.createBuddy(OWNER, {
          workspaceId: s.workspaceId,
          slug: `exp-${s.id}`.toLowerCase(),
          name: `⛺ ${s.charter.name}`,
          role: `${CREW_ROLE} Your expedition id: ${s.id}.`,
          manager: { kind: 'buddy', id: s.launcherId },
          provider: s.charter.crew.manager.provider,
          model: s.charter.crew.manager.model,
          reasoningEffort: s.charter.crew.manager.reasoningEffort,
          key: `exp:${s.id}:crew`,
        });
        // The owner↔crew DM is the expedition's chat (opening it is idempotent).
        const chat = await core.openChannel(OWNER, {
          kind: 'direct',
          members: [OWNER, buddyActor(crew.id)],
        });
        return [{ t: 'crew_ready', at: now(), buddyId: crew.id, chatChannelId: chat.id }];
      }
      case 'brief_attempt': {
        const body = briefOf(s, effect.attempt);
        await append(s.id, [
          { t: 'attempt_posting', at: now(), attemptId: effect.attempt.id, body },
        ]);
        return postAttempt(s, effect.attempt.id, body);
      }
      case 'post_attempt':
        return postAttempt(s, effect.attemptId, effect.body);
      case 'post_status': {
        if (s.crew.t !== 'ready') throw new Error('status posted before the crew exists');
        // Crew-authored in its own DM with the owner: wakes nobody, reads as the expedition.
        const write = await core.post(
          buddyActor(s.crew.buddyId),
          { kind: 'id', id: s.crew.chatChannelId },
          {
            kind: 'inform',
            body: effect.text,
            purpose: 'expedition_status',
            evidence: [`expedition:${s.id}`],
            mentions: [],
            broadcast: false,
            key: `exp:${s.id}:status:${effect.seq}`,
          }
        );
        return [{ t: 'status_posted', at: now(), seq: effect.seq, postId: write.post.id }];
      }
      case 'post_badge': {
        // The clickable badge in the chat the launch came from; the client renders posts with
        // this purpose as a live card that opens /expeditions/<id>.
        const target = originRef(s);
        const write = await core.post(buddyActor(s.launcherId), target.channel, {
          kind: 'inform',
          body: `⛺ Expedition launched: ${s.charter.name}. ${s.charter.goal.slice(0, 200)}`,
          purpose: 'expedition_badge',
          evidence: [`expedition:${s.id}`],
          replyToId: target.replyToId,
          mentions: [],
          broadcast: false,
          key: `exp:${s.id}:badge`,
        });
        return [{ t: 'badge_posted', at: now(), postId: write.post.id }];
      }
    }
  }

  /** Where a worker's tree starts: work at the expedition branch head, a check at its claim. */
  async function treeBase(s: State, spec: WorkerSpec): Promise<string> {
    switch (spec.kind) {
      case 'work':
        return branchHead(s.repo);
      case 'check':
        return claimOf(s, spec).commit;
    }
  }

  async function createWorktree(s: State, attemptId: string): Promise<Entry[]> {
    const tree = worktreeOf(s, attemptId);
    const made = await ensureWorktree(s.repo.root, tree.name, tree);
    switch (made.t) {
      case 'ready':
        return [{ t: 'worktree_ready', at: now(), attemptId, ...made.at }];
      case 'failed':
        return [{ t: 'worktree_failed', at: now(), attemptId, reason: made.reason }];
    }
  }

  async function postAttempt(s: State, attemptId: string, body: string): Promise<Entry[]> {
    if (s.crew.t !== 'ready') throw new Error('attempt posted before the crew exists');
    const attempt = attemptOf(s, attemptId);
    // The crew's note-to-self DM holds the attempts (plumbing), so the owner↔crew chat stays a chat.
    const crew = buddyActor(s.crew.buddyId);
    const write = await core.post(
      crew,
      { kind: 'direct', members: [crew] },
      {
        kind: 'request',
        body,
        purpose: 'expedition_attempt',
        evidence: [`expedition:${s.id}`],
        mentions: [],
        runConfig: configOf(s.charter, attempt.spec),
        broadcast: false,
        key: `exp:${s.id}:attempt:${attemptId}`,
      }
    );
    return [{ t: 'attempt_posted', at: now(), attemptId, requestId: write.post.id }];
  }

  // ---------- Tick ----------

  async function tickOnce(id: string): Promise<void> {
    let wrote = false;
    for (let round = 0; round < ROUNDS_PER_TICK; round += 1) {
      await append(id, await observe(stateOf(id)));
      const intents = decide(stateOf(id), clock());
      await append(id, intents);
      const effects = pendingEffects(stateOf(id));
      for (const effect of effects) {
        // Each effect reads the state its predecessor left (a brief sees earlier postings).
        await append(id, await run(stateOf(id), effect));
      }
      if (intents.length === 0 && effects.length === 0) break;
      wrote = true;
    }
    if (wrote) events.emit({ kind: 'changed' });
  }

  /** Serialized per expedition; a failed tick is logged and retried by the next wake. */
  function tick(id: string): Promise<void> {
    const next = (chains.get(id) ?? Promise.resolve())
      .then(() => tickOnce(id))
      .catch((error) => console.warn(`[expeditions] tick ${id} failed:`, error));
    chains.set(id, next);
    return next;
  }

  // A finished expedition stays active while it owes effects (its last status, worktree removal)
  // or has live attempts: their ends are still observed, and only then are their trees released.
  const active = () =>
    [...ledgers.keys()].filter((id) => {
      const s = stateOf(id);
      return s.run.t !== 'finished' || live(s).length > 0 || pendingEffects(s).length > 0;
    });
  const tickAll = () => Promise.all(active().map(tick)).then(() => undefined);

  let debounce: NodeJS.Timeout | null = null;
  const wake = labelled('timer expeditions-wake', () => {
    debounce = null;
    void tickAll();
  });
  const enabled = gate.t === 'enabled';
  const unsubscribe = enabled
    ? events.on((event) => {
        if (event.kind !== 'changed' && event.kind !== 'posted') return;
        if (debounce || active().length === 0) return;
        debounce = setTimeout(wake, DEBOUNCE_MS);
        debounce.unref();
      })
    : () => undefined;
  const backstop = enabled
    ? setInterval(
        labelled('timer expeditions-backstop', () => void tickAll()),
        BACKSTOP_MS
      )
    : null;
  backstop?.unref();
  if (enabled) void tickAll();

  return {
    async launch(input: LaunchInput): Promise<State> {
      const prior = [...ledgers.keys()].map(stateOf).find((s) => s.key === input.key);
      if (prior) return prior;
      const workspace = (await core.listWorkspaces()).find((w) => w.id === input.workspaceId);
      if (!workspace) throw new LaunchRefused([`no workspace ${input.workspaceId}`]);
      const checked = await preflight(workspace.rootPath);
      if (checked.t === 'refused') throw new LaunchRefused(checked.reasons);
      const id = `${input.charter.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 24)}-${randomUUID().slice(0, 6)}`;
      await fsp.mkdir(path.join(root, id), { recursive: true, mode: 0o700 });
      // The ledger joins the map only once its `launched` line is on disk: every ledger in the
      // map folds (a concurrent tick or launch never meets an empty one).
      const repo = { root: checked.root, baseSha: checked.baseSha, branch: `expedition/${id}` };
      const launched: Entry = { t: 'launched', at: now(), id, ...input, repo };
      await fsp.appendFile(fileOf(id), `${JSON.stringify(launched)}\n`, { mode: 0o600 });
      ledgers.set(id, [launched]);
      // The launch status: the badge in the thread from the first second.
      await append(id, [
        {
          t: 'status',
          at: now(),
          seq: 0,
          text: `⛺ Launched: ${input.charter.goal.slice(0, 300)}\nPlanning…`,
        },
      ]);
      if (enabled) await tick(id);
      return stateOf(id);
    },
    async steer(id: string, from: string, feedback: Feedback): Promise<State> {
      stateOf(id);
      await append(id, [{ t: 'feedback', at: now(), from, feedback }]);
      if (enabled) await tick(id);
      return stateOf(id);
    },
    has: (id: string) => ledgers.has(id),
    view(id: string): ExpeditionView {
      const s = stateOf(id);
      return expeditionView(s, badge(s, now()), now());
    },
    status(id: string): string {
      const s = stateOf(id);
      return statusText(s, badge(s, now()));
    },
    list(workspaceId: string): { id: string; badge: string }[] {
      return [...ledgers.keys()]
        .map(stateOf)
        .filter((s) => s.workspaceId === workspaceId)
        .map((s) => ({ id: s.id, badge: badge(s, now()) }));
    },
    /** The expedition a crew Buddy belongs to, so a mentioned crew can answer about itself. */
    ofCrew(buddyId: string): string | undefined {
      return [...ledgers.keys()].find((id) => {
        const s = stateOf(id);
        return s.crew.t === 'ready' && s.crew.buddyId === buddyId;
      });
    },
    workspaceOf: (id: string) => stateOf(id).workspaceId,
    /** Tests drive ticks directly. */
    tick,
    close(): void {
      unsubscribe();
      if (backstop) clearInterval(backstop);
      if (debounce) clearTimeout(debounce);
    },
  };
}
