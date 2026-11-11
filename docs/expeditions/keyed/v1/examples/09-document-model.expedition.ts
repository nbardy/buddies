// Case 09: ratify one Studio document model and a plan that retires what runs.
// Serial design/critique/referee rounds; owner questions and independent spikes are wide.
// Gemini judges Claude designs, Codex critiques and the assumed Claude lead’s ledger.
// Base: wave_sim origin/main:agent_notes/2026-11-11_document_model_review/
// document-model-next.expedition.ts (read-only, 2026-11-11). Its one-file steps table,
// checkout -> independent review -> owner handoff structure is adapted here. Its three
// implementation tasks are a later phase and cannot replace this case’s no-app-code contract.
//
// V1 limits and NOTES carried forward:
// No host land or write fences: carry source through on, keep spike scope advisory, and leave
// manual integration to the owner. No typed x.ask answer: ask for a text ratification note
// and use x.confirm for the decision. This is separate from the host’s final owner criterion
// for the whole package including retirement. Refusal leaves a gap and preserves disagreement.
// A failed attack still ambiguously means no real defect or a poorly supported critique; the
// real-defect rubric is the guard, and the ratification question states how the last round ended.
// Coverage is third-provider judgment, not mechanical counts; no coverage checker exists.
// Named Buddy independence depends on the actual id/provider at preview. No wide primitive:
// parallel spans short spikes while x.ask waits without holding a seat. Owner defaults are
// options, never assumed answers. Historical flag calls mean report the gap; no flag API exists.
// Base file’s old UNLEASHD_EXPEDITIONS_V1 launch toggle is obsolete and intentionally omitted.
//
// Before launch (historical prerequisites; verify against the target checkout):
// - The `document-model-lead` Buddy id is assumed from the "Document Model Lead" owner named in
//   `product/MASTER_TASKS.md` §7. Its provider must not be gemini, or the dry run refuses the
//   ledger's reviewer.
// - `agent_notes/2026-11-10_document_model/` and everything in it (`LEDGER.md`, `MODEL.md`,
//   `COVERAGE.md`, `ROUNDS.md`, `RETIREMENT.md`, `spikes/`) is written by this expedition; none exists.
// - There is no command that checks ledger coverage. Coverage is judged by a reviewer against the
//   `covers-ledger` rubric, which is weaker than a script; see NOTES.md.
// - Spike commands are whatever each spike writes. No benchmark for Z5 (column evaluation within 3×
//   of plain JS) or Z9 (agent productivity) exists as a runnable command today.
// - Model ids pass the catalog gate; verify local CLI availability before launch. The budget
//   figures are illustrative.
// - Real paths this expedition reads, as they exist today: `studio/DOCUMENT_MODEL.md`,
//   `studio/design_kernel/09_ADJUDICATION.md`, `product/MASTER_TASKS.md`,
//   `agent_notes/2026-10-09_document_model_parity/REQUIREMENT_CONTRACTS.md`,
//   `agent_notes/2026-10-11_model_comparison/` (`DESIGN_GOALS_AND_USE_CASES.md`, `COMPARISON.md`,
//   `design_v1/`), `agent_notes/2026-10-12_reset/PLAN.md`,
//   `agent_notes/2026-10-14_document_model_owner_decisions.md`.
//
// Gates typecheck and dry-run declarations; they never execute or establish existence of these tools.
// Fill in actual Buddy ids and check their providers; test providers below are explicit assumptions.

import { type Readable, type Result, expedition, step } from 'expedition';
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

const PRIOR = [
  'studio/',
  'product/MASTER_TASKS.md',
  'agent_notes/2026-10-09_document_model_parity/',
  'agent_notes/2026-10-11_model_comparison/',
  'agent_notes/2026-10-12_reset/',
  'agent_notes/2026-10-14_document_model_owner_decisions.md',
];
const Verdict = z.object({
  blocking: z.number(),
  questions: z.array(
    z.object({ id: z.string(), question: z.string(), options: z.string(), fallback: z.string() })
  ),
  spikes: z.array(z.object({ id: z.string(), claim: z.string(), measure: z.string() })),
});

