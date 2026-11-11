/**
 * Case 1 — GTM market research: evidence → thesis → buyer test.
 *
 * Shape: wide collection (decomposable, verified per source) → one deep synthesis (narrow) →
 * three recorded attack/defend rounds on different providers → packet → owner.
 * Scaling: wide only where pieces are independent and checkable (one org each, anchored to
 * fetched pages); the synthesis and duel stay width 1 (research/scaling.md rules 1, 2, 5).
 * Fixes the 2026-11-08 run: the owner gate holds no slot, a pass never ends the run early,
 * and the producer and the critic are different providers.
 */
import { z } from 'zod';
import { expedition } from '../expedition';

const OUT = 'business/research/2026-11-10_gtm_expedition';

const Org = z.object({ name: z.string(), segment: z.string(), why: z.string() });
const Collected = z.object({
  org: z.string(),
  sources: z.array(
    z.object({ url: z.string(), status: z.enum(['fetched', 'missing', 'login-blocked']) })
  ),
  facts: z.array(z.object({ text: z.string(), quote: z.string(), url: z.string() })),
});
const Thesis = z.object({
  version: z.number(),
  claims: z.array(
    z.object({
      text: z.string(),
      level: z.enum(['verified', 'claimed', 'speculation']),
      sourceIds: z.array(z.string()),
    })
  ),
  beliefs: z.array(z.object({ belief: z.string(), falsifier: z.string() })),
});
const Attack = z.object({
  counterexample: z.string(),
  sourceIds: z.array(z.string()),
  newKey: z.string(),
});
const Verdict = z.object({ pass: z.boolean(), why: z.string() });

