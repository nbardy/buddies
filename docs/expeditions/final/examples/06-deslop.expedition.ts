/**
 * Case 6 — Deslop buddies: unify the data model and types, shrink the code.
 *
 * Shape: measure (wide read-only scans, checked by a script) → one lean target with line
 * budgets (narrow) → owner signs target and keep pins → revisable rounds, one wave of
 * file-fenced slices per round → serial integration on the merged commit → finish.
 * Scaling: wide only where pieces are independent: the ten scans, and the slices of one wave,
 * whose fences are disjoint (rule 1). The target and every cross-file seam stay width 1. Each
 * slice is gauged by machine (typecheck + tests on its commit) and gets a 2nd attempt only
 * when the plan marks it hard; one sonnet already lands most slices (rules 2, 5).
 * Prevents: 48724f4 (half-applied commit verified green on the dirty tree: every check runs on
 * a commit); hunks captured through a shared file (fences + serial integrate); the importer that
 * counted 0 and passed (loc refuses 0 files); "3–4× not achieved" closing quietly (frozen metric).
 */
import { z } from 'zod';
import { expedition } from '../expedition';
import { roundLoop } from '../lib/round-loop';

// tools/deslop/* do not exist yet (written before launch). loc.mjs prints {sha, sourceLines, testLines} and
// exits non-zero on 0 files; inventory.mjs derives owners from source; screens-at.mjs runs `pnpm screenshots
// --baseline` against a throwaway server on copied stores (execution disabled).
const [LOC, INVENTORY] = [
  'node tools/deslop/loc.mjs --json',
  'node tools/deslop/inventory.mjs --json',
];
const [BASELINE, NOTES] = ['output/screenshots/deslop-baseline', 'agent_notes/2026-11-10_deslop'];

// One slice = "replace and delete one redundant path"; `preserve` = behaviors real consumers keep; `netLines` = budget.
const Slice = z.object({
  id: z.string(),
  fence: z.array(z.string()),
  replace: z.string(),
  delete: z.array(z.string()),
  preserve: z.array(z.string()),
  netLines: z.number(),
  hard: z.boolean(),
});
const Plan = z.object({ waves: z.array(z.object({ id: z.string(), slices: z.array(Slice) })) });
const Landed = z.object({ sha: z.string(), deleted: z.array(z.string()), netLines: z.number() });
const Verdict = z.object({ pass: z.boolean(), why: z.string() });
const Loc = z.object({ sha: z.string(), sourceLines: z.number() });

