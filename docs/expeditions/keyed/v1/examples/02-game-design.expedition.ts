// Case 02: make Tidewar fun to finish; an honest no-change round is useful.
// Wide single-lever builds and paired trials; serial baseline repair and stack confirmation.
// Gemini judges Claude builders, Codex hunters and the assumed Claude lead.
//
// V1 limits and NOTES carried forward:
// No sub-goals, land, learning ledger, no-retest, write fences or protected grader paths.
// Use phases, explicit on bases and a final record; the owner integrates. Concurrency pools
// are expedition-local only. compile is held for the whole producer plus check, so dev.sh must
// still take the actual machine lock for build only; matches run outside it at nice 15.
// fresh-seeds: 1 is only concurrency; this plan calls confirm once, but retries/rewrites can spend
// it again. Require an external spent-seed receipt before launch. Pilot a build explicitly;
// a measured rejection never suppresses other trials (the old wide-pilot NOTES gap is obsolete).
// The median <=20 metric is folded into targets.py --require-median-at-most 20; implement that
// exit-code flag. Done reads a stored fresh-seed receipt via verify_confirmation.py rather
// than running the scarce seed set again; implement it to bind all targets to candidate source.
// No API fence or automatic keep/reject exists despite historical brief wording.
//
// Before launch (historical prerequisites; verify against the target checkout):
// - `game-design` is an invented Buddy id. No Buddy with that id is known to exist.
// - `reports/tidewar-balance/spread.py` does not exist. It should run 16 seeds and exit 0 only when
//   first blood and first tower fall at different times across seeds.
// - `reports/tidewar-balance/ab.sh` does not exist. It should build `keel_cli` at the commit through
//   `keel/scripts/dev.sh build keel_cli --release`, run the frozen baseline map and
//   `variants/<variant>.json` on seeds 1..48, plain and `--mirror`, under every persona, compare
//   them with the existing `compare.py`, keep the raw per-seed lines in the repo's ignored
//   `output/`, and print `{ "inTarget": int }` as JSON. Exit 0 means confirmed (shorter by the
//   paired sign test, no team bias on the mirrored run, fun proxies not worse), exit 1 means
//   refuted with the JSON still printed, and any other failure prints none. `compare.py` exists
//   but only prints a table: it has no JSON output and no pass rule today.
// - `reports/tidewar-balance/targets.py` does not exist. It should run the map compiled into the
//   commit on the given seeds and exit 0 only when every owner target holds. Its `--json` output
//   and the `median_minutes` field are invented with it.
// - `reports/tidewar-balance/predictions.py` does not exist. It should exit 0 when every log row
//   without a verdict has a prediction, a metric, an expected value and a refuted-if condition;
//   with `--closed`, when no row is left without a verdict.
// - `variants/stack.json` is a name this plan chooses. The existing `variants/r1-stack-confirmed.json`
//   is round 1's.
// - The pool shape `{ uses: 1 }` and `scope: machine` come from DESIGN.md §4; 01-gtm's contract
//   does not show them.
// - These exist and are used as they are: `keel_cli tidewar` and its flags, `compare.py`, the
//   `pacing` knobs, `keel/scripts/dev.sh`, the compile lock in `keel/scripts/lib/build_gate.sh`,
//   `tests/it/fairness.rs`, the theory doc and its sections 11, 14 and 15, and the meta prompt.
//
// Gates typecheck and dry-run declarations; they never execute or establish existence of these tools.
// Fill in actual Buddy ids and check their providers; test providers below are explicit assumptions.

import {
  type Held,
  type Readable,
  type Result,
  buddy,
  check,
  command,
  expedition,
  need,
  parallel,
  review,
  role,
  seat,
  steps,
} from 'expedition';
import { z } from 'zod';

