import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { test } from 'node:test';
import {
  http,
  type BackendCase,
  alive,
  ask,
  backendExited,
  createChat,
  disposeCase,
  eventually,
  executionJournals,
  fakeClaude,
  fakeExists,
  fakeFile,
  hire,
  makeBackendCase,
  mcpCall,
  readFake,
  runOf,
  spawnsOf,
  startBackend,
  within,
  workspace,
  wsSend,
} from './fixtures/adoption-backend';

/**
 * Release blocker 2a (product review of P1, 2026-10-01): Stop and timeouts revoked a turn's tool
 * grant in memory only. A backend SIGKILLed inside the 3 s SIGTERM → SIGKILL grace, while the CLI
 * still ran, left a journal the next backend adopted as a LIVE turn: it re-registered the bearer
 * and nothing stopped the turn again, so a stopped agent kept writing with restored authority.
 * The stop intent is now on disk before any signal (turns/executions.ts `markStopping`), and boot
 * adoption re-issues the stop instead of adopting a writer (lifecycle/adopt-executions.ts).
 *
 * The window is held open deterministically: the fake CLI ignores SIGTERM (as a CLI busy in a
 * tool call can), and SIGKILLs the backend itself the instant every expected Stop has reached it.
 */

const PORT = 7533;

// Every scenario: one line of output, a Buddy tool call when it has tools, then parks. A SIGTERM
// is recorded and ignored; from then on the CLI keeps writing output and calling its tool, which
// is exactly the "second writer" the stop must prevent. `crash-on-stop` names the scenarios whose
// SIGTERM must all have arrived before the CLI kills the backend.
const FAKE = fakeClaude(String.raw`
async function main(scenario, tools) {
  text('one;');
  if (tools) mark(scenario + '.before', await post(tools, scenario + ' before-stop', scenario + '-before'));
  let stopped = false;
  process.on('SIGTERM', () => {
    fs.appendFileSync(path.join(dir, scenario + '.sigterm'), Date.now() + '\n');
    // Once: the replacement backend's re-issued SIGTERM must not kill the replacement too.
    const crashFile = path.join(dir, 'crash-on-stop');
    const crashed = path.join(dir, 'backend-killed');
    if (fs.existsSync(crashFile) && !fs.existsSync(crashed)) {
      const all = fs.readFileSync(crashFile, 'utf8').trim().split(' ');
      if (all.every((s) => fs.existsSync(path.join(dir, s + '.sigterm')))) {
        fs.writeFileSync(crashed, scenario);
        killBackend();
      }
    }
    if (stopped) return;
    stopped = true;
    let n = 0;
    setInterval(() => text('after-stop;'), 100);
    if (tools)
      setInterval(async () => {
        const got = await post(tools, scenario + ' after-stop', scenario + '-after-' + n++);
        fs.appendFileSync(path.join(dir, scenario + '.poststop'), got + '\n');
      }, 250);
  });
  text('two;');
  mark(scenario + '.midturn', process.pid);
  setInterval(() => {}, 1000);
}
`);

const terminal = (status: string | undefined) =>
  status === 'complete' || status === 'failed' || status === 'cancelled';

async function attemptOf(c: BackendCase, conversationId: string) {
  const detail = await http(c, 'GET', `/api/conversations/${conversationId}`);
  return detail.body?.latestAttempt as { state: string; terminalCause?: string } | undefined;
}

async function assistantText(c: BackendCase, conversationId: string): Promise<string> {
  const page = await http(
    c,
    'GET',
    `/api/conversations/${conversationId}/messages?afterSeq=-1&limit=500`
  );
  return (page.body.messages as Array<{ role: string; body: { t: string; text?: string } }>)
    .filter((m) => m.role === 'assistant' && m.body.t === 'text')
    .map((m) => m.body.text)
    .join('');
}

