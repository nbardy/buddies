/**
 * Perf audit: one Markdown report on why the app feels slow.
 *
 *   pnpm perf:audit                  # last 7 days -> output/perf-audit/<ts>.md
 *   pnpm perf:audit --days 2 --data-dir /path/to/.agent-viewer
 *
 * Reads (never writes, never opens SQLite): <data-dir>/observability/perf/{boot,stalls,routes}.jsonl,
 * perf/profiles/, errors.jsonl (fallback for boots and stalls from before perf telemetry existed),
 * file sizes under the data dir and ~/.buddies, and machine load via os / vm_stat / sysctl / ps.
 * Writers: server/src/observability/perf.ts, event-loop-stall.ts and the dev supervisor.
 * Built 2026-10-23 after a slow-boot investigation had to be reconstructed by hand from errors.jsonl.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ---------- canonical rows ----------

export interface StallRow {
  atMs: number;
  /** Longest stall this row stands for. */
  ms: number;
  label: string;
  /** Stalls this row stands for (errors.jsonl rows summarize repeats). */
  count: number;
}

export interface BootRow {
  bootId: string;
  source: string;
  phase: string;
  ms: number;
  atMs: number;
}

export interface RouteRow {
  atMs: number;
  method: string;
  route: string;
  count: number;
  p50: number;
  p90: number;
  max: number;
}

export interface MachineSnapshot {
  load: [number, number, number];
  cpus: number;
  totalMemBytes: number;
  /** free + inactive + speculative: memory the OS can hand out without swapping. */
  availableMemBytes: number;
  swapUsedMb: number;
  swapTotalMb: number;
  processes: { node: number; codex: number; claude: number };
}

// ---------- readers ----------

/** Rotated files oldest first, then the live one: `x.jsonl.4 ... x.jsonl.1, x.jsonl`. */
// biome-ignore lint/suspicious/noExplicitAny: untyped JSONL rows are validated field by field by each reader
function* jsonLines(base: string): Generator<Record<string, any>> {
  for (const file of [4, 3, 2, 1].map((i) => `${base}.${i}`).concat(base)) {
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      if (!line) continue;
      try {
        yield JSON.parse(line);
      } catch {
        /* a torn line from a crash is not a finding */
      }
    }
  }
}

/** Stall durations over this are laptop sleep / SIGSTOP, not slowness (as the 2026-10-22 scripts also dropped). */
const SUSPEND_ARTIFACT_MS = 60_000;

const ERROR_STALL = /stalled (\d+)ms; last activity: (.*?) \(started/;
const ERROR_REPEATS = /; (\d+) more stall\(s\) up to (\d+)ms/;

/** Volatile ids out of a label so one activity is one key. */
export function normalizeLabel(label: string): string {
  return label
    .replace(/\b(post|list|run|task|bud|buddy|project|ws|conv)_[0-9a-f-]{10,}/g, '$1_ID')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, 'UUID')
    .split('?')[0];
}

export function readStalls(observabilityDir: string): { rows: StallRow[]; source: string } {
  const perf: StallRow[] = [];
  for (const e of jsonLines(path.join(observabilityDir, 'perf', 'stalls.jsonl'))) {
    if (typeof e.ms !== 'number' || e.ms > SUSPEND_ARTIFACT_MS) continue;
    perf.push({
      atMs: Date.parse(e.at),
      ms: e.ms,
      label: normalizeLabel(String(e.label)),
      count: 1,
    });
  }
  if (perf.length > 0) return { rows: perf, source: 'perf/stalls.jsonl (every stall)' };
  const fallback: StallRow[] = [];
  for (const e of jsonLines(path.join(observabilityDir, 'errors.jsonl'))) {
    if (e.component !== 'event-loop') continue;
    const m = ERROR_STALL.exec(e.message ?? '');
    if (!m) continue;
    const r = ERROR_REPEATS.exec(e.message);
    const ms = Math.max(Number(m[1]), r ? Number(r[2]) : 0);
    if (ms > SUSPEND_ARTIFACT_MS) continue;
    fallback.push({
      atMs: Date.parse(e.timestamp),
      ms,
      label: normalizeLabel(m[2]),
      count: 1 + (r ? Number(r[1]) : 0),
    });
  }
  return { rows: fallback, source: 'errors.jsonl (fallback: one report per label per minute)' };
}