export default expedition({
  name: 'deslop-buddies-data-model',
  userGoal:
    'Deslop buddies: one canonical owner per fact, unify the types, delete the superseded paths, ' +
    'and actually get the line cut this time without breaking anything I use.',
  objective: {
    criteria: [
      { kind: 'check', id: 'typecheck', run: 'pnpm typecheck', pool: 'cpu' },
      {
        kind: 'check',
        id: 'tests',
        run: 'pnpm test:server && pnpm test:client && pnpm test:tools',
        pool: 'cpu',
      },
      {
        kind: 'check',
        id: 'invariants',
        run: 'bash tools/check-client-invariants.sh',
        pool: 'cpu',
      },
      {
        kind: 'check',
        id: 'screens',
        run: `node tools/deslop/screens-at.mjs ${BASELINE}`,
        pool: 'screens',
      },
      // 99,841 after the lean rewrite; 1.5× more is the bound the owner signed, tests counted apart.
      {
        kind: 'metric',
        id: 'source-lines',
        run: LOC,
        pool: 'cpu',
        field: 'sourceLines',
        op: '<=',
        bound: 66_000,
      },
      {
        kind: 'metric',
        id: 'one-owner',
        run: INVENTORY,
        pool: 'cpu',
        field: 'competingOwners',
        op: '<=',
        bound: 0,
      },
      {
        kind: 'metric',
        id: 'retired',
        run: INVENTORY,
        pool: 'cpu',
        field: 'unretiredInterfaces',
        op: '<=',
        bound: 0,
      },
      {
        kind: 'judged',
        id: 'parity',
        rubric:
          'Every preserved behavior in the slice notes still holds through a real consumer; no deleted path had a live reader.',
        judge: 'codex',
        pass: 0.9,
      },
      { kind: 'owner', id: 'owner-keeps', ask: 'Does everything you use still behave the same?' },
    ],
  },
  repo: { path: '~/git/buddies' },
  budget: { usd: 400, hours: 36 },
  pools: {
    opus: {
      kind: 'agent',
      seat: { provider: 'claude', model: 'claude-opus-5-5', effort: 'high' },
      slots: 2,
    },
    sonnet: {
      kind: 'agent',
      seat: { provider: 'claude', model: 'claude-sonnet-5-5', effort: 'medium' },
      slots: 6,
    },
    haiku: {
      kind: 'agent',
      seat: { provider: 'claude', model: 'claude-haiku-5', effort: 'low' },
      slots: 10,
    },
    codex: {
      kind: 'agent',
      seat: { provider: 'codex', model: 'gpt-6.1-sol', effort: 'high' },
      slots: 2,
    },
    cpu: { kind: 'local', slots: 4, lock: null }, // shared machine: concurrent sessions run here too
    cargo: { kind: 'local', slots: 1, lock: 'cargo-build' }, // machine-wide compile lock
    screens: { kind: 'local', slots: 1, lock: 'screenshots' },
  },
  rules: [
    'Verify the commit, never the working tree. Never stash, reset --hard or force-push.',
    'A new interface without retirement is preparatory work, not a simplification.',
    'Never open ~/.buddies or ~/.agent-viewer stores; reproduce on temp stores.',
    'Delete superseded tests with their paths; report source and test deltas separately.',
  ],

  async run(x) {
    // 1. Measure: ten read-only scans (wide), then the inventory script decides what is verified.
    const areas = ['conversations', 'turns', 'buddies', 'ingest', 'transport']
      .map((d) => `server/src/${d}`)
      .concat([
        'shared/src',
        'client/src/atoms',
        'client/src/components',
        'client/src/mobile',
        'crates',
      ]);
    await x.parallel(
      areas.map(
        (a) => () =>
          x
            .agent({
              key: `scan-${a}`,
              pool: 'haiku',
              usd: 0.5,
              prompt: `List every type/fact in ${a} with a competing definition elsewhere: definitions, writers, readers.`,
              output: z.object({
                facts: z.array(z.object({ fact: z.string(), owners: z.array(z.string()) })),
              }),
              workspace: { kind: 'read-only', paths: [a] },
            })
            .then(
              async (r) =>
                r.kind === 'ok' &&
                x.notebook.add(
                  r.value.facts.map((f, i) => ({
                    kind: 'note' as const,
                    id: `scan-${a}-${i}`,
                    text: `${f.fact}: ${f.owners.join(', ')}`,
                    claim: 'claimed' as const,
                    sources: f.owners,
                  }))
                )
            )
      )
    );
    const [loc, shots] = await x.parallel([
      () => x.check({ key: 'loc-0', pool: 'cpu', run: LOC, at: 'origin-default', seconds: 120 }),
      () =>
        x.check({
          key: 'shots-0',
          pool: 'screens',
          run: `node tools/deslop/screens-at.mjs --capture ${BASELINE}`,
          at: 'origin-default',
          seconds: 900,
        }),
    ]);
    const base = Loc.safeParse(loc.kind === 'pass' ? loc.report : null);
    if (!base.success || shots.kind !== 'pass')
      return x.log(`baseline failed: loc ${loc.kind}, screens ${shots.kind}`);

    // 2. Target: one deep call writes budgets and waves with disjoint fences. Narrow.
    const target = await x.agent({
      key: 'target',
      pool: 'opus',
      usd: 15,
      prompt:
        `Inventory: \`${INVENTORY}\` is ground truth; scans are leads. Write ${NOTES}/TARGET.md: one canonical owner ` +
        `per fact, line budgets per area from ${base.data.sourceLines} source lines, and waves of slices whose fences ` +
        'never overlap within a wave. Cross-file seams go in a later wave. Commit it.',
      context: [
        { kind: 'all', rowKind: 'note' },
        { kind: 'all', rowKind: 'owner' },
      ],
      output: z.object({ plan: Plan, sha: z.string() }),
      workspace: { kind: 'worktree', base: 'origin-default', fence: [NOTES] },
    });
    if (target.kind !== 'ok') return x.log(`target failed: ${target.kind}`);

    // 3. Owner gate: holds no slot. Unanswered is not a yes.
    const signed = await x.ask({
      key: 'sign-target',
      question: `Target at ${target.value.sha}. Approve, and list anything that must be kept as-is.`,
      answer: z.object({ approve: z.boolean(), keep: z.array(z.string()) }),
    });
    if (signed.kind === 'unanswered' || !signed.value.approve) return x.log('target not approved');
    await x.notebook.add(
      signed.value.keep.map((k, i) => ({
        kind: 'owner' as const,
        id: `keep-${i}`,
        text: `KEEP: ${k}`,
      }))
    );

    // 4. Rounds: one wave per round, revisable by the leader between waves.
    let head = base.data.sha;
    const done = new Set<string>();
    // API GAP: integrate rechecks "the merged commit", but CheckSpec.at is required; 'origin-default' here is a
    // placeholder the host must override. A Recheck type without `at` would say what actually happens.
    const recheck = [
      'pnpm typecheck',
      'pnpm test:server:fast && pnpm test:client',
      'bash tools/check-client-invariants.sh',
    ].map((run, i) => ({
      key: `recheck-${i}`,
      pool: 'cpu' as const,
      run,
      at: 'origin-default' as const,
      seconds: 900,
    }));

    const landSlice = async (s: z.infer<typeof Slice>) => {
      const tried = await x.sample({
        key: `slice-${s.id}`,
        family: `slice:${s.fence[0]}`,
        gauge: 'machine',
        want: s.hard ? 2 : 1,
        make: () => ({
          pool: 'sonnet',
          usd: 6,
          output: Landed,
          // API GAP: alsoHolds is fixed per call; a slice that touches crates/ needs the cargo lock only while it builds.
          alsoHolds: s.fence.some((f) => f.startsWith('crates/')) ? ['cpu', 'cargo'] : ['cpu'],
          prompt:
            `Replace and delete one redundant path: ${s.replace}. Delete ${s.delete.join(', ')} with their tests. ` +
            `Preserve: ${s.preserve.join('; ')}. Budget: remove >= ${s.netLines} lines. Run typecheck + tests yourself; commit.`,
          context: [
            { kind: 'all', rowKind: 'owner' },
            { kind: 'family', family: `slice:${s.fence[0]}` },
          ],
          workspace: { kind: 'worktree', base: { sha: head }, fence: s.fence },
        }),
        verify: (v) => ({
          key: `verify-${v.sha}`,
          pool: 'cpu',
          run: `pnpm typecheck && pnpm test:server:fast && ${LOC}`,
          at: { sha: v.sha },
          seconds: 900,
        }),
      });
      const best = tried.kept.sort((a, b) => a.value.netLines - b.value.netLines)[0];
      if (!best)
        return {
          id: s.id,
          kind: 'rejected' as const,
          why: tried.rejected.map((r) => r.why).join('; '),
        };
      const review = await x.agent({
        key: `review-${s.id}`,
        pool: 'codex',
        usd: 2,
        output: Verdict,
        prompt: `Does ${best.value.sha} preserve ${s.preserve.join('; ')}, and does every deleted path have zero live readers?`,
        workspace: { kind: 'worktree', base: { sha: best.value.sha }, fence: [] },
      });
      if (review.kind !== 'ok')
        return { id: s.id, kind: 'rejected' as const, why: `review ${review.kind}` };
      return review.value.pass
        ? { id: s.id, kind: 'kept' as const, sha: best.value.sha, why: review.value.why }
        : { id: s.id, kind: 'rejected' as const, why: review.value.why };
    };

    await roundLoop(x, {
      plan: target.value.plan,
      planSchema: Plan,
      leader: 'opus',
      head: async () => head,
      context: [
        { kind: 'latest', rowKind: 'result', n: 40 },
        { kind: 'all', rowKind: 'owner' },
      ],
      reflectPrompt:
        'Compare measured line and owner deltas with the budget. Re-slice conflicts and rejected slices ' +
        'into the next wave; restructure if the cut is not converging toward 66k. Finish when no wave is left.',
      watch: {
        pool: 'opus',
        batchSeconds: 120,
        prompt: 'Cancel a slice running 3x its peers; steer slices when the owner adds a keep pin.',
      },
      round: async (plan) => {
        const wave = plan.waves.find((w) => !done.has(w.id));
        if (!wave) return 'no waves left';
        done.add(wave.id);
        const outcomes = await x.parallel(wave.slices.map((s) => () => landSlice(s)));
        for (const o of outcomes) {
          // serial: each merge rechecks the merged commit, then fast-forwards
          const row = { kind: 'result' as const, id: `r-${o.id}`, ideaId: o.id };
          if (o.kind === 'rejected') {
            await x.notebook.add([{ ...row, sha: head, verdict: 'reject', evidence: o.why }]);
            continue;
          }
          const m = await x.integrate({ key: `int-${o.id}`, sha: o.sha, recheck });
          switch (m.kind) {
            case 'integrated':
              head = m.sha;
              await x.notebook.add([{ ...row, sha: m.sha, verdict: 'keep', evidence: o.why }]);
              break;
            case 'conflict':
              await x.notebook.add([
                { ...row, sha: o.sha, verdict: 'reject', evidence: 'conflict: re-slice' },
              ]);
              break;
            case 'recheck-failed':
              await x.notebook.add([
                { ...row, sha: o.sha, verdict: 'reject', evidence: m.failing.join(', ') },
              ]);
              break;
          }
        }
        return `${wave.id}: ${outcomes.filter((o) => o.kind === 'kept').length}/${outcomes.length} kept, head ${head}`;
      },
    });
  },
});
