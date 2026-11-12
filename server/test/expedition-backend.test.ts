import assert from 'node:assert/strict';
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { type ExpeditionView, WS_PATH, decodeRows } from '@unleashd/shared';
import { WebSocket } from 'ws';
import { NO_AUTO_INSTALL } from './fixtures/backend-env';
import { freePortSync } from './free-port';

// Bugs caught: replay double-spawns; reviews grade the wrong commit; a rewrite changes owner
// policy or leaves dropped work running; one failed fan-out item ends .try; budget admits debt.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'expedition-backend-'));
const repo = path.join(root, 'repo'),
  fake = path.join(root, 'fake'),
  data = path.join(root, 'data');
const bin = path.join(root, 'bin'),
  home = path.join(root, 'home'),
  checkout = path.join(root, 'nongit');
const port = freePortSync(),
  auth = 'isolated-expedition-test';
let child: ChildProcess | undefined, workspaceId: string, buddyId: string;
let logs = '';
const sdkClient = require.resolve('@modelcontextprotocol/sdk/client/index.js');
const sdkHttp = require.resolve('@modelcontextprotocol/sdk/client/streamableHttp.js');
const FAKE = String.raw`#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const fake=process.env.EXPEDITION_FAKE;
const codex=path.basename(process.argv[1])==='codex';
const say=o=>process.stdout.write(JSON.stringify(o)+'\n');
let prompt='';process.stdin.on('data',b=>prompt+=b);process.stdin.on('end',()=>main().catch(e=>{fs.writeFileSync(path.join(fake,'error'),String(e.stack));process.exit(1)}));
async function main(){
 const tag=/TAG:(\w+)/.exec(prompt)?.[1];
 const out=text=>say(codex?{type:'item.completed',item:{type:'agent_message',text}}:{type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text}}});
 const done=text=>{out(text);if(!codex)say({type:'assistant',message:{content:[],usage:{input_tokens:10,output_tokens:2,cache_read_input_tokens:0,cache_creation_input_tokens:0}}});say(codex?{type:'turn.completed',usage:{input_tokens:10,output_tokens:2}}:{type:'result',subtype:'success',result:text});};
 say(codex?{type:'thread.started',thread_id:'fake-'+Date.now()}:{type:'system',subtype:'init',session_id:'fake-'+Date.now()});
 const manager=/Expedition ([a-f0-9-]+) needs your decision: (rewrite|stop)/.exec(prompt);
 if(manager&&(manager[2]==='stop'||!fs.existsSync(path.join(fake,'rewritten')))){
  const {Client}=require(process.env.SDK_CLIENT),{StreamableHTTPClientTransport}=require(process.env.SDK_HTTP);
  const spec=Object.values(JSON.parse(process.argv[process.argv.indexOf('--mcp-config')+1]).mcpServers)[0];
  const headers=Object.fromEntries(Object.entries(spec.headers).map(([k,v])=>[k,v.replace(/\$\{([^}]+)\}/g,(_,n)=>process.env[n])]));
  const client=new Client({name:'fake-manager',version:'1'});
  await client.connect(new StreamableHTTPClientTransport(new URL(spec.url),{requestInit:{headers}}));
  if(manager[2]==='stop'){await client.callTool({name:'expedition',arguments:{action:{do:'stop',id:manager[1],why:'Done with this proof'}}});await client.close();done('Stopped');return;}
  const folder=/Read (.+)\/log.jsonl/.exec(prompt)[1];
  const next=fs.readFileSync(path.join(fake,'next.ts'),'utf8');
  fs.writeFileSync(path.join(folder,'plan.expedition.ts'),next.replace("goal:'test'","goal:'changed'"));
  const invoke=()=>client.callTool({name:'expedition',arguments:{action:{do:'rewrite',id:manager[1],why:'Replace dropped work'}}});
  const rejected=await invoke();fs.writeFileSync(path.join(fake,'rejected'),JSON.stringify(rejected));
  fs.writeFileSync(path.join(folder,'plan.expedition.ts'),next);
  const accepted=await invoke();fs.writeFileSync(path.join(fake,'accepted'),JSON.stringify(accepted));
  fs.writeFileSync(path.join(fake,'rewritten'),'');await client.close();done('Manager rewrote plan');return;
 }
 if(/needs your decision:.*wait cancelled/.test(prompt))fs.writeFileSync(path.join(fake,'cancel-wake'),prompt);
 if(!tag){done('ok');return;}
 if(process.argv.includes('--dangerously-skip-permissions')||process.argv.includes('--dangerously-bypass-approvals-and-sandbox'))throw Error('Expedition omitted capabilities');
 fs.writeFileSync(path.join(fake,tag+'.argv'),JSON.stringify(process.argv.slice(2)));
 if(codex ? !process.argv.includes('-s') : !process.argv.includes('dontAsk'))throw Error('Missing restrictive capability argv');
 fs.appendFileSync(path.join(fake,'spawns'),tag+' '+process.pid+'\n');
 fs.writeFileSync(path.join(fake,tag+'.started'),String(process.pid));
 if(tag==='slow'||tag==='drop'||tag==='resource'||tag==='ownerstop')await new Promise(resolve=>{const t=setInterval(()=>{if(fs.existsSync(path.join(fake,tag+'.go'))){clearInterval(t);resolve()}},10)});
 if(tag==='edit'){
  fs.writeFileSync('value.txt','after\n');cp.execFileSync('git',['add','value.txt']);cp.execFileSync('git',['-c','commit.gpgsign=false','commit','-qm','edit']);
 }
 if(tag==='review'){
  const code=/THE CODE: exact commit (\S+) at ([^;]+); diff ([^\s]+)/.exec(prompt);
  if(!code)throw Error('Review was not given code');
  const file=path.join(code[2],'value.txt'),diff=code[3].replace(/\.$/,'');
  if(fs.readFileSync(file,'utf8')!=='after\n'||!fs.readFileSync(diff,'utf8').includes('+after'))throw Error('Wrong review source or diff');
 }
 const text=tag==='bad'?'not json':tag==='review'?JSON.stringify({verdict:'yes',why:'SOURCE after; DIFF +after'}):JSON.stringify({summary:tag,files:tag==='edit'?['value.txt']:[]});
 done(text);
}
`;
async function api<T = { id: string }>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(`http://127.0.0.1:${port}${url}`, {
    method: body ? 'POST' : 'GET',
    headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const value = await res.json();
  assert.ok(res.ok, JSON.stringify(value));
  return value as T;
}
async function eventually(check: () => unknown | Promise<unknown>, why: string) {
  const end = Date.now() + 60000;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.fail(
    `${why}\n${logs.slice(-4000)}\n${fs.existsSync(path.join(fake, 'error')) ? fs.readFileSync(path.join(fake, 'error'), 'utf8') : ''}`
  );
}
async function start() {
  logs = '';
  child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    cwd: path.resolve(__dirname, '..'),
    detached: true,
    env: {
      ...process.env,
      ...NO_AUTO_INSTALL,
      HOME: home,
      PATH: `${bin}:${path.dirname(process.execPath)}:${path.dirname(execFileSync('which', ['git-cambium'], { encoding: 'utf8' }).trim())}:/usr/bin:/bin`,
      PORT: String(port),
      UNLEASHD_DATA_DIR: data,
      UNLEASHD_BUDDIES_DB: path.join(root, 'buddies.sqlite'),
      BUDDIES_HOME: path.join(root, 'buddies'),
      UNLEASHD_CHECKOUT_ROOT: checkout,
      UNLEASHD_BUDDY_EXECUTION: '1',
      UNLEASHD_AUTH_TOKEN: auth,
      EXPEDITION_FAKE: fake,
      SDK_CLIENT: sdkClient,
      SDK_HTTP: sdkHttp,
      NODE_ENV: 'test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout!.on('data', (b) => {
    logs += b;
  });
  child.stderr!.on('data', (b) => {
    logs += b;
  });
  await eventually(() => logs.includes('Initial load complete'), 'backend started');
}
async function kill() {
  if (child?.exitCode === null && child.signalCode === null)
    await new Promise<void>((resolve) => {
      child!.once('exit', () => resolve());
      child!.kill('SIGKILL');
    });
}
const count = (tag: string) =>
  fs.existsSync(path.join(fake, 'spawns'))
    ? fs
        .readFileSync(path.join(fake, 'spawns'), 'utf8')
        .split('\n')
        .filter((l) => l.startsWith(`${tag} `)).length
    : 0;