export function readBoots(observabilityDir: string): BootRow[] {
  const rows: BootRow[] = [];
  for (const e of jsonLines(path.join(observabilityDir, 'perf', 'boot.jsonl'))) {
    if (typeof e.bootId !== 'string' || typeof e.ms !== 'number') continue;
    rows.push({
      bootId: e.bootId,
      source: String(e.source ?? 'backend'),
      phase: String(e.phase),
      ms: e.ms,
      atMs: Date.parse(e.at),
    });
  }
  return rows;
}

export function readRoutes(observabilityDir: string): RouteRow[] {
  const rows: RouteRow[] = [];
  for (const e of jsonLines(path.join(observabilityDir, 'perf', 'routes.jsonl'))) {
    if (typeof e.p90 !== 'number') continue;
    rows.push({
      atMs: Date.parse(e.at),
      method: String(e.method),
      route: String(e.route),
      count: Number(e.count),
      p50: e.p50,
      p90: e.p90,
      max: e.max,
    });
  }
  return rows;
}

// ---------- statistics ----------

export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export interface BootComparison {
  latestBootId: string;
  rows: { key: string; latest: number; medianPrevious: number | null }[];
  previousBoots: number;
}

/** Latest boot's time per `source:phase` against the median of earlier boots. */
export function compareBoots(rows: BootRow[]): BootComparison | null {
  if (rows.length === 0) return null;
  const lastSeen = new Map<string, number>();
  for (const r of rows) lastSeen.set(r.bootId, Math.max(lastSeen.get(r.bootId) ?? 0, r.atMs));
  const ordered = [...lastSeen.entries()].sort((a, b) => a[1] - b[1]).map(([id]) => id);
  const latestBootId = ordered[ordered.length - 1];
  const perBoot = new Map<string, Map<string, number>>();
  for (const r of rows) {
    const phases = perBoot.get(r.bootId) ?? new Map<string, number>();
    const key = `${r.source}:${r.phase}`;
    phases.set(key, (phases.get(key) ?? 0) + r.ms);
    perBoot.set(r.bootId, phases);
  }
  const previous = ordered.slice(0, -1).map((id) => perBoot.get(id)!);
  const latest = perBoot.get(latestBootId)!;
  return {
    latestBootId,
    previousBoots: previous.length,
    rows: [...latest.entries()]
      .map(([key, ms]) => {
        const history = previous.flatMap((p) => (p.has(key) ? [p.get(key)!] : []));
        return { key, latest: ms, medianPrevious: history.length ? median(history) : null };
      })
      .sort((a, b) => b.latest - a.latest),
  };
}

export interface RouteSummary {
  key: string;
  count: number;
  p50: number;
  p90: number;
  worstMinuteP90: number;
  max: number;
}

/** Count-weighted p50/p90 across minutes (an approximation of the true percentile), worst first. */
export function summarizeRoutes(rows: RouteRow[]): RouteSummary[] {
  const by = new Map<string, RouteRow[]>();
  for (const r of rows)
    by.set(`${r.method} ${r.route}`, [...(by.get(`${r.method} ${r.route}`) ?? []), r]);
  return [...by.entries()]
    .map(([key, list]) => {
      const count = list.reduce((n, r) => n + r.count, 0);
      const weighted = (pick: (r: RouteRow) => number) =>
        list.reduce((n, r) => n + pick(r) * r.count, 0) / count;
      return {
        key,
        count,
        p50: weighted((r) => r.p50),
        p90: weighted((r) => r.p90),
        worstMinuteP90: Math.max(...list.map((r) => r.p90)),
        max: Math.max(...list.map((r) => r.max)),
      };
    })
    .sort((a, b) => b.worstMinuteP90 - a.worstMinuteP90);
}

export interface LabelSummary {
  label: string;
  stalls: number;
  maxMs: number;
}

