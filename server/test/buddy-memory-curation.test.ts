import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { type UnifiedAgentEvent, executeCommand } from '@nbardy/agent-cli';
import { BuddiesCore } from '@unleashd/buddies-core';
import { OWNER } from '../src/buddies/core';
import { createBuddyEvents } from '../src/buddies/events';
import { createGrants } from '../src/buddies/grants';
import { startMcpEndpoint } from '../src/buddies/mcp';
import {
  MEMORY_REVIEW_INSTRUCTIONS,
  MEMORY_REVIEW_MODELS,
  MEMORY_REVIEW_TIMEOUT_MS,
  type MemoryReviewReceipt,
  createMemoryReviewer,
} from '../src/buddies/memory-review';
import { TURN_MAX_RUNTIME_MS } from '../src/constants/timeouts';
import { redactAndBound } from '../src/observability/error-journal';
import {
  CURATION_CASES,
  type CurationCase,
  type CurationCheck,
  type MemoryDoc,
} from './fixtures/memory-curation/cases';
import { BackgroundWork } from '../src/turns/background-work';

// One per test backend, as in server.ts: the hook route and the channel status read it.
const backgroundWork = new BackgroundWork();

// LIVE memory-relevance benchmark: the production reviewer (real executeCommand, real ladder,
// real MCP endpoint, real BuddiesCore on a temp DB) on each synthetic case. It makes real model
// calls, so it is skipped unless UNLEASHD_LIVE_MEMORY_CURATION=1. Runbook and grading rules:
// server/test/fixtures/memory-curation/README.md. A skipped run is not a benchmark pass.

const LIVE = process.env.UNLEASHD_LIVE_MEMORY_CURATION === '1';
const CASES_FILE = join(__dirname, 'fixtures/memory-curation/cases.ts');
/** Worst case a review climbs every rung, each to its own timeout. */
const REVIEW_BUDGET_MS = MEMORY_REVIEW_TIMEOUT_MS * MEMORY_REVIEW_MODELS.length + 60_000;

// ---- the plan: env parsed once, at the boundary ------------------------------------------------

interface Plan {
  cases: CurationCase[];
  repeats: number;
  resultsDir: string;
}

function parsePlan(env: NodeJS.ProcessEnv): Plan {
  const only = env.UNLEASHD_MEMORY_CURATION_CASE;
  const cases = only ? CURATION_CASES.filter((c) => c.id === only) : CURATION_CASES;
  if (cases.length === 0) throw new Error(`UNLEASHD_MEMORY_CURATION_CASE: no case "${only}"`);
  const repeats = Number(env.UNLEASHD_MEMORY_CURATION_REPEATS ?? '2');
  if (![1, 2, 3].includes(repeats))
    throw new Error('UNLEASHD_MEMORY_CURATION_REPEATS must be 1, 2 or 3');
  const resultsDir =
    env.UNLEASHD_MEMORY_CURATION_RESULTS ?? mkdtempSync(join(tmpdir(), 'memory-curation-'));
  mkdirSync(resultsDir, { recursive: true });
  return { cases, repeats, resultsDir };
}

// ---- verdicts: one handler per check kind -----------------------------------------------------

interface DocState {
  content: string;
  revision: number;
}
type Snapshot = Record<'soul' | MemoryDoc, DocState>;
interface Verdict {
  check: string;
  pass: boolean;
  detail: string;
}

const matches = (text: string, pattern: string) =>
  (text.match(new RegExp(pattern, 'gi')) ?? []).length;

function judge(check: CurationCheck, before: Snapshot, after: Snapshot, report: string): Verdict {
  const name = JSON.stringify(check);
  switch (check.kind) {
    case 'noWrites':
      return {
        check: name,
        pass:
          after.working.revision === before.working.revision &&
          after.long_term.revision === before.long_term.revision,
        detail: `working r${before.working.revision}->r${after.working.revision}, long_term r${before.long_term.revision}->r${after.long_term.revision}`,
      };
    case 'unchanged':
      return {
        check: name,
        pass: after[check.doc].revision === before[check.doc].revision,
        detail: `r${before[check.doc].revision}->r${after[check.doc].revision}`,
      };
    case 'includes':
      return {
        check: name,
        pass: matches(after[check.doc].content, check.pattern) > 0,
        detail: `${matches(after[check.doc].content, check.pattern)} matches`,
      };
    case 'excludes':
      return {
        check: name,
        pass: matches(after[check.doc].content, check.pattern) === 0,
        detail: `${matches(after[check.doc].content, check.pattern)} matches`,
      };
    case 'occursOnce':
      return {
        check: name,
        pass: matches(after[check.doc].content, check.pattern) === 1,
        detail: `${matches(after[check.doc].content, check.pattern)} matches`,
      };
    case 'reportsNone':
      return { check: name, pass: /\bNONE\b/.test(report), detail: report.slice(-200) };
  }
}