// Preserve failed outputs as evidence too: passed(...) alone would erase a search's refutations.
function evidence(result: Result<unknown>): Readable[] {
  switch (result.t) {
    case 'passed':
      return [result];
    case 'failed':
      return [result, `failed: ${result.why}`];
    case 'errored':
      return [`errored: ${result.why}`];
    case 'cancelled':
      return [result.partial, 'cancelled'];
    case 'refused':
      return [`refused: ${result.reason}`];
  }
}
const noResult = (why: string) => need({ t: 'errored', why }, why);
const RUNS = 'reports/tidewar-balance';
const Exp = z.object({ id: z.string(), family: z.string(), idea: z.string() });
const judge = seat('gemini', 'gemini-3.1-pro-preview', 'high');
const lead = role({ by: buddy('game-design'), usd: 8, minutes: 45 }).reads(
  'notes/design/',
  RUNS,
  'keel/GAMES.md'
);
const coder = role({ by: seat('claude', 'claude-sonnet-5-5', 'high'), usd: 5, minutes: 60 });
const hunter = role({ by: seat('codex', 'gpt-6.1-sol', 'high'), usd: 6, minutes: 45 });
const SUITE = check('keel/scripts/dev.sh test game_bships --test it');
const exploit_evidence = `# Rubric: is the exploit report backed by runs?

You are judging an exploit hunter's report. You did not write it, and you did not write the game.
You are not judging whether the game is good. You are judging whether the report can be trusted,
including when it says "nothing found".

For every exploit listed, check:

1. **The run exists.** The evidence path holds per-seed lines for at least 16 seeds, from the
   seeds 1..48, with a baseline on the same seeds.
2. **The numbers match.** Recount the win split and the first-tower time from the lines. They
   must equal what the report states.
3. **The blocking rule was applied as written**: blocking if the exploiting side wins at least
   80% of the seeds run, or the first tower falls in under half the baseline time. The count in
   \`blocking\` must equal the number of exploits that meet it. The hunter may not move the bar.

If the report gives zero blocking exploits, check that it tried. It must name the code paths it
read and at least three attack ideas it ran, with their runs, and say whether each round-1
exploit (free duplicate Cannons, Mortar outranging towers) is still open on this commit.

Pass only if every listed exploit meets 1 to 3 and a zero is supported. Fail a plausible story
with no run. Fail a count that does not follow from the rule. In your answer, list each exploit
and what you recounted.
`;
const log_honest = `# Rubric: does the log say what the measurements say?

You are reviewing the round's record, written on another model by the Buddy that also chose the
experiments. It has a reason to want its theory to look right. Check it against the raw
measurements in your inputs, not against its own summary.

For every row of the progression log opened this round:

1. **The prediction is unchanged.** Compare the row with the version landed on main before the
   measurements. A prediction edited after its measurement fails the whole review.
2. **The numbers match.** Finished count, median length, win split and the paired sign test
   equal the measurement's output. Unfinished matches are reported as censored, not averaged.
3. **The verdict follows**, and agrees with the keep or reject the host wrote in the learning
   log. Confirmed needs the predicted direction and significance. A team-bias
   claim needs the mirrored run. "Inconclusive" is not used to avoid writing "refuted".
4. **The row is closed**: verdict, and kept or reverted.

Then check the whole:

- Every lever that was measured has a row. A refuted lever that is missing fails it.
- No earlier row was deleted or reworded.
- Tags are right: \`[measured]\` only for a number from a run in your inputs.
- Nothing is claimed about how the game feels. Headless matches cannot show it.
- If the round shipped nothing, the record says so plainly, and says at which gate a stack died.
- The meta prompt has a section of lessons for this round, and they are about the process.

Pass only if every row meets 1 to 4 and none of the whole-record checks fails. List each row you
checked and what you compared it with.
`;
const one_lever = `# Rubric: is this diff exactly one lever?

You are reviewing a change written on another model. It claims to implement one balance lever.
The measurement that follows is only worth anything if that is true.

Read the lever's stated idea and its prediction row in section 11 of the theory doc. Then read
the diff, and compare the variant map with \`reports/tidewar-balance/baseline/map.json\` field by
field.

Pass only if all of these hold:

1. **One family.** The variant map differs from the baseline only in the knobs of the stated
   lever. Any other differing field fails it, however small.
2. **Stated setting.** The knob values are the ones the idea and the prediction row state.
3. **Off by default.** Any new knob in \`pacing.rs\` ships off, and the shipped map
   \`keel/content/tidewar-map.json\` is untouched. With the knob off, no code path changes.
4. **No owner ruling bent.** Nothing changes when or how the flagship shield opens.
5. **Nothing else.** No edit to the AI, the tests, the match runner, the theory doc or another
   variant.
6. **A prediction exists** for this lever, written before this change.

Do not judge whether the lever is a good idea or will work. A lever you expect to fail still
passes if it is clean. In your answer, list the differing map fields and the files changed, and
for a fail, name the line that breaks which rule.
`;

