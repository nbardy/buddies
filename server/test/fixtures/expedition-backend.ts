import fs from 'node:fs';
import { createServer } from 'node:http';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';

// The REAL backend (src/server.ts, unchanged) with the expedition executor running INSIDE it, as
// step 6 will compose it, for expeditions-v1-agent-*.test.ts. The executor is not wired into
// server.ts yet (CONNECT_PLAN §8: boot and routes are step 6), so this entry captures the three
// objects server.ts builds that the executor needs (its Buddy core, its in-process event bus and
// its conversation records) as server.ts creates them, then builds the executor beside it. Why in
// the same process: a cancel stops a running turn only through the bus the runner listens on, and a
// SIGKILL of "the backend" must kill the executor with it, exactly as in production.
//
// Run: node --import tsx test/fixtures/expedition-backend.ts (the backend's own env, plus
// EXP_CONTROL_PORT). A loopback control server takes the executor's port calls as JSON.
// EXP_HANG=post makes every expedition-call post hang (the host "dies" between writing the record
// and sending the post; the test SIGKILLs it there).

type Loaded = Record<string, unknown>;
const M = Module as unknown as {
  _load(request: string, parent: unknown, isMain: boolean): unknown;
  _resolveFilename(request: string, parent: unknown): string;
};
const SRC = path.resolve(__dirname, '..', '..', 'src');
const at = (rel: string) => path.join(SRC, rel);
const captured: { events?: unknown; core?: unknown; records?: unknown } = {};

/** Wrap one export of one source module; every importer of it gets the wrapper. */
const WRAP: Record<string, (m: Loaded) => Loaded> = {
  [at('buddies/events.ts')]: (m) => ({
    ...m,
    createBuddyEvents: () => {
      captured.events = (m.createBuddyEvents as () => unknown)();
      return captured.events;
    },
  }),
  [at('buddies/core.ts')]: (m) => ({
    ...m,
    lateBoundCore: (ready: unknown) => {
      captured.core = (m.lateBoundCore as (r: unknown) => unknown)(ready);
      return captured.core;
    },
  }),
  [at('conversations/config-records.ts')]: (m) => {
    const Store = m.ConversationRecordStore as new (...args: unknown[]) => object;
    class Captured extends Store {
      constructor(...args: unknown[]) {
        super(...args);
        captured.records = this;
      }
    }
    return { ...m, ConversationRecordStore: Captured };
  },
};
const load = M._load;
M._load = function (request: string, parent: unknown, isMain: boolean) {
  const loaded = load.call(this, request, parent, isMain) as Loaded;
  if (!request.startsWith('.')) return loaded;
  const wrap = WRAP[M._resolveFilename(request, parent)];
  return wrap ? wrap(loaded) : loaded;
};

require('../../src/server');

