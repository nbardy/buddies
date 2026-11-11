// Case 03: search for >=15% matched-error APIC speedup, keeping every rejection.
// Wide candidates across three serial generations; local screen then Modal scoring.
// Gemini audits the assumed Claude lead; numerical checks judge Codex implementations.
//
// V1 limits and NOTES carried forward:
// No sub-goals, host land, protected protocol, learning rows or automatic no-retest refusal.
// The measuring-stick repair is a phase and explicit base; final records carry the trail.
// Pools are concurrency only: gpu is local to this expedition, modal:4 is not a $30 spend pool,
// and confirm:1 is not two lifetime uses. The loop tries at most two audits; an external ledger
// and launcher must enforce $30 total Modal spend across noise, screens, gates and audits,
// including retries and done. A free GPU slot is not an idle machine: only Modal timings count.
// A local screen is its own command so Codex preparation can overlap GPU work. No pilot API:
// one full trial is run before the rest, and a measured no continues the generation.
// The old NOTES about double keep rows are moot: v1 writes none; the record judges all stages.
// Before launch add verify_audit.py --max-error-ratio 1.0 --min-speedup 1.15, which reads the
// stored six-block receipt and binds it to candidate source (no extra scarce/paid audit in done).
//
// Before launch (historical prerequisites; verify against the target checkout):
// - `tools/speed_search_v1/` does not exist in wave_sim. The plan assumes four scripts in it, written
//   and committed before launch (scripts must exist before live execution):
//   - `cases.py --json` prints the frozen case ids from the protocol file;
//   - `abba.py` runs an ABBA pair of the checked-out commit against the protocol's pinned baseline
//     commit and prints `{ speedup, errorRatio, spread, usd, device, sha }`. Flags assumed: `--aa`,
//     `--case`, `--all`, `--device local-m4|modal-l4`, `--blocks`, `--complete-cost`, `--max-usd`,
//     and three that turn a number into an exit code: `--require-matched` (error ratio at most 1.0
//     on every case), `--require-speedup N` and `--max-spread N`;
//   - its own unit tests, discoverable by `python3 -m unittest discover -s tools/speed_search_v1`,
//     including a synthetic-noise test of the pairing arithmetic.
// - `benchmarks/speed_search_v1/protocol.json` (frozen cases, error metric, reference fields, pinned
//   baseline commit, device names) and `benchmarks/speed_search_v1/results/` do not exist.
// - The case ids are expected to be a subset of the READY cases in
//   `tools/surf_engine_bench_v1/cases.ts` (`dam_break`, `soliton_ridge`, `flat_rest`, …). Which
//   ones, and the error metric per case, is the owner's choice and is not made yet.
// - `bun test prototypes/surf_engine_v1/src` is assumed to run the engine's existing `*.test.ts`
//   files without a GPU. Not verified.
// - The `wave-simulation-lead` Buddy id is assumed from "Accountable: Wave Simulation Lead" in
//   `goals/2026-10-12_three_engine_goals.md`. Its provider is not known here; the dry run must show
//   it is not gemini, or the `speed-claim` review needs another seat.
// - The `--device modal-l4` path is assumed to wrap the existing central runner
//   (`bun run sim surf_engine_v1 <case>`), which already keeps one scale-to-zero L4 per invocation.
//   No ABBA mode exists in that runner today.
// - The 15% bar, the 3% A/A spread limit, the $30 Modal pool and the two confirm uses are example
//   numbers, not owner decisions.
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
  passed,
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
const ENGINE = 'prototypes/surf_engine_v1/src/';
const BENCH = 'tools/speed_search_v1';
const MAX_SPREAD = 0.03;
const Case = z.object({ id: z.string() });
const Idea = z.object({
  id: z.string(),
  family: z.string(),
  idea: z.string(),
  prediction: z.string(),
});
const judge = seat('gemini', 'gemini-3.1-pro-preview', 'high');
const lead = role({ by: buddy('wave-simulation-lead'), usd: 6, minutes: 45 }).reads(
  'KEY_LEARNINGS.md',
  'SHADER_AND_PERFORMANCE_TRICKS.md',
  'auto_research/'
);
const coder = role({ by: seat('codex', 'gpt-6.1-sol', 'high'), usd: 5, minutes: 60 });
const abba = (flags: string) => `python3 ${BENCH}/abba.py ${flags} --json`;
const speed_claim = `# Rubric: does the record say exactly what the measurements say?

You are reviewing the results page and the new \`KEY_LEARNINGS.md\` rows. You did not write them,
and you did not build or benchmark any candidate. Assume the author wants the result to look good.

Open the reports the page cites. Check each of these:

1. **Every number traces.** Each speedup, error ratio and dollar figure on the page appears in a
   cited report, for the stated commit and device. Quote the report field next to each one.
2. **Matched error.** For the candidate called the result, the error ratio is at or below 1.0 on
   every frozen case in the audit report, not only in aggregate. If one case is above 1.0, fail.
3. **Paired and complete.** The audit is ABBA with six blocks on one named device, and its cost
   includes setup, compile, readback and output. A single timing, or timing of the evolution
   loop alone, fails.
4. **The protocol did not move.** The cases, metric and baseline commit in the report match
   \`benchmarks/speed_search_v1/protocol.json\` at the launch commit.
5. **The rejects are all there.** Every idea in the learning log has a row in the table and, if
   rejected, a graveyard row. A missing reject fails the review as surely as a wrong number.
6. **No promotion.** The page says "candidate". \`matchedErrorSpeedup\` is not set. Nothing claims
   the result holds on a device or case that was not measured.

Pass only if all six hold. If no candidate passed the audit, items 2 and 3 do not apply, and the
page must say "no candidate passed" in its first two lines.

In your answer, list each number you checked and where you found it. If you fail the page, name
the line and the report field that disagree.
`;