const view = (id: string) => api<ExpeditionView>(`/api/buddies/expeditions/${id}`);
function plan(steps: string, body: string, budget = 3) {
  return `import { expedition,step } from 'expedition';import {z} from 'zod';
export default expedition({contract:{goal:'test',leader:'buddy:${buddyId}',repo:${JSON.stringify(repo)},budget:{usd:${budget},hours:1},autoApply:{usd:1},rules:[],done:[]},steps:{${steps}},plan:async(s,x)=>{${body}}});`;
}
async function launch(source: string) {
  const file = path.join(repo, `plan-${Date.now()}.expedition.ts`);
  fs.writeFileSync(file, source);
  return api<ExpeditionView>('/api/buddies/expeditions/launch', {
    file,
    hash: createHash('sha256').update(JSON.stringify(source)).digest('hex'),
    workspaceId,
  });
}
before(async () => {
  for (const dir of [repo, fake, bin, home, checkout]) fs.mkdirSync(dir, { recursive: true });
  for (const name of ['claude', 'codex'])
    fs.writeFileSync(path.join(bin, name), FAKE, { mode: 0o755 });
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.invalid');
  fs.writeFileSync(path.join(repo, 'value.txt'), 'before\n');
  fs.writeFileSync(
    path.join(repo, 'check.cjs'),
    `require('node:assert/strict').equal(require('node:fs').readFileSync('value.txt','utf8'),'after\\n')`
  );
  git('add', '.');
  git('commit', '-qm', 'base');
  await start();
  workspaceId = (await api('/api/buddies/workspaces', { rootPath: repo, name: 'Test' })).id;
  buddyId = (
    await api('/api/buddies', {
      workspaceId,
      slug: 'manager',
      name: 'Manager',
      role: 'Manage expeditions',
      provider: 'claude',
      model: 'claude-haiku-5-5',
      reasoningEffort: 'low',
      key: 'manager',
    })
  ).id;
});
after(async () => {
  await kill();
  if (fs.existsSync(path.join(fake, 'spawns')))
    for (const line of fs.readFileSync(path.join(fake, 'spawns'), 'utf8').trim().split('\n')) {
      try {
        process.kill(Number(line.split(' ')[1]), 'SIGKILL');
      } catch {}
    }
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10 });
});
test('real backend: fan-out, restart adoption, checkout judges, question, rewrite and budget', {
  timeout: 240000,
}, async () => {
  const who = 'claude:claude-haiku-5-5:low';
  const source = plan(
    `first:{by:'${who}',brief:'TAG:first'},fan:step({by:'${who}',item:z.object({id:z.string()}),brief:i=>'TAG:'+i.id}),slow:{by:'${who}',brief:'TAG:slow'}`,
    `const a=await s.first();const fan=await Promise.all([{id:'good'},{id:'bad'}].map(i=>s.fan.try(i)));if(fan[1].t!=='errored')throw Error('bad accepted');await s.slow();await x.ask('Name?');return a;`
  );
  const launched = await launch(source);
  await eventually(() => count('slow') === 1, 'slow running after settled fan-out');
  await kill();
  await start();
  fs.writeFileSync(path.join(fake, 'slow.go'), '');
  await eventually(
    async () => (await view(launched.id)).questions.some((q) => q.kind === 'text'),
    'question replayed after adoption'
  );
  assert.equal(count('first'), 1);
  assert.equal(count('good'), 1);
  assert.equal(count('bad'), 1);
  assert.equal(count('slow'), 1);
  const q = (await view(launched.id)).questions.find((q) => q.kind === 'text')!;
  await api(`/api/buddies/expeditions/${launched.id}/answer`, { key: q.key, value: 'Nick' });
  await eventually(async () => (await view(launched.id)).status === 'met', 'completed');
  const checkoutRun = await launch(
    plan(
      `edit:{by:'${who}',checkout:true,brief:'TAG:edit',judge:{review:'TAG:review',by:'codex:gpt-6.1-sol:low'}},check:{run:'node check.cjs'}`,
      `const a=await s.edit();await s.check({on:a});return a;`
    ).replace('done:[]', `done:[{review:'TAG:review',by:'codex:gpt-6.1-sol:low'}]`)
  );
  await eventually(
    async () => ['met', 'held'].includes((await view(checkoutRun.id)).status),
    'checkout settled'
  );
  assert.equal(
    (await view(checkoutRun.id)).status,
    'met',
    JSON.stringify(await view(checkoutRun.id))
  );
  const checked = await launch(
    plan(
      `edit:{by:'${who}',checkout:true,brief:'TAG:edit',judge:{check:'node check.cjs'}}`,
      `return s.edit();`
    )
  );
  await eventually(
    async () => ['met', 'held'].includes((await view(checked.id)).status),
    'command judge'
  );
  assert.equal((await view(checked.id)).status, 'met', 'check judge reads the committed tree');
  const initial = plan(
    `first:{by:'${who}',brief:'TAG:first'},drop:{by:'${who}',brief:'TAG:drop'}`,
    `const a=await s.first();await Promise.all([s.drop.try(),x.checkin('rewrite')]);return a;`
  ).replace('autoApply:{usd:1}', 'autoApply:{usd:0}');
  fs.writeFileSync(
    path.join(fake, 'next.ts'),
    plan(
      `first:{by:'${who}',brief:'TAG:first'},added:{by:'${who}',brief:'TAG:added'}`,
      `const a=await s.first();await x.checkin('rewrite');await s.added();return a;`
    ).replace('autoApply:{usd:1}', 'autoApply:{usd:0}')
  );
  const rewritten = await launch(initial);
  await eventually(
    async () => (await view(rewritten.id)).questions.some((q) => q.kind === 'confirm'),
    'rewrite cost approval'
  );
  const approval = (await view(rewritten.id)).questions.find((q) => q.kind === 'confirm')!;
  await api(`/api/buddies/expeditions/${rewritten.id}/answer`, { key: approval.key, value: true });
  await eventually(
    async () => (await view(rewritten.id)).status === 'met',
    'manager rewrite completed'
  );
  assert.match(fs.readFileSync(path.join(fake, 'rejected'), 'utf8'), /owner contract changed/);
  assert.equal(count('first'), 2, 'one per expedition; rewrite reuses its first step');
  assert.equal(count('drop'), 1);
  assert.equal(count('added'), 1);
  assert.equal((await view(rewritten.id)).versions.length, 2);
  assert.ok(
    (await view(checkoutRun.id)).steps.some((s) => s.key === 'edit/review' && s.conversationId),
    'judge conversation is inspectable'
  );
  const budget = await launch(
    plan(`costly:{by:'${who}',brief:'TAG:costly',usd:4}`, `return await s.costly.try() as never;`)
  );
  await eventually(
    async () => (await view(budget.id)).steps.some((s) => s.state === 'refused'),
    'budget refused'
  );
  assert.equal(count('costly'), 0);
  // Two different harnesses still share a named resource; reserving dollars does not acquire it.
  const resources = await launch(
    plan(
      `a:{by:'${who}',needs:['cpu'],brief:'TAG:resource'},b:{by:'codex:gpt-6.1-sol:low',needs:['cpu'],brief:'TAG:blocked'}`,
      `const [a]=await Promise.all([s.a(),s.b()]);return a;`
    )
  );
  await eventually(
    async () => count('resource') === 1 && (await view(resources.id)).steps.length === 2,
    'resource held'
  );
  assert.equal(count('blocked'), 0, 'second harness waits for the shared resource');
  fs.writeFileSync(path.join(fake, 'resource.go'), '');
  await eventually(async () => (await view(resources.id)).status === 'met', 'resource released');
  assert.equal(count('blocked'), 1);
  const stopped = await launch(
    plan(
      '',
      `const [out]=await Promise.all([x.ask('pending'),x.checkin('stop')]);return {out,ref:{id:'owner'}};`
    )
  );
  await eventually(async () => (await view(stopped.id)).status === 'stopped', 'manager stop');
  assert.deepEqual((await view(stopped.id)).questions, [], 'stopped questions cannot be answered');
});

