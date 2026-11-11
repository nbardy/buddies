/**
 * Case 5 — Expand simulator capability: forces (R6), moving bodies (R7), wind (R9) × engines.
 *
 * Shape: a matrix of independent cells (row × engine), each a deep serial debug-and-repair loop
 * against a frozen case through the central runner. A leader reflects between rounds and may
 * park, reorder or re-aim cells; a watcher kills slow Modal runs inside a round.
 * Scaling: wide ACROSS cells (independent, each judged by a frozen numeric gate: rules 1, 2).
 * Narrow WITHIN a cell: width 1, or 2 only while the mechanism is undiagnosed, because every
 * verification is a paid 3–30 min GPU run (rule 6). Two strikes per cell stop paid spend.
 * Fixes: the 19-attempt plate-lift loop and the DualSPHysics R5 runs (no strike limit, no owner
 * stop until late); three finish lines mixed together (this expedition has one: the matrix);
 * beta silently depending on R6 (the matrix is reported per cell, never folded into "beta").
 */
import { z } from 'zod';
import { expedition } from '../expedition';
import { roundLoop } from '../lib/round-loop';

// tools/three_engine_matrix_v1/ does not exist yet: it is the central runner's CLI over
// `Scene` → frozen case → typed result ("Shared executable cases", goals/2026-10-12_three_engine_goals.md).
const T = 'tools/three_engine_matrix_v1';
const ROWS = {
  'R6.foil_lift': {
    case: 'R6.foil_lift.re1000.n32_n64',
    bound: 0.1,
    doc: 'R6_FOIL_LIFT_FAILURE_CLASS.md',
  },
  'R7.draft': { case: 'R7.floating_box.draft', bound: 0.02, doc: 'R7_DRAFT_FAILURE_CLASS.md' },
  'R9.setup': { case: 'R9.wind_setup.slope', bound: 0.1, doc: 'R9_SETUP_FAILURE_CLASS.md' },
} as const;
type Row = keyof typeof ROWS;
const NOTES = 'agent_notes/2026-11-10_sim_capabilities';
const runCase = (row: Row, engine: string) =>
  `python ${T}/run_case.py --case ${ROWS[row].case} --engine ${engine} --max-usd 3 --json`;

const Cell = z.object({
  row: z.enum(['R6.foil_lift', 'R7.draft', 'R9.setup']),
  engine: z.enum(['E', 'A']), // E: Eulerian CUDA, A: APIC CUDA (PTX/CCCL)
  status: z.enum(['active', 'parked']),
  width: z.number().int().min(1).max(2),
  focus: z.string(), // the leader's one-line aim, e.g. "lift deficit is in the flow, not the probe"
});
const Plan = z.object({ cells: z.array(Cell) });
type Plan = z.infer<typeof Plan>;
const Fix = z.object({
  sha: z.string(),
  mechanism: z.string(),
  hypothesis: z.string(),
  predictedRelErr: z.number(),
});