export function topLabels(rows: StallRow[]): LabelSummary[] {
  const by = new Map<string, LabelSummary>();
  for (const r of rows) {
    const s = by.get(r.label) ?? { label: r.label, stalls: 0, maxMs: 0 };
    s.stalls += r.count;
    s.maxMs = Math.max(s.maxMs, r.ms);
    by.set(r.label, s);
  }
  return [...by.values()].sort((a, b) => b.stalls - a.stalls || b.maxMs - a.maxMs);
}

/** Startup-window stalls per boot from errors.jsonl, for boots from before boot.jsonl existed. */
export function estimateBootsFromErrors(observabilityDir: string) {
  const boots = new Map<
    string,
    { startedAtMs: number; stalls: number; sumMs: number; maxMs: number; lastAtMs: number }
  >();
  for (const e of jsonLines(path.join(observabilityDir, 'errors.jsonl'))) {
    const m = ERROR_STALL.exec(e.message ?? '');
    if (e.component !== 'event-loop' || !m || m[2] !== 'startup' || !e.serverBootId) continue;
    const started = /started (\d+)ms before/.exec(e.message);
    const at = Date.parse(e.timestamp);
    const b = boots.get(e.serverBootId) ?? {
      startedAtMs: at - Number(started?.[1] ?? 0),
      stalls: 0,
      sumMs: 0,
      maxMs: 0,
      lastAtMs: at,
    };
    b.stalls += 1;
    b.sumMs += Number(m[1]);
    b.maxMs = Math.max(b.maxMs, Number(m[1]));
    b.lastAtMs = at;
    boots.set(e.serverBootId, b);
  }
  return [...boots.entries()].sort((a, b) => a[1].startedAtMs - b[1].startedAtMs).slice(-10);
}

// ---------- machine + disk ----------

const run = (cmd: string, args: string[]): string => {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', timeout: 10_000 });
  } catch {
    return '';
  }
};

export function collectMachine(): MachineSnapshot {
  const vm = run('vm_stat', []);
  const pageSize = Number(/page size of (\d+) bytes/.exec(vm)?.[1] ?? 16384);
  const pages = (name: string) => Number(new RegExp(`${name}:\\s+(\\d+)`).exec(vm)?.[1] ?? 0);
  const swap = run('sysctl', ['-n', 'vm.swapusage']);
  const mb = (name: string) => Number(new RegExp(`${name} = ([\\d.]+)M`).exec(swap)?.[1] ?? 0);
  const names = run('ps', ['-axo', 'comm='])
    .split('\n')
    .map((l) => path.basename(l.trim()));
  const count = (name: string) => names.filter((n) => n === name).length;
  return {
    load: os.loadavg() as [number, number, number],
    cpus: os.cpus().length,
    totalMemBytes: os.totalmem(),
    availableMemBytes:
      (pages('Pages free') + pages('Pages inactive') + pages('Pages speculative')) * pageSize,
    swapUsedMb: mb('used'),
    swapTotalMb: mb('total'),
    processes: { node: count('node'), codex: count('codex'), claude: count('claude') },
  };
}

/** Reasons to look at the machine before the code. Empty when it is not overloaded. */
export function checkFirst(m: MachineSnapshot): string[] {
  const notes: string[] = [];
  if (m.load[0] > m.cpus * 1.5)
    notes.push(
      `Load average ${m.load[0].toFixed(1)} is over 1.5x the ${m.cpus} cores: the CPU is saturated.`
    );
  if (m.swapUsedMb > 4096)
    notes.push(
      `Swap used is ${(m.swapUsedMb / 1024).toFixed(1)} GB: memory pressure makes every stall longer.`
    );
  if (m.availableMemBytes < m.totalMemBytes * 0.05)
    notes.push(
      `Only ${gb(m.availableMemBytes)} GB of ${gb(m.totalMemBytes)} GB memory is reclaimable.`
    );
  if (m.processes.node + m.processes.codex + m.processes.claude > 60)
    notes.push(
      `${m.processes.node} node, ${m.processes.codex} codex, ${m.processes.claude} claude processes: stray agents or dev servers compete for the CPU.`
    );
  return notes;
}

const gb = (bytes: number) => (bytes / 1024 ** 3).toFixed(1);

