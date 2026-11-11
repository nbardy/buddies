// Case 04: invent a true-3D water representation, or establish a precise no-go.
// Four blind discovery calls are wide; census and <=2 falsifiers are serial.
// Claude re-derives Codex math, Gemini judges Claude claims and the assumed Claude keeper.
//
// V1 limits and NOTES carried forward:
// No counted or machine-wide pools: falsifiers:1 serializes, and slice(0,2) caps plan calls
// only; an external durable receipt must prohibit repeats after retries/rewrites. No land,
// learning rows or no-retest gate: keeper records lineage and all rejections explicitly.
// The lineage family is not sent to builders, but cannot trigger a host no-retest refusal.
// Checkout reads cannot be restricted: builder blindness remains advisory. Discovery uses
// no checkout and only BLIND reads; verify the harness access report before live launch.
// Review has no configurable grant and only pass/fail, so SURVIVES vs REVISE/KILL stays in
// rubric prose; judges need evidence packaged in supplied refs. Contract rules reach blind
// workers and therefore must not name earlier architecture. No per-call write fences or
// protected evaluator paths; scripts must independently verify frozen bytes. The >=10 metric
// is an explicit exit-code assertion over receipt.py output, not a new metric API.
//
// Before launch (historical prerequisites; verify against the target checkout):
// - `tools/astra/known_answer.py`, `tools/astra/falsify.py`, `tools/astra/audit_run.py` and
//   `tools/astra/receipt.py` do not exist in wave_sim. They are four small scripts to write and
//   review before launch; the scripts must exist before live execution. `falsify.py` must
//   print one JSON object with `speedup` and write the full receipt the packet's `01_build.md` asks
//   for, including the physical error of both sides.
// - `auto_research/experiments/astra_wave_sim_restart_2026-11-10/` does not exist. The packet's
//   README says to create the dated run folder and copy the frozen campaign files into it at launch.
// - The `simulation-research` Buddy id is assumed. It must not run on gemini, or the `record` review
//   is refused at the dry run.
// - The freeze step (`! rg -q TBD_AT_LAUNCH` over the two contracts) uses only real paths, and it
//   fails today, as it should: `MODEL_AND_HARDWARE_CONTRACT.md` and
//   `REFERENCE_AND_ACCOUNTING_CONTRACT.md` still carry `TBD_AT_LAUNCH` fields. The status lines that
//   mention the token must be rewritten when the fields are frozen.
// - The blind allowlist names `MODEL_AND_HARDWARE_CONTRACT.md` for the hardware facts. The packet
//   also lists "solver-neutral scene and observation schemas" without a path; that file has to be
//   named and added to the allowlist before launch.
// - Seat names (`gpt-6-astra`, `claude-opus-5-5`, `gemini-3.1-pro-preview`) are the ones the repo's
//   own charters use; the packet leaves model identity `TBD_AT_LAUNCH`.
// - No falsifier against "the best admissible baseline" exists as one command today. The retained
//   reference class is a field of the unfrozen reference contract.
//
// Gates typecheck and dry-run declarations; they never execute or establish existence of these tools.
// Fill in actual Buddy ids and check their providers; test providers below are explicit assumptions.

import { type Held, type Readable, type Result, expedition, step } from 'expedition';
import { z } from 'zod';

// Preserve failed outputs as evidence too: filtering for passes alone would erase a search's refutations.
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

const PACKET = 'auto_research/experiments/pending/astra_wave_sim_restart_v1';
const HANDOFF = 'theory/radical_wave_computation/astra_handoff/v1';
const HARDWARE = `${PACKET}/MODEL_AND_HARDWARE_CONTRACT.md`;
const BLIND = [`${HANDOFF}/MINIMAL_PROBLEM.md`, HARDWARE];
const TRACKS = [{ id: 'N00-A' }, { id: 'N00-B' }, { id: 'S00-A' }, { id: 'S00-B' }];
const Pick = z.object({
  id: z.string(),
  source: z.enum(['N00-A', 'N00-B', 'S00-A', 'S00-B']),
  premise: z.string(),
  kill: z.string(),
});

