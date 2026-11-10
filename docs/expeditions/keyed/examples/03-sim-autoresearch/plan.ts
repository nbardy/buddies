import { z } from 'zod';
import {
  type Held,
  best,
  buddy,
  check,
  checkout,
  command,
  gap,
  passed,
  plan,
  review,
  role,
  seat,
  steps,
  usd,
  wide,
} from '../../api/expedition';

const ENGINE = 'prototypes/surf_engine_v1/src/';
const BENCH = 'tools/speed_search_v1';
const PROTOCOL = 'benchmarks/speed_search_v1/protocol.json';
const MAX_SPREAD = 0.03; // an A/A pair must agree to 3% before any A/B ratio is believed

const Case = z.object({ id: z.string() });
const Noise = z.object({ spread: z.number() }); // A/A: worst |T_a / T_a' − 1| over the ABBA blocks
const Idea = z.object({
  id: z.string(),
  family: z.string(),
  idea: z.string(),
  prediction: z.string(),
});
const Score = z.object({ speedup: z.number() }); // T_control / T_candidate, at matched error

// Who. Implementers and the judge sit on providers other than the lead's; numbers decide where they can.
const judge = seat('gemini', 'gemini-3.1-pro-preview', 'high');
const lead = role({ by: buddy('wave-simulation-lead'), max: usd(6), minutes: 45 }).reads(
  'KEY_LEARNINGS.md',
  'SHADER_AND_PERFORMANCE_TRICKS.md',
  'auto_research/'
);
const coder = role({ by: seat('codex', 'gpt-6.1-sol', 'high'), max: usd(5), minutes: 60 });
const abba = (flags: string) => `python3 ${BENCH}/abba.py ${flags} --json`;
const modal = '--all --device modal-l4 --require-matched';

const { cases, noise, instrument, propose, implement, gate, confirm, record } = steps({
  cases: command(`python3 ${BENCH}/cases.py --json`, { minutes: 1 }).lists(Case),
  noise: command(abba('--aa --case {{id}} --device modal-l4 --max-usd 0.50'), { minutes: 20 })
    .returns(Noise)
    .needs('modal'),
  instrument: coder.in(checkout(`${BENCH}/`)),
  propose: lead.lists(Idea),
  // A candidate is valid when the engine tests pass and the free local screen says its error is matched.
  implement: coder
    .in(checkout(ENGINE))
    .judged(
      check(
        `bun test ${ENGINE} && ${abba('--case dam_break --device local-m4 --require-matched')}`
      ).needs('gpu')
    ),
  // Exit 0 only when faster than the A/A spread at matched error, so passed is `keep` and failed is `reject`.
  gate: command(abba(`${modal} --blocks 2 --require-speedup ${1 + MAX_SPREAD} --max-usd 1.00`), {
    minutes: 40,
  })
    .returns(Score)
    .needs('modal')
    .protect(PROTOCOL),
  confirm: command(
    abba(`${modal} --blocks 6 --complete-cost --require-speedup 1.15 --max-usd 4.00`),
    { minutes: 120 }
  )
    .needs('modal', 'confirm')
    .protect(PROTOCOL),
  record: lead
    .in(checkout('KEY_LEARNINGS.md', 'benchmarks/speed_search_v1/results/'))
    .judged(review('speed-claim', judge)),
});

export default plan(async (x) => {
  const set = await x.phase('cases', () => cases());
  if (set.t !== 'passed') return gap('The frozen case set could not be listed.', set);

  // A/A on every frozen case, in parallel on Modal. `wide` pays for one case before the rest.
  const aa = passed(
    await x.phase('noise', () => wide(set.value.out, (c) => noise({ item: c })))
  ).map((a) => a.value);
  if (aa.length < set.value.out.length || Math.max(...aa.map((a) => a.out.spread)) > MAX_SPREAD) {
    const quiet = check(
      abba(`--aa --all --device modal-l4 --max-spread ${MAX_SPREAD} --max-usd 2.00`)
    ).needs('modal');
    const stick = x.goal('measuring-stick', {
      why: 'A/A spread exceeds the speedups we are searching for.',
      done: [quiet],
    });
    const fixed = await stick.phase('instrument', () => instrument({ reads: aa }));
    const ok = fixed.t === 'passed' ? await stick.met(fixed.value) : fixed;
    if (ok.t !== 'passed')
      return gap('The benchmark cannot tell A from A, and its repair did not pass.', ok, ...aa);
    await x.land('measuring-stick', ok.value); // the tip moves: every later call starts from the repaired harness
  }
  await x.review(
    'Is the measuring stick trustworthy on every frozen case? If one case is the noisy one, should it leave the set (an owner decision)?'
  );

  // Population search: three generations, keep the best three. The host records every other one as a reject.
  let keep: { id: string; code: Held<unknown>; speedup: number }[] = [];
  for (const gen of [1, 2, 3]) {
    await x.phase(`generation-${gen}`, async () => {
      const ideas = await propose({
        id: gen,
        item: { gen },
        reads: [x.learnings('all'), ...keep.map((k) => k.code)],
      });
      if (ideas.t !== 'passed') return;
      await wide(ideas.value.out, async (i) => {
        const tests = { family: i.family, idea: i.idea };
        const built = await implement({
          item: i,
          tests,
          reads: [x.learnings({ family: i.family })],
        }); // local GPU: one at a time
        if (built.t !== 'passed') return built;
        const scored = await gate({ item: i, on: built.value, tests }); // Modal: up to four at once
        if (scored.t === 'passed')
          keep.push({ id: i.id, code: built.value, speedup: scored.value.out.speedup });
        return scored.t === 'failed' ? built : scored; // a measured "no" still proves the pipeline; only a broken run stops the rest
      });
      keep = best(keep, (k) => k.speedup, 3);
    });
    await x.review(
      `Generation ${gen}: did any family move matched-error speed, and did predictions match? Stop if two generations moved nothing.`
    );
  }

  // The long audit, best candidate first. The `confirm` pool allows two of these in the whole run.
  const winner = await x.phase('confirm', async () => {
    for (const k of keep) {
      const audit = await confirm({ id: k.id, on: k.code });
      if (audit.t === 'passed') return [k.code, audit.value];
    }
    return [];
  });
  // One write-up either way: the winner's evidence, or the graveyard rows alone.
  const written = await x.phase('record', () =>
    record({ on: winner[0], reads: [x.learnings('all'), ...winner] })
  );
  if (written.t !== 'passed')
    return gap('The write-up did not pass its independent audit.', written, ...winner);
  await x.land('result', written.value);
  return winner.length > 0
    ? written.value
    : gap(
        'No candidate was faster at matched error. The graveyard rows are landed.',
        written.value
      );
});
