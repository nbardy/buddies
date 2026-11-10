import { z } from 'zod';
import {
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
} from '../../api/expedition';
import type { Held, Readable } from '../../api/expedition';

const PACKET = 'auto_research/experiments/pending/astra_wave_sim_restart_v1';
const HANDOFF = 'theory/radical_wave_computation/astra_handoff/v1';
const RUN = 'auto_research/experiments/astra_wave_sim_restart_2026-11-10';
const HARDWARE = `${PACKET}/MODEL_AND_HARDWARE_CONTRACT.md`;
const BLIND = [`${HANDOFF}/MINIMAL_PROBLEM.md`, HARDWARE]; // the whole allowlist of a blind run
const TRACKS = ['N00-A', 'N00-B', 'S00-A', 'S00-B'] as const;

const Pick = z.object({
  id: z.string(),
  source: z.enum(TRACKS),
  premise: z.string(),
  kill: z.string(),
});
const [Kin, Receipt] = [z.object({ family: z.string() }), z.object({ speedup: z.number() })];

// Who. Inventors are anonymous seats: a named Buddy would carry its memory of the project into a
// blind run. Nobody on the inventors' provider judges anything.
const gemini = seat('gemini', 'gemini-3.1-pro-preview', 'high');
const redTeam = seat('claude', 'claude-opus-5-5', 'high');
const inventor = role({ by: seat('codex', 'gpt-6-astra', 'high'), max: usd(30), minutes: 240 });
const outsider = role({ by: gemini, max: usd(8), minutes: 60 });
const builder = role({ by: redTeam, max: usd(25), minutes: 180 }).in(
  checkout(`${RUN}/candidates/`)
);
const keeper = role({ by: buddy('simulation-research'), max: usd(6), minutes: 45 });

const { frozen, neutral, subvolume, census, lineage, build, falsify, claim, record } = steps({
  frozen: command(
    `! rg -q TBD_AT_LAUNCH ${HARDWARE} ${PACKET}/REFERENCE_AND_ACCOUNTING_CONTRACT.md`,
    { minutes: 1 }
  ),
  neutral: inventor.reads(...BLIND).judged(review('math-red-team', redTeam)),
  subvolume: inventor
    .reads(...BLIND, `${HANDOFF}/SUBVOLUMETRIC_CHALLENGE.md`)
    .judged(review('math-red-team', redTeam)),
  census: outsider.lists(Pick),
  lineage: keeper.returns(Kin),
  build: builder.judged(
    check('python3 tools/astra/known_answer.py --candidate {{id}}', 'tools/astra/', PACKET)
  ),
  falsify: command('python3 tools/astra/falsify.py --candidate {{id}} --json', { minutes: 180 })
    .needs('gpu', 'falsifiers')
    .protect('tools/astra/', PACKET)
    .returns(Receipt),
  claim: builder.judged(review('matched-error', gemini)),
  record: keeper
    .in(checkout('KEY_LEARNINGS.md', 'theory/', `${RUN}/`))
    .judged(review('faithful-record', gemini)),
});

export default plan(async (x) => {
  const ready = await x.phase('freeze', () => frozen());
  if (ready.t !== 'passed')
    return gap(
      'The evaluator contracts still have TBD_AT_LAUNCH fields. Nothing is generated against an unfrozen judge.',
      ready
    );

  // Blind: a call sees its step's allowlist and its `reads`. These pass none: no ledger, no sibling.
  const runs = await x.phase('discover', () =>
    Promise.all(TRACKS.map((id) => (id.startsWith('N') ? neutral : subvolume)({ id })))
  );
  const sound = passed(runs);
  if (sound.length === 0) return gap('No discovery survived the blind math red team.', ...runs);

  const picks = await x.phase('census', () => census({ reads: sound }));
  if (picks.t !== 'passed') return gap('The census selected nothing to build.', picks, ...sound);
  await x.review(
    'Before a falsifier is spent: are the picks distinct mechanisms, each with a killing observation, or one idea renamed?'
  );

  const survivors: { claim: Held<unknown>; speedup: number }[] = [];
  const dead: Readable[] = [];
  await x.phase('falsify', async () => {
    for (const c of picks.value.out) {
      const origin = runs[TRACKS.indexOf(c.source)];
      // The keeper reads the ledger and names a family. Only the host sees it, as `tests`: no builder or judge does.
      const kin = await lineage({ id: c.id, item: c, reads: [origin, x.learnings('all')] });
      if (kin.t !== 'passed') {
        dead.push(kin);
        continue;
      }
      const { family } = kin.value.out;
      const mine = [`${RUN}/candidates/${c.id}/`]; // each call may change its own candidate's folder only
      const built = await build({
        id: c.id,
        item: c,
        reads: [origin],
        fence: mine,
        tests: { family, idea: `${c.id}: known answer` },
      });
      if (built.t !== 'passed') {
        dead.push(built);
        continue;
      } // includes refused: 'already-rejected'
      const run = await falsify({ id: c.id, item: c, on: built.value }); // a third pick is refused: 'pool'
      await x.land(c.id, built.value); // the slice is kept whether the candidate lives or dies
      if (run.t !== 'passed') {
        dead.push(run);
        continue;
      }
      // Judged with `tests`: the host writes the ledger row itself (SURVIVES is keep, anything else is reject).
      const claimed = await claim({
        id: c.id,
        item: c,
        continues: built.value,
        on: built.value,
        reads: [run.value],
        fence: mine,
        tests: { family, idea: c.id },
      });
      if (claimed.t !== 'passed') {
        dead.push(claimed);
        continue;
      } // unmatched error, an unfair baseline or a hidden cost dies here
      await x.land(`${c.id}-claim`, claimed.value);
      survivors.push({ claim: claimed.value, speedup: run.value.out.speedup });
    }
  });

  await x.review(
    'Set each receipt beside its prediction. Did the blocker move? Two clean failures end this line of research.'
  );

  const kept = await x.phase('record', () =>
    record({ reads: [x.learnings('all'), ...runs, ...dead, ...survivors.map((s) => s.claim)] })
  );
  if (kept.t === 'passed') await x.land('record', kept.value);

  const [winner] = best(survivors, (s) => s.speedup, 1);
  if (!winner)
    return gap(
      'No candidate survived a matched-error, complete-cost falsifier. The kills and any lower bound are the result.',
      ...dead,
      kept
    );
  return winner.claim;
});
