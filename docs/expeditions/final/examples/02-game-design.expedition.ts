/**
 * Case 2 — Tidewar balance: AI-vs-AI A/B over rule levers, a theory loop, a human playtest.
 *
 * Shape: fix the measuring stick → hunt exploits → revisable rounds led by the Theorist (fixes,
 * ≤4 one-family levers A/B'd on frozen seeds, serial stacking with a re-measure) → owner playtest.
 * Scaling: wide where the verifier is cheap and exact (64 seeds × mirror per A/B at ~6.5 s CPU a
 * match; ≤4 independent levers, one worktree each). Narrow where it is not: one Theorist, one
 * serially integrated stack, every build behind the compile lock (~8 min wall a rebuild), so the
 * lock, not agent count, sets lever width (research/scaling.md rules 1, 2, 5, 6).
 * Fixes round 1 (38 agents, 7 experiments, 0 shipped): the stick is fixed first (first blood at
 * 55 s on all 48 seeds), the exploit hunt precedes experiments, a fixer seat edits code,
 * predictions are recorded before runs, kept levers are re-measured stacked with --mirror, and
 * finish is judged on the reserved seeds 1001..1048, never the seeds levers were tuned on.
 */
import { z } from 'zod';
import { expedition } from '../expedition';
import { roundLoop } from '../lib/round-loop';

const THEORY = 'notes/design/2026-11-01_tidewar_balance_theory.md';
const META = 'notes/design/2026-11-01_balance_swarm_meta_prompt.md';
// tools/balance/* does not exist yet: wrappers over `keel_cli tidewar --summary` and reports/
// tidewar-balance/compare.py (paired sign test, unfinished games censored); binaries cached by SHA.
const BUILD = 'keel/scripts/lib/build_gate.sh cargo build --release -p keel_cli';
const AB = (sha: string, predict: string) =>
  `tools/balance/ab.sh --base origin/main --cand ${sha} --seeds 1..64 --mirror --predict '${predict}' --json`;
const HOLDOUT = 'tools/balance/summary.sh --seeds 1001..1048 --mirror --json';
const ANGLES = ['economy and shop', 'range and tower reach', 'unit duplication and spawn'];

const Lever = z.object({
  id: z.string(),
  family: z.string(),
  change: z.string(),
  files: z.array(z.string()),
  prediction: z.string(), // machine-checkable, recorded before the run: "medianMinutes<=18"
  owner: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('within-rulings') }),
    z.object({ kind: z.literal('bends-ruling'), ruling: z.string() }),
  ]),
});
type Lever = z.infer<typeof Lever>;
const Plan = z.object({ fixes: z.array(z.string()), levers: z.array(Lever).max(4) });
const Commit = z.object({ sha: z.string(), summary: z.string() });
const Exploit = z.object({ name: z.string(), repro: z.string(), sha: z.string() });
type Outcome =
  | { kind: 'kept'; lever: Lever; sha: string }
  | { kind: 'dropped'; lever: Lever; why: string };