async function midturn(c: BackendCase, scenario: string): Promise<number> {
  await eventually(c, () => fakeExists(c, `${scenario}.midturn`), Boolean, `${scenario} mid-turn`);
  return Number(readFake(c, `${scenario}.midturn`));
}

test(
  'a Stop survives a backend crash inside the kill grace: no restored tools, no second writer',
  { timeout: 240_000 },
  async () => {
    const c = makeBackendCase(PORT, 'adopt-stop', FAKE);
    try {
      await startBackend(c, 'A');
      const ws = await workspace(c, 'stop');
      const control = await hire(c, ws, 'control');
      const worker = await hire(c, ws, 'crashworker');

      // The control: what a Stop does to a worker when no backend dies (A escalates to SIGKILL).
      await ask(c, control, 'control');
      const controlPid = await midturn(c, 'control');
      const controlRun = await eventually(
        c,
        () => runOf(c, control),
        (r) => r?.status === 'running' && !!r.conversationId,
        'control run bound'
      );
      await wsSend(
        c,
        { type: 'stop_conversation', conversationId: controlRun?.conversationId },
        () => fakeExists(c, 'control.sigterm')
      );
      const controlEnd = await eventually(
        c,
        () => runOf(c, control),
        (r) => terminal(r?.status),
        'control settled'
      );
      await eventually(c, () => !alive(controlPid), Boolean, 'control CLI killed');
      const controlAttempt = await attemptOf(c, String(controlRun?.conversationId));

      // The crash: a chat and a worker are stopped, and the backend dies before either CLI exits.
      const chatId = crypto.randomUUID();
      await createChat(c, chatId, 'Hello. SCENARIO:crashchat');
      const request = await ask(c, worker, 'crashworker');
      const pids = { chat: await midturn(c, 'crashchat'), worker: await midturn(c, 'crashworker') };
      assert.match(readFake(c, 'crashworker.before'), /^200 ok/, 'the tool works before Stop');
      const workerRun = await runOf(c, worker);
      const workerConversation = String(workerRun?.conversationId);
      fs.writeFileSync(fakeFile(c, 'crash-on-stop'), 'crashchat crashworker');
      const died = backendExited(c);
      await wsSend(c, { type: 'stop_conversation', conversationId: chatId }, () =>
        fakeExists(c, 'crashchat.sigterm')
      );
      await wsSend(c, { type: 'stop_conversation', conversationId: workerConversation }, () =>
        fakeExists(c, 'crashworker.sigterm')
      );
      await within(c, died, 30_000, 'the CLI to kill the backend');
      c.backend = null;
      for (const pid of Object.values(pids))
        assert.ok(alive(pid), 'the stopped CLI outlived the backend (the window is open)');

      await startBackend(c, 'B');
      // No restored authority: the stopped turn's bearer is dead on the new backend.
      const tools = JSON.parse(readFake(c, 'crashworker.tools')) as { url: string; auth: string };
      assert.equal(await mcpCall(tools), 401, 'a stopped turn keeps no tools after a restart');
      // B re-issued the stop: the TERM-ignoring CLIs end by B's SIGKILL escalation.
      await eventually(
        c,
        () => !alive(pids.chat) && !alive(pids.worker),
        Boolean,
        'B kills the stopped CLIs'
      );

      // It settles exactly as it would have without the crash (the lead's decision).
      const workerEnd = await eventually(
        c,
        () => runOf(c, worker),
        (r) => terminal(r?.status),
        'worker settled'
      );
      assert.deepEqual(
        { status: workerEnd?.status, errorCode: workerEnd?.errorCode, error: workerEnd?.error },
        { status: controlEnd?.status, errorCode: controlEnd?.errorCode, error: controlEnd?.error },
        'the crashed Stop settles the run like the control'
      );
      const workerAttempt = await eventually(
        c,
        () => attemptOf(c, workerConversation),
        (a) => !!a && a.state !== 'running' && a.state !== 'stopping',
        'worker attempt ended'
      );
      assert.deepEqual(workerAttempt, controlAttempt);
      assert.equal(controlAttempt?.state, 'cancelled');
      assert.equal(controlAttempt?.terminalCause, 'user_stop');
      const chatAttempt = await eventually(
        c,
        () => attemptOf(c, chatId),
        (a) => !!a && a.state !== 'running' && a.state !== 'stopping',
        'chat attempt ended'
      );
      assert.equal(chatAttempt?.state, 'cancelled');
      assert.equal(chatAttempt?.terminalCause, 'user_stop');

      // No second writer: nothing the stopped CLIs did after Stop landed anywhere.
      const poststop = fakeExists(c, 'crashworker.poststop')
        ? readFake(c, 'crashworker.poststop').trim().split('\n')
        : [];
      assert.ok(
        poststop.every((line) => !line.startsWith('200')),
        `no tool call after Stop succeeded: ${poststop.join(' | ')}`
      );
      const dm = await http(c, 'GET', `/api/buddies/channels/${request.channelId}/posts`);
      const workerPosts = (
        (dm.body.posts ?? dm.body) as Array<{ body: string; author: { id?: string } }>
      )
        .filter((p) => p.author.id === worker)
        .map((p) => p.body);
      assert.ok(workerPosts.includes('crashworker before-stop'), workerPosts.join(' | '));
      assert.ok(
        !workerPosts.some((body) => body.includes('after-stop')),
        `no post after Stop: ${workerPosts.join(' | ')}`
      );
      for (const conversationId of [chatId, workerConversation])
        assert.ok(
          !(await assistantText(c, conversationId)).includes('after-stop'),
          `${conversationId}: no output after Stop reached the transcript`
        );
      for (const scenario of ['crashchat', 'crashworker'])
        assert.equal(spawnsOf(c, scenario).length, 1, `${scenario}: one spawn, never respawned`);
      await eventually(
        c,
        () => executionJournals(c),
        (left) => left.length === 0,
        'journals removed after settle'
      );
    } finally {
      await disposeCase(c);
    }
  }
);