/** Every case: soul untouched, both docs within their caps. */
function invariants(before: Snapshot, after: Snapshot): Verdict[] {
  return [
    {
      check: 'soulUnchanged',
      pass: after.soul.revision === before.soul.revision,
      detail: `r${before.soul.revision}->r${after.soul.revision}`,
    },
    {
      check: 'withinLimits',
      pass: after.working.content.length <= 2000 && after.long_term.content.length <= 4000,
      detail: `working ${after.working.content.length}/2000, long_term ${after.long_term.content.length}/4000`,
    },
  ];
}

// ---- one run ----------------------------------------------------------------------------------

/** What one ladder rung streamed: its final text is the reviewer's report. */
interface Rung {
  harness: string;
  model: string;
  text: string;
  stderr: string;
  tools: Array<{ name: string; input: unknown }>;
}

type RunResult =
  | {
      kind: 'reviewed';
      receipt: MemoryReviewReceipt;
      before: Snapshot;
      after: Snapshot;
      rungs: Rung[];
      report: string;
      verdicts: Verdict[];
    }
  /** Setup crash (receipt null) or a review that did not complete. Never a semantic grade. */
  | { kind: 'infra'; error: string; receipt: MemoryReviewReceipt | null; rungs: Rung[] };

async function snapshot(core: BuddiesCore, buddyId: string): Promise<Snapshot> {
  const read = async (kind: 'soul' | MemoryDoc): Promise<DocState> => {
    const doc = await core.readDoc(OWNER, { buddyId, scope: { kind: 'buddy' }, kind, name: '' });
    return { content: doc?.content ?? '', revision: doc?.revision ?? 0 };
  };
  return {
    soul: await read('soul'),
    working: await read('working'),
    long_term: await read('long_term'),
  };
}

async function runCase(c: CurationCase, repeat: number, warnings: string[]): Promise<RunResult> {
  const scratch = mkdtempSync(join(tmpdir(), `memory-curation-${c.id}-`));
  const root = join(scratch, 'workspace');
  mkdirSync(root);
  for (const [file, content] of Object.entries(c.files ?? {})) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), content);
  }
  const core = await BuddiesCore.open(join(scratch, 'db.sqlite'));
  const ws = (await core.createWorkspace(OWNER, { name: 'Bench', rootPath: root })).id;
  const buddy = await core.createBuddy(OWNER, {
    workspaceId: ws,
    slug: 'lead',
    name: 'Lead',
    role: 'Engineering lead for this workspace',
    manager: { kind: 'nobody' },
    key: 'lead',
  });
  const seeds: Array<[MemoryDoc | 'soul', string]> = [
    ['soul', 'You are Lead, a careful engineering Buddy who reports evidence, not guesses.'],
    ['working', c.working],
    ['long_term', c.longTerm],
  ];
  for (const [kind, content] of seeds.filter(([, content]) => content)) {
    await core.writeDoc(OWNER, {
      doc: { buddyId: buddy.id, scope: { kind: 'buddy' }, kind, name: '' },
      content,
      baseRevision: 0,
      reason: 'benchmark seed',
      key: `seed-${kind}`,
    });
  }
  const before = await snapshot(core, buddy.id);
  const grants = createGrants({ ttlMs: TURN_MAX_RUNTIME_MS });
  const endpoint = await startMcpEndpoint({
    backgroundWork,
    core,
    events: createBuddyEvents(),
    grants,
    uploadsRoot: () => scratch,
    messages: async () => null,
    openBranch: async () => {
      throw new Error('no owner chats in this test');
    },
    portFile: join(scratch, 'buddy-mcp.json'),
  });
  const rungs: Rung[] = [];
  // The real executeCommand; the tee only records what each rung streamed.
  const execute: typeof executeCommand = (request) => {
    const handle = executeCommand(request);
    const rung: Rung = {
      harness: request.harness,
      model: String(request.model),
      text: '',
      stderr: '',
      tools: [],
    };
    rungs.push(rung);
    async function* tee(events: AsyncIterable<UnifiedAgentEvent>) {
      try {
        for await (const event of events) {
          if (event.type === 'text.delta') rung.text += event.text;
          if (event.type === 'stderr') rung.stderr = (rung.stderr + event.text).slice(-8000);
          if (event.type === 'tool.use') rung.tools.push({ name: event.name, input: event.input });
          yield event;
        }
      } finally {
        rung.stderr = redactAndBound(rung.stderr, 8000);
      }
    }
    return { ...handle, events: tee(handle.events) };
  };
  const reviewer = createMemoryReviewer({
    core,
    grants,
    spec: endpoint.spec,
    execute,
    concurrency: 1,
    logger: { warn: (...args: unknown[]) => void warnings.push(args.map(String).join(' ')) },
  });
  try {
    reviewer.start();
    reviewer.enqueue({
      attemptId: `bench-${repeat}`,
      conversationId: `bench-${c.id}-${repeat}`,
      context: { buddyId: buddy.id, workspaceId: ws, coordinationRunId: `run-${c.id}` },
      completedAt: new Date().toISOString(),
      messages: c.messages,
    });
    const deadline = Date.now() + REVIEW_BUDGET_MS;
    let event = (await core.listEvents(buddy.id, Number.MAX_SAFE_INTEGER, 20)).find(
      (e) => e.op === 'memory_review'
    );
    while (!event) {
      if (Date.now() > deadline) throw new Error('no memory_review receipt before the budget');
      await new Promise((resolve) => setTimeout(resolve, 500));
      event = (await core.listEvents(buddy.id, Number.MAX_SAFE_INTEGER, 20)).find(
        (e) => e.op === 'memory_review'
      );
    }
    const receipt = JSON.parse(event.payload) as MemoryReviewReceipt;
    if (receipt.status !== 'complete')
      return { kind: 'infra', error: receipt.error ?? receipt.status, receipt, rungs };
    const after = await snapshot(core, buddy.id);
    const report = rungs.at(-1)?.text ?? '';
    const verdicts = [
      ...invariants(before, after),
      ...c.checks.map((check) => judge(check, before, after, report)),
    ];
    return { kind: 'reviewed', receipt, before, after, rungs, report, verdicts };
  } finally {
    reviewer.stop();
    await endpoint.close();
    rmSync(scratch, { recursive: true, force: true });
  }
}