const { spread, unblock, hunt, theorize, change, ab, stack, confirm, record } = steps({
  spread: command(`python3 -I ${RUNS}/spread.py --seeds 16`, { minutes: 20 }).needs('cpu'),
  unblock: coder
    .checkout()
    .needs('compile')
    .brief(`# Unblock: fix what stops the round from measuring anything

You own code fixes in this round. Nobody else may edit the game or the match runner before the
experiments start, so if you do not fix it, it stays broken.

Your inputs say what is blocking. It is one of two things.

**The measuring stick.** A spread check ran 16 seeds and found that they play the same early
game (in round 1, first blood fell at 55 s on all 48 seeds). The seeds are then one sample, and
no A/B result means anything. Make different seeds give different early games: seeded opening
variation from \`DetRng\`, and the persona brains in \`keel/games/game_bships/src/ai/\`. Both exist
after round-2 prep; find out why the spread check still fails before writing anything new.
\`reports/tidewar-balance/README.md\` has the instrumenter's note on what the seed drives.

**A confounding exploit.** The exploit hunter's report lists exploits marked blocking: ones
strong enough that every pacing experiment would measure the exploit, not the lever. Close each
one with a typed knob in the \`pacing\` block (\`src/pacing.rs\`), or use a knob that exists
(\`duplicate_guns\`, \`tower_range\`). Where closing it changes a rule a player would notice, ship
the knob off and write the owner decision it needs; do not turn it on.

## How to work

- Read the code path first and write down what you expect the tests to say. Compiling is the
  slow part: a small release rebuild has taken 8 minutes on this machine.
- \`keel/scripts/dev.sh check game_bships\`, then \`keel/scripts/dev.sh test game_bships --test it
  <module>::\` for what you changed. Use \`--fast\` builds. Do not build \`--release\`.
- When your fix passes, it is merged to main and every later step starts from it.
- Add a test that fails on the old behaviour. The crate's \`it\` suite is your judge, and
  \`tests/it/fairness.rs\` is restored before it runs, so do not edit that file.
- Keep the fix small. You are not tuning the game. Change nothing that moves match length.

## Report

Say what was wrong, what you changed, and which test proves it. Record the cause with the \`learn\`
tool, family \`measuring-stick\` or \`exploit\`. If the block cannot be fixed without bending an
owner ruling, stop and say so; that is the leader's and the owner's decision.
`)
    .judged(SUITE),
  hunt: hunter
    .checkout()
    .needs('cpu')
    .brief(`# Hunt: break the game before anyone tunes it

You are the exploit hunter. You run twice in a round: on the baseline before any experiment, and
on the stacked candidate before it is confirmed. Your inputs tell you which commit you are on.

Find ways to win, stall or snowball that the designer did not intend: cheese builds, degenerate
loops, a unit that outranges what should threaten it, a free purchase, a way to deny the other
team its comeback. Read the code paths, not only the numbers. Round 1 found two this way, both
too late: duplicate Cannons at price 0, and a Mortar that outranges towers (612 against 476).

## Read first

- \`reports/tidewar-balance/exploits-r1/summary.txt\` and the harness beside it
- \`keel/games/game_bships/src/\` : \`inventory.rs\`, \`loadout.rs\`, \`tower.rs\`, \`economy.rs\`, \`kraken.rs\`
- The theory doc, sections 5.3 (snowball loops) and 15 (owner decisions O4, O11)

## Prove each one

An exploit counts only with a run behind it. Write a scripted bot or reuse the round-1 harness,
run it against the standard AI on at least 16 of the seeds 1..48, and keep the per-seed lines
under \`reports/tidewar-balance/exploits/<name>/\`. State the win split and the time of the first
tower with and without the exploit. A reviewer on another model will check that the runs exist
and say what you claim.

Do not re-report the round-1 exploits as new. Check whether each is still open on this commit
and say so in one line.

## Answer

Give \`blocking\`: the number of exploits strong enough to confound a pacing experiment. Use this
rule, fixed now: an exploit is blocking if the exploiting side wins at least 80% of the seeds
run, or the first tower falls in under half the baseline time. List every exploit, blocking or
not, with its evidence path. Zero is a valid answer; that is your sign-off, so do not give it
unless you tried.

Do not fix anything. Do not edit the game. Stop after 45 minutes and report what you have.
`)
    .returns(z.object({ blocking: z.number() }))
    .judged(review(exploit_evidence, judge)),
  theorize: lead
    .checkout()
    .brief(`# Theorize: choose the experiments and write their predictions

You own the theory doc, \`notes/design/2026-11-01_tidewar_balance_theory.md\`. In this step you are
the only one who edits it. You choose what the round tests. You do not run anything.

## Read first

- The theory doc, whole. Sections 11 (progression log), 12 (what the theory got wrong) and 13
  (the round-2 plan) matter most.
- The learning log in your inputs: every lever tried so far, with its family and verdict.
- The exploit hunter's report in your inputs.
- \`reports/tidewar-balance/README.md\` for the knobs that exist and how a variant is made.

## Produce

A list of 3 to 6 experiments. Each has an \`id\` (lowercase, hyphenated, like \`r2-pusher-standing\`),
a \`family\` (the mechanism it belongs to: \`respawn\`, \`minion-scaling\`, \`pusher\`, \`kraken\`,
\`economy\`, \`tower-defence\`, \`ai-siege\`) and an \`idea\` (one sentence: the lever and the setting).

For each, append a row to the progression log before you answer: the change, the metric it
should move, the expected direction and rough value, why (cite the section of the theory), and
the result that would refute it. A script checks that every open row has all of these. Your rows
are merged to main before any lever is measured, and nobody can edit them after that.

## Choosing

- Rank by expected effect on the owner's target, 12 to 20 minute matches, and say what each
  costs in fun proxies if the theory is right.
- One lever per experiment. Prefer a map knob to a code change.
- Do not propose a lever whose family the log shows rejected, unless you state what is different
  this time: a new representation, or a blocker that has been removed. "Try it again with
  another number" is not different. Gold-only levers were inert in round 1 because the AI's build
  was already finished.
- If a lever lets lanes drift apart, say so in its row; it will get a mirrored run.
- A lever that bends an owner ruling goes in section 15 as a decision for the owner. It does not
  go in your list.

Fewer good experiments beat more. If the theory supports only two, return two. If it supports
none, return an empty list and write why in section 12.
`)
    .lists(Exp)
    .judged(check(`python3 -I ${RUNS}/predictions.py`)),
  change: coder
    .checkout()
    .brief(
      (item: z.infer<typeof Exp>) => `# Change: implement one lever, ${item.id}

Family: ${item.family}

The lever: ${item.idea}

You implement exactly this and nothing else. You do not measure it. When you commit, the host
builds your commit and runs the A/B on the frozen seeds; you will not see the numbers and you
cannot adjust to them.

## Read first

- This lever's prediction row in section 11 of
  \`notes/design/2026-11-01_tidewar_balance_theory.md\`. Do not edit the doc.
- \`reports/tidewar-balance/README.md\`, "Making a variant" and "Pacing knobs".
- The learning rows for this family in your inputs: what was tried and how it failed.

## Do

1. Copy the frozen baseline map, not the live content file:
   \`reports/tidewar-balance/baseline/map.json\` to \`reports/tidewar-balance/variants/${item.id}.json\`.
2. Set only the knobs of this lever in its \`pacing\` block. Leave every other field identical.
   This is the only variant map you can write; the others belong to other workers.
3. If the lever needs a knob that does not exist, add it in \`keel/games/game_bships/src/pacing.rs\`
   as a typed field that ships off, so the shipped map plays exactly as before. Content before
   code: write code only when no existing knob expresses the lever.
4. If you wrote code, \`keel/scripts/dev.sh check game_bships\`. Do not build \`--release\` and do
   not run match batches; the host does both.
5. Commit the variant map and any code.

## Do not

- Tune. If the stated setting looks wrong to you, implement it as stated and say why you doubt it.
- Touch a second lever, the shipped map \`keel/content/tidewar-map.json\`, the AI, or the tests.
- Change anything behind the flagship shield rule.

A reviewer on another model reads your diff and passes it only if it is this one lever.

## Report

State the knob values you set and the files you changed, and what you expect the measurement
to show. Do not write a learning row for the lever: the host writes keep or reject from the
measurement.
`
    )
    .judged(review(one_lever, judge)),
  ab: command((item: { id: string }) => `${RUNS}/ab.sh --variant ${item.id}`, { minutes: 40 })
    .returns(z.object({ inTarget: z.number() }))
    .needs('cpu'),
  stack: coder
    .checkout()
    .needs('compile')
    .brief(`# Stack: combine the confirmed levers into one candidate

Your inputs are up to three levers. Each was changed alone and confirmed alone on seeds 1..48.
Put them together in one commit. The host then measures the stack again, because confirmed levers
interact: in round 1 two of them stacked into a biased, snowballing game.

## Do

1. Merge the code of each lever's commit onto your starting commit. Your inputs hold each
   lever's change and its measurement. The changes touch the same file,
   \`keel/games/game_bships/src/pacing.rs\`, so expect conflicts there and resolve them by keeping
   every knob. All knobs still ship off in code.
2. Write \`reports/tidewar-balance/variants/stack.json\`: the frozen baseline map with each
   lever's knobs set exactly as its own variant map set them. Change no value.
3. Apply the same \`pacing\` block to the shipped map, \`keel/content/tidewar-map.json\`. This is the
   candidate the owner will play. It merges only if the stack is confirmed, the exploit hunter
   signs off, the reserved seeds confirm it and the owner's playtest passes.
4. \`keel/scripts/dev.sh check game_bships\`, then
   \`keel/scripts/dev.sh test game_bships --test it\`. The suite is your judge. A test that pins a
   shipped value you changed on purpose (a map constant, a knob default) may be updated to the
   new value, with a comment naming the lever. \`tests/it/fairness.rs\` is restored before the
   suite runs; do not edit it.

## Do not

- Retune. If two levers obviously fight, stack them as they are and say so; the measurement
  decides, and the leader chooses what to drop.
- Add a lever that was not in your inputs, or leave one out.
- Run match batches, or run seeds 1001..1048 for any reason.

## Report

List the levers stacked, the final knob values, and every conflict you resolved and how. Say
which interactions you expect between the levers and which metric would show each one.
`)
    .judged(SUITE),
  confirm: command(
    `python3 -I ${RUNS}/targets.py --seed-start 1001 --seeds 48 --mirror --require-median-at-most 20`,
    {
      minutes: 60,
    }
  ).needs('cpu', 'fresh-seeds'),
  record: lead
    .checkout()
    .brief(`# Record: write the round into the repo

The round is over. Your inputs hold the learning log, every A/B measurement, and, if a stack was
built, its re-measurement, the exploit hunter's report and the reserved-seed confirmation. Write
what happened into the files that already own this knowledge. You are the only one editing them
in this step.

The first line of your inputs is the outcome of the stack in one sentence: nothing stacked,
dropped at a named gate, refused by the owner's playtest, or landed. Use it as written. If the
stack landed, the shipped map in your checkout already carries it.

## Write

1. **Progression log** (theory doc, section 11). For every row opened this round, fill in the
   seeds, the measured numbers and the verdict: confirmed, refuted or inconclusive. Say whether
   the mechanism was confirmed, not only the headline number. Mark each lever kept or reverted.
   Leave no open row. Never delete or soften an earlier row. The host has already written each
   lever's keep or reject into the learning log; your rows must agree with it.
2. **What the theory got wrong** (section 12). For each prediction that missed, say which
   formula or assumption was at fault, and correct it where it stands, with its tag: \`[code:
   file:line]\`, \`[derived]\`, \`[assumption]\` or \`[measured]\`. Only a number from this round's
   runs is \`[measured]\`.
3. **Human playtest questions** (section 14) and **owner decisions** (section 15). Add what this
   round raised, each question with the AI-side number it checks.
4. **Run summaries.** For each variant, a short \`reports/tidewar-balance/<id>/README.md\` with
   the command, the commit, the numbers and a pointer to the raw lines.
5. **The meta prompt**, \`notes/design/2026-11-01_balance_swarm_meta_prompt.md\`: a "Lessons from
   round 2" section about running the round itself: what wasted effort, what the plan should do
   differently. One durable lesson may also go in \`key_learnings/agent_workflow_and_evidence.md\`.
6. **\`keel/GAMES.md\`**, "Balance status", is outside your fence. Put its replacement paragraph
   in your report for the owner to apply.

## Honesty

- Take every number from the measurements in your inputs. Do not round toward the prediction.
- If nothing was confirmed, write that the round ships no change. That is a result.
- If the stack was built and then dropped, say at which gate: re-measurement, exploit hunt,
  reserved seeds or playtest. If the reserved seed set was used, say that it is now spent.
- AI against AI measures structure. Claim nothing about how the game feels.

A reviewer on another model checks your rows against the raw measurements.
`)
    .judged(review(log_honest, judge)),
});