const ledger_complete = `# Rubric: does the ledger carry every source row, unchanged in force?

You are reviewing a requirement ledger written on another model. Every design round will be
judged against it, so an omission here is invisible later. You are checking completeness and
fidelity, not whether the requirements are good ones.

## Check

1. **Count.** For each source, count its rows yourself and compare with the count the ledger
   states and with the rows actually present:
   \`agent_notes/2026-10-09_document_model_parity/REQUIREMENT_CONTRACTS.md\` (inherited rows),
   \`agent_notes/2026-10-11_model_comparison/DESIGN_GOALS_AND_USE_CASES.md\` (G01–G12 and the
   use-case inventory), \`product/MASTER_TASKS.md\` §7 (Z1–Z11).
2. **Fidelity.** Pick fifteen rows spread across the sources. Open each source row. The ledger
   row must say the same thing with the same force: "required" stays required, the acceptance is
   the source's acceptance, and nothing was merged with a neighbour.
3. **Owner rulings.** Every question in
   \`agent_notes/2026-10-14_document_model_owner_decisions.md\` appears against the rows it covers,
   with its options and default. A ruling quoted as made must be one the owner actually made;
   a recommended default is not a ruling.
4. **The running model.** Pick five capabilities from \`studio/DOCUMENT_MODEL.md\` and confirm
   each has a row.
5. **No additions.** A row with no source is a fail, unless it is a \`RUN-nn\` row citing the
   running model.

## Verdict

Pass only if no source row is missing, none of the fifteen is softened or merged, and no default
is presented as a ruling. List what you counted and each row you opened. If you fail it, name the
missing or altered rows by id so they can be fixed without a second search.
`;
const covers_ledger = `# Rubric: does the model answer every ledger row, for real?

You are reviewing a document model written on another model, against the requirement ledger.
There is no test suite for a design. You are the check, so do the work a test would do.

## Check

1. **Every row has a line.** \`COVERAGE.md\` lists every ledger row, in order, as \`covered\`,
   \`scoped out\` or \`open\`. A missing row is a fail before you read anything else.
2. **Covered means shown.** Pick at least twenty \`covered\` rows, weighted toward the hard ones:
   identity and references, Undo and cold reopen, geometry that must keep its meaning, anything a
   prior critique broke. For each, open the cited \`MODEL.md\` section and ask whether you could
   work the row's acceptance through the model's types as written. A section that names the
   topic without showing the mechanism is not coverage.
3. **Scoped out means decided.** Each \`scoped out\` row cites a dated owner ruling or is listed as
   an owner question. The designer scoping out a required row on its own authority is a fail.
4. **Owner rulings are obeyed.** Every ruling quoted in the ledger or in \`ROUNDS.md\` is
   reflected in the model. Quote any contradiction.
5. **It can replace what runs.** The model does not depend on the running model in
   \`studio/DOCUMENT_MODEL.md\` remaining in place.
6. **The record is intact.** \`ROUNDS.md\` still has earlier rounds as they were written.

## Verdict

Pass only if every row has a line, at least nine in ten of the rows you checked are shown and
none of the failures is a row the model's central idea rests on, and checks 3 to 5 hold with no
exception.

In your answer list each row you checked, the section you opened and what you found. Judge the
model as written, not as it could be charitably read; the next reader will be an implementer.
Do not fail it for being unfinished where it honestly marks a row \`open\`, and do not pass it
because it is well written.
`;
const real_defect = `# Rubric: is this a real defect in the model?

You are judging a critique of a document model. You wrote neither. The critic is paid to find
faults, so some of what it reports will be doubts dressed as defects. Sort them.

A critique passes if at least one of its defects meets all three:

1. **Grounded.** It names a ledger row or use case and the \`MODEL.md\` section it breaks. Open
   both. The row says what the critic says it says, and the section is the one that governs it.
2. **Specific.** It gives a concrete document, edit sequence or program. Work it through the
   model as written. The model mishandles it in the way the critic claims.
3. **New.** It was not raised and settled in an earlier round recorded in \`ROUNDS.md\`. A defect
   the last revision reopened counts as new if the critic shows how.

For each defect, say which of the three it meets and, where it fails one, why. Then answer one
more question for each defect that passes, which does not change the verdict: does it break the
model's central idea or only one section?

## Fail

- A preference ("this would be cleaner as...") with no row behind it.
- A defect in a reading of the model weaker than what \`MODEL.md\` says.
- A repeat.
- A claim about what Zoo or Onshape does with no source the critic opened.

Do not pass a critique because the model looks weak, and do not fail one because the model looks
strong. If no defect meets the bar, fail the critique; that outcome ends the rounds, so be sure
you worked each concrete case before you rule.
`;
const replaces_running = `# Rubric: does this plan actually retire the running model?

You are reviewing a retirement plan written on another model. The owner has ratified the design.
The question here is narrower and has been failed eight times: will following this plan leave the
old model deleted, or will it leave a new model sitting beside it?

## Check

1. **The inventory is the running model.** Take the layers and components that
   \`studio/DOCUMENT_MODEL.md\` lists. Each appears in \`RETIREMENT.md\` with a fate. Pick ten paths
   from the inventory and confirm each exists in the tree at this commit.
2. **Every fate is defensible.** \`replaced by\` cites a section of the model that really does that
   job. \`deleted with no successor\` cites the ledger row and the owner ruling that scoped it out.
   \`kept\` explains why the thing is not part of the document model.
3. **Every step deletes.** Go through the ordered steps. A step that only adds fails, unless the
   very next step deletes what it supersedes and the plan says what happens if work stops between
   them.
4. **Consumers are named.** Each step names the check that shows real consumers still work: edit,
   Undo, save, cold reopen, export, and existing saved documents opening. "Tests pass" with no
   test named is not a check.
5. **Old documents.** There is an explicit migration, with original bytes and readers retained
   until it is proven.
6. **The first step can start.** It names files, a consumer journey and an acceptance.
7. **Conditions.** Any condition in the owner's ratification note is met.

## Verdict

Pass only if all seven hold. In your answer, list the paths you checked, each step and what it
deletes, and anything in the running model you could not find a fate for.

Do not reopen the design: whether the model is right was the previous question. Do not pass a
plan because it is detailed; a detailed plan to build beside the old model is the failure this
rubric exists to catch.
`;