// ---- the benchmark ----------------------------------------------------------------------------

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

test(
  'memory curation benchmark (live)',
  {
    skip: LIVE ? false : 'set UNLEASHD_LIVE_MEMORY_CURATION=1 to run (real model calls)',
    concurrency: 2,
  },
  async (t) => {
    const plan = parsePlan(process.env);
    const provenance = {
      commit: execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim(),
      dirty: execSync('git status --porcelain', { encoding: 'utf8' }).trim() !== '',
      instructionsSha256: sha256(MEMORY_REVIEW_INSTRUCTIONS),
      casesSha256: sha256(readFileSync(CASES_FILE, 'utf8')),
      harnessSha256: sha256(readFileSync(__filename, 'utf8')),
      ladder: MEMORY_REVIEW_MODELS,
      rungTimeoutMs: MEMORY_REVIEW_TIMEOUT_MS,
    };
    t.diagnostic(`results: ${plan.resultsDir}`);
    const rows: Array<{ case: string; repeat: number; outcome: string }> = [];
    const runs = plan.cases.flatMap((c) =>
      Array.from({ length: plan.repeats }, (_, i) => ({ c, repeat: i + 1 }))
    );
    await Promise.all(
      runs.map(({ c, repeat }) =>
        t.test(`${c.id} #${repeat}`, { timeout: REVIEW_BUDGET_MS + 60_000 }, async () => {
          const warnings: string[] = [];
          const startedAt = new Date().toISOString();
          // A setup crash is an infra result too: recorded, never dropped.
          const result = await runCase(c, repeat, warnings).catch(
            (error): RunResult => ({
              kind: 'infra',
              error: String(error),
              receipt: null,
              rungs: [],
            })
          );
          const failed = result.kind === 'reviewed' ? result.verdicts.filter((v) => !v.pass) : [];
          rows.push({
            case: c.id,
            repeat,
            outcome:
              result.kind === 'infra' ? 'infra' : failed.length ? 'checks-failed' : 'checks-passed',
          });
          writeFileSync(
            join(plan.resultsDir, `${c.id}.r${repeat}.json`),
            JSON.stringify(
              { case: c.id, repeat, startedAt, provenance, input: c, warnings, result },
              null,
              2
            )
          );
          // Saved first; assertions after. Rubric lines are graded manually from the JSON.
          assert.equal(result.kind, 'reviewed', result.kind === 'infra' ? result.error : '');
          assert.deepEqual(failed, [], `${c.id} #${repeat} failed checks`);
        })
      )
    );
    writeFileSync(
      join(plan.resultsDir, 'summary.json'),
      JSON.stringify({ provenance, repeats: plan.repeats, rows }, null, 2)
    );
  }
);