export default expedition({
  name: 'sim-capabilities-r6-r7-r9',
  userGoal:
    'No engine combines all the rows — that is the point. Get forces, floating/moving bodies and wind to pass their ' +
    'frozen rows on a named engine, from committed source, with complete cost, independently re-checked, and tell me ' +
    'honestly which engine passes which rows.',
  objective: {
    criteria: [
      {
        kind: 'check',
        id: 'matrix-reproducible',
        run: `python ${T}/matrix.py --from-commit --verify-cost`,
        pool: 'cpu',
      },
      {
        kind: 'metric',
        id: 'rows-with-a-passing-engine',
        run: `python ${T}/matrix.py --json`,
        pool: 'cpu',
        field: 'rows_passing',
        op: '>=',
        bound: 3,
      },
      {
        kind: 'judged',
        id: 'independent-recheck',
        judge: 'codex',
        pass: 0.9,
        rubric:
          'Every PASS cell was re-run unchanged on the merged commit, uses the frozen window, and cites its cost.',
      },
      {
        kind: 'owner',
        id: 'owner-accepts',
        ask: 'Do you accept the matrix and the failure-class docs for the cells that did not pass?',
      },
    ],
  },
  repo: { path: '~/git/wave_sim' },
  budget: { usd: 400, hours: 24 },
  pools: {
    opus: {
      kind: 'agent',
      seat: { provider: 'claude', model: 'claude-opus-5-5', effort: 'high' },
      slots: 4,
    },
    sonnet: {
      kind: 'agent',
      seat: { provider: 'claude', model: 'claude-sonnet-5-5', effort: 'medium' },
      slots: 2,
    },
    codex: {
      kind: 'agent',
      seat: { provider: 'codex', model: 'gpt-6.1-sol', effort: 'high' },
      slots: 1,
    },
    modal: { kind: 'modal', gpu: 'L40S', slots: 4, usdPerHour: 1.95 },
    cpu: { kind: 'local', slots: 2, lock: null },
  },
  rules: [
    'A row passes unchanged on the named engine. Changing a scene, window, gauge, reference or scoring makes a NEW case, never a pass.',
    'Tolerances come from typed constructors (f32 relative >= 1e-4). Every paid run carries --max-usd.',
    'Replay every saved failure locally before spending again. Two strikes per cell, then paid runs stop for the owner.',
    'Do not touch beta scope: BETA_SCOPE.md lists moving rocks and wind as out of scope; this work does not change that.',
  ],

  async run(x) {
    // Baseline the matrix before any work: predictions are graded against these numbers.
    const base = await x.check({
      key: 'baseline',
      pool: 'cpu',
      run: `python ${T}/matrix.py --json`,
      at: 'origin-default',
      seconds: 600,
    });
    if (base.kind !== 'pass') return x.log(`baseline matrix failed: ${base.kind}`);
    // API GAP: CheckResult does not carry the commit 'origin-default' resolved to; the sha is read from the report.
    let head = (base.report as { sha: string }).sha;
    const strikes = new Map<string, number>();
    // API GAP: Call has no non-blocking settled() peek, so a round cannot ask "has the owner answered the spend
    // ask?" without blocking its barrier. Closest: the ask is awaited only when the leader re-activates the cell.
    const spendAsks = new Map<string, ReturnType<typeof x.ask<{ fundUsd: number }>>>();

    async function cell(c: z.infer<typeof Cell>, n: number): Promise<string> {
      const k = `${c.row}/${c.engine}`;
      const asked = spendAsks.get(k);
      if (asked) {
        const a = await asked;
        if (a.kind === 'unanswered' || a.value.fundUsd === 0) return `${k}: held for owner`;
        spendAsks.delete(k);
        strikes.set(k, 0);
      }
      // Narrow, verified search: candidate fixes from different mechanism families, each judged by the frozen case.
      const r = await x.sample({
        key: `fix-${k}-${n}`,
        family: k,
        gauge: 'machine',
        want: c.width,
        make: () => ({
          pool: 'opus',
          alsoHolds: ['modal'], // the agent runs its own short Modal debug runs (smoke ~158 s) inside its turn
          prompt:
            `Repair ${k} (frozen case ${ROWS[c.row].case}, gate rel err <= ${ROWS[c.row].bound}). Aim: ${c.focus}. ` +
            `First replay every saved failure (${T}/replay_failures.py --row ${c.row} --engine ${c.engine}). ` +
            'Pick a mechanism family not already rejected in the notebook. Commit the fix; never edit the case.',
          context: [
            { kind: 'family', family: k },
            { kind: 'latest', rowKind: 'note', n: 20 },
          ],
          output: Fix,
          workspace: {
            kind: 'worktree',
            base: { sha: head },
            fence: ['engines/', 'tools/', `${NOTES}/`],
          },
          usd: 15,
        }),
        verify: (fix) => ({
          key: `verify-${k}-${fix.sha}`,
          pool: 'modal',
          run: runCase(c.row, c.engine),
          at: { sha: fix.sha },
          seconds: 1800,
        }),
      });
      x.log(`${k} round ${n}: granted ${r.granted} (${r.narrowedBy}), kept ${r.kept.length}`);
      await x.notebook.add([
        ...r.kept.map(({ value: f }) => ({
          kind: 'idea' as const,
          id: `${k}-${f.sha}`,
          family: k,
          hypothesis: f.hypothesis,
          prediction: `rel err ${f.predictedRelErr}`,
          by: 'opus',
        })),
        ...r.kept.map(({ value: f }) => ({
          kind: 'result' as const,
          id: `res-${k}-${f.sha}`,
          ideaId: `${k}-${f.sha}`,
          sha: f.sha,
          verdict: 'keep' as const,
          evidence: runCase(c.row, c.engine),
        })),
        ...r.rejected.map((rej) => ({
          kind: 'note' as const,
          id: `rej-${k}-${n}-${rej.i}`,
          text: rej.why,
          claim: 'verified' as const,
          sources: [k],
        })),
      ]);

      if (r.kept.length === 0) {
        const s = (strikes.get(k) ?? 0) + 1;
        strikes.set(k, s);
        if (s < 2) return `${k}: strike 1`;
        // Two strikes: write the failure class, stop paid runs, ask the owner (holds no slot).
        await x.agent({
          key: `failure-class-${k}-${n}`,
          pool: 'opus',
          output: z.object({ sha: z.string() }),
          usd: 4,
          prompt: `Write ${NOTES}/${c.engine}_${ROWS[c.row].doc}: one page on the whole failure class, every rejected mechanism, and the local replay of each saved failure.`,
          context: [{ kind: 'family', family: k }],
          workspace: { kind: 'worktree', base: { sha: head }, fence: [`${NOTES}/`] },
        });
        spendAsks.set(
          k,
          x.ask({
            key: `fund-${k}-${n}`,
            answer: z.object({ fundUsd: z.number() }),
            question: `${k} failed two strikes (see the failure-class doc). Fund more paid runs? 0 = park the cell.`,
          })
        );
        return `${k}: two strikes, parked for owner`;
      }
      // Land the best kept fix serially; recheck this cell AND the rows already passing, on the merged commit.
      const best = r.kept[0].value;
      const merged = await x.integrate({
        key: `land-${k}-${best.sha}`,
        sha: best.sha,
        recheck: [
          {
            key: `re-${k}-${best.sha}`,
            pool: 'modal',
            run: runCase(c.row, c.engine),
            at: { sha: best.sha },
            seconds: 1800,
          },
          {
            key: `re-matrix-${best.sha}`,
            pool: 'cpu',
            run: `python ${T}/matrix.py --no-regress --json`,
            at: { sha: best.sha },
            seconds: 900,
          },
        ],
      });
      switch (merged.kind) {
        case 'integrated':
          head = merged.sha;
          return `${k}: PASS integrated ${merged.sha}`;
        case 'conflict':
          return `${k}: kept but conflicts; next round rebases`;
        case 'recheck-failed':
          return `${k}: passed alone, regressed on merge (${merged.failing.join(', ')})`;
      }
    }

    const cells: Plan['cells'] = (['R6.foil_lift', 'R7.draft', 'R9.setup'] as const).flatMap(
      (row) =>
        (['E', 'A'] as const).map((engine) => ({
          row,
          engine,
          status: 'active' as const,
          width: 2,
          focus: 'diagnose the mechanism first',
        }))
    );
    await roundLoop(x, {
      plan: { cells },
      planSchema: Plan,
      round: async (plan, n) =>
        (
          await x.parallel(
            plan.cells.filter((c) => c.status === 'active').map((c) => () => cell(c, n))
          )
        ).join('; '),
      head: async () => head,
      leader: 'opus',
      reflectPrompt:
        'Compare each cell to its prediction. Progress means a row number moved toward its gate, not activity. Park cells ' +
        'whose blocker is upstream (e.g. A has no GPU force producer); set width 1 once a mechanism is diagnosed. A partial ' +
        'matrix with honest failure classes is a valid finish.',
      context: [
        { kind: 'all', rowKind: 'result' },
        { kind: 'latest', rowKind: 'note', n: 40 },
      ],
      watch: {
        pool: 'sonnet',
        batchSeconds: 300,
        prompt:
          'Cancel a Modal verification running past 2x its expected wall time. Steer any repair agent that edits a ' +
          'case, window or scoring file back to the engine. End the round early if budget passes 80% of its share.',
      },
    });
    // API GAP: the objective is all-or-nothing, but this case's honest result is usually a PARTIAL matrix (which
    // engine passes which rows). Closest: 'rows-passing >= 3' + owner acceptance; a partial matrix ends at the
    // deadline as not-met with the failure-class docs, rather than as a first-class "delivered with gaps" outcome.
  },
});