test(
  'a timeout survives a backend crash inside the kill grace: failed as max_runtime_timeout, no tools',
  { timeout: 180_000 },
  async () => {
    const c = makeBackendCase(PORT, 'adopt-timeout', FAKE);
    // The worker's run deadline: short, so the timeout fires while the test watches.
    const env = { CWV_BUDDY_BACKGROUND_TURN_MS: '6000' };
    try {
      await startBackend(c, 'C', env);
      const ws = await workspace(c, 'timeout');
      const worker = await hire(c, ws, 'timeout');
      fs.writeFileSync(fakeFile(c, 'crash-on-stop'), 'timeout');
      const died = backendExited(c);
      await ask(c, worker, 'timeout');
      const pid = await midturn(c, 'timeout');
      // The deadline's SIGTERM reaches the CLI, which kills the backend at once.
      await within(c, died, 30_000, 'the CLI to kill the backend');
      c.backend = null;
      assert.ok(alive(pid), 'the timed-out CLI outlived the backend');

      await startBackend(c, 'D', env);
      const tools = JSON.parse(readFake(c, 'timeout.tools')) as { url: string; auth: string };
      assert.equal(await mcpCall(tools), 401, 'a timed-out turn keeps no tools after a restart');
      await eventually(c, () => !alive(pid), Boolean, 'D kills the timed-out CLI');
      const run = await eventually(
        c,
        () => runOf(c, worker),
        (r) => terminal(r?.status),
        'timeout run settled'
      );
      assert.equal(run?.status, 'failed', JSON.stringify(run));
      assert.match(String(run?.error), /maximum runtime/, JSON.stringify(run));
      const attempt = await attemptOf(c, String(run?.conversationId));
      assert.deepEqual(attempt && [attempt.state, attempt.terminalCause], [
        'failed',
        'max_runtime_timeout',
      ]);
      assert.equal(spawnsOf(c, 'timeout').length, 1);
    } finally {
      await disposeCase(c);
    }
  }
);
