import { z } from 'zod';
import {
  type Readable,
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

const RUNS = 'reports/tidewar-balance';
const GAME = 'keel/games/game_bships';
const SPREAD = `python3 -I ${RUNS}/spread.py --seeds 16`; // exit 0 when different seeds give different early games
const SUITE = check(
  'keel/scripts/dev.sh test game_bships --test it',
  `${GAME}/tests/it/fairness.rs`
).needs('compile');
const Exp = z.object({ id: z.string(), family: z.string(), idea: z.string() });
const Ab = z.object({ inTarget: z.number() }); // matches of 48 that end in 12-20 min

// Who. Three providers: the coder builds, the hunter breaks, and the judge shares neither one's model.
const judge = seat('gemini', 'gemini-3.1-pro-preview', 'high');
const lead = role({ by: buddy('game-design'), max: usd(8), minutes: 45 }).reads(
  'notes/design/',
  RUNS,
  'keel/GAMES.md'
);
const coder = role({ by: seat('claude', 'claude-sonnet-5-5', 'high'), max: usd(5), minutes: 60 });
const hunter = role({ by: seat('codex', 'gpt-6.1-sol', 'high'), max: usd(6), minutes: 45 });

const { spread, unblock, hunt, theorize, change, ab, stack, confirm, record } = steps({
  spread: command(SPREAD, { minutes: 20 }).needs('cpu').protect(`${RUNS}/spread.py`),
  unblock: coder.in(checkout(`${GAME}/`, 'keel/tools/keel_cli/')).judged(SUITE),
  hunt: hunter
    .in(checkout(`${RUNS}/exploits/`))
    .returns(z.object({ blocking: z.number() }))
    .judged(review('exploit-evidence', judge)),
  theorize: lead
    .in(checkout('notes/design/'))
    .lists(Exp)
    .judged(check(`python3 -I ${RUNS}/predictions.py`, `${RUNS}/predictions.py`)),
  change: coder
    .in(checkout(`${RUNS}/variants/`, `${GAME}/src/`))
    .judged(review('one-lever', judge)),
  // The paired A/B on seeds 1..48. Exit 0: confirmed. Exit 1: refuted, numbers still printed.
  ab: command(`${RUNS}/ab.sh --variant {{id}}`, { minutes: 40 })
    .returns(Ab)
    .needs('cpu')
    .protect(`${RUNS}/ab.sh`, `${RUNS}/compare.py`, `${RUNS}/baseline/`),
  stack: coder
    .in(checkout(`${RUNS}/variants/`, `${GAME}/src/`, 'keel/content/tidewar-map.json'))
    .judged(SUITE),
  confirm: command(`python3 -I ${RUNS}/targets.py --seed-start 1001 --seeds 48 --mirror`, {
    minutes: 60,
  })
    .needs('cpu', 'fresh-seeds')
    .protect(`${RUNS}/targets.py`),
  record: lead
    .in(checkout('notes/design/', `${RUNS}/`, 'key_learnings/'))
    .judged(review('log-honest', judge)),
});

export default plan(async (x) => {
  // Round 0. If 48 seeds are one sample, fixing the measuring stick becomes a goal of its own.
  const sampled = await x.phase('stick', () => spread());
  if (sampled.t !== 'passed') {
    const stick = x.goal('measuring-stick', {
      why: 'Different seeds play the same early game, so a seed set is one sample.',
      done: [check(SPREAD)],
    });
    const fixed = await stick.phase('instrument', () => unblock({ id: 'stick', reads: [sampled] }));
    if (fixed.t !== 'passed')
      return gap(
        'The measuring stick is broken and the fix did not pass the game tests.',
        sampled,
        fixed
      );
    const ok = await stick.met(fixed.value);
    if (ok.t !== 'passed')
      return gap(
        'Seeds still do not give independent games; no experiment would mean anything.',
        ok
      );
    if ((await x.land('stick', ok.value)).t !== 'passed')
      return gap('The measuring-stick fix failed its re-check on main.', ok);
  }
  const hunted = await x.phase('exploits', () => hunt({ id: 'base' })); // before any lever, not after stacking
  if (hunted.t === 'passed' && hunted.value.out.blocking > 0) {
    const cleared = await x.phase('unblock', () =>
      unblock({ id: 'exploits', reads: [hunted.value] })
    );
    if (cleared.t !== 'passed')
      return gap(
        'A known exploit confounds every experiment and its fix did not pass.',
        hunted,
        cleared
      );
    if ((await x.land('exploits', cleared.value)).t !== 'passed')
      return gap('The exploit fix failed its re-check on main.', cleared);
  }
  await x.review(
    'Is the baseline now a fair measuring stick, or does a confound or a map bias remain?'
  );

  const exps = await x.phase('theory', () => theorize({ reads: [x.learnings('all'), hunted] }));
  if (exps.t !== 'passed' || exps.value.out.length === 0)
    return gap('The theorist found no untested lever with a written prediction.', exps);
  // Predictions are on main before anything is measured, and every later call starts from them.
  if ((await x.land('predictions', exps.value)).t !== 'passed')
    return gap('The prediction rows failed their re-check on main.', exps);

  // One lever per worker, fenced to its own variant map. One runs first; the rest only if it passes review.
  const made = passed(
    await x.phase('levers', () =>
      wide(exps.value.out, (e) =>
        change({
          item: e,
          fence: [`${RUNS}/variants/${e.id}.json`, `${GAME}/src/`],
          reads: [x.learnings({ family: e.family })],
        })
      )
    )
  );
  // The host measures each lever alone and writes its learning row: passed is keep, failed is reject.
  // Not `wide`: a refuted lever is a valid result, and a refuted pilot must not refuse the rest (NOTES.md).
  const trials = await x.phase('measure', () =>
    Promise.all(
      made.map(async (m) => ({
        item: m,
        result: await ab({ id: m.item.id, item: m.item, on: m.value, tests: m.item }),
      }))
    )
  );
  await x.review(
    'Which levers moved the game, and did the theory predict it? "No change worth shipping" is a valid result.'
  );

  // Keep the three best confirmed levers, stack them, and measure the stack again: confirmed levers interact.
  const evidence: Readable[] = [x.learnings('all'), ...trials.map((t) => t.result)];
  const top = best(passed(trials), (k) => k.value.out.inTarget, 3);
  const outcome = await x.phase('stack', async () => {
    if (top.length === 0) return 'No lever was confirmed alone, so nothing was stacked.';
    const stacked = await stack({ reads: top.flatMap((k) => [k.item.value, k.value]) });
    evidence.push(stacked);
    if (stacked.t !== 'passed') return 'The stack did not pass the game tests.';
    const again = await ab({ id: 'stack', item: { id: 'stack' }, on: stacked.value });
    const clean = await hunt({ id: 'stack', on: stacked.value });
    evidence.push(again, clean);
    if (again.t !== 'passed') return 'The stack was dropped at its re-measurement.';
    if (clean.t !== 'passed' || clean.value.out.blocking > 0)
      return 'The stack was dropped at the exploit hunt.';
    const fresh = await confirm({ on: stacked.value }); // the reserved seed set: one use, then it is spent
    evidence.push(fresh);
    if (fresh.t !== 'passed')
      return 'The stack was dropped on the reserved seeds, which are now spent.';
    const played = await x.confirm(
      'Play two matches on the stacked candidate with the checklist in the theory doc, section 14. Does it pass?'
    );
    if (!played)
      return 'The stack passed every measured gate. The owner played it and it did not pass.';
    const landed = await x.land('candidate', stacked.value);
    return landed.t === 'passed'
      ? 'The stack passed every gate, the owner playtest included, and is on main.'
      : 'The stack passed every gate but failed its re-check on main.';
  });

  // The log is written whether or not anything ships. A refuted round still lands its rows and lessons.
  const logged = await x.phase('record', () => record({ reads: [outcome, ...evidence] }));
  if (logged.t !== 'passed')
    return gap(
      'The progression log did not pass review, so it was not landed.',
      logged,
      ...evidence
    );
  if ((await x.land('round', logged.value)).t !== 'passed')
    return gap('The round log failed its re-check on main.', logged);
  return logged.value;
});