export default expedition({
  contract: {
    goal: `I want one document model for Studio that I can ratify and that actually replaces what runs: the
capacity of Zoo or Onshape for the things we do, behind a much leaner interface.

We have designed this roughly eight times. Authoring v1–v4 and v7, L6, Marine v0.5,
feature_program, PR146, ae4487, DG and cleanroom: none of them replaced what runs in the app. I do
not want a ninth design document. I want the argument had properly, on the record, against the
requirement rows and use cases we already wrote down, by models that do not share each other's
blind spots, and then I want the questions that are really mine put to me with options and a
default.

The result is a model I ratify, with every inherited requirement row either covered or explicitly
scoped out, plus a retirement plan that names what gets deleted and in what order. If the critique
and the design cannot be reconciled, or I do not ratify it, tell me exactly what the open
disagreement is. That is a useful result. A polished design nobody adopted is not.`,
    leader: 'buddy:document-model-lead',
    repo: '~/git/wave_sim',
    budget: { usd: 120, hours: 72 },
    autoApply: { usd: 10 },
    pools: { claude: 1, codex: 2, gemini: 1, cpu: 2 },
    done: [
      { review: covers_ledger, by: 'referee' },
      { review: replaces_running, by: 'referee' },
      {
        owner:
          'Do you ratify this model and its retirement plan as the replacement for what runs in the app today?',
      },
    ],
    rules: [
      'Commit on the work branch; never merge main or push. Integrate supplied commits only inside your private checkout.',
      'Keep predictions and every verdict, including failures, in repo records from the supplied call evidence.',
      'studio/DOCUMENT_MODEL.md owns the facts about what runs today. Older design documents are history, not instructions.',
      'Every ledger row ends each round as covered (with the section that covers it), scoped out (with the reason and who decided), or open for the owner. No row is dropped silently.',
      'Owner rulings are fixed inputs, quoted with their date. A design may propose changing one; it may not assume the change.',
      'Tag every claim VERIFIED (run, or read in the code at a commit), CLAIMED or SPECULATION. A claim about Zoo or Onshape needs a source you opened.',
      "No changes to app, kernel or solver code. Spikes live under the expedition's spikes folder and are thrown away.",
      'A design that would sit beside the running model is not a result.',
    ],
  },
  agents: {
    referee: 'gemini:gemini-3.1-pro-preview',
    lead: { use: 'buddy:document-model-lead', usd: 8, minutes: 60 },
    designer: { use: 'claude:claude-sonnet-5-5:high', usd: 12, minutes: 90 },
    critic: { use: 'codex:gpt-6.1-sol:high', usd: 6, minutes: 45 },
    reflect: { use: 'gemini:gemini-3.1-pro-preview', usd: 4, minutes: 30 },
    builder: { use: 'codex:gpt-6.1-sol:medium', usd: 3, minutes: 30 },
  },
  steps: {
    ledger: {
      by: 'lead',
      reads: [...PRIOR],
      checkout: true,
      brief: `# Ledger: every requirement the model will be held to

Before anyone designs anything, write down the rows a design must answer. Every later round is
judged against this file, row by row, so a row you leave out is a requirement nobody will defend.
You are not designing and you are not judging the rows. You are making the list complete.

## Read

- \`agent_notes/2026-10-09_document_model_parity/REQUIREMENT_CONTRACTS.md\`: the inherited rows
  (D01 onward), each with its operations, consumers, migration and executable acceptance.
- \`agent_notes/2026-10-11_model_comparison/DESIGN_GOALS_AND_USE_CASES.md\`: goals G01–G12 with
  "how we know it works", the use-case inventory, and section 5, "no inherited obligations dropped".
- \`product/MASTER_TASKS.md\` §7: the Zoo-parity roadmap Z1–Z11.
- \`agent_notes/2026-10-14_document_model_owner_decisions.md\`: the twelve owner questions, their
  A/B/C options and defaults, and which assertion gaps each covers.
- \`studio/DOCUMENT_MODEL.md\`: what runs today. A capability the running model has is a row even
  if no requirement document mentions it.

## Write \`agent_notes/2026-11-10_document_model/LEDGER.md\` and commit it

One row per requirement, with:

- a stable id (keep the source's id: \`D06\`, \`G10\`, \`Z5\`; mint \`RUN-nn\` for capabilities found only
  in the running model),
- the requirement in one or two plain sentences, and the source \`file#section\` it comes from,
- how we would know it works, copied from the source where the source says,
- any dated owner ruling that already bears on it, quoted,
- any owner question still open on it, with its default.

Then two short lists: rows where two sources conflict (state both), and prior designs with the
one-line reason each was abandoned, from \`agent_notes/2026-10-12_reset/PLAN.md\` §1.

## What good looks like

- Nothing merged. Two source rows that sound alike stay two rows unless the source says they are
  one.
- Nothing softened. Carry "required" as required.
- Row count per source is stated at the top, so a reviewer can count against the source.

Do not add requirements of your own, rank the rows, or mark any row satisfied. Stop when every
source row has a ledger row; about an hour.
`,
      judge: { review: ledger_complete, by: 'referee' },
    },
    design: {
      by: 'designer',
      reads: [...PRIOR],
      checkout: true,
      brief: `# Design: one document model that can replace what runs

You are the designer for this expedition and you keep this role through every round: later calls
continue this conversation, so reason here in a way you can build on. The ledger is in your inputs
and is committed in your checkout. It is the list of what the model must answer.

## Read first

- The ledger, all of it, including the conflicts and the list of abandoned designs.
- \`studio/DOCUMENT_MODEL.md\`: the model that runs. Your design replaces this or it is not done.
- \`agent_notes/2026-10-11_model_comparison/COMPARISON.md\` and \`design_v1/\` (\`MODEL.md\`,
  \`CODE_PLAN.md\`, \`ACCEPTANCE.md\`, \`RETIREMENT.md\`): the most recent attempt.
- \`studio/design_kernel/09_ADJUDICATION.md\`: what a serious critique of an earlier draft found,
  including "smuggling a feature catalog while calling B-rep a backend problem".

## Write, under \`agent_notes/2026-11-10_document_model/\`

- \`MODEL.md\`: the model. Start with the types: the document's layers, what is authored and what
  is derived, identity and references, how an edit, Undo, save and cold reopen pass through it.
  Then the interface a person or an agent actually uses, and why it is leaner than Zoo's or
  Onshape's for the same capacity. Say what the core refuses to contain.
- \`COVERAGE.md\`: one line per ledger row: \`covered\` with the \`MODEL.md\` section that covers it,
  \`scoped out\` with the reason, or \`open\` with the owner question. Every row, in ledger order.
- \`ROUNDS.md\`: start it with this version's summary. Later rounds append; nothing is rewritten.

## What good looks like

- Small. If a capability can be a library over the core, it is not in the core, and you show the
  library's shape in ten lines.
- Each claim of capacity names the ledger row and the use case it serves, and how we would know.
- You say where this design differs from each abandoned one on the point that killed it. If it
  does not differ, that is a finding to state, not to hide.
- Where a decision is the owner's, you do not make it. You give options, a default, and what each
  costs, and mark the row \`open\`.

## Do not

- Write a design that needs the running model to stay. Additive designs are how the last eight
  ended.
- Mark a row \`covered\` because a section mentions it. Covered means a reader can see how the
  operation, its identity rules and its acceptance work in this model.
- Claim a performance or expressiveness property without tagging it SPECULATION until it is run.

Take the time this needs; this is one mind holding the whole model. Commit when \`COVERAGE.md\` has
a line for every row.
`,
      judge: { review: covers_ledger, by: 'referee' },
    },
    attack: {
      by: 'critic',
      reads: [...PRIOR],
      web: true,
      brief: `# Attack: where this model fails a requirement

You are the critic. You are given the current model, its coverage table and the ledger. The
designer is on another provider and will defend the model; a referee on a third decides whether
your defects are real. Your job is to find where the model, as written, does not do what a ledger
row requires.

First restate the model's central idea in its strongest form, in a few sentences, so you are not
attacking a careless reading.

## Find defects

Work from the ledger and the use cases, not from taste. Good places to press:

- Rows marked \`covered\` where the cited section does not actually show the operation, its
  identity rules or its acceptance.
- A consumer journey walked end to end: author, edit, Undo, save, cold reopen, export. Where does
  identity or meaning get lost?
- Capacity claimed against Zoo or Onshape that the types cannot express without a new core
  concept. A feature catalog hidden behind "that is a library" is a defect; show the library
  cannot be written against the stated core.
- The retirement path: something the running model in \`studio/DOCUMENT_MODEL.md\` does that this
  model has no place for.
- An owner ruling the design quietly contradicts.

## A defect counts only if it is

- **Grounded.** It names the ledger row or use case, and the section of \`MODEL.md\` it breaks.
- **Specific.** It gives a concrete document, edit sequence or program that the model mishandles,
  small enough to write out.
- **New.** Earlier rounds' defects and their rulings are in your inputs. Do not re-raise a
  settled one unless the revision reopened it, and then say how.

For each defect say whether you think it is blocking (the model cannot be ratified with it) and
whether it can be tested by running something. If it can, describe the smallest spike.

## Do not

- Propose your own model. Say what breaks, not what you would build.
- Pad. Three grounded defects beat twelve doubts. If you find none that meets the bar, say so
  and stop: a round with no real defect is evidence the model is holding.
`,
      judge: { review: real_defect, by: 'referee' },
    },
    adjudicate: {
      by: 'reflect',
      reads: [...PRIOR],
      brief: `# Adjudicate: which defects stand, and who has to decide

You are the referee, on a different provider from both the designer and the critic. You have the
model, the critique and the ledger. Neither side is yours. Decide what this round established.

## For each defect in the critique

1. Open the \`MODEL.md\` section and the ledger row it cites. Does the model, as written, fail the
   row in the concrete case the critic gives? Work the case yourself.
2. Rule: **stands** (the model must change), **falls** (say exactly why the case is handled),
   or **owner** (both readings are defensible and the choice is about scope, cost or product,
   which is not the designer's or yours to make).
3. For a defect that stands, say whether it is blocking: could the owner sensibly ratify the
   model with it open?

Do not split differences. If the critic is right, say the model is wrong.

## Owner questions

Write one for each \`owner\` ruling and for each ledger row the design left \`open\` that blocks
progress. First check \`agent_notes/2026-10-14_document_model_owner_decisions.md\` and the ledger's
quoted rulings: if the owner already answered, quote the answer and do not ask again.

Each question must stand alone for someone who has not read this round: the row ids, the choice
in plain words, two or three options with what each costs, and a default with one line of reason.
Keep them few. Five questions the owner can answer in ten minutes are worth more than fifteen.

## Spikes

List a spike only where a disputed claim can be settled by running something small in under half
an hour: a performance bound, whether a library really can be written against the core, a round
trip. Give the claim and exactly what to measure.

## Answer

Return \`blocking\` (the number of standing, blocking defects), \`questions\` (each with \`id\`,
\`question\`, \`options\`, \`fallback\` as the default) and \`spikes\` (each with \`id\`, \`claim\`,
\`measure\`). Put the per-defect rulings and your reasoning in the report. If nothing blocks and
nothing needs the owner, return zero and empty lists; that ends the rounds.
`,
      returns: Verdict,
    },
    spike: step({
      by: 'builder',
      needs: ['cpu'],
      checkout: true,
      brief: (item) => `# Spike ${item.id}: run it instead of arguing about it

The designer and the critic disagree about a claim that can be tested. Test it.

- **Claim:** ${item.claim}
- **Measure:** ${item.measure}

The current model is in your inputs. Work only under
\`agent_notes/2026-11-10_document_model/spikes/${item.id}/\`. This is throwaway code: nothing here is
imported by the app, the kernel or a solver, and you change no file outside that folder.

## Do

1. Before writing code, write \`PREDICTION.md\`: what result would support the claim, what result
   would refute it, and the threshold between them. Commit it first.
2. Write the smallest program that produces the measurement. Follow \`MODEL.md\` as written; if
   you have to deviate from the model to make the spike work, that deviation is the finding.
3. Run it. Record in \`RESULT.md\` the exact command, the commit, the machine, the output, and
   your verdict against the prediction: supported, refuted or inconclusive.

## What good looks like

- Someone else can rerun the command and get the same answer.
- A timing claim has a baseline measured the same way in the same run. A claim like "within 3x of
  plain JS" needs the plain JS number beside it.
- An expressiveness claim ("this is a library, not a core concept") is shown by the library
  existing in the spike, with the core untouched, or by the exact point where it could not be
  written.
- \`inconclusive\` with the reason is an acceptable result. A weak pass is not.

## Do not

- Change the prediction after you see the result.
- Extend the spike into a prototype. Thirty minutes. If it cannot be settled in that time, say
  what a real test would need and stop.
- Use a GPU, a remote machine or any paid service.

Your result is a claim until someone independent reruns it; say so in your summary.
`,
      item: z.object({ id: z.string(), claim: z.string(), measure: z.string() }),
    }),
    revise: {
      by: 'designer',
      reads: [...PRIOR],
      checkout: true,
      brief: `# Revise: answer the round

You designed the current model, and this call continues that work. In your inputs are the
critique, the referee's ruling on each defect, any spike results, and the ledger. The owner's
answers to this round's questions are also in your inputs, each starting "Owner ruling on" and
the question's id.

Owner answers are fixed. Quote each one in \`ROUNDS.md\` with today's date before you change
anything, and design to it even where you argued the other way.

## For every defect the referee ruled \`stands\`

Do one of three things, and say which in \`ROUNDS.md\`:

- **Change the model** so the critic's concrete case is handled. Show the case working.
- **Scope the row out**, only if an owner answer permits it. Cite the answer.
- **Concede it open.** If you cannot fix it without breaking something else, write down the
  conflict plainly. An honest open defect is better than a patch that moves it.

Do not re-argue a \`stands\` ruling. If you believe the referee misread the model, the fix is to
make \`MODEL.md\` say it clearly enough that the next round reads it correctly.

## Spikes

A refuted claim comes out of the model or is redesigned. A supported claim keeps its tag as
CLAIMED until rerun independently. Do not promote it.

## Update

- \`MODEL.md\` in place. It must read as one coherent model, not a model plus amendments.
- \`COVERAGE.md\`: every ledger row again, in order. A row whose section changed gets rechecked.
- \`ROUNDS.md\`: append this round: the defects, the rulings, the owner answers, what changed and
  what did not. Never edit earlier rounds.

## Watch for

- Growth. If this revision adds a core concept, name the concept it removes or explain why the
  core is still small. Each of the eight earlier designs grew this way.
- Fixing a defect by adding a layer beside the running model. The model must still be able to
  replace it.

Commit when \`COVERAGE.md\` again has a line for every row. A reviewer on another provider will
check coverage against the ledger before the next round starts.
`,
      judge: { review: covers_ledger, by: 'referee' },
    },
    retire: {
      by: 'designer',
      reads: [...PRIOR],
      checkout: true,
      brief: `# Retirement: how this model replaces what runs

The owner has ratified the model. You designed it, and this call continues that work. The owner's
note with the ratification is in your inputs, starting "Owner ratification note".

Treat any condition in that note as a requirement. The remaining job is the one the last eight
designs never did: say how the running model goes away.

## Read

- \`studio/DOCUMENT_MODEL.md\`: the running model and its layers, as fact.
- \`agent_notes/2026-10-11_model_comparison/design_v1/RETIREMENT.md\` and \`CODE_PLAN.md\`: an
  earlier retirement inventory. Use it as a lead; recheck every path against the current tree.
- Your own \`MODEL.md\` and \`COVERAGE.md\`.

## Write \`agent_notes/2026-11-10_document_model/RETIREMENT.md\`

1. **Inventory.** Every part of the running model: schemas, readers, writers, evaluators,
   codecs, views. For each: the path, what consumes it, and its fate, which is one of \`replaced by\`
   (the section of the new model), \`kept\` (why it is not part of the document model), or \`deleted
   with no successor\` (the ledger row that scopes it out, and who decided).
2. **Order.** The sequence of steps that gets from today to the old model deleted. Each step
   names what it adds, what it deletes in the same step, and the check that shows real consumers
   still work: edit, Undo, save, cold reopen, export, and old saved documents still opening.
3. **Old documents.** How existing saved documents are read: an explicit migration, with the
   original bytes and readers retained until it is proven.
4. **The first step,** in enough detail to start: files, the consumer journey it carries, its
   acceptance.
5. **What would stop this.** The conditions under which the plan should be abandoned.

Then add a short dated note at the top of \`studio/DOCUMENT_MODEL.md\`:
the ratified model, a link to this folder, and the statement that the document still describes
what runs until each step lands. Change nothing else in that file.

## What good looks like

- No step is "build the new thing beside the old one" without a deletion attached.
- Every path in the inventory exists in the tree at your commit.
- An engineer could disagree with the order on specifics, because the specifics are there.

Do not start the migration, and do not edit app, kernel or solver code. Stop when the inventory
accounts for every layer the running model document lists.
`,
      judge: { review: replaces_running, by: 'referee' },
    },
  },
  plan: async ({ ledger, design, attack, adjudicate, spike, revise, retire }, x) => {
    const rows = await x.phase('ledger', () => ledger());
    let current = await x.phase('design', () => design({ on: rows, reads: [rows] }));
    let open: Readable[] = [];
    let clean = false;
    for (const round of [1, 2, 3]) {
      const model = current;
      const next = await x.phase(`round-${round}`, async () => {
        const hit = await attack.try({ id: round, reads: [model, rows, ...open] });
        if (hit.t === 'failed') {
          open = evidence(hit);
          return { t: 'clean' as const };
        }
        if (hit.t !== 'passed')
          throw new Error(`Attack round ${round} did not produce a judged answer.`);
        const critique = hit;
        const verdict = await adjudicate({ id: round, reads: [model, critique, rows] });
        open = [critique, verdict];
        const { blocking, questions, spikes } = verdict.out;
        if (!blocking && !questions.length && !spikes.length) return { t: 'clean' as const };
        const [answers, probes] = await Promise.all([
          Promise.all(
            questions.map(
              async (q) =>
                `Owner ruling on ${q.id}: ${await x.ask(`${q.id}. ${q.question} Options: ${q.options} Default: ${q.fallback}`)}`
            )
          ),
          Promise.all(spikes.map((item) => spike.try(item, { on: model, reads: [model] }))),
        ]);
        open.push(...answers, ...probes.flatMap(evidence));
        const revised = await revise({
          id: round,
          on: model,
          continues: model,
          reads: [rows, ...open],
        });
        return { t: 'revised' as const, next: revised };
      });
      if (next.t === 'clean') {
        clean = true;
        break;
      }
      current = next.next;
      await x.checkin(
        `Round ${round}: did a blocking defect close, or only the wording move? Stop a ninth unadopted design.`
      );
    }
    const note = await x.ask(
      'What conditions or remaining disagreement should accompany your document-model ratification?'
    );
    const ratified = await x.confirm(
      `Do you ratify this model as the replacement for what runs? Last round ended ${clean ? 'with no referee-supported blocking defect' : 'on a revision not attacked again'}. Conditions: ${note}`
    );
    if (!ratified)
      throw new Error(`The owner did not ratify. Open disagreement and conditions: ${note}`);
    return await x.phase('retirement', () =>
      retire({
        on: current,
        continues: current,
        reads: [current, rows, ...open, `Owner ratification note: ${note}`],
      })
    );
  },
});