const { cases, noise, instrument, quiet, propose, implement, screen, gate, confirm, record } =
  steps({
    cases: command(`python3 ${BENCH}/cases.py --json`, { minutes: 1 }).lists(Case),
    noise: command(
      (item: z.infer<typeof Case>) =>
        abba(`--aa --case ${item.id} --device modal-l4 --max-usd 0.50`),
      { minutes: 20 }
    )
      .returns(z.object({ spread: z.number() }))
      .needs('modal'),
    instrument: coder
      .checkout()
      .brief(`# Instrument: make the benchmark able to tell A from A

The A/A runs in your inputs are the same commit timed against itself on the same device. They
should agree. They do not: at least one frozen case shows a spread above 3%, or failed to produce
a number at all. Until that is fixed, no A/B ratio from this benchmark means anything, and the
search is paused behind you.

This is a sub-goal of the expedition, not the expedition. You are repairing the measuring stick.
You are not making the engine faster.

## Read first

- The A/A reports in your inputs: per case, per ABBA block, the timings and the device.
- \`tools/speed_search_v1/abba.py\` and its tests.
- \`KEY_LEARNINGS.md\`, section "2026-10-05 — Fast Modal GPU iteration" (a 157.8 s smoke held 1.1 s
  of compute), and the immutable-RHS graveyard row (the false 0.842×).
- \`tools/gpu_fastlane_v1/README.md\`, for how cached images and sessions are meant to remove
  install and compile time from the measured window.

## Find the cause before changing anything

Say which of these the data supports, and show the blocks that support it: setup or compile time
inside the timed window; cold versus warm container; the first block differing from the rest;
too few steps for the timer's resolution; readback counted in one arm and not the other; A and B
on different containers. If the data cannot separate two causes, say what one extra A/A run would
separate them, and stop there with that as your report.

## Change

Only files under \`tools/speed_search_v1/\`. Do not touch the protocol file, the reference fields,
the error metric or the engine. Keep the report fields the same; add fields if you need them.
Every repair gets a unit test that fails on the old behaviour, using recorded or synthetic
timings, with no GPU.

## What good looks like

One cause, named, with the evidence. A small change. The harness's own tests pass. The sub-goal's
check is then run by the host, not by you: A/A on every frozen case on Modal from your commit,
passing only if the worst spread is at most 3%. You do not run Modal or the local GPU yourself.

Write one \`learn\` row: family \`benchmark-noise\`, the cause as the idea, your predicted spread
after the fix, and leave \`measured\` for the re-run. Stop when the tests pass and you have committed.
`)
      .judged(check(`python3 -m unittest discover -s ${BENCH}`)),
    quiet: command(abba('--aa --all --device modal-l4 --max-spread 0.03 --max-usd 2.00'), {
      minutes: 40,
    }).needs('modal'),
    propose: lead
      .brief(
        (item: { gen: number }) => `# Propose: the ideas for generation ${item.gen}

You are choosing what the implementers build next. Each idea you list becomes one candidate
commit, a local screen on the M4 and, if it survives, a paid run on Modal. Choose as if each one
costs a dollar and an hour, because it does.

## Read first, all of it

- The learning log in your inputs. Every idea already tried in this run or an earlier one is
  there with its prediction, its measurement and its verdict.
- \`KEY_LEARNINGS.md\`, "Refuted (the graveyard — never delete, never re-test without a
  representation change)". About thirty rows. Multigrid at our grid sizes, kernel fusion and
  pressure warm-start are in it.
- \`SHADER_AND_PERFORMANCE_TRICKS.md\` and \`auto_research/KEY_LEARNINGS.md\`.
- The surviving candidates' commits in your inputs, if this is not generation 1.

## Produce

A list of four to six ideas. Each has:

- \`id\`: \`g${item.gen}-\` plus a short hyphenated name. It must not repeat an id from an earlier generation.
- \`family\`: the mechanism family, in the words the learning log already uses where one fits
  (\`pressure-solver\`, \`kernel-fusion\`, \`precision\`, \`memory-layout\`, \`pass-scheduling\`, …).
- \`idea\`: one change, stated so that an implementer can build exactly it. Name the pass or file.
- \`prediction\`: the speedup you expect on the frozen set, as a number, and where the time comes
  from. "Removes one full-grid readback per step, about 8% of step time, so 1.08×."

## Rules for choosing

- One change family per idea. A candidate that changes two things teaches nothing when it moves.
- If a family is rejected in the log or the graveyard, you may propose in it only by stating the
  representation change that makes this a different experiment. Otherwise the host refuses the call.
- After generation 1, spend most slots near what survived: a retune of a kept family, or the next
  step it makes possible. Keep one slot for a family nobody has tried.
- Prefer ideas whose prediction can be wrong. "Should help a bit" is not a prediction.
- Do not propose anything that changes the cases, the error metric, the time step rule or the
  pressure tolerance. Those are the frozen protocol, and they are how we know the answer is still right.

If you cannot find four ideas worth a dollar each, list fewer and say so in your summary. Do not
write code in this step.
`
      )
      .lists(Idea),
    implement: coder
      .checkout()
      .brief(
        (item: z.infer<typeof Idea>) => `# Implement: ${item.id}

Family: ${item.family}

The idea: ${item.idea}

The proposer's prediction: ${item.prediction}

Build exactly this one change in the WebGPU APIC engine, as a clean commit the host can benchmark
against the baseline. Other implementers are building other ideas now; you do not need the GPU.

## Read first

- \`prototypes/surf_engine_v1/README.md\` and \`LANE.md\`, then the passes the idea names.
- The learning rows for the \`${item.family}\` family in your inputs. If one of them already tried what
  you are about to build, stop and say so in your report instead of building it again.
- \`benchmarks/speed_search_v1/protocol.json\`, to know what will be measured. You may not edit it.

## Before you write code

Write a \`learn\` row with the idea, the family and your own prediction: the speedup you expect and
which pass it comes from. The row must exist before any measurement does.

## Build

- Change only files under \`prototypes/surf_engine_v1/src/\`. The checkout will not let you commit
  anything else.
- One change family. If the idea needs a second, unrelated change to work, that is a finding:
  report it and stop.
- Keep the physics identical in intent: same time step rule, same pressure tolerance, same
  particle admission gates. A candidate that is faster because it does less work to a looser
  tolerance will fail the matched-error gate, and its paid run will have been wasted.
- GPU legality is part of the method: buffer sizes, capacities, pass order, overflow. Do not add
  a CPU fallback or an extra readback to make something work.
- Run \`bun test prototypes/surf_engine_v1/src\` and fix what you break.

## How you are judged

The host runs those tests on your commit, then one short dam-break pair on the local M4 that
checks the error is still matched. Failing either records the idea as rejected. Passing means
only that the candidate is valid; the paid Modal run that follows decides whether it is faster.

## Do not

- Run the benchmark, the local GPU or Modal yourself.
- Add a flag that leaves the old path as default. The candidate is the commit.
- Claim a speedup. You have not measured one.

Stop when the tests pass and the change is committed. In your summary, say what you changed in
two or three lines and anything about the code that the next implementer in this family should know.
`
      )
      .judged(check(`bun test ${ENGINE}`)),
    screen: command(abba('--case dam_break --device local-m4 --require-matched'), {
      minutes: 20,
    }).needs('gpu'),
    gate: command(
      abba(
        '--all --device modal-l4 --require-matched --blocks 2 --require-speedup 1.03 --max-usd 1.00'
      ),
      { minutes: 40 }
    )
      .returns(z.object({ speedup: z.number() }))
      .needs('modal'),
    confirm: command(
      abba(
        '--all --device modal-l4 --require-matched --blocks 6 --complete-cost --require-speedup 1.15 --max-usd 4.00'
      ),
      { minutes: 120 }
    ).needs('modal', 'confirm'),
    record: lead
      .checkout()
      .brief(`# Record: the result, and the graveyard rows

The search is over. Your inputs hold the whole learning log and, if a candidate passed the long
audit, its commit and the audit report. Write the tracked record and commit it. A reviewer on
another model will check every number you write against the reports.

There are two cases. Look at your inputs to see which one you are in.

**A candidate passed the audit.** You are working on top of its commit.
**Nothing passed.** You are working on the baseline. This is a valid result; write it as one.

## Write

1. \`benchmarks/speed_search_v1/results/2026-11-10.md\`, one page:
   - the outcome in two lines: the candidate, its speedup and error ratio at matched error, the
     device, the number of ABBA blocks, the complete cost in dollars; or "no candidate passed";
   - a table of every idea tried: id, family, prediction, measured, verdict, commit;
   - what the run cost in total, including rejected candidates and the benchmark repair;
   - what the audit does not show: other devices, other cases, other grid sizes.
2. \`KEY_LEARNINGS.md\`: one new row in the graveyard for each rejected idea, in the table's
   existing format, with the measured ratio and the report it comes from. If a candidate passed,
   one entry under "Open hypotheses" naming it as a measured candidate.

## Rules

- Copy numbers from the reports. Do not round a 1.13 up, and do not average runs from two devices.
- Do not edit an existing graveyard row. Add rows.
- Do not set \`matchedErrorSpeedup=true\` anywhere, and do not move anything to \`KEY_INSIGHTS.md\`.
  The owner promotes a claim after reading your page. Until then the word is "candidate".
- If two ideas in one family both failed, say what they have in common in one line. That line is
  what stops the next run repeating them.
- Do not write agent notes, and do not touch the engine source or the benchmark.

Stop when both files are committed.
`)
      .judged(review(speed_claim, judge)),
  });

