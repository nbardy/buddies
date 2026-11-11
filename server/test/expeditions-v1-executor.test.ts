import assert from 'node:assert/strict';
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { keyed } from '@unleashd/shared';
import { parseCommand } from '../src/expedition-kernel/argv';
import { systemClock } from '../src/expedition-kernel/clock';
import { staticGate } from '../src/expedition-kernel/gates';
import { type Expedition, launch, open } from '../src/expedition-kernel/kernel';
import { LogStore } from '../src/expedition-kernel/log-store';
import type { RawOutcome, RunSpec } from '../src/expedition-kernel/ports';
import { keyedViewOf } from '../src/expedition-kernel/projection';
import type { Authored } from '../src/expedition-kernel/protocol';
import { HostExecutor } from '../src/expeditions-v1/executor';
import { outcomeOf } from '../src/expeditions-v1/executor/answer';
import { putRef } from '../src/expeditions-v1/executor/refs';
import { ingestMeter } from '../src/expeditions-v1/executor/usage';
import { NO_CALLS, hostDeps } from './fixtures/expedition-host';
import { tempDir } from './fixtures/temp';

// The executor core (CONNECT_PLAN §8 step 2) through real boundaries: the REAL kernel over the
// REAL host executor, real plan child processes, a real git repo in a temp dir and real processes
// (node scripts committed in that repo; no shell anywhere). Only the leader and the owner are
// scripted: no agent kind runs yet. A second host process is spawned and SIGKILLed for the
// restart case, because "a dead host's command" is only real if a host actually died.

const SERVER = path.resolve(__dirname, '..');
const HOST_SCRIPT = path.join(__dirname, 'fixtures', 'expedition-host.ts');

const SCRIPTS: Record<string, string> = {
  'probe.js': `const { execFileSync } = require('node:child_process');
const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
process.stdout.write(JSON.stringify({ n: 7, head }));`,
  'use.js': `const { execFileSync } = require('node:child_process');
const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
process.stdout.write(JSON.stringify({ n: Number(process.argv[2]) * 2, head }));`,
  'fail.js': `console.error('nope: the probe found nothing'); process.exit(3);`,
  'slow.js': 'setTimeout(() => {}, 60000);',
  'emit.js': `const mode = process.argv[2];
process.stdout.write(mode === 'wrong' ? JSON.stringify({ n: 'seven', head: 'x' }) : 'not json');`,
  'check.js': `const out = JSON.parse(require('node:fs').readFileSync(process.env.EXPEDITION_OUTPUT, 'utf8'));
process.exit(out.n === 14 ? 0 : 1);`,
  'ok.js': 'process.exit(0);',
  'hang.js': `const { spawn } = require('node:child_process');
const kid = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
require('node:fs').writeFileSync(process.argv[2], JSON.stringify({ pid: process.pid, kid: kid.pid }));
setInterval(() => {}, 1000);`,
  'count.js': `require('node:fs').appendFileSync(process.argv[2], 'ran\\n');`,
  'head.js': `const { execFileSync } = require('node:child_process');
process.stdout.write(JSON.stringify({ head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() }));`,
};

const git = (cwd: string, ...args: string[]): string =>
  execFileSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8' }
  ).trim();

/** A repo with the scripts at `base`, and one more commit (`second`) so HEAD is not the base. */
function repoWithScripts(): { repo: string; base: string; second: string } {
  const repo = fs.realpathSync(tempDir('exp-repo-'));
  git(repo, 'init', '-q', '-b', 'main');
  fs.mkdirSync(path.join(repo, 'scripts'));
  for (const [name, text] of Object.entries(SCRIPTS))
    fs.writeFileSync(path.join(repo, 'scripts', name), `${text}\n`);
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'scripts');
  const base = git(repo, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(repo, 'second.txt'), 'later work\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'second');
  return { repo, base, second: git(repo, 'rev-parse', 'HEAD') };
}
const worktreesOf = (repo: string) =>
  git(repo, 'worktree', 'list', '--porcelain')
    .split('\n')
    .filter((l) => l.startsWith('worktree '));

function contractFor(repo: string, doneCheck: string): string {
  return `---
leader: lead
repo: ${repo}
budget: { usd: 1, hours: 1 }
autoApply: { usd: 0 }
pools: { host: 1 }
done:
  - check: ${doneCheck}
rules:
  - Stay inside the repo.
---

# Goal

Run host commands to a checked answer.
`;
}
function planFolder(contract: string, plan: string): string {
  const folder = tempDir('exp-plan-');
  fs.writeFileSync(path.join(folder, 'contract.md'), contract);
  fs.writeFileSync(path.join(folder, 'plan.ts'), plan);
  return folder;
}