function duKb(target: string): number {
  return Number(run('du', ['-sk', target]).split('\t')[0]) || 0;
}

function dirGrowth(dir: string): { name: string; kb: number }[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .map((name) => ({ name, kb: duKb(path.join(dir, name)) }))
    .sort((a, b) => b.kb - a.kb)
    .slice(0, 12);
}

// ---------- report ----------

const fmtKb = (kb: number) =>
  kb >= 1024 ** 2
    ? `${(kb / 1024 ** 2).toFixed(1)} GB`
    : kb >= 1024
      ? `${(kb / 1024).toFixed(1)} MB`
      : `${kb} KB`;
const ms0 = (v: number) => `${Math.round(v)}`;

export interface ReportInput {
  dataDir: string;
  buddiesDir: string;
  nowMs: number;
  days: number;
  machine: MachineSnapshot;
}

export function buildReport(input: ReportInput): string {
  const obs = path.join(input.dataDir, 'observability');
  const sinceMs = input.nowMs - input.days * 86_400_000;
  const out: string[] = [
    `# Perf audit ${new Date(input.nowMs).toISOString()}`,
    '',
    `Data dir: \`${input.dataDir}\`, window: last ${input.days} day(s).`,
    '',
  ];

  const notes = checkFirst(input.machine);
  if (notes.length)
    out.push(
      '## Check first: the machine is overloaded',
      '',
      ...notes.map((n) => `- ${n}`),
      '',
      'Fix this before reading code-level findings below; they are inflated by it.',
      ''
    );

  // boot
  out.push('## Boot phases', '');
  const boots = compareBoots(readBoots(obs));
  if (boots) {
    out.push(
      `Latest boot \`${boots.latestBootId}\` vs median of ${boots.previousBoots} previous boot(s), ms.`,
      '',
      '| phase | latest | median previous | delta |',
      '|---|---:|---:|---:|'
    );
    for (const r of boots.rows)
      out.push(
        `| ${r.key} | ${ms0(r.latest)} | ${r.medianPrevious === null ? 'n/a' : ms0(r.medianPrevious)} | ${r.medianPrevious === null ? '' : (r.latest - r.medianPrevious >= 0 ? '+' : '') + ms0(r.latest - r.medianPrevious)} |`
      );
  } else {
    out.push(
      'No boot.jsonl yet. Estimate from startup-window stalls in errors.jsonl (last 10 boots):',
      '',
      '| boot started | startup stalls | sum ms | max ms | span s |',
      '|---|---:|---:|---:|---:|'
    );
    for (const [, b] of estimateBootsFromErrors(obs))
      out.push(
        `| ${new Date(b.startedAtMs).toISOString()} | ${b.stalls} | ${ms0(b.sumMs)} | ${ms0(b.maxMs)} | ${((b.lastAtMs - b.startedAtMs) / 1000).toFixed(1)} |`
      );
  }
  out.push('');

  // stalls
  const { rows: allStalls, source } = readStalls(obs);
  const stalls = allStalls.filter((s) => s.atMs >= sinceMs);
  out.push(
    '## Event-loop stalls',
    '',
    `Source: ${source}. ${stalls.reduce((n, s) => n + s.count, 0)} stalls of 100 ms or more in the window.`,
    ''
  );
  const bucket = (rows: StallRow[], slice: number) => {
    const m = new Map<string, { n: number; max: number }>();
    for (const r of rows) {
      const k = new Date(r.atMs).toISOString().slice(0, slice);
      const v = m.get(k) ?? { n: 0, max: 0 };
      m.set(k, { n: v.n + r.count, max: Math.max(v.max, r.ms) });
    }
    return [...m.entries()].sort();
  };
  out.push(
    '| day (UTC) | stalls | max ms |',
    '|---|---:|---:|',
    ...bucket(stalls, 10).map(([k, v]) => `| ${k} | ${v.n} | ${ms0(v.max)} |`),
    ''
  );
  out.push(
    'Last 24 h by hour (UTC):',
    '',
    '| hour | stalls | max ms |',
    '|---|---:|---:|',
    ...bucket(
      stalls.filter((s) => s.atMs >= input.nowMs - 86_400_000),
      13
    ).map(([k, v]) => `| ${k}:00 | ${v.n} | ${ms0(v.max)} |`),
    ''
  );
  out.push(
    'Top labels (prime suspects, not proof):',
    '',
    '| label | stalls | max ms |',
    '|---|---:|---:|',
    ...topLabels(stalls)
      .slice(0, 15)
      .map((l) => `| ${l.label.slice(0, 90)} | ${l.stalls} | ${ms0(l.maxMs)} |`),
    ''
  );

  // routes
  const routes = readRoutes(obs).filter((r) => r.atMs >= sinceMs);
  out.push('## Slowest routes', '');
  if (routes.length === 0)
    out.push('No routes.jsonl data yet (needs `routeLatencyMiddleware()` wired in server.ts).', '');
  else
    out.push(
      'Ranked by worst per-minute p90. p50/p90 are count-weighted across minutes (approximate).',
      '',
      '| route | requests | p50 ms | p90 ms | worst-minute p90 | max ms |',
      '|---|---:|---:|---:|---:|---:|',
      ...summarizeRoutes(routes)
        .slice(0, 15)
        .map(
          (r) =>
            `| ${r.key} | ${r.count} | ${ms0(r.p50)} | ${ms0(r.p90)} | ${ms0(r.worstMinuteP90)} | ${ms0(r.max)} |`
        ),
      ''
    );

  // profiles
  const profilesDir = path.join(obs, 'perf', 'profiles');
  out.push('## Recent CPU profiles', '');
  const profiles = (fs.existsSync(profilesDir) ? fs.readdirSync(profilesDir) : [])
    .filter((f) => f.endsWith('.cpuprofile'))
    .map((f) => ({ f, stat: fs.statSync(path.join(profilesDir, f)) }))
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)
    .slice(0, 10);
  out.push(
    ...(profiles.length
      ? profiles.map(
          (p) => `- \`${path.join(profilesDir, p.f)}\` (${fmtKb(Math.ceil(p.stat.size / 1024))})`
        )
      : [
          'None. `pnpm perf:profile` captures one; stalls of 500 ms or more capture one automatically.',
        ]),
    ''
  );

  // growth
  out.push('## Data growth', '');
  for (const dir of [input.dataDir, input.buddiesDir]) {
    out.push(
      `\`${dir}\` (largest entries; file sizes only, no SQLite opened):`,
      '',
      ...dirGrowth(dir).map((e) => `- ${e.name}: ${fmtKb(e.kb)}`),
      ''
    );
  }
  const executions = path.join(input.dataDir, 'executions');
  out.push(
    `Executions dir entries: ${fs.existsSync(executions) ? fs.readdirSync(executions).length : 0}`,
    ''
  );

  // machine
  const m = input.machine;
  out.push(
    '## Machine',
    '',
    `- Load average: ${m.load.map((v) => v.toFixed(2)).join(' / ')} on ${m.cpus} cores`,
    `- Memory: ${gb(m.availableMemBytes)} GB reclaimable of ${gb(m.totalMemBytes)} GB`,
    `- Swap: ${(m.swapUsedMb / 1024).toFixed(1)} GB used of ${(m.swapTotalMb / 1024).toFixed(1)} GB`,
    `- Processes: ${m.processes.node} node, ${m.processes.codex} codex, ${m.processes.claude} claude`,
    ''
  );
  return out.join('\n');
}

function main(): void {
  const args = process.argv.slice(2);
  const flag = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const dataDir = path.resolve(
    flag('--data-dir') ?? process.env.UNLEASHD_DATA_DIR ?? path.join(os.homedir(), '.agent-viewer')
  );
  const nowMs = Date.now();
  const report = buildReport({
    dataDir,
    buddiesDir: path.join(os.homedir(), '.buddies'),
    nowMs,
    days: Number(flag('--days') ?? 7),
    machine: collectMachine(),
  });
  const outDir = path.resolve(__dirname, '..', 'output', 'perf-audit');
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `${new Date(nowMs).toISOString().replace(/[:.]/g, '-')}.md`);
  fs.writeFileSync(file, report);
  process.stdout.write(`${file}\n`);
}

if (require.main === module) main();
