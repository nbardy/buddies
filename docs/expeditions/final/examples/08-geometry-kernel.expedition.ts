/**
 * Case 8 — Own geometry kernel, first replacement: the D2 analytic boundary (curved wall +
 * cylindrical bore: faces, trim curves, adjacency, meshes at r = 0.45 / 0.60 m).
 *
 * Shape: deep serial. One worker on one warm session runs its own test loop (it holds the guard
 * lane), an independent check re-runs the suite on its commit, a serial integrator lands it,
 * and the leader picks the next cases. The plan is revisable: a derived refusal case or a
 * memory failure changes what comes next.
 * Scaling: width 1 everywhere except memory fixes. A proof-like derivation and a coupled
 * boundary graph are sequential work (research/scaling.md rule 1). Memory fixes are independent
 * alternatives against an exact, seconds-long verifier (the guarded suite), so they are sampled
 * with gauge 'machine' (rule 6), and the host narrows when one try already works (rule 5).
 * Prevents: G0 (the one replay was a retry like any other and the run died on `deadline`
 * with the verdict `skipped`) and Oompa cf9ea773 (two approved candidates and zero merges,
 * because validation read the dirty shared checkout). Here checks read a commit, integration
 * is serial and journaled, and owner judgment continues past the deadline.
 */
import { z } from 'zod';
import { expedition } from '../expedition';
import { roundLoop } from '../lib/round-loop';

const KERNEL = 'studio/design_kernel/native_geometry';
const NOTES = 'agent_notes/2026-10-30_own_geometry';
const GUARDED = `python3 oompa/geometry/guard.py -- bun test ./${KERNEL}/boundary.test.ts`;
// tools/geometry/* do not exist yet: chord_volume.py (independent cylindrical-chord volume),
// manifold.py (closure / orientation / manifold) and condition.py (numeric check of one derived
// condition). Each prints a JSON report and exits non-zero on failure.
const CHORD = `python3 tools/geometry/chord_volume.py --radii 0.45,0.60 --json`;
const MANIFOLD = `python3 tools/geometry/manifold.py ${KERNEL} --json`;

const Plan = z.object({ cases: z.array(z.string()), approach: z.string() }); // test names, in order
const Derivation = z.object({ id: z.string(), statement: z.string(), refuse: z.boolean() });
const Work = z.object({
  sha: z.string(),
  passing: z.array(z.string()),
  derivations: z.array(Derivation),
});
const Fix = z.object({ sha: z.string(), idea: z.string() });