const math_red_team = `# Rubric: does the mathematics close?

You are reviewing one discovery answer written on another model. You have the answer and the
files its author was given, and nothing else. You do not know what the project has built or
tried, and you must not look: judge the answer against the problem, not against a preference.

Do not improve the design. Do not suggest a better one. Recompute.

## Check, in this order

1. **Labels.** Every load-bearing statement carries TEXTBOOK, LITERATURE, DERIVATION or
   CONJECTURE. Re-derive each DERIVATION yourself. One you cannot reproduce is a CONJECTURE that
   was mislabelled; say which.
2. **Units and limits.** Every equation is dimensionally consistent. Take the obvious limits
   (still water, linear waves, vanishing timestep, a single cell) and see that they give the
   known answer.
3. **Conservation and closure.** Mass, momentum and energy are conserved or explicitly ledgered.
   The system is closed: no quantity is used that nothing evolves or reconstructs.
4. **State sufficiency.** The stated state can produce overturning, enclosed cavities and
   disconnected liquid. A single-valued surface or a 2D slice as the terminal state fails.
5. **Complete cost.** The work and memory formulas include adaptation, certification, conversion,
   rejected work, fallback and output. Look for a dense decode or a CPU loop that was not charged.
6. **The killing experiment.** It could actually fail, and its failure would refute the premise.

## Pass

Pass if no DERIVATION the system rests on is wrong, units and limits hold, the state is
sufficient, and the cost formula hides no problem-sized term. Honest CONJECTURES with a killing
test do not fail an answer. A no-go answer passes on the same terms: its bound must follow from
its stated assumptions.

Fail for a broken load-bearing derivation, a hidden cost term, or an insufficient state. Give the
exact equation and the mechanism. Elegance, novelty and length earn nothing in either direction.
`;
const matched_error = `# Rubric: does this candidate survive at matched error and complete cost?

You are a hostile, independent reviewer. You are given a frozen candidate, its exact source, its
immutable inputs, the falsifier receipt and the author's claim ledger. You do not have the
author's conversation, and you do not improve the design while judging it.

## Recompute

- The load-bearing equations, their units, the conservation identities and the sufficiency of
  the state, from the source and not from the prose.
- The comparison. Both sides ran on the same named adapter at the commits the receipt states.
  The physical error of the candidate is within the frozen tolerance of the baseline's. The
  baseline is the best admissible member of the frozen reference class at the same order; a
  higher-order method timed against a first-order baseline is not a speedup.
- The complete cost, term by term from the receipt: setup, compile, adaptation, certification,
  conversion, rejected work, fallback, readback, output, peak memory.

## Look specifically for

Hidden CPU work. Hidden dense state. Conversion, certification or fallback that ran but was not
charged. A test that only passes because of how this candidate is built. A receipt older than the
source it claims to describe. A threshold or prediction edited after the run.

## Verdict

Start your answer with one word.

- \`SURVIVES\`: pass. The stated speedup holds at matched error and complete cost on the named
  hardware, and the claim ledger claims no more than that.
- \`REVISE\`: fail. The slice is sound but the claim outruns the evidence. Say what to remove.
- \`KILL\`: fail. Give the exact failure mechanism.

Then list the facts you reproduced independently, the claims that remain unearned, and the single
cheapest observation that would most change your verdict. A hard physical, provenance or
GPU-execution failure cannot be averaged away by elegance, novelty or a good-looking result.
`;
const faithful_record = `# Rubric: is the record faithful to the evidence?

You are reviewing a commit that writes a research campaign's results into the repository's
knowledge files. You did not take part in the campaign. You are given the commit, the receipts
and the judgments it cites.

Open the evidence behind each new statement. Do not trust a summary of it.

## Check

1. **Every new graveyard row** names the hypothesis as claimed, the failure mechanism with a
   measured number, and an evidence path that exists at the cited commit. The number in the row
   is the number in the receipt.
2. **No promotion.** A killed candidate is recorded as refuted in the form that was tested. A
   surviving candidate's claim sentence matches its claim ledger word for word. Nothing judged
   REVISE or KILL is described as promising, partial success or "close".
3. **No deletion.** No existing graveyard row was removed or reworded. Compare against the base.
4. **The run ledger is complete.** Every run that the evidence shows took place has a row,
   including the discoveries that failed review and any refused falsifier.
5. **A no-go is stated with its assumptions.** A lower bound written without them reads as
   stronger than it is.
6. **Nothing is cited from a worker tree or a dirty tree.**

## Pass

Pass only if all six hold. If the synthesis and the evidence disagree anywhere, fail it and quote
both. A record that is modest and correct passes; a record that is complete and inflated does not.
`;

