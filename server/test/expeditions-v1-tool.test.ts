import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { BuddiesCore } from '@unleashd/buddies-core';
import { keyed } from '@unleashd/shared';
import { OWNER, buddyActor } from '../src/buddies/core';
import { createBuddyEvents } from '../src/buddies/events';
import { createGrants } from '../src/buddies/grants';
import { startMcpEndpoint, toolsFor } from '../src/buddies/mcp';
import { createKeyedExpeditions } from '../src/expeditions-v1/service';
import { BackgroundWork } from '../src/turns/background-work';
import { rpc } from './fixtures/expedition-fixture';
import { writePlan } from './fixtures/expedition-source';
import { tempDir } from './fixtures/temp';

// CONNECT_PLAN §8 step 8: the keyed half of the `expedition` Buddy tool, through the REAL MCP
// endpoint, a real BuddiesCore and the live keyed service (typecheck gate, dry run and static gate
// run for real), on temp stores. Launch is not here: it is the owner's HTTP route (the digest rule
// is tested in expeditions-v1-server.test.ts).

const SEAT = "seat('claude', 'claude-sonnet-5-5', 'low')";
const HEAD = `import { check, need, expedition, role, seat, steps } from 'expedition';
const worker = role({ by: ${SEAT}, usd: 1, minutes: 10 });`;
const GOOD = `${HEAD}
const { work } = steps({ work: worker.brief(PROMPTS.work) });
export default expedition({ contract: CONTRACT, plan: async () => need(await work(), 'no work') });
`;

// Every endpoint a test opened is closed at the end, or its listener keeps the process alive.
const endpoints: Array<{ close(): Promise<void> }> = [];
after(async () => {
  for (const e of endpoints) await e.close();
});

async function setup() {
  const scratch = tempDir('xk-tool-');
  const repo = path.join(scratch, 'repo');
  fs.mkdirSync(path.join(repo, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'scripts', 'ok.js'), 'process.exit(0);\n');
  const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'T');
  git('add', '.');
  git('commit', '-qm', 'base');
  const core = await BuddiesCore.open(path.join(scratch, 'buddies.sqlite'));
  const ws = await core.createWorkspace(OWNER, { name: 'Repo', rootPath: repo });
  const lead = await core.createBuddy(OWNER, {
    workspaceId: ws.id,
    slug: 'lead',
    name: 'Lead',
    role: 'Lead',
    manager: { kind: 'nobody' },
    key: 'lead',
  });
  const events = createBuddyEvents();
  const x = createKeyedExpeditions(
    { t: 'live' },
    {
      core,
      events,
      gate: { t: 'enabled' },
      root: path.join(scratch, 'expeditions-v1'),
      home: os.homedir(),
      records: {} as never,
      ingest: {} as never,
      installed: () => ({ kind: 'claude' }) as never,
      logger: console,
    }
  );
  const grants = createGrants({ ttlMs: 60_000 });
  const endpoint = await startMcpEndpoint({
    core,
    events,
    grants,
    backgroundWork: new BackgroundWork(),
    messages: async () => null,
    openBranch: async () => 'unused',
    uploadsRoot: () => scratch,
    portFile: path.join(scratch, 'buddy-mcp.json'),
    keyed: x,
  });
  endpoints.push(endpoint);
  const spec = endpoint.spec(
    grants.issueBuddy({
      role: 'worker',
      buddyId: lead.id,
      workspaceId: ws.id,
      conversationId: 'lead-turn',
      runId: null,
      subscribes: 'self',
      hooks: { t: 'unrecorded' },
    })
  );
  /** A plan file inside the workspace (the Buddy wrote it with its own file tools). */
  const file = (plan: string, prompts: Record<string, string> = { work: 'Do the work.' }) => {
    const dir = fs.mkdtempSync(path.join(repo, 'exp-'));
    return writePlan(
      path.join(dir, 'plan.expedition.ts'),
      {
        leader: lead.id,
        repo,
        goal: 'Do the work.',
        budget: { usd: 50, hours: 4 },
        autoApply: { usd: 5 },
        pools: { claude: 4 },
        done: [{ check: 'node scripts/ok.js' }],
        rules: ['Stay inside the repo.'],
      },
      plan,
      prompts
    );
  };
  const propose = (dir: string) =>
    rpc(spec, 'expedition', { action: { do: 'propose', file: dir } });
  const cards = async () => {
    const dm = await core.openChannel(OWNER, {
      kind: 'direct',
      members: [OWNER, buddyActor(lead.id)],
    });
    const page = await core.listPosts(OWNER, { kind: 'channel', channelId: dm.id }, null, 50);
    return page.posts.filter((p) => p.evidence.some((e) => e.startsWith(keyed.PROPOSAL_EVIDENCE)));
  };
  return {
    scratch,
    ws,
    file,
    propose,
    cards,
    call: (action: object) => rpc(spec, 'expedition', { action }),
  };
}