export default expedition({
  contract: {
    goal: `Tidewar is not fun to finish yet. On the shipped map, AI against AI, most matches are still going
at 45 minutes, there are almost no fights, and captains spend a third of their time doing nothing.

I want matches that land in 12 to 20 minutes, a Kraken about every 4.5 minutes, no advantage for
either team, and the fun numbers in range: lead changes, comebacks, fights, contested Krakens, low
idle time. Balance means fun. A balanced game that is dull has failed.

Round 1 spent 38 agents on 7 experiments and shipped nothing, and most of what went wrong was the
process: one deterministic AI made 48 seeds into one sample, exploits confounded every experiment,
two confirmed levers stacked into a biased game, and code fixes had no owner. Read
\`notes/design/2026-11-01_balance_swarm_meta_prompt.md\` and do not repeat it. Check the measuring
stick first. Hunt exploits before experimenting. Test one lever at a time, and never a lever that
the log already shows refuted unless something about it has changed.

AI against AI measures structure, not feel, so I will play the result myself before it merges.
If no lever earns its place, say so. A round that ships nothing but leaves an honest log, a
corrected theory and better lessons in the meta prompt is a result I accept.`,
    leader: 'game-design',
    repo: '~/git/room-runners-arena-lib',
    budget: { usd: 120, hours: 12 },
    autoApply: { usd: 15 },
    pools: { claude: 4, codex: 1, gemini: 2, compile: 1, cpu: 2, 'fresh-seeds': 1 },
    done: [
      {
        check:
          'python3 -I reports/tidewar-balance/verify_confirmation.py --seed-start 1001 --seeds 48 --mirror --median-at-most 20',
      },
      { check: 'python3 -I reports/tidewar-balance/predictions.py --closed' },
      { review: { rubric: exploit_evidence, by: judge } },
      {
        owner: "Do you accept the change set, the round's log and the owner decisions it asks for?",
      },
    ],
    rules: [
      'Owner rulings are fixed. The flagship stays shielded until all three Inner towers are sunk. A lever that bends a ruling is proposed in the log, never applied.',
      'Predict before you measure. The prediction row is written before the run. No bar is lowered after a result is seen.',
      'A/B runs use the same seeds, 1..48. Seeds 1001..1048 are reserved; do not run them. A team-bias claim needs the mirrored run. An unfinished match is censored, never averaged at the cap.',
      'Refuted results stay. Never delete a log row, a variant map or a run folder.',
      "Compile only through keel/scripts/dev.sh (it takes the machine's compile lock). Run matches outside the lock at nice 15. Report no tick timing: the host is not idle.",
      'Never deploy. Do not touch the production server or keel/deploy/.',
      'V1 execution notes override historical host claims in the briefs: no land, fence, protect, tests/learn tool, automatic learning rows or no-retest gate exists. Commit on the work branch; never merge main or push. Integration may combine supplied commits only inside its private checkout. Carry prior commits explicitly through on/reads; record predictions and every verdict in the repo records from the supplied evidence, including failures. Writable scopes and frozen graders are instructions and review obligations, not host-enforced write fences.',
      'Seeds 1001..1048 are for the single host confirm call only; the done checker reads its stored receipt and must not run matches. No retry without owner authorization. Before live launch implement verify_confirmation.py and targets.py --require-median-at-most 20.',
    ],
  },
  plan: async (x) => {
    let base: Held<unknown> | undefined;
    const trail: Readable[] = [];
    const sampled = await x.phase('stick', () => spread());
    trail.push(...evidence(sampled));
    if (sampled.t !== 'passed') {
      base = need(
        await x.phase('instrument', () => unblock({ id: 'stick', reads: trail })),
        'The measuring-stick repair failed.'
      );
      need(
        await spread({ id: 'repaired', on: base }),
        'Seeds still do not give independent games.'
      );
    }
    let hunted = need(
      await x.phase('exploits', () => hunt({ id: 'base', on: base })),
      'No trustworthy exploit hunt.'
    );
    trail.push(hunted);
    if (hunted.out.blocking > 0) {
      base = need(
        await x.phase('unblock', () => unblock({ id: 'exploits', on: base, reads: [hunted] })),
        'Blocking exploits remain.'
      );
      hunted = need(
        await hunt({ id: 'repaired', on: base }),
        'The repaired baseline was not hunted.'
      );
      if (hunted.out.blocking > 0)
        return noResult('A blocking exploit still confounds the baseline.');
    }
    await x.review(
      'Is the baseline a fair measuring stick, or does a confound or map bias remain?'
    );
    const exps = need(
      await x.phase('theory', () => theorize({ on: base, reads: trail })),
      'No written predictions.'
    );
    const build = (item: z.infer<typeof Exp>) => change({ item, on: exps, reads: [exps] });
    const [first, ...rest] = exps.out;
    const made: { item: z.infer<typeof Exp>; code: Held<unknown> }[] = [];
    if (first) {
      const pilot = need(
        await x.phase('pilot', () => build(first)),
        'The first lever build failed; width was not started.'
      );
      made.push({ item: first, code: pilot });
      const results = await x.phase('levers', () =>
        parallel(rest, async (item) => ({ item, result: await build(item) }))
      );
      for (const { item, result } of results) {
        trail.push(...evidence(result));
        if (result.t === 'passed') made.push({ item, code: result });
      }
    }
    const trials = await x.phase('measure', () =>
      parallel(
        made.map((m) => ({ ...m, id: m.item.id })),
        async (m) => ({ ...m, result: await ab({ item: m.item, on: m.code }) })
      )
    );
    trail.push(...trials.flatMap((t) => evidence(t.result)));
    await x.review(
      'Which levers moved the game as predicted? No change worth shipping is a valid result.'
    );
    const top = trials
      .flatMap((t) => (t.result.t === 'passed' ? [{ code: t.code, score: t.result }] : []))
      .sort((a, b) => b.score.out.inTarget - a.score.out.inTarget)
      .slice(0, 3);
    let candidate: Held<unknown> = exps;
    const outcome = await x.phase('stack', async () => {
      if (!top.length) return 'No lever was confirmed alone, so nothing was stacked.';
      const stacked = await stack({ on: exps, reads: top.flatMap((t) => [t.code, t.score]) });
      trail.push(...evidence(stacked));
      if (stacked.t !== 'passed') return 'The stack did not pass the game tests.';
      const again = await ab({ item: { id: 'stack' }, on: stacked });
      const clean = await hunt({ id: 'stack', on: stacked });
      trail.push(...evidence(again), ...evidence(clean));
      if (again.t !== 'passed') return 'The stack was dropped at its re-measurement.';
      if (clean.t !== 'passed' || clean.out.blocking > 0)
        return 'The stack was dropped at the exploit hunt.';
      const fresh = await confirm({ on: stacked });
      trail.push(...evidence(fresh));
      if (fresh.t !== 'passed')
        return 'The stack was dropped on the reserved seeds, which are now spent.';
      if (!(await x.confirm('Play two matches with theory section 14. Does the candidate pass?')))
        return 'The owner playtest refused the measured stack.';
      candidate = stacked;
      return 'The stack passed every gate, including the owner playtest; it awaits owner integration.';
    });
    return need(
      await x.phase('record', () => record({ on: candidate, reads: [outcome, exps, ...trail] })),
      'The round log failed independent review.'
    );
  },
});