export default expedition({
  name: 'gtm-evidence-thesis-buyer-test',
  userGoal:
    'Find out who actually buys RL environments / simulation data, what they pay, and what they would never admit — ' +
    'build a traceable evidence packet, an adversarially tested thesis, and a buyer test I can run.',
  objective: {
    criteria: [
      {
        kind: 'check',
        id: 'ledger-complete',
        run: `python tools/gtm/audit_ledger.py ${OUT}`,
        pool: 'cpu',
      },
      {
        kind: 'metric',
        id: 'orgs-covered',
        run: `python tools/gtm/coverage.py ${OUT} --json`,
        pool: 'cpu',
        field: 'orgs',
        op: '>=',
        bound: 25,
      },
      {
        kind: 'judged',
        id: 'claims-traceable',
        rubric: 'Every load-bearing claim links to a fetched source that says it.',
        judge: 'gemini',
        pass: 0.9,
      },
      {
        kind: 'owner',
        id: 'owner-accepts',
        ask: 'Do you accept the packet and the buyer-test plan?',
      },
    ],
  },
  repo: { path: '~/git/wave_sim' },
  budget: { usd: 60, hours: 8 },
  pools: {
    opus: {
      kind: 'agent',
      seat: { provider: 'claude', model: 'claude-opus-5-5', effort: 'high' },
      slots: 1,
    },
    sonnet: {
      kind: 'agent',
      seat: { provider: 'claude', model: 'claude-sonnet-5-5', effort: 'medium' },
      slots: 6,
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
  },
  rules: [
    'No paid scraping or enrichment, no GPU, no outreach, no publication.',
    'Tag every claim VERIFIED, CLAIMED or SPECULATION. A polished report does not establish PMF.',
    `Raw page bodies go to output/ via artifact_store_v1; tracked files go under ${OUT}.`,
  ],

  async run(x) {
    // 1. Scope: one call lists the organizations. Narrow, cheap.
    const scope = await x.agent({
      key: 'scope',
      pool: 'opus',
      prompt:
        'Read business/plans/REVENUE_PLAN.md, 2026-10-22_gtm_program.md and 2026-10-03_rl_env_buyers/. ' +
        'List 25–40 organizations that buy or sell RL environments / sim data, with segment and why.',
      output: z.object({ orgs: z.array(Org) }),
      workspace: { kind: 'read-only', paths: ['business/'] },
      usd: 2,
    });
    if (scope.kind !== 'ok') return x.log(`scope failed: ${scope.kind}`);

    // 2. Collect: wide. One org per call, each verified by anchors (quote found in the stored page).
    const collected = await x.pipeline(
      scope.value.orgs,
      (_: unknown, org: z.infer<typeof Org>) =>
        x.agent({
          key: `collect-${org.name}`,
          pool: 'sonnet',
          prompt: `Collect product, pricing, docs and case-study pages for ${org.name}. Quote exactly; record every surface's status.`,
          output: Collected,
          workspace: { kind: 'worktree', base: 'origin-default', fence: [`${OUT}/sources/`] },
          usd: 1.5,
        }),
      async (
        r: Awaited<ReturnType<typeof x.agent<z.infer<typeof Collected>>>>,
        org: z.infer<typeof Org>
      ) => {
        if (r.kind !== 'ok')
          return x.notebook.add([
            {
              kind: 'note',
              id: `gap-${org.name}`,
              text: `collection ${r.kind}`,
              claim: 'verified',
              sources: [],
            },
          ]);
        const anchors = await x.check({
          key: `anchors-${org.name}`,
          pool: 'cpu',
          run: `python tools/gtm/anchors.py ${OUT}/sources/${org.name}`,
          at: 'origin-default',
          seconds: 120,
        });
        await x.notebook.add([
          ...r.value.sources.map((s, i) => ({
            kind: 'source' as const,
            id: `${org.name}-${i}`,
            url: s.url,
            status: s.status,
          })),
          ...r.value.facts.map((f, i) => ({
            kind: 'note' as const,
            id: `${org.name}-f${i}`,
            text: f.text,
            claim: anchors.kind === 'pass' ? ('verified' as const) : ('claimed' as const),
            sources: [f.url],
          })),
        ]);
      }
    );
    x.log(`collected ${collected.length} orgs`);

    // 3. Synthesis: narrow. One agent holds the whole corpus (reads all notes, failed ones included as gaps).
    let thesis = await x.agent({
      key: 'synthesis-v1',
      pool: 'opus',
      prompt:
        'Answer the forcing questions: what do winners know that customers would never admit; which beliefs ' +
        'does the industry take for granted, and what would make each false. Link every claim to source ids.',
      context: [
        { kind: 'all', rowKind: 'note' },
        { kind: 'all', rowKind: 'source' },
      ],
      output: Thesis,
      workspace: { kind: 'worktree', base: 'origin-default', fence: [`${OUT}/thesis/`] },
      usd: 8,
    });

    // 4. Adversarial loop: 3 recorded rounds, attacker on codex, judge on gemini, defender on claude.
    for (let round = 1; round <= 3 && thesis.kind === 'ok'; round++) {
      const attack = await x.agent({
        key: `attack-${round}`,
        pool: 'codex',
        prompt: `Find the strongest counterexample to thesis v${thesis.value.version} not already in the notebook. Give a new key.`,
        context: [
          { kind: 'all', rowKind: 'note' },
          { kind: 'latest', rowKind: 'idea', n: 10 },
        ],
        output: Attack,
        workspace: { kind: 'read-only', paths: [OUT] },
        usd: 4,
      });
      if (attack.kind !== 'ok') continue;
      await x.notebook.add([
        {
          kind: 'idea',
          id: attack.value.newKey,
          family: 'counterexample',
          hypothesis: attack.value.counterexample,
          prediction: 'thesis bends',
          by: 'codex',
        },
      ]);
      const real = await x.agent({
        key: `judge-attack-${round}`,
        pool: 'gemini',
        prompt: `Is this counterexample real, sourced and new? ${attack.value.counterexample}`,
        context: [{ kind: 'ids', ids: attack.value.sourceIds }],
        output: Verdict,
        workspace: { kind: 'read-only', paths: [OUT] },
        usd: 1,
      });
      if (real.kind !== 'ok' || !real.value.pass) continue;
      thesis = await x.agent({
        key: `revise-${round}`,
        pool: 'opus',
        prompt:
          'Revise or reject the thesis against the counterexample. Keep the original thesis text in the record.',
        context: [
          { kind: 'ids', ids: [attack.value.newKey] },
          { kind: 'all', rowKind: 'note' },
        ],
        output: Thesis,
        workspace: { kind: 'worktree', base: 'origin-default', fence: [`${OUT}/thesis/`] },
        usd: 5,
      });
    }

    // 5. Packet + buyer test, then finish. Owner criteria become an ask that holds no slot.
    const packet = await x.agent({
      key: 'packet',
      pool: 'opus',
      prompt:
        'Write the packet: coverage counts with candid gaps, thesis history, belief/falsifier table, and a buyer ' +
        'test (5 accounts, checked contact routes, pass rule ≥2 concrete current cases and ≥1 scoped next step). Commit it.',
      context: [
        { kind: 'all', rowKind: 'note' },
        { kind: 'all', rowKind: 'idea' },
      ],
      output: z.object({ sha: z.string(), summary: z.string() }),
      workspace: { kind: 'worktree', base: 'origin-default', fence: [OUT] },
      usd: 6,
    });
    if (packet.kind !== 'ok') return x.log('packet failed; deadline will close with gaps');
    const done = await x.finish({ sha: packet.value.sha, report: packet.value.summary });
    x.log(`finish: ${done.kind}`);
  },
});