test('propose: a clean file returns its preview and posts one card, however often it is repeated; an edit posts a new one', {
  timeout: 120_000,
}, async () => {
  const t = await setup();
  const dir = t.file(GOOD);
  const first = await t.propose(dir);
  assert.equal(first.error, false, first.text);
  const clean = first.value as {
    t: string;
    costUsd: number;
    firstWave: { key: string; who: string }[];
  };
  assert.equal(clean.t, 'clean');
  assert.equal(clean.costUsd, 1);
  assert.deepEqual(
    clean.firstWave.map((c) => [c.key, c.who]),
    [['work', 'claude · claude-sonnet-5-5 · low']]
  );
  const posted = await t.cards();
  assert.equal(posted.length, 1);
  assert.ok(posted[0]?.body.includes(`File: ${fs.realpathSync(dir)}`));
  // The card carries what the client needs to render and launch it, parsed with the wire schema.
  const evidence = posted[0]?.evidence.find((e) => e.startsWith(keyed.PROPOSAL_EVIDENCE)) as string;
  const proposal = keyed.KeyedProposal.parse(
    JSON.parse(evidence.slice(keyed.PROPOSAL_EVIDENCE.length))
  );
  assert.equal(proposal.file, fs.realpathSync(dir));
  assert.equal(proposal.workspaceId, t.ws.id);

  assert.equal((await t.propose(dir)).error, false);
  assert.equal((await t.cards()).length, 1, 'an unchanged file posts nothing new');

  fs.writeFileSync(
    dir,
    fs.readFileSync(dir, 'utf8').replace('Do the work.', 'Do the work, carefully.')
  );
  assert.equal((await t.propose(dir)).error, false);
  assert.equal((await t.cards()).length, 2, 'a changed file is a new card');
});

test('propose: a type error answers the gate and its issues, and posts nothing', {
  timeout: 120_000,
}, async () => {
  const t = await setup();
  const r = await t.propose(
    t.file(`${HEAD}\nexport default expedition({ contract: CONTRACT, plan: async () => nope });\n`)
  );
  assert.equal(r.error, false, r.text);
  const rejected = r.value as { t: string; gate: string; issues: string[] };
  assert.equal(rejected.t, 'rejected');
  assert.equal(rejected.gate, 'typecheck');
  assert.ok(rejected.issues.length > 0);
  assert.equal((await t.cards()).length, 0);
});

// Guard (CONNECT_PLAN §5): a Buddy proposes only what its workspace owns, symlinks resolved.
test('propose: a file outside the workspace is refused, a symlink out of it too', {
  timeout: 120_000,
}, async () => {
  const t = await setup();
  const outside = path.join(tempDir('xk-tool-outside-'), 'outside.ts');
  fs.writeFileSync(outside, 'export default {};');
  const refused = await t.propose(outside);
  assert.equal(refused.error, true);
  assert.match(refused.text, /outside this workspace/);
  const link = path.join(path.dirname(t.file(GOOD)), 'link.ts');
  fs.symlinkSync(outside, link);
  assert.match((await t.propose(link)).text, /outside this workspace/);
  assert.match((await t.propose('relative/dir')).text, /absolute path/);
  assert.equal((await t.cards()).length, 0);
});

test('a call-role turn is shown no expedition tool; status and list read only this workspace', {
  timeout: 120_000,
}, async () => {
  assert.deepEqual(Object.keys(toolsFor('call')), []);
  const t = await setup();
  const listed = await t.call({ do: 'list' });
  assert.equal(listed.error, false, listed.text);
  assert.deepEqual(listed.value ?? [], []);
  const missing = await t.call({ do: 'status', id: '20261111T000000-aaaaaa' });
  assert.equal(missing.error, true);
  assert.match(missing.text, /no expedition/);
});
