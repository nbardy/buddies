/**
 * Case 9 — Design and critique the new document model (Zoo / Onshape capacity, leaner interface).
 *
 * Shape: one history pass (narrow) → revisable adversarial rounds: propose (claude) → critique
 * (codex) ∥ machine spikes → adjudicate (gemini) → owner questions → integrate → reflect.
 * Scaling: the design argument is a sequential chain, so propose/critique/adjudicate stay width 1
 * (research/scaling.md rules 1, 5). Width appears only where a claim has an exact verifier:
 * a spike (Z5 column speed, edit → Undo → save → cold reopen) samples up to 8 implementations
 * under the `machine` gauge, each checked by a bench, never by a reviewer (rules 2, 6).
 * Fixes the reset finding (agent_notes/2026-10-12_reset/PLAN.md §1 item 3): eight redesigns, none
 * replaced what runs. Here every round lands on main through x.integrate, abandoned designs are
 * notebook rows a proposal must cite, and the objective requires a retirement plan the owner ratifies.
 */
import { z } from 'zod';
import { expedition } from '../expedition';
import { roundLoop } from '../lib/round-loop';

const DOC = 'studio/DOCUMENT_MODEL.md';
const OUT = 'agent_notes/2026-11-10_document_model_final';
const LEDGER = 'agent_notes/2026-10-09_document_model_parity/REQUIREMENT_CONTRACTS.md';
const GOALS = 'agent_notes/2026-10-11_model_comparison/DESIGN_GOALS_AND_USE_CASES.md';
const ASKED = 'agent_notes/2026-10-14_document_model_owner_decisions.md';
// Not yet in wave_sim: coverage.py passes when all 67 rows and G01–G12 are covered by an executable
// acceptance or scoped out by an owner ruling id. The spike bench and journey test are new too.
const COVERAGE = `python3 tools/document_model_ledger_v1/coverage.py ${DOC} --rows ${LEDGER} --goals ${GOALS} --strict`;
const EXAMPLES = `python3 tools/document_model_ledger_v1/validate_examples.py ${OUT}/examples`;
const JOURNEY = 'bun test tools/document_model_spikes_v1/journey.test.ts';

const Plan = z.object({
  focus: z.array(z.string()), // ledger rows / goals this round argues, e.g. ['D02', 'A01', 'G05']
  spikes: z.array(z.object({ id: z.string(), claim: z.string(), run: z.string() })),
  ownerQuestions: z.array(z.object({ id: z.string(), question: z.string(), default: z.string() })),
});
type Plan = z.infer<typeof Plan>;
const Draft = z.object({ sha: z.string(), summary: z.string() });
const Attacks = z.object({
  attacks: z.array(
    z.object({ id: z.string(), row: z.string(), claim: z.string(), test: z.string() })
  ),
});
const Rulings = z.object({
  rulings: z.array(
    z.object({
      attackId: z.string(),
      verdict: z.enum(['stands', 'answered', 'needs-owner']),
      why: z.string(),
    })
  ),
});
const Spike = z.object({ sha: z.string(), approach: z.string() });
// An attack that stands is kept (the draft has a defect); one the draft answers is rejected.
const RULING = { stands: 'keep', answered: 'reject', 'needs-owner': 'unjudged' } as const;