export default expedition({
  name: 'geometry-g0-d2-analytic-boundary',
  userGoal:
    'Our own geometry implementation for internal operations, with OCCT confined to explicit external CAD ' +
    'compatibility. First: the D2 analytic boundary passes every original boundary case under unchanged caps.',
  objective: {
    criteria: [
      { kind: 'check', id: 'boundary-suite', run: GUARDED, pool: 'guard' },
      {
        kind: 'metric',
        id: 'chord-volume',
        run: CHORD,
        pool: 'cpu',
        field: 'maxRelError',
        op: '<=',
        bound: 1e-9,
      },
      { kind: 'check', id: 'manifold', run: MANIFOLD, pool: 'cpu' },
      {
        kind: 'judged',
        id: 'behavior-preserved',
        judge: 'codex',
        pass: 0.9,
        rubric:
          'Reading the diff and REQUIREMENTS.md: geometry behavior is preserved, every refusal is derived, not tuned.',
      },
      {
        kind: 'owner',
        id: 'owner-g0',
        ask: 'Accept this candidate as G0 and hand it to Product receiving checks?',
      },
    ],
  },
  repo: { path: '~/git/wave_sim' },
  budget: { usd: 45, hours: 12 },
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
      slots: 1,
    },
    // One guarded run at a time machine-wide: peak RSS is the measurement, so runs must not share RAM.
    guard: { kind: 'local', slots: 1, lock: 'wave_sim-geometry-guard' },
    cpu: { kind: 'local', slots: 2, lock: null },
  },
  rules: [
    'Guard caps are fixed: 268,435,456 B aggregate RSS and 60 s. Never raise them, never skip a radius or a negative control.',
    'Refuse, do not approximate: e.g. the bore cap meets the inner wall when r > √(3.75²−2²)−2.5; that case is refused.',
    'No OCCT, native CAD, GPU or Modal in this packet. No new package or store.',
    `Each guarded receipt records commit, command, peak RSS, duration and result in ${NOTES}/WORK.md.`,
  ],

  async run(x) {
    let head = 'origin-default' as { sha: string } | 'origin-default';
    let warm: { from: string } | undefined;

    const verifyAt = (sha: string, n: number) => [
      { key: `suite-${sha}-${n}`, pool: 'guard' as const, run: GUARDED, at: { sha }, seconds: 90 },
      { key: `chord-${sha}-${n}`, pool: 'cpu' as const, run: CHORD, at: { sha }, seconds: 60 },
    ];

    await roundLoop(x, {
      plan: {
        cases: ['r045-positive', 'r060-positive', 'negative-controls'],
        approach: 'one face kind at a time',
      },
      planSchema: Plan,
      leader: 'opus',
      reflectPrompt:
        'Compare the round with your predictions. Progress is a case newly passing on an integrated commit, not code ' +
        'written. Put refusal cases derived this round into the plan. Finish only when every original case passes.',
      context: [
        { kind: 'all', rowKind: 'result' },
        { kind: 'all', rowKind: 'note' },
      ],
      watch: {
        pool: 'sonnet',
        batchSeconds: 120,
        prompt:
          'The worker runs the guarded suite itself. Steer it if it re-runs the suite without a code change, or ' +
          'if a run takes over 3x the last one. Cancel it after a second identical guard failure.',
      },
      head: async () => (head === 'origin-default' ? 'origin-default' : head.sha),

      round: async (plan, n) => {
        // Deep worker: holds the guard lane so its own red/green loop needs no extra calls.
        const work = await x.agent({
          key: `work-${n}`,
          pool: 'opus',
          alsoHolds: ['guard'],
          warm,
          prompt:
            `Make these boundary cases pass, in order: ${plan.cases.join(', ')}. Approach: ${plan.approach}. ` +
            `Derive every geometric condition you rely on and list it; mark refusal cases. Commit; report the sha.`,
          context: [
            { kind: 'all', rowKind: 'note' },
            { kind: 'latest', rowKind: 'result', n: 8 },
          ],
          output: Work,
          workspace: { kind: 'worktree', base: head, fence: [`${KERNEL}/`, `${NOTES}/WORK.md`] },
          usd: 6,
        });
        if (work.kind !== 'ok') return `worker ${work.kind}`;
        warm = { from: work.sessionId };

        // Derived conditions become notebook knowledge, 'verified' only if a numeric check agrees.
        await x.parallel(
          work.value.derivations.map((d) => async () => {
            const c = await x.check({
              key: `cond-${d.id}`,
              pool: 'cpu',
              run: `python3 tools/geometry/condition.py ${d.id}`,
              at: { sha: work.value.sha },
              seconds: 30,
            });
            await x.notebook.add([
              {
                kind: 'note',
                id: d.id,
                text: d.statement,
                claim: c.kind === 'pass' ? 'verified' : 'claimed',
                sources: [work.value.sha],
              },
            ]);
          })
        );

        // Independent re-check on the immutable commit; never the shared checkout.
        let candidate = work.value.sha;
        const suite = await x.check(verifyAt(candidate, n)[0]);
        if (suite.kind === 'fail' && suite.exitCode === -9) {
          // Over the memory cap (G0: 270,024,704 B at 1.42 s, exit −9). Alternatives are independent
          // and the guard is exact, so sample them; the host caps and narrows the width.
          const fixes = await x.sample({
            key: `memfix-${n}`,
            family: 'boundary-memory',
            gauge: 'machine',
            want: 4,
            make: (i) => ({
              pool: 'sonnet',
              prompt: `The guarded suite exceeds 268,435,456 B. Try one distinct memory reduction (#${i}); do not change caps or tests.`,
              context: [{ kind: 'family', family: 'boundary-memory' }],
              output: Fix,
              workspace: { kind: 'worktree', base: { sha: candidate }, fence: [`${KERNEL}/`] },
              usd: 1.5,
            }),
            verify: (f, i) => ({
              key: `memfix-${n}-${i}`,
              pool: 'guard',
              run: GUARDED,
              at: { sha: f.sha },
              seconds: 90,
            }),
          });
          await x.notebook.add(
            fixes.rejected.map((r) => ({
              kind: 'result' as const,
              id: `memfix-${n}-${r.i}`,
              ideaId: 'boundary-memory',
              sha: candidate,
              verdict: 'reject' as const,
              evidence: r.why,
            }))
          );
          const best = fixes.kept[0];
          if (best === undefined)
            return `memory cap held; no fix in ${fixes.granted} tries (${fixes.narrowedBy})`;
          candidate = best.value.sha;
        } else if (suite.kind !== 'pass') return `suite ${suite.kind} on ${candidate}`;

        // API GAP: G0's "exactly one replay, no automatic retries" is a count budget. Budgets are
        // only usd/hours, so nothing in the host stops a second integrate of a replayed candidate.
        const landed = await x.integrate({
          key: `integrate-${candidate}`,
          sha: candidate,
          recheck: verifyAt(candidate, n),
        });
        await x.notebook.add([
          {
            kind: 'result',
            id: `receipt-${n}`,
            ideaId: plan.cases.join('+'),
            sha: candidate,
            verdict: landed.kind === 'integrated' ? 'keep' : 'reject',
            evidence: `${GUARDED} → ${landed.kind}`,
          },
        ]);
        switch (landed.kind) {
          case 'integrated':
            head = { sha: landed.sha };
            return `integrated ${landed.sha}: ${work.value.passing.join(', ')}`;
          case 'conflict':
            return `conflict on ${candidate}; candidate retained for the next round`;
          case 'recheck-failed':
            return `recheck failed on merge: ${landed.failing.join(', ')}`;
        }
      },
    });

    // API GAP: "hand to Product for edit / Undo / publish / cold-reopen checks" is a follow-up
    // owned elsewhere. There is no call to open a task for another team, so it is a notebook row.
    await x.notebook.add([
      {
        kind: 'note',
        id: 'handoff-product',
        claim: 'claimed',
        sources: [`${NOTES}/PRODUCT_RECEIVING.md`],
        text: 'G0 candidate ready for Product receiving checks (edit, Undo, publish, cold reopen).',
      },
    ]);
  },
});
