/**
 * Case 7 — Straightforward CRUD SaaS: plan ahead, fan out per slice, integrate serially.
 *
 * Shape: one schema step (narrow, owns the one type source) → owner signs the plan → waves of
 * slices (wide) → each slice: implement → machine checks → cross-provider review → serial
 * integrate → screenshots → owner walkthrough. The plan is fixed at launch, so there is no
 * roundLoop and no watcher: this is the one case a fixed script is enough for (use-cases §7).
 * Scaling: wide only across slices, which are decomposable and machine-verified (rules 1, 2).
 * Each slice is width 1 because one agent already passes most CRUD slices first try (rule 5);
 * width appears only to repair a slice that failed its checks, via x.sample on gauge 'machine'.
 * Fixes the theory-fork merge mess: workers are fenced to their own slice directories, only the
 * schema step may touch the shared type file, and nothing lands except through x.integrate.
 */
import { z } from 'zod';
import { expedition } from '../expedition';

// The owner named no target repo (use-cases §7). This path is a placeholder for the new app.
const REPO = '~/git/invoicer';
const TYPES = 'shared/src/schema.ts'; // one type source (docs/patterns.md#one-type-source)

// The plan, fixed at launch. Wave 2 depends on wave 1's tables; slices inside a wave do not.
const WAVES = [
  ['auth', 'customers', 'projects'],
  ['invoices', 'payments', 'team-settings'],
] as const;
type Slice = (typeof WAVES)[number][number];

const Built = z.object({
  sha: z.string(),
  routes: z.array(z.string()),
  tests: z.array(z.string()),
});
const Review = z.object({ pass: z.boolean(), why: z.string() });
type BuiltT = z.infer<typeof Built>;

