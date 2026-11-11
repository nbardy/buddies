/**
 * Case 3 — wave_sim auto-research: faster at matched error, on local M4 + Modal.
 *
 * Shape: revisable rounds (roundLoop). Each round: per mechanism family, a verified search
 * (codex producers, each running its own Modal smoke loop) → ABBA timing of the kept
 * candidates on Modal L4 and the local M4 → serial integration of the best → leader reflects.
 * Scaling: wide only on candidate kernels, where the verifier is a cheap exact matched-error
 * check (gauge 'machine', rule 6). Timing stays narrow: one M4 runner (machine lock) and
 * ABBA pairs. Reflection and integration are width 1 (rules 1, 2). Producers share one
 * notebook, never each other (rule 4). There is no ssh pool: wave_sim has no standing fleet.
 * Prevents: plate lift's ~19 paid attempts (two strikes per family, then an owner ask),
 * the false 0.842× from a noisy baseline (ABBA only), artifacts lost in worker trees
 * (results cite an integrated sha), and "fresh eyes from the same model" (gemini judges).
 */
import { z } from 'zod';
import { expedition } from '../expedition';
import { roundLoop } from '../lib/round-loop';

// tools/autoresearch_v1/ does not exist yet: abba.py wraps tools/bench_v0/bench.py in an
// A-B-B-A schedule and tools/matched_error_v1/residual_certificate.py for the error gate.
const CASES = 'goals/frozen_cases_v1.json'; // frozen at launch: dam_break, ridge, sloshing, solitary
const ABBA = (dev: string) =>
  `python tools/autoresearch_v1/abba.py --cases ${CASES} --device ${dev} --json`;
const GATE = `python tools/autoresearch_v1/matched_error_gate.py --cases ${CASES} --json`;
const R1_R12 = 'python tools/goal_manager.py check --requirements R1-R12 --json';

const Plan = z.object({
  families: z.array(
    z.object({ family: z.string(), lever: z.string(), want: z.number().int().min(1).max(16) })
  ),
});
const Candidate = z.object({
  sha: z.string(),
  ideaId: z.string(),
  hypothesis: z.string(),
  predictedSpeedup: z.number(), // theoretical, from tools/cuda_memory_roofline_v0, before any timing
});
type Cand = z.infer<typeof Candidate>;