const opened = new Set<Expedition>();
const children = new Set<ChildProcess>();
afterEach(async () => {
  for (const e of opened) await e.detach().catch(() => {});
  opened.clear();
  for (const c of children) c.kill('SIGKILL');
  children.clear();
});

const within = <T>(p: Promise<T>, ms: number, label: string): Promise<T> =>
  Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`timed out: ${label}`)), ms).unref()
    ),
  ]);
/** Bounded wait on something outside the test's control (a file a child writes, a pid exiting). */
async function until(pred: () => boolean, label: string, ms = 60_000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${label}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
};
const settledOf = (e: Expedition, key: string) => {
  const found = e
    .entries()
    .filter((x): x is Extract<keyed.Entry, { t: 'settled' }> => x.t === 'settled' && x.key === key);
  const last = found.at(-1);
  if (!last) throw new Error(`${key} never settled`);
  return last.outcome;
};

describe('the host executor under the real kernel', () => {
  test('command steps and a check judge run to `finished: met` at the launch base', async () => {
    const { repo, base, second } = repoWithScripts();
    const root = tempDir('exp-root-');
    const folder = planFolder(
      contractFor(repo, 'node scripts/check.js'),
      `import { z } from 'zod';
import { command, need, plan, steps } from 'expedition';

const Probe = z.object({ n: z.number(), head: z.string() });
const { probe, double, fails, slow, notjson, wrong } = steps({
  probe: command('node scripts/probe.js', { minutes: 1 }).returns(Probe),
  double: command('node scripts/use.js {{n}}', { minutes: 1 }).returns(Probe),
  fails: command('node scripts/fail.js', { minutes: 1 }),
  slow: command('node scripts/slow.js', { minutes: 0.01 }),
  notjson: command('node scripts/emit.js notjson', { minutes: 1 }).returns(Probe),
  wrong: command('node scripts/emit.js wrong', { minutes: 1 }).returns(Probe),
});

export default plan(async () => {
  const p = need(await probe(), 'no probe');
  await Promise.all([fails(), slow(), notjson(), wrong()]);
  return need(await double({ item: { n: p.out.n }, on: p }), 'no double');
});
`
    );
    const r = await launch(hostDeps(root).deps, root, folder, base, { t: 'none' });
    if (r.t !== 'launched') throw new Error(`rejected at ${r.gate}: ${r.issues.join('\n')}`);
    const e = r.expedition;
    opened.add(e);
    const finish = await within(e.finished, 90_000, 'the expedition finishes');

    // Stdout JSON reached the plan typed: `double` ran on probe's `n` (7) and answered 14, and
    // both ran at the launch base, not at the repo's HEAD (`second`).
    const probe = settledOf(e, 'probe');
    assert.deepEqual(probe.t === 'passed' && probe.out, { n: 7, head: base });
    const double = settledOf(e, 'double');
    assert.deepEqual(double.t === 'passed' && double.out, { n: 14, head: base });
    assert.notEqual(base, second);
    // The check judge read the candidate's answer (EXPEDITION_OUTPUT) and passed it.
    assert.deepEqual(finish, { t: 'met', candidate: double.t === 'passed' ? double.ref : '' });
    assert.equal(settledOf(e, 'done/0').t, 'passed');

    // A non-zero exit is a judged `no`: the call failed, with the tail as its why.
    const fails = settledOf(e, 'fails');
    assert.equal(fails.t, 'failed');
    assert.match(fails.t === 'failed' ? fails.why : '', /nope: the probe found nothing/);
    // Past maxMinutes the command is killed and errored.
    assert.deepEqual(settledOf(e, 'slow'), { t: 'errored', why: 'exceeded 0.01 min' });
    // An answer that is not JSON, or not the schema's shape, is errored before anything is judged.
    const notjson = settledOf(e, 'notjson');
    assert.match(
      notjson.t === 'errored' ? notjson.why : '',
      /^malformed output: stdout is not JSON/
    );
    const wrong = settledOf(e, 'wrong');
    assert.match(wrong.t === 'errored' ? wrong.why : '', /^malformed output: .*n/);

    // Every checkout was released: only the repo's own worktree is left.
    assert.deepEqual(worktreesOf(repo), [`worktree ${repo}`]);

    // The wire projection survives JSON whole: no Map, no Set, no undefined field.
    const view = keyedViewOf(e.view(), { t: 'none' }, () => ({ t: 'nothing' }));
    const wire: unknown = JSON.parse(JSON.stringify(view));
    assert.deepEqual(wire, view);
    assert.deepEqual(keyed.KeyedView.parse(wire), view);
    assert.deepEqual(view.lanes.map((l) => l.key).sort(), [
      'done/0',
      'double',
      'fails',
      'notjson',
      'probe',
      'slow',
      'wrong',
    ]);
    assert.equal(view.status.t, 'finished');
  });

  test('a command running when its host dies settles errored on reopen, its group killed', async () => {
    const { repo, base } = repoWithScripts();
    const root = tempDir('exp-root-');
    const marker = path.join(tempDir('exp-marker-'), 'hang.json');
    const folder = planFolder(
      contractFor(repo, 'node scripts/ok.js'),
      `import { command, need, plan, steps } from 'expedition';

const { hang, after } = steps({
  hang: command('node scripts/hang.js {{marker}}', { minutes: 5 }),
  after: command('node scripts/ok.js', { minutes: 1 }),
});

export default plan(async () => {
  const h = await hang({ item: { marker: ${JSON.stringify(marker)} } });
  if (h.t !== 'errored') throw new Error('hang ended ' + h.t);
  return need(await after(), 'no after');
});
`
    );
    // Host 1: a separate process that launches the expedition and is then killed outright.
    const host = spawn(process.execPath, ['--import', 'tsx', HOST_SCRIPT, root, folder, base], {
      cwd: SERVER,
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    children.add(host);
    let printed = '';
    host.stdout?.on('data', (b: Buffer) => {
      printed += b.toString('utf8');
    });
    await until(() => fs.existsSync(marker) && printed.includes('\n'), 'the command is running');
    const { dir } = JSON.parse(printed) as { dir: string };
    const pids = JSON.parse(fs.readFileSync(marker, 'utf8')) as { pid: number; kid: number };
    // The dead host must have recorded the group (its pgid and leader start), as a host that ran
    // a command for more than a moment has; a host killed inside spawn is the `starting` case.
    const spawnedRecord = () =>
      fs
        .readdirSync(path.join(dir, 'runs'))
        .filter((f) => f.endsWith('.json'))
        .some((f) => fs.readFileSync(path.join(dir, 'runs', f), 'utf8').includes('"spawned"'));
    await until(spawnedRecord, 'the host recorded the process group');
    const exited = new Promise((resolve) => host.once('exit', resolve));
    host.kill('SIGKILL');
    await exited;
    // The command outlived its host (its own process group): this is the case being tested.
    assert.ok(alive(pids.pid) && alive(pids.kid), 'the command survives the host');

    // Host 2: this process, a fresh executor on the same root.
    const { deps } = hostDeps(root);
    const e = (await open(deps, dir)).expedition;
    opened.add(e);
    const finish = await within(e.finished, 90_000, 'the reopened expedition finishes');
    assert.deepEqual(settledOf(e, 'hang'), {
      t: 'errored',
      why: 'host restarted during command',
    });
    assert.equal(finish.t, 'met');
    // The whole group is gone: the command and the process it started.
    await until(() => !alive(pids.pid) && !alive(pids.kid), 'the process group is killed', 10_000);
    assert.throws(() => process.kill(-pids.pid, 0), { code: 'ESRCH' });
    assert.deepEqual(worktreesOf(repo), [`worktree ${repo}`]);
  });
});

// ---- the executor alone: start, close and where a command runs ----

const ID = '20261110T090000-abc123';
const HASH = (c: string) => c.repeat(64);
const runIdOf = (key: string, h: string) => `${ID}/${key}@${HASH(h)}#1:producer`;

async function seeded(repo: string, base: string): Promise<{ ex: HostExecutor; dir: string }> {
  const root = tempDir('exp-root-');
  const dir = path.join(root, ID);
  const store = await LogStore.create(dir, contractFor(repo, 'node scripts/ok.js'));
  await store.append(
    keyed.Entry.parse({
      t: 'launched',
      at: new Date().toISOString(),
      id: ID,
      baseSha: base,
      contract: {
        goal: 'g',
        done: [{ t: 'check', command: 'node scripts/ok.js' }],
        budget: { usd: 1, hours: 1 },
        pools: {},
        rules: [],
        leader: 'lead',
        repo,
        autoApply: { usd: 0 },
      },
    })
  );
  await store.close();
  return {
    ex: new HostExecutor({ root, home: os.homedir(), clock: systemClock, calls: NO_CALLS }),
    dir,
  };
}
const commandSpec = (key: string, command: string, on: keyed.Base, output: unknown): RunSpec => ({
  t: 'command',
  call: { t: 'command', key, command, on, output, pools: [], maxMinutes: 1 },
});
function nextSettle(ex: HostExecutor, runId: string): Promise<RawOutcome> {
  return new Promise((resolve) => {
    const off = ex.onSettled((id, raw) => {
      if (id !== runId) return;
      off();
      resolve(raw);
    });
  });
}

describe('the host executor', () => {
  test('a second start of one run id does not run the command again', async () => {
    const { repo, base } = repoWithScripts();
    const { ex } = await seeded(repo, base);
    const file = path.join(tempDir('exp-count-'), 'count.txt');
    const id = runIdOf('cmd/count', 'a');
    const spec = commandSpec('cmd/count', `node scripts/count.js ${file}`, { t: 'launch' }, null);
    const settled = nextSettle(ex, id);
    await Promise.all([ex.start(id, spec), ex.start(id, spec)]);
    assert.equal((await within(settled, 30_000, 'the count settles')).t, 'ok');
    await ex.start(id, spec);
    assert.equal(fs.readFileSync(file, 'utf8'), 'ran\n');
    assert.equal((await ex.status(id)).t, 'settled');
  });

  test('a start that arrives after close runs nothing', async () => {
    const { repo, base } = repoWithScripts();
    const { ex, dir } = await seeded(repo, base);
    const file = path.join(tempDir('exp-count-'), 'count.txt');
    const id = runIdOf('cmd/late', 'b');
    await ex.close(id);
    await ex.start(
      id,
      commandSpec('cmd/late', `node scripts/count.js ${file}`, { t: 'launch' }, null)
    );
    // `start` returns once a run's record is written; the record is still the tombstone.
    const records = fs.readdirSync(path.join(dir, 'runs')).filter((f) => f.endsWith('.json'));
    assert.equal(records.length, 1);
    const record = JSON.parse(
      fs.readFileSync(path.join(dir, 'runs', records[0] as string), 'utf8')
    );
    assert.deepEqual(record, { t: 'closed', runId: id, last: { t: 'never-settled' } });
    assert.equal(fs.existsSync(file), false);
  });

  test('a command on a ref runs at that ref’s commit, and its checkout is released', async () => {
    const { repo, base, second } = repoWithScripts();
    const { ex, dir } = await seeded(repo, base);
    const ref = keyed.refOf('seed/work', HASH('c'));
    await putRef(dir, {
      ref,
      out: { summary: 'committed later work' },
      commit: second,
      checkout: { t: 'none' },
      conversation: { t: 'none' },
    });
    const schema = {
      type: 'object',
      properties: { head: { type: 'string' } },
      required: ['head'],
    };
    const run = async (key: string, h: string, on: keyed.Base) => {
      const id = runIdOf(key, h);
      const settled = nextSettle(ex, id);
      await ex.start(id, commandSpec(key, 'node scripts/head.js', on, schema));
      return within(settled, 30_000, `${key} settles`);
    };
    assert.deepEqual(await run('cmd/on-ref', 'd', { t: 'ref', ref }), {
      t: 'ok',
      out: { head: second },
    });
    assert.deepEqual(await run('cmd/on-launch', 'e', { t: 'launch' }), {
      t: 'ok',
      out: { head: base },
    });
    const missing = await run('cmd/on-nothing', 'f', { t: 'ref', ref: 'nope@x' });
    assert.equal(missing.t, 'errored');
    assert.deepEqual(worktreesOf(repo), [`worktree ${repo}`]);
  });
});

// ---- the command syntax rule ----

describe('commands are argv, never shell', () => {
  test('quotes and escapes tokenise the way a reader expects', () => {
    const argv = (command: string) => {
      const p = parseCommand(command);
      return p.t === 'argv' ? p.argv : p.why;
    };
    assert.deepEqual(argv('node -e "console.log(1); process.exit(0)"'), [
      'node',
      '-e',
      'console.log(1); process.exit(0)',
    ]);
    assert.deepEqual(argv(`a  'b c' "d \\"e\\" \\\\" f\\ g`), ['a', 'b c', 'd "e" \\', 'f g']);
    assert.deepEqual(argv(`x '' "it's"`), ['x', '', "it's"]);
    assert.deepEqual(argv("python 'tools/$x.py'"), ['python', 'tools/$x.py']);
  });

  test('anything a shell would interpret is refused, naming the command', () => {
    for (const command of [
      'a && b',
      'a | b',
      'a; b',
      'a > out.txt',
      'a < in.txt',
      'echo $(whoami)',
      'echo `whoami`',
      'echo "$HOME"',
      'ls *.ts',
      'ls file?.ts',
      '~/bin/x',
      'a # comment',
      'a\nb',
      "echo 'unterminated",
      'a\\',
      '   ',
    ]) {
      const p = parseCommand(command);
      assert.equal(p.t, 'refused', command);
      assert.ok(
        p.t === 'refused' && p.why.includes(JSON.stringify(command)),
        p.t === 'refused' ? p.why : ''
      );
    }
  });

  test('the static gate refuses shell syntax in a command, a check judge or a done check', () => {
    const folder = tempDir('exp-gate-');
    const contract: keyed.Contract = {
      goal: 'g',
      done: [{ t: 'check', command: 'pytest | tee log' }],
      budget: { usd: 1, hours: 1 },
      pools: {},
      rules: [],
      leader: 'lead',
      repo: '/tmp/r',
      autoApply: { usd: 0 },
      leaderWake: { t: 'given', usd: 0.5, minutes: 10 },
      doneReview: { t: 'given', usd: 0.5, minutes: 10 },
    };
    const cmd = (key: string, command: string): Authored => ({
      t: 'command',
      key,
      step: key,
      command,
      item: {},
      on: { t: 'launch' },
      output: null,
      needs: [],
      maxMinutes: 1,
    });
    const r = staticGate({
      contract,
      folder,
      calls: [cmd('build', 'make && make test'), cmd('fine', "node -e 'a && b'")],
      providerOf: () => ({ t: 'unknown', why: 'none' }),
    });
    assert.equal(r.t, 'failed');
    const issues = r.t === 'failed' ? r.issues : [];
    assert.equal(issues.length, 2, issues.join('\n'));
    assert.ok(issues.some((i) => i.startsWith('build: ') && i.includes('"make && make test"')));
    assert.ok(
      issues.some((i) => i.startsWith('contract done: ') && i.includes('"pytest | tee log"'))
    );
  });
});

// ---- the clock ----

test('a month-away wakeAt does not fire, and a near one does', async () => {
  // setTimeout replaces a delay over 2^31-1 ms with 1 ms; without the clamp in clock.ts this
  // deadline "arrives" at once and the expedition finishes on launch.
  let far = 0;
  const cancel = systemClock.wakeAt(new Date(Date.now() + 30 * 24 * 3_600_000), () => far++);
  let near = 0;
  systemClock.wakeAt(new Date(Date.now() + 20), () => near++);
  await new Promise((r) => setTimeout(r, 150));
  cancel();
  assert.equal(far, 0);
  assert.equal(near, 1);
});

test('a leader continue needs its reason; a log written without one still reads', () => {
  const act = (o: unknown) =>
    outcomeOf({ t: 'act', folder: '/d' }, `\`\`\`json\n${JSON.stringify(o)}\n\`\`\``);
  assert.deepEqual(act({ t: 'continue', why: 'on track' }), {
    t: 'ok',
    out: { t: 'continue', why: 'on track' },
  });
  const bare = act({ t: 'continue' });
  assert.equal(bare.t, 'errored');
  assert.match(bare.t === 'errored' ? bare.why : '', /malformed answer: a continue needs a reason/);
  assert.equal(act({ t: 'continue', why: '  ' }).t, 'errored');
  // F7: the old log's act has no `why`; the wire default reads it as empty.
  assert.deepEqual(keyed.LeaderAct.parse({ t: 'continue' }), { t: 'continue', why: '' });
});

// F6 (2026-11-11 run): every Codex call was `unreported` and charged its whole $0.50 reservation.
describe('what a call cost, from ingest usage rows', () => {
  const meterOver = (provider: string, model: string) =>
    ingestMeter({
      sessionOf: async () => ({ t: 'session', sessionId: 's1' }),
      ingest: () =>
        ({
          t: 'ready',
          ingest: {
            // The real run's Codex turn: 48,324 input of which 36,992 cached, 234 output.
            usage: async () => ({
              groups: [
                {
                  key: { t: 'session', sessionId: 's1', provider, model },
                  input: 11_332,
                  output: 234,
                  cacheRead: 36_992,
                  cacheWrite: 0,
                  reportedCostUsd: 0,
                },
              ],
            }),
          },
        }) as never,
    });
  test('a Codex model with a published rate is priced', async () => {
    const m = await meterOver('codex', 'gpt-6.1-sol').spent(['c1'], 0);
    // (11,332 x $2 + 36,992 x $0.10 + 234 x $10) / 1M
    assert.equal(m.t, 'priced');
    assert.ok(m.t === 'priced' && Math.abs(m.usd - 0.028703) < 1e-6, JSON.stringify(m));
  });
  test('a Codex model with no published rate stays unpriced', async () => {
    assert.equal((await meterOver('codex', 'gpt-5.3-codex-spark').spent(['c1'], 0)).t, 'unpriced');
  });
});