export default expedition({
  name: 'document-model-final-design',
  userGoal:
    'Design the document model we actually ship: Zoo/Onshape capacity with a leaner interface. Critique it ' +
    'against the use cases and the requirement ledger until I ratify it, with a plan that retires what runs today.',
  objective: {
    criteria: [
      { kind: 'check', id: 'ledger-covered', run: COVERAGE, pool: 'cpu' },
      { kind: 'check', id: 'examples-valid', run: EXAMPLES, pool: 'cpu' },
      {
        kind: 'check',
        id: 'z9-references',
        run: 'node tools/z9_extension_benchmark_v1/reference.test.cjs',
        pool: 'cpu',
      },
      { kind: 'check', id: 'journey', run: JOURNEY, pool: 'bench' },
      // Z5: column evaluation within 3× of plain JS. The bench is new (tools/document_model_spikes_v1/).
      {
        kind: 'metric',
        id: 'z5-column-speed',
        run: 'bun tools/document_model_spikes_v1/z5_column.bench.ts --json',
        pool: 'bench',
        field: 'ratio_vs_plain_js',
        op: '<=',
        bound: 3,
      },
      {
        kind: 'judged',
        id: 'retires-running',
        judge: 'gemini',
        pass: 0.85,
        rubric:
          `${OUT}/RETIREMENT.md names every model that runs today (authoring v1–v4, v7, L6, Marine v0.5, feature_program), ` +
          'its consumers, the migration and the deletion order. A design that sits beside the running model fails.',
      },
      {
        kind: 'owner',
        id: 'owner-ratifies',
        ask: 'Do you ratify this document model and its retirement plan?',
      },
    ],
  },
  repo: { path: '~/git/wave_sim' },
  budget: { usd: 90, hours: 36 }, // owner latency dominates; answers still land after the deadline
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
    gemini: {
      kind: 'agent',
      seat: { provider: 'gemini', model: 'gemini-3.1-pro-preview', effort: 'high' },
      slots: 2,
    },
    cpu: { kind: 'local', slots: 2, lock: null },
    bench: { kind: 'local', slots: 1, lock: 'wave_sim-timing' }, // timing needs an idle host
  },
  rules: [
    'Owner amendment 2026-10-30: own geometry for internal operations; OCCT only for external CAD compatibility.',
    'Never re-propose an abandoned design without naming the representation change.',
    'Do not smuggle a feature catalog in while calling B-rep a backend problem (design_kernel/09_ADJUDICATION.md).',
    `The design lives in ${DOC}; working notes under ${OUT}; generated output under output/.`,
  ],

  async run(x) {
    // 1. History: one reader turns eight abandoned designs and the 12 open owner questions into rows.
    const history = await x.agent({
      key: 'history',
      pool: 'opus',
      usd: 4,
      prompt:
        `Read agent_notes/2026-10-12_reset/PLAN.md, ${GOALS}, ${ASKED}, studio/design_kernel/09_ADJUDICATION.md. ` +
        'One row per abandoned design (what it was, why it never replaced the running model) and per open question.',
      output: z.object({
        notes: z.array(
          z.object({ id: z.string(), text: z.string(), sources: z.array(z.string()) })
        ),
      }),
      workspace: { kind: 'read-only', paths: ['agent_notes/', 'studio/'] },
    });
    if (history.kind !== 'ok') return x.log(`history ${history.kind}; nothing to design against`);
    await x.notebook.add(
      history.value.notes.map((n) => ({ kind: 'note' as const, ...n, claim: 'verified' as const }))
    );

    let head = 'origin-default';
    let warm = history.sessionId;
    await roundLoop(x, {
      plan: {
        focus: ['D01', 'D02', 'D06', 'A01', 'G01', 'G05', 'G10'],
        spikes: [],
        ownerQuestions: [],
      } as Plan,
      planSchema: Plan,
      leader: 'opus',
      head: async () => head,
      context: [
        { kind: 'all', rowKind: 'owner' },
        { kind: 'latest', rowKind: 'result', n: 40 },
      ],
      reflectPrompt:
        'Did the critique move a blocker (a ledger row covered, a spike verified, a ruling), or only add ' +
        'prose? Pick next focus rows, testable claims for spikes, and questions only the owner can settle.',
      watch: {
        pool: 'gemini',
        batchSeconds: 300,
        prompt:
          'Cancel a critique that re-attacks a row the owner already ruled on. ' +
          'End the round if the proposal reverts to a design already in the notebook as abandoned.',
      },
      round: async (plan, n) => {
        const draft = await x.agent({
          key: `propose-${n}`,
          pool: 'opus',
          usd: 10,
          warm: { from: warm },
          prompt:
            `Revise ${DOC} for rows ${plan.focus.join(', ')}. Where an owner question is open, follow its default ` +
            `and say so. Update ${OUT}/RETIREMENT.md. Commit.`,
          context: [
            { kind: 'all', rowKind: 'note' },
            { kind: 'all', rowKind: 'owner' },
            { kind: 'latest', rowKind: 'result', n: 40 },
          ],
          output: Draft,
          workspace: {
            kind: 'worktree',
            base: head === 'origin-default' ? 'origin-default' : { sha: head },
            fence: [DOC, OUT],
          },
        });
        if (draft.kind !== 'ok') return `propose ${draft.kind}`;
        warm = draft.sessionId;
        // Critique and spikes are independent: start the critique, run the spikes while it works.
        const critique = x.agent({
          key: `critique-${n}`,
          pool: 'codex',
          usd: 6,
          output: Attacks,
          prompt: `Attack draft ${draft.value.sha} row by row against ${LEDGER} and ${GOALS}. Each attack names a test.`,
          workspace: {
            kind: 'read-only',
            paths: [DOC, OUT, LEDGER, GOALS, 'studio/design_kernel/'],
          },
        });
        const spikes = await x.parallel(
          plan.spikes.map(
            (s) => () =>
              x.sample({
                key: `spike-${n}-${s.id}`,
                family: `spike-${s.id}`,
                gauge: 'machine',
                want: 8,
                // The prototyper runs its own test loop on a cpu slot; the verdict is timed on the idle bench.
                // Both pools cap the granted width (narrowedBy 'pool'), which is the honest limit here.
                make: () => ({
                  pool: 'sonnet',
                  alsoHolds: ['cpu'],
                  usd: 3,
                  output: Spike,
                  prompt: `Prototype the smallest code that tests: ${s.claim}. Iterate against \`${s.run}\` yourself. Commit.`,
                  workspace: {
                    kind: 'worktree',
                    base: 'origin-default',
                    fence: ['tools/document_model_spikes_v1/'],
                  },
                }),
                verify: (v) => ({
                  key: `verify-${n}-${s.id}-${v.sha}`,
                  pool: 'bench',
                  run: s.run,
                  at: { sha: v.sha },
                  seconds: 600,
                }),
              })
          )
        );
        for (const [i, s] of plan.spikes.entries()) {
          const r = spikes[i];
          await x.notebook.add([
            {
              kind: 'note',
              id: `spike-${n}-${s.id}`,
              claim: 'verified',
              sources: [s.run],
              text: `${s.claim}: ${r.kept.length}/${r.granted} passed (narrowed by ${r.narrowedBy})`,
            },
            ...r.kept.map((k) => ({
              kind: 'result' as const,
              id: `spike-${n}-${s.id}-${k.i}`,
              ideaId: `spike-${n}-${s.id}`,
              sha: k.value.sha,
              verdict: 'keep' as const,
              evidence: `${s.run} passed at ${k.value.sha}: ${k.value.approach}`,
            })),
          ]);
        }
        const attacks = await critique;
        if (attacks.kind === 'ok') {
          await x.notebook.add(
            attacks.value.attacks.map((a) => ({
              kind: 'idea' as const,
              id: `atk-${n}-${a.id}`,
              family: `row-${a.row}`,
              hypothesis: a.claim,
              prediction: a.test,
              by: 'codex',
            }))
          );
          const judged = await x.agent({
            key: `adjudicate-${n}`,
            pool: 'gemini',
            usd: 4,
            output: Rulings,
            prompt: `Rule on each attack against draft ${draft.value.sha}: stands, answered by the draft, or needs the owner.`,
            context: [
              { kind: 'ids', ids: attacks.value.attacks.map((a) => `atk-${n}-${a.id}`) },
              { kind: 'all', rowKind: 'owner' },
            ],
            workspace: { kind: 'read-only', paths: [DOC, OUT, LEDGER] },
          });
          if (judged.kind === 'ok')
            await x.notebook.add(
              judged.value.rulings.map((r) => ({
                kind: 'result' as const,
                id: `rule-${n}-${r.attackId}`,
                ideaId: `atk-${n}-${r.attackId}`,
                sha: draft.value.sha,
                verdict: RULING[r.verdict],
                evidence: r.why,
              }))
            );
        }
        // Land the draft every round, so a design never sits beside main in a worktree.
        const at = { sha: draft.value.sha };
        const landed = await x.integrate({
          key: `land-${n}`,
          sha: at.sha,
          recheck: [
            { key: `cov-${n}`, pool: 'cpu', run: COVERAGE, at, seconds: 120 },
            { key: `ex-${n}`, pool: 'cpu', run: EXAMPLES, at, seconds: 120 },
          ],
        });
        if (landed.kind === 'integrated') head = landed.sha;
        // Owner questions hold no slot. The round proceeds on each question's default meanwhile.
        // API GAP: Call has no non-blocking settled()/peek, so the round must await the answers here;
        // ideally an unanswered question would carry into the next round instead of holding this one.
        const answers = await x.parallel(
          plan.ownerQuestions.map(
            (q) => () =>
              x.ask({
                key: `ask-${n}-${q.id}`,
                question: `${q.question} (default: ${q.default})`,
                answer: z.string(),
              })
          )
        );
        await x.notebook.add(
          answers.flatMap((a, i) =>
            a.kind === 'answered'
              ? [
                  {
                    kind: 'owner' as const,
                    id: `ruling-${n}-${plan.ownerQuestions[i].id}`,
                    text: a.value,
                  },
                ]
              : []
          )
        );
        return `${landed.kind}; ${answers.filter((a) => a.kind === 'answered').length}/${answers.length} answered`;
      },
    });
  },
});