async function main(): Promise<void> {
  // Required after server.ts: the same module instances it uses.
  const { decideExecutionGate } = require('../../src/buddies/execution-gate') as typeof import(
    '../../src/buddies/execution-gate'
  );
  const { appDataDirectory } = require('../../src/app-data') as typeof import('../../src/app-data');
  const { currentIngest } = require('../../src/ingest/instance') as typeof import(
    '../../src/ingest/instance'
  );
  const { systemClock } = require('../../src/expedition-kernel/clock') as typeof import(
    '../../src/expedition-kernel/clock'
  );
  const { HostExecutor } = require('../../src/expeditions-v1/executor') as typeof import(
    '../../src/expeditions-v1/executor'
  );
  const { CALL_TIMING, recordPathOf } =
    require('../../src/expeditions-v1/executor/calls') as typeof import(
      '../../src/expeditions-v1/executor/calls'
    );
  const { ingestMeter, recordsSessionOf } =
    require('../../src/expeditions-v1/executor/usage') as typeof import(
      '../../src/expeditions-v1/executor/usage'
    );
  const { refFilesOf } = require('../../src/expeditions-v1/executor/refs') as typeof import(
    '../../src/expeditions-v1/executor/refs'
  );
  const { parseRunId } = require('../../src/expeditions-v1/executor/address') as typeof import(
    '../../src/expeditions-v1/executor/address'
  );
  const { readRecord } = require('../../src/expeditions-v1/executor/records') as typeof import(
    '../../src/expeditions-v1/executor/records'
  );
  const { expeditionsV1Root } = require('../../src/expeditions-v1/call-directory') as typeof import(
    '../../src/expeditions-v1/call-directory'
  );
  const { buddyProviders } = require('../../src/expeditions-v1/providers') as typeof import(
    '../../src/expeditions-v1/providers'
  );
  const { installedAgent } = require('../../src/providers/installed-agent') as typeof import(
    '../../src/providers/installed-agent'
  );
  type Core = import('../../src/buddies/core').BuddiesCore;
  type Events = import('../../src/buddies/events').BuddyEvents;
  type Records = import('../../src/conversations/config-records').ConversationRecordStore;
  type Spec = import('../../src/expedition-kernel/ports').RunSpec;

  const real = captured.core as Core;
  const hang = process.env.EXP_HANG === 'post';
  // Only the expedition call's post hangs: the process "dies" after `posting` is durable.
  const core = new Proxy(real, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (prop !== 'post' || !hang) return typeof value === 'function' ? value.bind(target) : value;
      return (...args: unknown[]) =>
        (args[2] as { purpose?: string }).purpose === 'expedition_call'
          ? new Promise(() => {})
          : (value as (...a: unknown[]) => unknown).apply(target, args);
    },
  });
  const env = (name: string, fallback: number) => Number(process.env[name] ?? fallback);
  const root = expeditionsV1Root(appDataDirectory());
  const settled: { runId: string; raw: unknown; spent: unknown; refAtReport: boolean }[] = [];
  const executor = new HostExecutor({
    root,
    home: os.homedir(),
    clock: systemClock,
    calls: {
      t: 'buddies',
      deps: {
        core,
        events: captured.events as Events,
        gate: decideExecutionGate(),
        meter: ingestMeter({
          sessionOf: recordsSessionOf(captured.records as Records),
          ingest: currentIngest,
        }),
        timing: {
          debounceMs: env('EXP_DEBOUNCE_MS', CALL_TIMING.debounceMs),
          backstopMs: env('EXP_BACKSTOP_MS', CALL_TIMING.backstopMs),
          usagePollMs: env('EXP_USAGE_POLL_MS', CALL_TIMING.usagePollMs),
          usageWaitMs: env('EXP_USAGE_WAIT_MS', CALL_TIMING.usageWaitMs),
          usageRetryMs: env('EXP_USAGE_RETRY_MS', CALL_TIMING.usageRetryMs),
        },
        logger: console,
      },
    },
  });
  // Whether the run's ref (record AND answer file) existed at the moment `ok` was reported.
  executor.onSettled((runId, raw, spent) => {
    const a = parseRunId(runId);
    const files = refFilesOf(path.join(root, a.expedition), a.ref);
    const refAtReport = fs.existsSync(files.record) && fs.existsSync(files.answer);
    settled.push({ runId, raw, spent, refAtReport });
  });
  const providers = buddyProviders(real, () => installedAgent());

  type Body = { runId: string; spec: Spec; buddyId: string; who: never };
  const ROUTES: Record<string, (b: Body) => Promise<unknown>> = {
    start: (b) => executor.start(b.runId, b.spec),
    cancel: (b) => executor.cancel(b.runId),
    close: (b) => executor.close(b.runId),
    status: (b) => executor.status(b.runId),
    record: (b) => readRecord(recordPathOf(root, b.runId)),
    settled: async () => settled,
    reviews: async (b) =>
      (await real.listEvents(b.buddyId, Number.MAX_SAFE_INTEGER, 200))
        .filter((e) => e.op === 'memory_review')
        .map((e) => JSON.parse(e.payload) as unknown),
    provider: async (b) => {
      await providers.refresh();
      return providers.providerOf(b.who);
    },
  };
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => {
      raw += d;
    });
    req.on('end', () => {
      const route = ROUTES[(req.url ?? '').slice(1)];
      Promise.resolve()
        .then(() =>
          route ? route(raw ? JSON.parse(raw) : {}) : Promise.reject(new Error('no route'))
        )
        .then(
          (value) => res.writeHead(200).end(JSON.stringify(value ?? null)),
          (e: Error) => res.writeHead(500).end(JSON.stringify({ error: e.message }))
        );
    });
  });
  server.listen(Number(process.env.EXP_CONTROL_PORT), '127.0.0.1', () => {
    void executor.watch().then(() => console.log('[expedition-backend] control ready'));
  });
}

main().catch((e: unknown) => {
  console.error(`[expedition-backend] ${(e as Error).stack ?? String(e)}`);
  process.exit(1);
});