export default expedition({
  contract: {
    goal: `I want a materially faster true-3D breaking-water system: new mathematics that gives a 10× to 200×
speedup at matched physical error and complete target-GPU cost, not another tuning pass on what we
have. Everything we have tried so far is in the graveyard, and I think the next real step comes
from a representation we have not looked at.

Run the Astra restart packet the way it was designed. The discovery runs must be blind: they see
the minimal problem and the hardware facts and nothing else of ours, no architecture names, no
attempt ledger, no sibling output. Otherwise I cannot tell invention from our own vocabulary read
back to us. Then a blind census by a different model, then one GPU falsifier per selected
candidate against the best admissible baseline, then a hostile judgment by someone who did not
write it.

I would rather get "nothing survived, and here is the lower bound that says why" than a candidate
that was graded by its author or timed against an unfair baseline. That has happened to us: an
integrator-order result sold as novelty against a first-order baseline, an elimination that cut
iterations 18% and ran 30% slower. If two clean falsifiers fail, stop.

Whatever happens, the refuted representations go into the graveyard with their mechanism, so the
next campaign does not pay for them again.`,
    leader: 'buddy:simulation-research',
    repo: '~/git/wave_sim',
    budget: { usd: 400, hours: 36 },
    autoApply: { usd: 40 },
    pools: { codex: 4, claude: 2, gemini: 2, gpu: 1, falsifiers: 1 },
    done: [
      {
        check:
          'python3 tools/astra/audit_run.py auto_research/experiments/astra_wave_sim_restart_2026-11-10',
      },
      {
        check: `python3 -c 'import json,subprocess; r=json.loads(subprocess.check_output(["python3","tools/astra/receipt.py","--best","--json"])); assert r["speedup"] >= 10'`,
      },
      { review: matched_error, by: 'gemini' },
      { owner: 'Do you accept this candidate (or this no-go) as the result of the campaign?' },
    ],
    rules: [
      'Commit on the work branch; never merge main or push. Integrate supplied commits only inside your private checkout.',
      'Keep predictions and every verdict, including failures, in repo records from the supplied call evidence.',
      'Label every load-bearing statement TEXTBOOK, LITERATURE (with the citation), DERIVATION or CONJECTURE.',
      'Speed counts only at matched physical error and complete cost. Charge setup, compile, adaptation, certification, conversion, rejected work, fallback, readback and output.',
      'A precise no-go or lower bound is a full result. Page count, theorem count and polished prose are not progress.',
      "No Modal and no paid compute. The local GPU is used only by the host's falsifier command. Do not start a GPU run yourself.",
      'Raw responses and run output go to output/ through artifact_store_v1. Tracked summaries go under the run folder and cite a commit, never a dirty tree.',
      'No retry of a spent falsifier. Before launch establish external machine GPU locking and a durable two-use authorization record. Write each prediction, verdict and mechanism in the run ledger from supplied call evidence.',
    ],
  },
  agents: {
    gemini: 'gemini:gemini-3.1-pro-preview',
    redTeam: 'claude:claude-opus-5-5:high',
    inventor: { use: 'codex:gpt-6-astra:high', usd: 30, minutes: 240 },
    outsider: { use: 'gemini:gemini-3.1-pro-preview', usd: 8, minutes: 60 },
    builder: { use: 'claude:claude-opus-5-5:high', usd: 25, minutes: 180 },
    keeper: { use: 'buddy:simulation-research', usd: 6, minutes: 45 },
  },
  steps: {
    frozen: {
      run: `bash -c '! rg -q TBD_AT_LAUNCH ${HARDWARE} ${PACKET}/REFERENCE_AND_ACCOUNTING_CONTRACT.md && test -s ${HARDWARE} && test -s ${PACKET}/REFERENCE_AND_ACCOUNTING_CONTRACT.md'`,
      minutes: 1,
    },
    neutral: {
      by: 'inventor',
      reads: [...BLIND],
      brief: `# Discover: one system, from first principles

You are a mathematical physicist and GPU systems inventor. This is a fresh context, on purpose.

## Read

Only the two files you have been given: \`MINIMAL_PROBLEM.md\` and the hardware contract. You have
no repository access and no web access. You are not being shown any earlier design, any earlier
attempt, or anyone else's answer, and you should not try to guess at them. If the problem
statement seems to leave something open (the state carrier, the time representation, how the
global constraint is enforced, what is analytical and what is learned), it is open.

## Produce

Derive one coherent end-to-end computational system. One, not a survey of alternatives and not an
optimization of some assumed existing solver. Specify:

- the authoritative physical state, its units, what is treated as equivalent, and how the fields
  an observer needs are reconstructed from it;
- how it evolves in time, and what owns the global constraint;
- what happens at topology change, in enclosed and venting cavities, at solids, and which wind
  level you implement;
- the finite GPU buffers and a legal pass and dependency graph;
- the complete work, memory, timestep and error variables, as formulas in the problem's sizes;
- the regime where it wins, the regime where it collapses, and the fail-closed fallback there;
- one self-contained experiment that could kill the load-bearing premise.

Label every load-bearing statement. Do not hide work in encoding, decoding, learning,
certification, conversion, rejected work or fallback: if it scales with the problem, charge it.

## What good looks like

A reviewer on another model will recompute your units, limits, conservation identities, closure
and cost, with only your answer and the same two files in front of them. A statement they cannot
re-derive must already be labelled CONJECTURE by you. An honest CONJECTURE with a cheap killing
test is worth more than a DERIVATION that does not close.

## End with

The single load-bearing hypothesis, the observation that would kill it, and the smallest
executable slice that would produce that observation. Then stop. Do not revise after the end.
`,
      judge: { review: math_red_team, by: 'redTeam' },
    },
    subvolume: {
      by: 'inventor',
      reads: [...BLIND, `${HANDOFF}/SUBVOLUMETRIC_CHALLENGE.md`],
      brief: `# Discover: a sub-volume-time system, or the reason there cannot be one

You are a mathematical physicist and GPU systems inventor. This is a fresh context, on purpose.

## Read

Only the three files you have been given: \`MINIMAL_PROBLEM.md\`, the hardware contract and
\`SUBVOLUMETRIC_CHALLENGE.md\`. You have no repository access and no web access. You are not being
shown any earlier design, any earlier attempt, or anyone else's answer. The challenge file defines
the best admissible volumetric baseline and the common accounting of arithmetic and memory
traffic. Use its definitions exactly; do not redefine the baseline to make the question easier.

## The question

Can the minimal problem be solved, at matched physical error, with complete work per unit of
simulated time that grows more slowly than the resolved volume? You are conditioned on this
question and nothing else.

## Produce exactly one of

**A candidate.** One coherent system, specified as fully as a neutral design would be: state,
units and reconstruction; evolution and the owner of the global constraint; topology, cavity,
solid and wind semantics; finite GPU buffers and a legal pass graph; complete work, memory,
timestep and error formulas; favourable regime, collapse regime and fail-closed fallback; one
experiment that could kill the premise. State the claimed scaling law and every term it omits.

**A no-go.** A precise statement of why no such system exists under the challenge's accounting: a
lower bound, a state-sufficiency argument, or a counterexample family, with its assumptions
listed. Say which assumption a future candidate would have to break. This is a full result. Do
not soften it into a candidate to have something to show.

## What good looks like

Every load-bearing statement is labelled. A reviewer on another model will recompute your scaling
law term by term with only your answer and the same three files. Work moved into encoding,
decoding, certification, conversion, rejected steps or fallback is still work: charge it, or the
law is wrong.

## End with

For a candidate: the load-bearing hypothesis, its killing observation, the smallest executable
slice. For a no-go: the bound, in one sentence, and the assumption it rests on. Then stop.
`,
      judge: { review: math_red_team, by: 'redTeam' },
    },
    census: {
      by: 'outsider',
      brief: `# Census: what was actually proposed, and what to build first

You are an independent census analyst. You are given the discovery answers that passed a
mathematical review, and nothing else. Two came from a neutral prompt (\`N00-*\`) and two from a
prompt conditioned on a sub-volume-time question (\`S00-*\`); some may be missing because they did
not pass. You have no access to the project's research, source or failure records. Do not repair,
merge or extend a candidate. A no-go answer is not a candidate; record it and do not select it.

## Fingerprint each answer

In neutral words, not the author's names:

- the authoritative state, and what information it leaves out;
- the time representation and what memory it carries;
- what owns the global constraint;
- who owns topology, cavities and solids;
- the form of execution on the accelerator;
- the certification, collapse and fallback law;
- the claimed favourable regime and the scaling or wall-clock hypothesis.

## Then

1. Mark any answer that shows knowledge it should not have had, or that is missing a field.
2. Cluster answers that are structurally the same system under different names. Give the pairwise
   similarity and say why.
3. Separate independent convergence from shared conditioning. Two \`S00\` answers agreeing is
   weaker evidence than an \`N00\` and an \`S00\` agreeing, and neither is proof.
4. For each cluster, name the earliest and cheapest observation that would falsify it.

## Select

At most two candidates to build first, normally the strongest neutral one and the strongest
conditioned one, unless a structural defect kills one before it is built. Only two falsifier runs
exist; a third selection will be refused. Selecting one, or none, is a valid answer if that is
what the answers support.

For each selection return \`id\` (lowercase, hyphenated, your own neutral name), \`source\` (the run
it came from), \`premise\` (its load-bearing hypothesis in one sentence) and \`kill\` (the observation
that would refute it). In your summary, list every non-selection and the reason.

Do not score prose. A long, confident answer and a short one are judged on their fingerprint.
`,
      returns: z.array(Pick),
    },
    lineage: step({
      by: 'keeper',
      reads: ['KEY_LEARNINGS.md'],
      brief: (item) => `# Lineage: has this family already been refuted?

Candidate: \`${item.id}\`, from run ${item.source}.
Premise: ${item.premise}

You are the only seat in this expedition that reads both a blind candidate and the project's
supplied call evidence. That is why your answer is one word. The builder and the judge of this candidate
must not learn what the project tried before, so nothing you write except the family name leaves
this call, and the family name goes to the host, not to them.

## Read

- The candidate's discovery answer, in your inputs.
- The supplied call evidence, in your inputs.
- \`KEY_LEARNINGS.md\`, the section "Refuted (the graveyard ...)", and
  \`theory/subvolumetric_simulation/v1/ATTEMPT_LEDGER.md\`.

## Decide

Which mechanism family does this candidate belong to? Compare mechanisms, not names: the state
carrier, the time representation, the owner of the global constraint. A candidate that reaches an
old idea through a genuinely different representation is a new family. That is the repo's own
rule: a refuted row is never re-tested without a representation change.

- If it matches a family already in the log, return that family's exact name. State any rejection
  explicitly for the leader to enforce before spending a falsifier; v1 has no automatic no-retest gate.
- If it does not, return a new, short, neutral family name.

Do not stretch a match to save a falsifier, and do not invent a new name to let a dead idea
through. If you are unsure, return the existing family and say in your summary what would have to
be different for it to count as new; the leader reads that at the next review.

## Stop

About 30 minutes. Do not assess whether the candidate is good. That is not your call.
`,
      item: Pick,
      returns: z.object({ family: z.string() }),
    }),
    build: step({
      by: 'builder',
      checkout: true,
      brief: (item) => `# Build: the smallest slice that can kill \`${item.id}\`

Premise to test: ${item.premise}
Killing observation: ${item.kill}

You are given one frozen candidate (in your inputs), \`MINIMAL_PROBLEM.md\` and the hardware
contract. Do not redesign the candidate. If an explicit contradiction makes it impossible to
implement, stop and report the contradiction; that is a result.

## Produce

Under \`candidates/${item.id}/\` in the run folder, source before explanation:

- \`source/\`: the smallest GPU-owned executable slice that can produce the killing observation.
  Exact persistent buffers with units, capacities and overflow behaviour. A legal WebGPU/WGSL
  pass graph. Global coupling and dynamic work constructed on the device.
- A pure CPU f64 twin of the load-bearing computation, only where it serves as a known answer.
- One source-bound scene, one hostile control that destroys the candidate's favourable
  assumptions, and pass and kill thresholds fixed in a file before anything runs.
- \`PREDICTION.md\`: the speedup and the error you expect, and why, written now. It is compared
  with the measurement later and cannot be edited after the run.
- \`ORIGIN.md\` and \`lineage.json\`: which discovery run this came from, by its stored id.

The host's falsifier command will run your slice and the retained baseline at matched error. Make
the slice report physics error, wall time, bytes moved, dispatches, reductions, readbacks, peak
memory, failed work and fallback, so that complete cost can be charged.

## Your commit is checked

A known-answer script runs the CPU twin and thresholds file under \`candidates/${item.id}/\`. It does not touch the GPU. If
the known answer fails, the falsifier is not spent on this candidate.

## Do not

- Run anything on the GPU. There is one falsifier run for this candidate and the host owns it.
- Put a per-entity or per-iteration loop on the CPU, or a dense decode nobody charged.
- Claim speed, novelty or a full solver. A slice that passes its known answer has shown only that.
- Read the project's earlier work: \`KEY_LEARNINGS.md\`, \`theory/\` outside the handoff's
  \`MINIMAL_PROBLEM.md\`, other candidates' folders, or solver source. Your checkout can open them;
  the campaign is only valid if you do not.
- Edit \`tools/astra/\`, the campaign packet or another candidate's folder. The first two must be
  independently checked against the frozen source before grading and before the falsifier runs.

Stop at the smallest slice that would materially change belief. Record what you learn in the candidate notes for the final research ledger.
`,
      item: Pick,
      judge: { check: (item) => `python3 tools/astra/known_answer.py --candidate ${item.id}` },
    }),
    falsify: step({
      run: (item) => `python3 tools/astra/falsify.py --candidate ${item.id} --json`,
      minutes: 180,
      item: Pick,
      needs: ['gpu', 'falsifiers'],
      returns: z.object({ speedup: z.number() }),
    }),
    claim: step({
      by: 'builder',
      checkout: true,
      brief: (item) => `# Claim: exactly what the receipt supports for \`${item.id}\`

You built this slice. The host has now run its one falsifier, and the receipt is in your inputs.
There will be no second run. Your job is to write down what was shown, and nothing more.

## Write \`candidates/${item.id}/CLAIM_LEDGER.md\`

1. **Prediction against measurement.** Copy the numbers from \`PREDICTION.md\` unchanged, put the
   measured numbers beside them, and state the difference. Do not explain a miss away.
2. **The comparison.** Which baseline, on which adapter, at which commit, and the physical error
   of both sides. Matched means within the tolerance frozen in the reference contract. If the
   baseline was not the best admissible member of the reference class at the same order (for a
   time integrator: the same-stage Gauss, Lobatto or Radau scheme), say so; the speedup then
   does not stand.
3. **Complete cost.** Setup, compile, evolution, adaptation, certification, conversion, rejected
   work, fallback, readback and output, each from the receipt. A term the receipt does not
   report is written "not measured", not zero.
4. **The claim.** One sentence with the speedup factor, the scene, the error and the hardware.
   Then the list of larger claims this does not earn: other scenes, other resolutions, the
   full solver, scaling.
5. **The hostile control.** What happened on it.

## Rules

- Change no source and no threshold. This step adds the ledger and the receipt pointer only.
- Every number carries the path of the receipt it came from.
- If the measurement refutes the premise, write that as the claim. A clean refutation with its
  mechanism is what the graveyard needs, and it is a better outcome than an inflated survival.

A reviewer on another model, who has not seen your conversation, will recompute the comparison
from the frozen source and the receipt. The host stores their verdict with the keyed call; write the durable research rows from it;
do not record a verdict yourself.
`,
      item: Pick,
      judge: { review: matched_error, by: 'gemini' },
    }),
    record: {
      by: 'keeper',
      checkout: true,
      brief: `# Record: put what was learned where the next campaign will read it

The falsifiers are spent. You are given the discovery answers, the kills, any surviving claim and
the supplied call evidence. Write the durable record in the repo's own files and commit it. Do not create a
new notes folder.

## Write

- \`auto_research/experiments/astra_wave_sim_restart_2026-11-10/RUN_LEDGER.md\`: one row per run
  (four discoveries, the census, each build, falsifier and judgment) with its stored id, model,
  outcome and cost. \`SYNTHESIS.md\` beside it: what the campaign found, in a page.
- \`KEY_LEARNINGS.md\`, the graveyard table: one row per refuted candidate. State the hypothesis as
  it was claimed, then the mechanism of the failure with its number, then the evidence path. Write
  it the way the existing rows are written, for example "cut iterations 18%, ran 30% slower
  overall". A row without a mechanism does not stop anyone from trying the idea again.
- For a no-go or lower bound: a short theory note under the matching program in \`theory/\`, with
  its assumptions and the one a future candidate would have to break. Add it to \`theory/INDEX.md\`.
- For a survivor: a pointer from \`theory/CURRENT.md\` to its claim ledger. Copy its claim sentence
  exactly. Do not restate the speedup in stronger words.

## Rules

- Never delete or reword an existing graveyard row. Add rows; add a dated marker to an old row
  only if this campaign corrected its mechanism.
- Every statement cites a receipt path and a commit. Nothing is cited from a worker tree.
- Keep claim levels as they were judged. A candidate that was killed is refuted in this form, not
  in all possible forms; say which form. A candidate that survived one scene has survived one
  scene.
- Raw responses stay in \`output/\` through \`artifact_store_v1\`; the tracked files hold digests and
  pointers.

## Stop

When the ledger, the synthesis and the knowledge rows are committed. If nothing survived, the
synthesis says so in its first line, followed by what future spend this saves.
`,
      judge: { review: faithful_record, by: 'gemini' },
    },
  },
  plan: async (
    { frozen, neutral, subvolume, census, lineage, build, falsify, claim, record },
    x
  ) => {
    await x.phase('freeze', () => frozen());
    const runs = await x.phase('discover', () =>
      Promise.all(TRACKS.map(({ id }) => (id.startsWith('N') ? neutral : subvolume).try({ id })))
    );
    const sound = runs.filter((r) => r.t === 'passed');
    if (!sound.length) throw new Error('No blind discovery survived the math red team.');
    const picks = await x.phase('census', () => census({ reads: sound }));
    await x.checkin(
      'Are the picks distinct mechanisms with killing observations, before a falsifier is spent?'
    );
    const trail: Readable[] = runs.flatMap(evidence);
    const survivors: { claim: Held<unknown>; speedup: number }[] = [];
    await x.phase('falsify', async () => {
      for (const c of picks.out.slice(0, 2)) {
        const origin = runs[TRACKS.findIndex((t) => t.id === c.source)]!;
        if (origin.t !== 'passed') throw new Error(`Discovery ${c.source} did not pass.`);
        const kin = await lineage.try(c, { reads: [origin] });
        trail.push(...evidence(kin));
        if (kin.t !== 'passed') continue;
        const built = await build.try(c, { reads: [origin] });
        trail.push(...evidence(built));
        if (built.t !== 'passed') continue;
        const run = await falsify.try(c, { on: built });
        trail.push(...evidence(run));
        if (run.t !== 'passed') continue;
        const claimed = await claim.try(c, { continues: built, on: built, reads: [run] });
        trail.push(...evidence(claimed));
        if (claimed.t === 'passed') survivors.push({ claim: claimed, speedup: run.out.speedup });
      }
    });
    await x.checkin(
      'Compare receipts to predictions. Two clean failures end this line; a no-go is a result.'
    );
    const winner = survivors.sort((a, b) => b.speedup - a.speedup)[0];
    return await x.phase('record', () =>
      record({
        on: winner?.claim,
        reads: [
          winner
            ? 'A candidate survived.'
            : 'No candidate survived; record every kill and lower bound.',
          ...trail,
        ],
      })
    );
  },
});