export default expedition({
  name: 'invoicer-crud-v1',
  userGoal:
    'Build the invoicing app: customers, projects, invoices, payments, team settings, with auth. ' +
    'Plan it first, fan the work out, and show me a walkthrough I can click through before I accept it.',
  objective: {
    criteria: [
      { kind: 'check', id: 'typecheck', run: 'pnpm typecheck', pool: 'cpu' },
      { kind: 'check', id: 'unit', run: 'pnpm test', pool: 'cpu' },
      // Does not exist yet: reads docs/plan.json and runs each slice's integration test through the real HTTP + DB boundary.
      {
        kind: 'check',
        id: 'features',
        run: 'node tools/check-planned-features.mjs --plan docs/plan.json',
        pool: 'browser',
      },
      {
        kind: 'judged',
        id: 'conventions',
        rubric:
          'All slices follow docs/conventions.md: one schema source, same route/error/form shapes.',
        judge: 'codex',
        pass: 0.85,
      },
      { kind: 'owner', id: 'walkthrough', ask: 'Click through the walkthrough. Do you accept v1?' },
    ],
  },
  repo: { path: REPO },
  budget: { usd: 80, hours: 10 },
  pools: {
    opus: {
      kind: 'agent',
      seat: { provider: 'claude', model: 'claude-opus-5-5', effort: 'high' },
      slots: 1,
    },
    sonnet: {
      kind: 'agent',
      seat: { provider: 'claude', model: 'claude-sonnet-5-5', effort: 'medium' },
      slots: 4,
    },
    codex: {
      kind: 'agent',
      seat: { provider: 'codex', model: 'gpt-6.1-sol', effort: 'high' },
      slots: 2,
    },
    cpu: { kind: 'local', slots: 3, lock: null },
    // Integration tests and screenshots share one Postgres + one headless Chrome.
    browser: { kind: 'local', slots: 1, lock: 'invoicer-e2e' },
  },
  rules: [
    `Only the schema step edits ${TYPES} and migrations/. Slices import types from it, never redefine them.`,
    'Integration tests go through the real HTTP + DB boundary; no mock-heavy units (docs/test-strategy.md).',
    'No deploy, no paid services, no new dependencies without a note saying why.',
  ],

  async run(x) {
    // 1. Schema + conventions: narrow, one deep agent owns the shared seam.
    const schema = await x.agent({
      key: 'schema',
      pool: 'opus',
      prompt:
        `Write ${TYPES}, the migrations, docs/conventions.md and docs/plan.json (one entry per slice: ` +
        `routes, screens, integration test name) for slices ${WAVES.flat().join(', ')}. Commit.`,
      output: z.object({ sha: z.string(), conventions: z.array(z.string()) }),
      workspace: {
        kind: 'worktree',
        base: 'origin-default',
        fence: [TYPES, 'migrations/', 'docs/'],
      },
      alsoHolds: ['cpu'], // it runs `pnpm typecheck` + migrations itself while iterating
      usd: 8,
    });
    if (schema.kind !== 'ok') return x.log(`schema step ${schema.kind}; nothing to fan out`);
    await x.notebook.add(
      schema.value.conventions.map((text, i) => ({
        kind: 'note' as const,
        id: `conv-${i}`,
        text,
        claim: 'verified' as const,
        sources: ['docs/conventions.md'],
      }))
    );
    const landed = await x.integrate({
      key: 'land-schema',
      sha: schema.value.sha,
      recheck: [
        {
          key: 'schema-tc',
          pool: 'cpu',
          run: 'pnpm typecheck && pnpm db:migrate --dry-run',
          at: { sha: schema.value.sha },
          seconds: 300,
        },
      ],
    });
    if (landed.kind !== 'integrated') return x.log(`schema did not land: ${landed.kind}`);

    // 2. Owner signs the plan before $60 of fan-out. Holds no slot; unanswered is not a yes.
    const go = await x.ask({
      key: 'plan-ok',
      question: `Plan at ${landed.sha} (docs/plan.json). Fan out?`,
      answer: z.boolean(),
    });
    if (go.kind !== 'answered' || !go.value) return x.log('plan not approved');
    let head = landed.sha;

    // 3. One slice: implement (width 1) → checks → repair by verified search only on failure.
    const checksFor = (s: Slice, sha: string) => [
      {
        key: `tc-${s}-${sha}`,
        pool: 'cpu' as const,
        run: 'pnpm typecheck && pnpm test',
        at: { sha },
        seconds: 600,
      },
      {
        key: `it-${s}-${sha}`,
        pool: 'browser' as const,
        run: `pnpm test:integration --grep ${s}`,
        at: { sha },
        seconds: 600,
      },
    ];
    const implement = (s: Slice, base: string, why: string) => ({
      pool: 'sonnet' as const,
      alsoHolds: ['cpu' as const],
      prompt: `Implement slice "${s}" from docs/plan.json: API routes, UI screens, and its integration test. ${why}`,
      context: [{ kind: 'all' as const, rowKind: 'note' as const }],
      output: Built,
      workspace: {
        kind: 'worktree' as const,
        base: { sha: base },
        fence: [`server/src/${s}/`, `client/src/${s}/`, `test/${s}/`],
      },
      usd: 4,
    });
    const passes = async (s: Slice, sha: string) =>
      (await x.parallel(checksFor(s, sha).map((c) => () => x.check(c)))).every(
        (r) => r.kind === 'pass'
      );

    const build = async (s: Slice, base: string): Promise<BuiltT | null> => {
      const first = await x.agent({ key: `impl-${s}`, ...implement(s, base, '') });
      if (first.kind === 'ok' && (await passes(s, first.value.sha))) return first.value;
      const repair = await x.sample<BuiltT>({
        key: `repair-${s}`,
        family: `slice-${s}`,
        gauge: 'machine',
        want: 3,
        make: () =>
          implement(
            s,
            base,
            'A first attempt failed its checks; start clean and read the notebook.'
          ),
        // One CheckSpec per verify, so the three checks run as one command on the e2e pool.
        verify: (b) => ({
          key: `v-${s}-${b.sha}`,
          pool: 'browser',
          run: `pnpm typecheck && pnpm test && pnpm test:integration --grep ${s}`,
          at: { sha: b.sha },
          seconds: 900,
        }),
      });
      x.log(
        `repair ${s}: granted ${repair.granted} (${repair.narrowedBy}), kept ${repair.kept.length}`
      );
      return repair.kept.length > 0 ? repair.kept[0].value : null;
    };

    // 4. Waves: slices fan out inside a wave; integration is serial; review is cross-provider.
    for (const wave of WAVES) {
      const base = head;
      const built = await x.parallel(wave.map((s) => () => build(s, base)));
      for (const [i, b] of built.entries()) {
        const s = wave[i];
        if (b === null) {
          await x.notebook.add([
            {
              kind: 'note',
              id: `gap-${s}`,
              text: `${s} failed checks after repair`,
              claim: 'verified',
              sources: [],
            },
          ]);
          continue;
        }
        const review = await x.agent({
          key: `review-${s}`,
          pool: 'codex',
          output: Review,
          usd: 1.5,
          prompt: `Review slice ${s} at ${b.sha} against docs/conventions.md. Fail on a redefined type or a mocked boundary.`,
          workspace: {
            kind: 'read-only',
            paths: [`server/src/${s}/`, `client/src/${s}/`, `test/${s}/`, TYPES],
          },
        });
        const ok = review.kind === 'ok' && review.value.pass;
        const merged = ok
          ? await x.integrate({ key: `land-${s}`, sha: b.sha, recheck: checksFor(s, b.sha) })
          : null;
        // API GAP: no slice-status row kind (selected/implementing/reviewed/validated/integrated, use-cases §10.17); 'result' carries a 3-value verdict.
        await x.notebook.add([
          {
            kind: 'result',
            id: `slice-${s}`,
            ideaId: `slice-${s}`,
            sha: b.sha,
            verdict: merged?.kind === 'integrated' ? 'keep' : 'reject',
            evidence:
              review.kind === 'ok'
                ? `${review.value.why} | ${merged?.kind ?? 'not merged'}`
                : `review ${review.kind}`,
          },
        ]);
        if (merged?.kind === 'integrated') head = merged.sha;
      }
    }

    // 5. Walkthrough: screenshots of every planned screen on the integrated head, then finish.
    // Does not exist yet: tools/screenshots.mjs in the target repo, modeled on buddies' `pnpm screenshots`.
    const shots = await x.check({
      key: 'shots',
      pool: 'browser',
      run: 'node tools/screenshots.mjs --plan docs/plan.json --out output/walkthrough',
      at: { sha: head },
      seconds: 900,
    });
    const gaps = (await x.notebook.read({ kind: 'all', rowKind: 'note' })).filter(
      (r) => r.kind === 'note' && r.id.startsWith('gap-')
    );
    // API GAP: finish takes a text report; the owner's walkthrough (screenshots, a running preview URL) can only be named as paths.
    const done = await x.finish({
      sha: head,
      report:
        `Integrated at ${head}. Walkthrough: output/walkthrough/index.html (${shots.kind}). ` +
        `Gaps: ${gaps.length === 0 ? 'none' : gaps.map((g) => g.id).join(', ')}.`,
    });
    switch (done.kind) {
      case 'met':
        return x.log(`accepted at ${done.sha}`);
      case 'not-met':
        return x.log(`not met: ${done.failing.join(', ')}`);
      case 'owner-declined':
        return x.log(`owner declined: ${done.why}`);
    }
  },
});