export default expedition({
  contract: {
    goal: `Make the WebGPU APIC engine (\`prototypes/surf_engine_v1\`) faster without making it less accurate,
and do it as a search I do not have to babysit.

I want many ideas tried in parallel: kernel variants, solver changes, precision, scheduling. Each
one has to clear the same matched-error gate before its speed counts for anything. Use the local
M4 for a quick screen and Modal for the full case set, and keep the implementers working while the
GPU is busy.

Two things have burned us before. First, noisy baselines: we once recorded a false 0.842× because
the A and B runs were not paired. If the benchmark cannot tell an A/A pair apart from a real
change, fix the benchmark before tuning anything. Second, repetition: the swarm re-tested ideas
that were already in the graveyard, and wrote hundreds of notes while no kernel moved. Keep one
dense shared record of what was tried and what it measured, and make every proposer read it.

A real result is one candidate that is at least 15% faster at matched error on the frozen cases,
under complete cost, on a named L4, confirmed by an ABBA audit and checked by someone who did not
build it. "Nothing beat the baseline, and here are the twelve ideas that failed and why" is also
a result I will accept. Either way the graveyard in \`KEY_LEARNINGS.md\` gets the new rows.`,
    leader: 'wave-simulation-lead',
    repo: '~/git/wave_sim',
    budget: { usd: 140, hours: 36 },
    autoApply: { usd: 15 },
    pools: { claude: 3, codex: 3, gemini: 1, gpu: 1, modal: 4, confirm: 1 },
    done: [
      {
        check:
          "bash -c 'bun test prototypes/surf_engine_v1/src tools/sim_runner_v1/runner.test.ts'",
      },
      {
        check:
          'python3 tools/speed_search_v1/verify_audit.py --max-error-ratio 1.0 --min-speedup 1.15',
      },
      { review: { rubric: speed_claim, by: judge } },
      { owner: 'Do you accept the audit, and may this case set record matchedErrorSpeedup=true?' },
    ],
    rules: [
      'Speed counts only at matched error on the frozen case set in benchmarks/speed_search_v1/protocol.json. Nobody edits that file, the reference fields or the scoring code during the run.',
      'Every speed number is an ABBA pair on one named device, with complete cost (setup, compile, evolution, readback, output, rejected work). A single timing is not a measurement.',
      'One change family per candidate. Before proposing or building, read the graveyard in KEY_LEARNINGS.md and the learning log. A refuted family is not re-tested without a stated representation change.',
      'Write a `learn` row for every idea you touch, with the prediction made before the measurement. Do not write agent notes for timing checkpoints; notes are not progress.',
      'Results cite a commit, never a dirty tree. Raw output goes to output/ through artifact_store_v1; only small summaries are tracked.',
      'Use "candidate" for everything that has not passed the confirm audit. Do not set matchedErrorSpeedup yourself.',
      "One local GPU runner at a time. Modal runs are scale-to-zero, carry --max-usd, and are launched only by the host's benchmark steps, never from an agent turn.",
      'V1 execution notes override historical host claims in the briefs: no land, fence, protect, tests/learn tool, automatic learning rows or no-retest gate exists. Commit on the work branch; never merge main or push. Integration may combine supplied commits only inside its private checkout. Carry prior commits explicitly through on/reads; record predictions and every verdict in the repo records from the supplied evidence, including failures. Writable scopes and frozen graders are instructions and review obligations, not host-enforced write fences.',
      'Modal total cap is $30 including all runs; use an external spend ledger and scale-to-zero launcher. confirm may be called at most twice, never automatically retried.',
    ],
  },
  plan: async (x) => {
    const set = need(await x.phase('cases', () => cases()), 'No frozen case list.');
    const trail: Readable[] = [];
    const [firstCase, ...otherCases] = set.out;
    if (!firstCase) return noResult('The frozen case set is empty.');
    const pilotNoise = await x.phase('noise-pilot', () => noise({ item: firstCase }));
    need(pilotNoise, 'The noise pilot did not produce a measurement.');
    const aa = [
      pilotNoise,
      ...(await x.phase('noise', () => parallel(otherCases, (item) => noise({ item })))),
    ];
    trail.push(...aa.flatMap(evidence));
    let base: Held<unknown> | undefined;
    if (passed(aa).length !== set.out.length || passed(aa).some((a) => a.out.spread > MAX_SPREAD)) {
      base = need(
        await x.phase('instrument', () => instrument({ reads: trail })),
        'The benchmark repair failed.'
      );
      const quieted = need(await quiet({ on: base }), 'A/A is still too noisy for the search.');
      trail.push(quieted);
    }
    await x.review('Is every frozen case trustworthy? Removing a noisy case needs the owner.');
    let keep: { id: string; code: Held<unknown>; speedup: number }[] = [];
    for (const gen of [1, 2, 3]) {
      await x.phase(`generation-${gen}`, async () => {
        const ideas = need(
          await propose({ id: gen, item: { gen }, reads: [...trail, ...keep.map((k) => k.code)] }),
          'No candidate proposals.'
        );
        trail.push(ideas);
        const trial = async (item: z.infer<typeof Idea>) => {
          const built = await implement({ item, on: base, reads: [ideas, ...trail] });
          const history: Readable[] = evidence(built);
          if (built.t !== 'passed')
            return {
              t: built.t === 'failed' ? ('ready' as const) : ('broken' as const),
              history,
              winners: [],
            };
          const local = await screen({ id: item.id, on: built });
          history.push(...evidence(local));
          if (local.t !== 'passed')
            return {
              t: local.t === 'failed' ? ('ready' as const) : ('broken' as const),
              history,
              winners: [],
            };
          const scored = await gate({ id: item.id, on: built });
          history.push(...evidence(scored));
          return {
            t:
              scored.t === 'passed' || scored.t === 'failed'
                ? ('ready' as const)
                : ('broken' as const),
            history,
            winners:
              scored.t === 'passed'
                ? [{ id: item.id, code: built, speedup: scored.out.speedup }]
                : [],
          };
        };
        const [first, ...rest] = ideas.out;
        const pilot = first ? await trial(first) : undefined;
        const trials = pilot ? [pilot] : [];
        // A refuted pilot teaches us something; only a broken pipeline suppresses width.
        if (pilot?.t === 'ready') trials.push(...(await parallel(rest, trial)));
        trail.push(...trials.flatMap((t) => t.history));
        keep = [...keep, ...trials.flatMap((t) => t.winners)]
          .sort((a, b) => b.speedup - a.speedup)
          .slice(0, 3);
      });
      await x.review(
        `Generation ${gen}: did any family move matched-error speed? Stop if two generations moved nothing.`
      );
    }
    let winner: Held<unknown> | undefined;
    await x.phase('confirm', async () => {
      for (const k of keep.slice(0, 2)) {
        const audit = await confirm({ id: k.id, on: k.code });
        trail.push(...evidence(audit));
        if (audit.t === 'passed') {
          winner = k.code;
          break;
        }
      }
    });
    return need(
      await x.phase('record', () =>
        record({
          on: winner ?? base,
          reads: [
            winner
              ? 'A candidate passed its long audit.'
              : 'No candidate passed; preserve every graveyard row.',
            ...trail,
          ],
        })
      ),
      'The independent audit of the record failed.'
    );
  },
});
