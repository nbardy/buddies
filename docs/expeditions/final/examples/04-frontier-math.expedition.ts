/**
 * Case 4: frontier simulation research, new math to 10–200× algorithms (wave_sim, Astra restart).
 *
 * Shape: freeze and hash the evaluator → blind divergent discovery (N00/S00) → one census (D00)
 * → one GPU falsifier per selected candidate (L01) → independent judge (L02) → integrate.
 * Scaling: discovery is wide because candidates are independent, and each one passes a blind
 * math red team on another provider. The gauge is 'review', so the host caps each sub-volume at
 * 4 (scaling.md rules 1, 2, 6). The census, each falsifier and each judgment stay at width 1:
 * they are sequential arguments with an expensive verifier, so the money goes into depth.
 * Prevents: modal-Schur's "18% fewer PCG iterations, 30% slower" (only complete-cost matched
 * error counts), the endpoint "novelty" that beat an unfair first-order baseline (same-stage
 * integrators are required), placement engineering on cell 66 (the watcher cancels drift), and
 * architecture leaking into discovery (blind workspaces; the graveyard is applied at the census).
 */
import { z } from 'zod';
import { expedition } from '../expedition';
import { roundLoop } from '../lib/round-loop';

const PKT = 'auto_research/experiments/pending/astra_wave_sim_restart_v1';
const BLIND = [`${PKT}/MINIMAL_PROBLEM.md`, `${PKT}/HARDWARE_FACTS.md`];
const SUBVOLUMES = ['neutral', 'pressure-projection', 'free-surface-interface', 'time-integration'];
// tools/astra/* does not exist yet; the matched-error certificate does (tools/matched_error_v1).
const CERT = (id: string) =>
  `python tools/matched_error_v1/residual_certificate.py --case-set ${PKT}/cases.json --candidate ${id} --abba --complete-cost --json`;

const Candidate = z.object({
  kind: z.enum(['candidate', 'no-go']),
  mechanism: z.string(),
  statements: z.array(
    z.object({
      text: z.string(),
      label: z.enum(['TEXTBOOK', 'LITERATURE', 'DERIVATION', 'CONJECTURE']),
    })
  ),
  predictedSpeedup: z.number(),
  completeCost: z.string(),
});
const Falsifier = z.object({
  ideaId: z.string(),
  family: z.string(),
  predictedSpeedup: z.number(),
  baselines: z.array(z.string()),
});
const Plan = z.object({ active: z.array(Falsifier) });
const Verdict = z.object({ pass: z.boolean(), why: z.string() });