export default expedition({
  name: 'wave-sim-matched-error-speedup',
  userGoal:
    'Make the wave_sim engines faster without losing accuracy. Run ideas in parallel on my M4 and Modal, keep ' +
    'one shared notebook so nobody repeats a dead idea, and show theoretical vs measured for every one.',
  objective: {
    criteria: [
      { kind: 'check', id: 'r1-r12-hold', run: R1_R12, pool: 'modal' },
      {
        kind: 'metric',
        id: 'l4-speedup',
        run: ABBA('nvidia-l4'),
        pool: 'modal',
        field: 'matchedErrorSpeedup',
        op: '>=',
        bound: 1.25,
      },
      {
        kind: 'metric',
        id: 'm4-no-regress',
        run: ABBA('apple-m4'),
        pool: 'm4',
        field: 'matchedErrorSpeedup',
        op: '>=',
        bound: 1.0,
      },
      {
        kind: 'judged',
        id: 'complete-cost',
        judge: 'gemini',
        pass: 0.8,
        rubric:
          'The speedup counts setup, compile, readback, rejected work and output, on the frozen cases, ABBA.',
      },
      {
        kind: 'owner',
        id: 'owner-accepts',
        ask: 'Accept this speedup and flip matchedErrorSpeedup to true?',
      },
    ],
  },
  repo: { path: '~/git/wave_sim' },
  budget: { usd: 150, hours: 12 },
  pools: {
    opus: {
      kind: 'agent',
      seat: { provider: 'claude', model: 'claude-opus-5-5', effort: 'high' },
      slots: 1,
    },
    sonnet: {
      kind: 'agent',
      seat: { provider: 'claude', model: 'claude-sonnet-5-5', effort: 'low' },
      slots: 1,
    },
    codex: {
      kind: 'agent',
      seat: { provider: 'codex', model: 'gpt-6.1-sol', effort: 'high' },
      slots: 6,
    },
    gemini: {
      kind: 'agent',
      seat: { provider: 'gemini', model: 'gemini-3.1-pro-preview', effort: 'high' },
      slots: 2,
    },
    modal: { kind: 'modal', gpu: 'L4', slots: 8, usdPerHour: 0.8 },
    m4: { kind: 'local', slots: 1, lock: 'wave_sim-local-gpu' }, // AGENTS.md: one local GPU runner
    cpu: { kind: 'local', slots: 3, lock: null },
  },
  rules: [
    'Speed counts only at matched error under complete cost, ABBA, on the frozen cases. Otherwise it is "candidate".',
    'Two strikes per family, then stop paid runs for it. Never re-test a graveyard row without a representation change.',
    'One change family per experiment. Typed tolerances from goals/2026-10-12_three_engine_goals.md; never loosen f32 bounds.',
    'Modal scales to zero. Artifacts go through tools/modal_run_v1/durable_results.py; cite a commit, never a dirty tree.',
  ],

  async run(x) {
    const strikes = new Map<string, number>(); // family → rounds with nothing kept
    let base: { sha: string } | 'origin-default' = 'origin-default'; // producers branch from the last integration

    const searchFamily = (f: z.infer<typeof Plan>['families'][number], n: number) =>
      x.sample<Cand>({
        key: `r${n}-${f.family}`,
        family: f.family,
        gauge: 'machine',
        want: f.want,
        make: (i) => ({
          pool: 'codex',
          alsoHolds: ['modal'],
          usd: 3,
          prompt:
            `Lever: ${f.lever}. Variant ${i}: one change in family ${f.family}. Predict the speedup from the ` +
            'roofline first, then iterate with Modal smokes (tools/modal_run_v1). Commit; report sha and prediction.',
          context: [
            { kind: 'family', family: f.family },
            { kind: 'all', rowKind: 'result' },
          ],
          output: Candidate,
          workspace: { kind: 'worktree', base, fence: ['src/', 'shaders/'] },
        }),
        verify: (c) => ({
          key: `gate-${c.sha}`,
          pool: 'modal',
          run: GATE,
          at: { sha: c.sha },
          seconds: 600,
        }),
      });

    const measure = async (c: Cand, f: string) => {
      const [l4, m4] = await x.parallel([
        () =>
          x.check({
            key: `abba-l4-${c.sha}`,
            pool: 'modal',
            run: ABBA('nvidia-l4'),
            at: { sha: c.sha },
            seconds: 1800,
          }),
        () =>
          x.check({
            key: `abba-m4-${c.sha}`,
            pool: 'm4',
            run: ABBA('apple-m4'),
            at: { sha: c.sha },
            seconds: 2400,
          }),
      ]);
      // API GAP: CheckResult has no machine identity (host, GPU, thermal/idle state); it lives only in the report JSON.
      const speed =
        l4.kind === 'pass' ? (l4.report as { matchedErrorSpeedup: number }).matchedErrorSpeedup : 0;
      const verdict = l4.kind === 'pass' && m4.kind === 'pass' && speed > 1 ? 'keep' : 'reject';
      await x.notebook.add([
        {
          kind: 'idea',
          id: c.ideaId,
          family: f,
          hypothesis: c.hypothesis,
          prediction: `${c.predictedSpeedup}×`,
          by: 'codex',
        },
        {
          kind: 'result',
          id: `res-${c.sha}`,
          ideaId: c.ideaId,
          sha: c.sha,
          verdict,
          evidence: `theoretical ${c.predictedSpeedup}× vs measured ${speed}× (L4 ABBA); M4 ${m4.kind}`,
        },
      ]);
      return { c, speed, verdict };
    };

    await roundLoop(x, {
      plan: {
        families: [
          {
            family: 'pressure-solve',
            lever: 'red-black SOR with f16 storage, f32 accumulate',
            want: 8,
          },
          {
            family: 'advection',
            lever: 'fused APIC P2G scatter with shared-memory tiles',
            want: 6,
          },
          {
            family: 'readback',
            lever: 'drop per-step readback; batch diagnostics every 32 steps',
            want: 3,
          },
        ],
      },
      planSchema: Plan,
      leader: 'opus',
      head: async () => (base === 'origin-default' ? 'origin-default' : base.sha),
      context: [
        { kind: 'all', rowKind: 'result' },
        { kind: 'latest', rowKind: 'idea', n: 40 },
      ],
      reflectPrompt:
        "Compare each family's predicted and measured speedups. Did the blocker move, or only activity? " +
        'Retire struck families, change representation, or finish. Predict the l4-speedup metric for the next round.',
      watch: {
        pool: 'sonnet',
        batchSeconds: 120,
        prompt:
          'Cancel a producer that changes two knobs at once or relabels a repair as a sidecar. ' +
          'Steer one that is 3× slower than its siblings toward a smaller change.',
      },
      round: async (plan, n) => {
        const live = plan.families.filter((f) => (strikes.get(f.family) ?? 0) < 2);
        const searched = await x.parallel(live.map((f) => () => searchFamily(f, n)));
        for (const [k, s] of searched.entries()) {
          if (s.kept.length === 0)
            strikes.set(live[k].family, (strikes.get(live[k].family) ?? 0) + 1);
        }
        // API GAP: two strikes is a script variable, not a host limit; a script edit can reset it. Rule 12 wants it in the host.
        for (const f of live.filter((f) => strikes.get(f.family) === 2)) {
          const a = await x.ask({
            key: `strike-${f.family}`,
            answer: z.enum(['retire', 'new-representation']),
            question: `${f.family} failed twice. Retire it to the graveyard, or allow one new representation?`,
          });
          if (a.kind === 'answered' && a.value === 'new-representation') strikes.set(f.family, 1);
        }
        await x.notebook.add(
          searched.flatMap((s, k) =>
            s.rejected.map((r) => ({
              kind: 'note' as const,
              id: `r${n}-${live[k].family}-${r.i}`,
              text: `gate rejected: ${r.why}`,
              claim: 'verified' as const,
              sources: [],
            }))
          )
        );
        const kept = searched.flatMap((s, k) =>
          s.kept.map((v) => ({ c: v.value, f: live[k].family }))
        );
        const measured = (await x.parallel(kept.map((k) => () => measure(k.c, k.f)))).filter(
          (m) => m.verdict === 'keep'
        );
        const best = measured.sort((a, b) => b.speed - a.speed)[0];
        if (!best)
          return `round ${n}: nothing kept (${searched.map((s) => s.narrowedBy).join(', ')})`;
        const merged = await x.integrate({
          key: `integrate-${best.c.sha}`,
          sha: best.c.sha,
          recheck: [
            {
              key: `recheck-${best.c.sha}`,
              pool: 'modal',
              run: R1_R12,
              at: { sha: best.c.sha },
              seconds: 3600,
            },
          ],
        });
        switch (merged.kind) {
          case 'integrated':
            base = { sha: merged.sha };
            return `round ${n}: integrated ${best.c.ideaId} at ${best.speed}×`;
          case 'conflict':
            return `round ${n}: ${best.c.ideaId} conflicts with head`;
          case 'recheck-failed':
            return `round ${n}: ${best.c.ideaId} broke ${merged.failing.join(', ')}`;
        }
      },
    });
  },
});