export default expedition({
  name: 'tidewar-balance',
  userGoal:
    'Get Tidewar balanced on the shipped map: 12–20 minute matches, a Kraken about every 4.5 minutes, no team ' +
    'bias, fun proxies in range — measured honestly, exploits closed, my rulings untouched, then I playtest it.',
  objective: {
    criteria: [
      {
        kind: 'check',
        id: 'fairness',
        run: 'keel/scripts/lib/build_gate.sh cargo test -p game_bships --test fairness',
        pool: 'build',
      },
      {
        kind: 'check',
        id: 'exploits-closed',
        run: 'tools/balance/exploits.sh --all --expect-none',
        pool: 'sim',
      },
      {
        kind: 'metric',
        id: 'length-max',
        run: HOLDOUT,
        pool: 'sim',
        field: 'medianMinutes',
        op: '<=',
        bound: 20,
      },
      {
        kind: 'metric',
        id: 'length-min',
        run: HOLDOUT,
        pool: 'sim',
        field: 'medianMinutes',
        op: '>=',
        bound: 12,
      },
      {
        kind: 'metric',
        id: 'kraken-cadence',
        run: HOLDOUT,
        pool: 'sim',
        field: 'krakenIntervalMinutes',
        op: '<=',
        bound: 5.5,
      },
      {
        kind: 'metric',
        id: 'no-team-bias',
        run: HOLDOUT,
        pool: 'sim',
        field: 'teamBiasSignP',
        op: '>=',
        bound: 0.05,
      }, // 96 games ≥ 64
      {
        kind: 'metric',
        id: 'lead-changes',
        run: HOLDOUT,
        pool: 'sim',
        field: 'medianLeadChanges',
        op: '>=',
        bound: 2,
      },
      {
        kind: 'judged',
        id: 'meta-lessons',
        rubric: `${META} carries this run's lessons, each tied to a progression-log row.`,
        judge: 'gemini',
        pass: 0.8,
      },
      {
        kind: 'owner',
        id: 'playtest',
        ask: 'Play the checklist in design_docs/PLAYTEST_LOG.md. AI-vs-AI measures structure, not feel: does it pass?',
      },
    ],
  },
  repo: { path: '~/git/room-runners-arena-lib' },
  budget: { usd: 120, hours: 12 },
  pools: {
    opus: {
      kind: 'agent',
      seat: { provider: 'claude', model: 'claude-opus-5-5', effort: 'high' },
      slots: 2,
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
    gemini: {
      kind: 'agent',
      seat: { provider: 'gemini', model: 'gemini-3.1-pro-preview', effort: 'high' },
      slots: 1,
    },
    build: { kind: 'local', slots: 1, lock: 'rr-compile' }, // the lock keel/scripts/lib/build_gate.sh takes
    sim: { kind: 'local', slots: 4, lock: null }, // load runs 60–200 on the shared box; 4 is the polite cap
  },
  rules: [
    'Owner rulings are fixed: the flagship stays shielded until all three Inner towers are sunk. A lever that bends a ruling is asked, never applied.',
    'One mechanism family per experiment; every knob ships in the pacing block, default off.',
    'Same seed set for A and B; never lower a bar after seeing results; no tick timings on a loaded host.',
    'Agents never deploy to the Hetzner server.',
  ],

  async run(x) {
    let head = '';
    const exp = (prompt: string, fence: string[]) => ({
      prompt,
      output: Commit,
      workspace: { kind: 'worktree' as const, base: { sha: head }, fence },
    });
    // API GAP: integrate's recheck takes CheckSpecs, which require `at`, though integrate picks the commit
    // (the merged one), and a multi-check recheck's order is unstated. Assumed: build, then sims, in order.
    const land = async (key: string, sha: string, sims: string[]) => {
      const r = await x.integrate({
        key,
        sha,
        recheck: [
          { key: `${key}-build`, pool: 'build', run: BUILD, at: 'origin-default', seconds: 1200 },
          ...sims.map((run, i) => ({
            key: `${key}-sim${i}`,
            pool: 'sim' as const,
            run,
            at: 'origin-default' as const,
            seconds: 1800,
          })),
        ],
      });
      if (r.kind === 'integrated') head = r.sha;
      return r;
    };

    // 1. Instrument first. It runs its own build → simulate loop, so it holds the lock and the sims.
    const inst = await x.agent({
      key: 'instrument',
      pool: 'codex',
      alsoHolds: ['build', 'sim'],
      usd: 8,
      output: Commit,
      prompt:
        'Make 48 seeds 48 samples (DetRng persona variation; first blood was 55 s on every seed) and record the ' +
        'knobs-off --mirror baseline (last time towers-ahead 59/23 from geography). Commit.',
      workspace: {
        kind: 'worktree',
        base: 'origin-default',
        fence: ['keel/games/game_bships/src/ai/', 'tools/balance/'],
      },
    });
    if (inst.kind !== 'ok')
      return x.log(`instrumenter ${inst.kind}: no lever runs on a broken stick`);
    const stick = await land('stick', inst.value.sha, [
      'tools/balance/seed_variety.sh --seeds 1..48 --min-distinct 40',
    ]);
    if (stick.kind !== 'integrated') return x.log(`stick not integrated: ${stick.kind}`);
    await x.notebook.add([
      {
        kind: 'note',
        id: 'baseline',
        text: inst.value.summary,
        claim: 'verified',
        sources: [head],
      },
    ]);

    // 2. Exploit hunt before any experiment. Machine-verified (a headless repro must reproduce).
    const hunt = await x.sample({
      key: 'exploit-hunt',
      family: 'exploit',
      gauge: 'machine',
      want: 3,
      make: (i) => ({
        pool: 'codex',
        usd: 5,
        ...exp(
          `Find a dominant or degenerate strategy; angle: ${ANGLES[i % 3]}. ` +
            'Commit a headless repro script under tools/balance/exploits/.',
          ['tools/balance/exploits/']
        ),
        output: Exploit,
      }),
      verify: (e) => ({
        key: `repro-${e.name}`,
        pool: 'sim',
        run: `tools/balance/exploits.sh --only ${e.repro} --expect-reproduces`,
        at: { sha: e.sha },
        seconds: 900,
      }),
    });
    await x.notebook.add(
      hunt.kept.map(({ value: e }) => ({
        kind: 'note' as const,
        id: `exploit-${e.name}`,
        text: e.repro,
        claim: 'verified' as const,
        sources: [e.sha],
      }))
    );

    // One experiment: prediction on record → implement → build (lock) → A/B (sims) → result row.
    const experiment = async (l: Lever): Promise<Outcome> => {
      if (l.owner.kind === 'bends-ruling') {
        const ok = await x.ask({
          key: `ruling-${l.id}`,
          question: `Lever ${l.id} bends "${l.owner.ruling}": ${l.change}. Test it?`,
          answer: z.boolean(),
        });
        if (ok.kind !== 'answered' || !ok.value)
          return { kind: 'dropped', lever: l, why: 'ruling stands' };
      }
      await x.notebook.add([
        {
          kind: 'idea',
          id: l.id,
          family: l.family,
          hypothesis: l.change,
          prediction: l.prediction,
          by: 'theorist',
        },
      ]);
      const impl = await x.agent({
        key: `lever-${l.id}`,
        pool: 'sonnet',
        usd: 3,
        context: [{ kind: 'family', family: l.family }],
        ...exp(
          `Implement exactly this ${l.family} lever as a pacing knob: ${l.change}. Commit; do not run matches.`,
          l.files
        ),
      });
      if (impl.kind !== 'ok') return { kind: 'dropped', lever: l, why: `implement ${impl.kind}` };
      const at = { sha: impl.value.sha };
      const built = await x.check({
        key: `build-${l.id}`,
        pool: 'build',
        run: BUILD,
        at,
        seconds: 1200,
      });
      if (built.kind !== 'pass') return { kind: 'dropped', lever: l, why: `build ${built.kind}` };
      const ab = await x.check({
        key: `ab-${l.id}`,
        pool: 'sim',
        run: AB(at.sha, l.prediction),
        at,
        seconds: 1800,
      });
      const verdict = ab.kind === 'pass' ? 'keep' : ab.kind === 'fail' ? 'reject' : 'unjudged';
      const evidence =
        ab.kind === 'pass' ? JSON.stringify(ab.report) : ab.kind === 'fail' ? ab.tail : ab.reason;
      await x.notebook.add([
        { kind: 'result', id: `r-${l.id}`, ideaId: l.id, sha: at.sha, verdict, evidence },
      ]);
      return verdict === 'keep'
        ? { kind: 'kept', lever: l, sha: at.sha }
        : { kind: 'dropped', lever: l, why: verdict };
    };

    // 3. Rounds. Round 1 carries only the exploit fixes; the Theorist's first reflection adds levers.
    await roundLoop(x, {
      plan: {
        fixes: hunt.kept.map(
          ({ value: e }) => `Close ${e.name}; ${e.repro} must stop reproducing.`
        ),
        levers: [],
      },
      planSchema: Plan,
      leader: 'opus',
      head: async () => head,
      round: async (plan, n) => {
        // Fixes land first, by a seat that can edit code (round 1's reflectors could not).
        for (const [i, fix] of plan.fixes.entries()) {
          const f = await x.agent({
            key: `fix-${n}-${i}`,
            pool: 'codex',
            usd: 4,
            ...exp(fix, ['keel/games/game_bships/src/']),
          });
          if (f.kind === 'ok')
            await land(`fix-${n}-${i}`, f.value.sha, [
              'tools/balance/exploits.sh --all --expect-none',
            ]);
        }
        const outcomes = await x.parallel(plan.levers.map((l) => () => experiment(l)));
        // Confirmed alone ≠ confirmed together: each kept lever is re-measured on the stack, serially.
        for (const o of outcomes) {
          if (o.kind !== 'kept') continue;
          const s = await land(`stack-${o.lever.id}`, o.sha, [AB('HEAD', 'teamBiasSignP>=0.05')]);
          if (s.kind !== 'integrated')
            await x.notebook.add([
              {
                kind: 'supersede',
                id: `s-${o.lever.id}`,
                replaces: `r-${o.lever.id}`,
                reason: `stack ${s.kind}`,
              },
            ]);
        }
        // One scribe owns the shared docs this phase: progression log (refuted rows stay) + meta-prompt lessons.
        const doc = await x.agent({
          key: `scribe-${n}`,
          pool: 'opus',
          usd: 2,
          context: [
            { kind: 'latest', rowKind: 'idea', n: 8 },
            { kind: 'latest', rowKind: 'result', n: 8 },
            { kind: 'latest', rowKind: 'supersede', n: 8 },
          ],
          ...exp(
            `Append round ${n} to the progression log in ${THEORY} (lever, prediction, seeds, binary SHA, numbers, ` +
              `verdict) and fold its lessons into ${META}. Tag numbers [measured]/[derived]/[assumption].`,
            [THEORY, META]
          ),
        });
        if (doc.kind === 'ok') await land(`scribe-${n}`, doc.value.sha, []);
        return `${plan.fixes.length} fixes, ${outcomes.filter((o) => o.kind === 'kept').length}/${outcomes.length} levers kept`;
      },
      reflectPrompt:
        'You are the Theorist. Grade each prediction against its result row. Propose ≤4 levers, one mechanism family ' +
        'each; never re-test a refuted family without a representation change; gold-only levers are inert while the AI ' +
        'build is already finished. Put code blockers in `fixes`. "No change worth shipping" is a valid finish.',
      context: [
        { kind: 'all', rowKind: 'idea' },
        { kind: 'all', rowKind: 'result' },
        { kind: 'all', rowKind: 'note' },
        { kind: 'all', rowKind: 'owner' },
      ],
      watch: {
        pool: 'opus',
        batchSeconds: 300,
        prompt:
          'Cancel an experimenter editing outside its lever family; end the ' +
          'round if an A/B shows identical outcomes across seeds (broken stick or new exploit). Never steer a measurement.',
      },
    });
  },
});