export default expedition({
  name: 'astra-frontier-math',
  userGoal:
    'A materially faster true-3D breaking-water system under matched physical error and complete target-GPU cost. ' +
    'New math, not tuning: 10–200×. A precise no-go or lower bound that saves future spend also counts.',
  objective: {
    criteria: [
      {
        kind: 'check',
        id: 'evaluator-frozen',
        run: `python tools/astra/verify_evaluator_hash.py ${PKT}`,
        pool: 'cpu',
      },
      {
        kind: 'metric',
        id: 'matched-error-speedup',
        run: CERT('head'),
        pool: 'h100',
        field: 'speedup_at_matched_error',
        op: '>=',
        bound: 10,
      },
      {
        kind: 'judged',
        id: 'fair-falsifier',
        judge: 'gemini',
        pass: 0.9,
        rubric:
          'Matched error on the frozen cases; complete cost (setup, compile, readback, rejected work); best admissible ' +
          'baseline incl. same-stage Gauss/Lobatto/Radau and Verlet/RATTLE; every statement labelled and checked for units, ' +
          'limits, conservation, closure.',
      },
      {
        kind: 'owner',
        id: 'owner-accepts',
        ask: 'Do you accept the stated speedup factor and the landed solver?',
      },
    ],
  },
  repo: { path: '~/git/wave_sim' },
  budget: { usd: 400, hours: 36 },
  pools: {
    opus: {
      kind: 'agent',
      seat: { provider: 'claude', model: 'claude-opus-5-5', effort: 'high' },
      slots: 4,
    },
    sol: {
      kind: 'agent',
      seat: { provider: 'codex', model: 'gpt-6.1-sol', effort: 'high' },
      slots: 4,
    },
    gemini: {
      kind: 'agent',
      seat: { provider: 'gemini', model: 'gemini-3.1-pro-preview', effort: 'high' },
      slots: 3,
    },
    sonnet: {
      kind: 'agent',
      seat: { provider: 'claude', model: 'claude-sonnet-5-5', effort: 'medium' },
      slots: 1,
    },
    h100: { kind: 'modal', gpu: 'H100', slots: 3, usdPerHour: 3.95 },
    cpu: { kind: 'local', slots: 2, lock: null },
  },
  rules: [
    'Label every statement TEXTBOOK, LITERATURE, DERIVATION or CONJECTURE. Page and theorem count are not progress.',
    'matchedErrorSpeedup stays false until the certificate passes on a commit. A dirty-tree run cannot be cited.',
    'Stop a family after two clean falsifiers fail to reduce the blocker. Never re-test a graveyard row without a representation change.',
    'Modal is scale-to-zero only. Raw outputs go to output/ via the artifact store; tracked summaries under the packet.',
  ],

  async run(x) {
    // 1. Freeze the evaluator before any S00 output exists. Narrow; nothing downstream may start first.
    const freeze = await x.agent({
      key: 'freeze',
      pool: 'opus',
      prompt: `Freeze ${PKT}: run tools/astra/freeze_evaluator.py, commit cases.json, the metric and the rubric with their hash.`,
      output: z.object({ sha: z.string(), hash: z.string() }),
      workspace: { kind: 'worktree', base: 'origin-default', fence: [PKT] },
      usd: 3,
    });
    if (freeze.kind !== 'ok')
      return x.log(`freeze ${freeze.kind}: nothing may run against an unfrozen evaluator`);
    let head = freeze.value.sha;

    // 2. Discovery: wide, blind (MINIMAL_PROBLEM + hardware only), producers alternate claude/codex, gemini red-teams.
    const found = await x.parallel(
      SUBVOLUMES.map(
        (sv) => () =>
          x.sample({
            key: `discover-${sv}`,
            family: `s00-${sv}`,
            gauge: 'review',
            want: 4,
            make: (i) => ({
              pool: i % 2 === 0 ? 'opus' : 'sol',
              prompt: `Sub-volume: ${sv}. Derive a new algorithm for the problem, or a precise no-go / lower bound. Show complete cost.`,
              output: Candidate,
              workspace: { kind: 'blind', reads: BLIND, network: false },
              usd: 8,
            }),
            verify: (c, i) => ({
              key: `redteam-${sv}-${i}`,
              pool: 'gemini',
              output: Verdict,
              usd: 2,
              prompt: `Blind red team. Check labels, units, limits, conservation, closure, error and complete cost:\n${JSON.stringify(c)}`,
              workspace: { kind: 'blind', reads: BLIND, network: false },
            }),
          })
      )
    );
    await x.notebook.add(
      found.flatMap((r, s) =>
        r.kept.map((k) => ({
          kind: 'note' as const,
          id: `cand-${SUBVOLUMES[s]}-${k.i}`,
          text: JSON.stringify(k.value),
          claim: 'claimed' as const,
          sources: [],
        }))
      )
    );

    // 3. Census (D00): one judge reads every frozen candidate plus the graveyard, clusters, assigns families, selects.
    const census = await x.agent({
      key: 'census',
      pool: 'gemini',
      prompt:
        'Cluster the candidates by mechanism. Reject any family in the KEY_LEARNINGS.md graveyard without a representation ' +
        'change. Select at most 3 for GPU falsifiers; name the best admissible baselines for each. Keep no-go results as notes.',
      context: [{ kind: 'all', rowKind: 'note' }],
      output: z.object({ selected: z.array(Falsifier.extend({ hypothesis: z.string() })) }),
      workspace: { kind: 'read-only', paths: ['KEY_LEARNINGS.md', 'theory/', PKT] },
      usd: 10,
    });
    if (census.kind !== 'ok') return x.log(`census ${census.kind}`);
    await x.notebook.add(
      census.value.selected.map((f) => ({
        kind: 'idea' as const,
        id: f.ideaId,
        family: f.family,
        hypothesis: f.hypothesis,
        prediction: `${f.predictedSpeedup}x`,
        by: 'census',
      }))
    );

    // 4. Falsifiers (L01) and judges (L02) in revisable rounds. The leader may redirect to a no-go objective.
    // API GAP: Objective is a conjunction, so "speedup ≥10× OR a precise no-go" cannot be signed at launch;
    // the no-go path is a `redirect` revision, which needs the owner's answer mid-run.
    await roundLoop(x, {
      plan: { active: census.value.selected.map(({ hypothesis: _h, ...f }) => f) },
      planSchema: Plan,
      leader: 'opus',
      head: async () => head,
      context: [
        { kind: 'all', rowKind: 'idea' },
        { kind: 'all', rowKind: 'result' },
      ],
      reflectPrompt:
        'Did any falsifier move the blocker (matched-error wall time)? Predict speedups before measuring. ' +
        'Drop families with two rejects. If every family is dead, redirect the objective to the strongest no-go with its bound.',
      watch: {
        pool: 'sonnet',
        batchSeconds: 600,
        prompt:
          'Cancel an implementer doing placement engineering, tolerance tuning or a relabelled sidecar; steer one that ' +
          'benchmarks only against a first-order baseline.',
      },
      round: async (plan, n) => {
        const results = await x.notebook.read({ kind: 'all', rowKind: 'result' });
        const rejects = (f: z.infer<typeof Falsifier>) =>
          results.filter(
            (r) => r.kind === 'result' && r.ideaId === f.ideaId && r.verdict === 'reject'
          ).length;
        const live = plan.active.filter((f) => rejects(f) < 2);
        const verdicts = await x.parallel(
          live.map((f) => async () => {
            // The implementer runs its own Modal smoke loop, so it holds one H100 slot for the whole turn.
            const impl = await x.agent({
              key: `l01-${f.ideaId}-r${n}`,
              pool: 'opus',
              alsoHolds: ['h100'],
              prompt: `Implement ${f.ideaId} and its falsifier against ${f.baselines.join(', ')}. Commit; cite the sha.`,
              context: [
                { kind: 'ids', ids: [f.ideaId] },
                { kind: 'family', family: f.family },
              ],
              output: z.object({ sha: z.string(), notes: z.string() }),
              workspace: {
                kind: 'worktree',
                base: { sha: head },
                fence: ['solvers/', `${PKT}/${f.ideaId}/`],
              },
              usd: 25,
            });
            if (impl.kind !== 'ok') return `${f.ideaId}: ${impl.kind}`;
            const cert = await x.check({
              key: `cert-${f.ideaId}-r${n}`,
              pool: 'h100',
              run: CERT(f.ideaId),
              at: { sha: impl.value.sha },
              seconds: 5400,
            });
            const judge = await x.agent({
              key: `l02-${f.ideaId}-r${n}`,
              pool: 'gemini',
              output: Verdict,
              usd: 4,
              prompt: `Independent judgment. Certificate: ${JSON.stringify(cert)}. Is the speedup real, fair and complete-cost?`,
              workspace: { kind: 'read-only', paths: ['solvers/', PKT] },
            });
            const keep = cert.kind === 'pass' && judge.kind === 'ok' && judge.value.pass;
            await x.notebook.add([
              {
                kind: 'result',
                id: `res-${f.ideaId}-r${n}`,
                ideaId: f.ideaId,
                sha: impl.value.sha,
                verdict: keep ? 'keep' : 'reject',
                evidence: judge.kind === 'ok' ? judge.value.why : `judge ${judge.kind}`,
              },
            ]);
            if (!keep) return `${f.ideaId}: reject`;
            const landed = await x.integrate({
              key: `land-${f.ideaId}-r${n}`,
              sha: impl.value.sha,
              recheck: [
                {
                  key: `recert-${f.ideaId}-r${n}`,
                  pool: 'h100',
                  run: CERT('head'),
                  at: { sha: impl.value.sha },
                  seconds: 5400,
                },
                {
                  key: `ledgers-${f.ideaId}-r${n}`,
                  pool: 'cpu',
                  run: 'python tools/conservation_ledgers.py --json',
                  at: { sha: impl.value.sha },
                  seconds: 900,
                },
              ],
            });
            // API GAP: integrate's recheck runs "on the merged commit", but CheckSpec needs a sha up front;
            // the candidate sha stands in here and the host is assumed to substitute the merge.
            if (landed.kind === 'integrated') head = landed.sha;
            return `${f.ideaId}: ${landed.kind}`;
          })
        );
        return verdicts.join('; ');
      },
    });
  },
});
