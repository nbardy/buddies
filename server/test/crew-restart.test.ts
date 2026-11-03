/**
 * Regression: owner 2026-11-03: crews restart on new sessions. An expedition crew's CLI used to
 * be adopted across a backend restart like any Buddy turn, so it kept running on the old
 * backend's harness. Now a crew turn is never adopted (its process group is killed and its journal
 * removed), a graceful shutdown kills it too, and a crew seat's provider session lasts one boot.
 * Every other Buddy turn is still adopted and every other session still resumes.
 *
 * Real journals on a temp root, each holding a detached `sleep 60` process group.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { type ExecutionHandle, trustSpawnedWrapper } from '@nbardy/agent-cli';
import type { BuddyContext } from '@unleashd/shared';
import { sessionAudienceKey } from '../src/buddies/turn-policy';
import {
  type AdoptionPorts,
  adoptExecutions,
  crewExecutions,
} from '../src/lifecycle/adopt-executions';
import { type TurnOwner, createExecutionJournals } from '../src/turns/executions';

const CREW = 'exp-crew-buddy';
const OTHER = 'ordinary-buddy';
// killExecution's SIGKILL grace (agent-cli journal.ts) plus slack for a loaded machine.
const KILL_GRACE_MS = 3_000 + 5_000;

function journals() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-restart-'));
  const executions = createExecutionJournals(root);
  const markers = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-restart-ready-'));
  const pids: number[] = [];
  test.after(() => {
    for (const pid of pids) {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {}
    }
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(markers, { recursive: true, force: true });
  });
  /** A running Buddy turn of `buddyId` whose provider is a live, detached process group;
   * `ignoresTerm`: the group ignores SIGTERM (a CLI busy in a tool call), so only SIGKILL ends it. */
  function liveTurn(
    buddyId: string,
    ignoresTerm = false
  ): { dir: string; pid: number; attemptId: string } {
    const attemptId = `attempt-${buddyId}`;
    const owner: Omit<TurnOwner, 'version' | 'kind'> = {
      conversationId: `conversation-${buddyId}`,
      attemptId,
      provider: 'claude',
      userMessage: { text: 'work', timestamp: new Date().toISOString() },
      startedAt: new Date().toISOString(),
      policy: {
        t: 'buddy',
        grant: { role: 'worker', buddyId } as never,
        run: {
          runId: `run-${buddyId}`,
          leaseToken: `lease-${buddyId}`,
          deadline: null,
          context: { buddyId, workspaceId: 'ws' } as BuddyContext,
        },
        briefedGeneration: null,
        audienceKey: null,
      },
    };
    const { dir } = executions.forTurn(owner);
    // `; :` keeps the shell (the group leader) alive instead of exec-ing sleep.
    // The shell touches `$2` once its trap is set, so a signal never lands before it.
    const ready = path.join(markers, `${buddyId}.ready`);
    const script = `${ignoresTerm ? "trap '' TERM; " : ''}: > "$2"; sleep 60; :`;
    const child = spawn('/bin/sh', ['-c', script, 'crew-restart', dir, ready], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    const pid = child.pid as number;
    for (const until = Date.now() + 60_000; !fs.existsSync(ready); )
      if (Date.now() > until) throw new Error(`${buddyId}'s process never started`);
    pids.push(pid);
    fs.writeFileSync(path.join(dir, 'pid'), String(pid));
    trustSpawnedWrapper(dir, pid);
    return { dir, pid, attemptId };
  }
  return { executions, liveTurn };
}

function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function groupGoneWithin(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!groupAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !groupAlive(pid);
}

test('boot adoption discards a crew turn (group killed, journal removed) and adopts any other', async () => {
  const { executions, liveTurn } = journals();
  const crew = liveTurn(CREW);
  const other = liveTurn(OTHER);
  const adopted: string[] = [];
  const interrupted: string[] = [];
  const ports: AdoptionPorts = {
    conversation: async () => ({ adoptTurn: (owner) => adopted.push(owner.attemptId) }),
    attach: () => ({}) as ExecutionHandle,
    discard: (found) => executions.discard(found),
    attemptInterrupted: (attemptId) => interrupted.push(attemptId),
    crews: { crewBuddyIds: () => new Set([CREW]) },
    logger: { log: () => undefined, warn: () => undefined, error: () => undefined },
  };

  const runs = await adoptExecutions(executions.scan(), ports);

  assert.deepEqual(
    runs.map((run) => run.runId),
    [`run-${OTHER}`],
    'only the non-crew run is adopted'
  );
  assert.deepEqual(adopted, [other.attemptId]);
  assert.deepEqual(interrupted, [crew.attemptId], 'the crew attempt ends interrupted');
  assert.equal(fs.existsSync(crew.dir), false, 'the crew journal is removed');
  assert.ok(await groupGoneWithin(crew.pid, KILL_GRACE_MS), 'the crew process group is gone');
  assert.ok(fs.existsSync(other.dir), 'the adopted journal stays');
  assert.ok(groupAlive(other.pid), 'the adopted turn keeps running');
});

test('graceful shutdown selects only crew journals; discarding them kills the crew group', async () => {
  const { executions, liveTurn } = journals();
  const crew = liveTurn(CREW, true);
  const other = liveTurn(OTHER);

  const doomed = crewExecutions(executions.scan(), new Set([CREW]));
  assert.deepEqual(
    doomed.map((found) => found.dir),
    [crew.dir]
  );
  // discardNow: shutdown exits right after, so a SIGTERM-then-grace kill never reaches SIGKILL.
  // The group must be gone with no event-loop turn for a grace timer (regression: a crew CLI that
  // ignored SIGTERM outlived a graceful shutdown with its journal already deleted).
  for (const found of doomed) executions.discardNow(found);

  // Well inside discard's 3 s SIGTERM grace: only an immediate SIGKILL passes.
  assert.ok(await groupGoneWithin(crew.pid, 1_500), 'the SIGTERM-proof crew group is gone');
  assert.ok(groupAlive(other.pid), 'a non-crew turn stays for the next backend to adopt');
});

test('a boot-scoped session key changes with the boot; a durable key is the pre-scope string', () => {
  const context = { buddyProjectId: undefined, workspaceId: 'ws' } as Pick<
    BuddyContext,
    'buddyProjectId' | 'workspaceId'
  >;
  const before = sessionAudienceKey('buddy_post', 'c1', context, { t: 'boot', bootId: 'b1' });
  const after = sessionAudienceKey('buddy_post', 'c1', context, { t: 'boot', bootId: 'b2' });
  assert.notEqual(before, after, 'a crew session saved last boot is not resumed this boot');
  // Saved sessions resume across a deploy only if their key string never changes.
  assert.equal(
    sessionAudienceKey('buddy_post', 'c1', context, { t: 'durable' }),
    JSON.stringify({ kind: 'thread', threadId: 'c1' })
  );
});