test('owner Stop cancels a step and wakes its manager', { timeout: 120000 }, async () => {
  const run = await launch(
    plan("wait:{by:'claude:claude-haiku-5-5:low',brief:'TAG:ownerstop'}", 'return await s.wait();')
  );
  await eventually(() => count('ownerstop') === 1, 'step running');
  const socket = new WebSocket(`ws://127.0.0.1:${port}${WS_PATH}`, {
    headers: { authorization: `Bearer ${auth}` },
  });
  try {
    await new Promise<void>((resolve, reject) => {
      socket.on('error', reject);
      socket.on('message', (b) => {
        const m = JSON.parse(b.toString());
        if (m.type !== 'hello') return;
        const row = decodeRows(m).find((row) => row.label === 'Expedition wait');
        assert.ok(row, 'step conversation is visible to the app');
        socket.send(JSON.stringify({ type: 'stop_conversation', conversationId: row.id }));
        resolve();
      });
    });
    await eventually(async () => {
      const v = await view(run.id);
      return (
        v.status === 'held' &&
        v.steps[0]?.state === 'cancelled' &&
        fs.existsSync(path.join(fake, 'cancel-wake'))
      );
    }, 'cancelled receipt held the plan and reached the manager');
    assert.match(
      fs.readFileSync(path.join(fake, 'cancel-wake'), 'utf8'),
      /Required step wait cancelled/
    );
    assert.equal(count('ownerstop'), 1);
    const pid = Number(fs.readFileSync(path.join(fake, 'ownerstop.started'), 'utf8'));
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  } finally {
    socket.close();
  }
});
