// Case 07: a repair-workshop CRUD app with one schema and four consistent features.
// Serial foundation and exemplar; remaining features wide, then integration and walkthrough.
// Acceptance tests judge builders; Gemini checks the Claude walkthrough against real screens.
//
// V1 limits and NOTES carried forward:
// No host land: the exemplar explicitly starts on foundation, later slices start on exemplar,
// and integration carries all commits into one checkout. Input refs include source information,
// but imports/merges are the integrating worker’s job. No write fences or protect API:
// acceptance tests created by foundation cannot be frozen from the launch base. Before
// launch add a check to the acceptance runner that verifies schema, shared pieces and tests
// against the foundation/exemplar source, and validates feature diffs against their scopes;
// otherwise those protections remain advisory. The pilot is explicit, with no review wake
// in this fixed pipeline. No flag tool is provided: a missing shared piece must be reported
// as a failed requirement in the answer; the leader handles the resulting gap.
//
// Before launch (historical prerequisites; verify against the target checkout):
// - `~/git/shop-desk` does not exist. The use-case brief names no target repo; the workshop app is
//   invented so that the example has concrete entities.
// - The run assumes a scaffold is already committed at the launch base: a pnpm workspace with
//   `server/`, `client/`, `shared/`, `db/`, `test/` and `tools/`, and the scripts `pnpm typecheck`,
//   `pnpm test`, `pnpm build` and `pnpm accept`. None of them exists. The scaffold comes before live execution.
// - `pnpm accept <feature>` is invented. It should run `test/acceptance/<feature>.test.ts`. With
//   `--all` it should run every acceptance test and fail when a feature folder is missing.
// - `tools/` holds that runner. It must exist before live execution; v1 has no protect API.
// - `docs/CONVENTIONS.md`, `db/schema.ts`, `test/acceptance/` and the feature loader are written by
//   the `foundation` step. They do not exist before it.
// - `product-dev` is an invented Buddy id (the buddies repo mentions a "Product Dev" Buddy; its id
//   was not checked).
//
// Gates typecheck and dry-run declarations; they never execute or establish existence of these tools.
// Fill in actual Buddy ids and check their providers; test providers below are explicit assumptions.

import { expedition, step } from 'expedition';
import { z } from 'zod';

const Entity = z.object({ id: z.string(), name: z.string() });

const walkthrough_real = `# Rubric: does the walkthrough show what it says?

You are reviewing a walkthrough of a small web app, written on another model. The owner will
accept or reject the app from this document alone, so it must not claim more than it shows.

Open \`docs/walkthrough/README.md\` and every image it uses. For each step, check:

1. **The image is the app.** A real screen with real entered data, not a mock-up, a blank page,
   an error overlay or a loading state passed off as a result.
2. **The sentence matches the image.** If the text says an invoice is marked paid, the image
   shows that invoice with the status paid. Name the element you looked at.
3. **Data carries through.** The customer, vehicle, job and invoice created early are the ones
   shown later. A record that changes name or id between steps means the steps were not one run.

Then check coverage against the owner's goal in the contract:

- All four features appear, each with list, search, one record, create, edit and delete.
- The refused delete of a parent with children is shown, with its message.
- Sign-in is shown, and so is a signed-out visitor being turned away.
- The table at the top agrees with the steps below it.

Pass only if every step meets 1 to 3 and nothing in the coverage list is missing. A step the
walkthrough honestly reports as broken does not fail this review; it is the owner's to judge.
A broken step described as working does. List each step and what you saw.
`;

export default expedition({
  contract: {
    goal: `I run a small repair workshop and I want a plain web app to replace the whiteboard and the
spreadsheet. Staff sign in with email and password. There are four things to keep track of:

- **Customers**: name, phone, email, notes.
- **Vehicles**: belongs to a customer; registration, make, model, year.
- **Jobs**: belongs to a vehicle; description, status (booked, in progress, waiting for parts,
  done), assigned staff member, booked date.
- **Invoices**: belongs to a job; line items, total, status (draft, sent, paid).

For each one I need a list I can search, a page for one record, and create, edit and delete.
Deleting a customer who has vehicles should be refused with a clear message, and the same down
the chain. Only signed-in staff see anything.

Nothing here is new or clever, and I do not want it to be. I want the four parts to look and
behave like one app written by one person. Show me a walkthrough with a screenshot of every
screen and I will tell you whether it is right.`,
    leader: 'buddy:product-dev',
    repo: '~/git/shop-desk',
    budget: { usd: 40, hours: 6 },
    autoApply: { usd: 5 },
    pools: { claude: 4, gemini: 1 },
    done: [
      { check: `bash -c 'pnpm typecheck && pnpm accept --all && pnpm build'` },
      { review: walkthrough_real, by: 'judge' },
      { owner: 'Does the walkthrough show the app you asked for?' },
    ],
    rules: [
      'Commit on the work branch; never merge main or push. Integrate supplied commits only inside your private checkout.',
      'Keep predictions and every verdict, including failures, in repo records from the supplied call evidence.',
      'One type source. Table shapes live in db/schema.ts and the types derived from it in shared/. Nothing else declares the shape of a record.',
      'Follow docs/CONVENTIONS.md. If it does not cover your case, copy the nearest existing feature. Do not invent a second way.',
      'Test through the real boundary, HTTP against a real database. No mocked database, no mocked router.',
      'Use pnpm. Add no dependency that docs/CONVENTIONS.md does not list.',
      'No deploy, no real email, no real payment. I deploy it myself.',
      'Stop and report an exact foundation fault in your answer. Do not change schema, tests or shared conventions from a feature turn.',
    ],
  },
  agents: {
    judge: 'gemini:gemini-3.1-pro-preview',
    lead: { use: 'buddy:product-dev', usd: 6, minutes: 60 },
    builder: { use: 'claude:claude-sonnet-5-5:medium', usd: 3, minutes: 40 },
  },
  steps: {
    foundation: {
      by: 'lead',
      checkout: true,
      brief: `# Foundation: everything the four features share

You build the part of the app that every feature depends on, and you fix the rules the feature
builders will follow. After you, four workers build one feature each in parallel, and they
cannot edit anything you wrote. What you leave unclear, they will each decide differently.

Read the owner's goal in the contract. It names the entities, their fields and their relations.

## Build

1. **Schema.** \`db/schema.ts\` for every entity, with foreign keys and the delete rule the owner
   asked for (a parent with children cannot be deleted), plus a migration. Types derived from the
   schema go in \`shared/\`; this is the only place a record's shape is declared.
2. **Auth.** Email and password sign-in, a session, and one guard that every feature route sits
   behind. A seed script that creates one staff user for tests and the walkthrough.
3. **Shell.** The server app and the client app with sign-in, navigation and an empty home page.
   Features are found by folder: the server mounts every \`server/src/features/<id>/routes.ts\`,
   the client adds every \`client/src/features/<id>/\` to the routes and the navigation. A builder
   must be able to add a feature without editing a shared file.
4. **Shared pieces** the features will all need: a list page with search, a record form, a
   confirm-delete dialog, the error shape for a refused delete.
5. **\`docs/CONVENTIONS.md\`**, one page: file layout of a feature, naming, how a route validates
   input, how errors are returned and shown, how a list searches and pages, which shared pieces
   to use, and the dependencies allowed.
6. **Acceptance tests**, \`test/acceptance/<id>.test.ts\`, one file per entity, written now and
   failing now. Each goes through HTTP against a real database: signed out is refused; create,
   read, update, delete; list with search; the refused delete of a parent with children. These
   are the builders' judge. They may not change them, so make each one exact and fair.

## Answer

Return the list of entities to build, each with an \`id\` (the feature folder name, lowercase) and
a \`name\`. Order it so that the first is the simplest entity with no parent: it is built first
and alone, and the others copy it.

## Check and stop

\`pnpm typecheck && pnpm test\` must pass: your own tests for auth, the guard and the feature
loader. The acceptance tests are not part of that run. Do not build any feature. If the owner's
goal leaves a field or a rule undecided, choose the plainest reading and list the choice in your
report.
`,
      returns: z.array(Entity),
      judge: { check: `bash -c 'pnpm typecheck && pnpm test'` },
    },
    slice: step({
      by: 'builder',
      checkout: true,
      brief: (item) => `# Slice: build the ${item.name} feature

You build one feature, \`${item.id}\`, end to end: its API and its screens. Other workers build the other
features from the same starting commit, most of them at the same time as you.

## Read first

- \`docs/CONVENTIONS.md\`, whole. It decides layout, naming, validation, errors and which shared
  pieces to use.
- \`test/acceptance/${item.id}.test.ts\`. This is your judge and you cannot change it. Read it before
  writing anything; it states exactly what the API must do.
- \`db/schema.ts\` and \`shared/\` for the shape of a ${item.name} record and its relations.
- If a finished feature is already under \`server/src/features/\`, read its code. Build yours the
  same way: same file names, same structure, same handling of errors. Where it and the
  conventions disagree, follow the conventions and say so in your report.

## Build

Only inside \`server/src/features/${item.id}/\` and \`client/src/features/${item.id}/\`:

- Routes for list with search, read one, create, update and delete, behind the auth guard,
  validating input with the shared types.
- A list screen with search, a screen for one record, and a create and edit form, built from
  the shared list, form and confirm-delete pieces.
- Where ${item.name} belongs to a parent, the form picks the parent and the record page links to it.
- A refused delete shows the server's message to the user.

## Do not

- Edit anything outside your two folders. The schema, the shared types, the shell, the
  conventions and the tests are fixed. The app finds your feature by its folder; there is no
  list to add it to.
- Add a dependency, a second way to fetch data, or your own copy of a shared piece.
- Build screens for another entity because yours links to it. Link to where it will be.

If the schema or a shared piece is wrong or missing something you need, do not work around it:
stop and report exactly what is missing in your answer for the leader to handle.

## Done

\`pnpm typecheck && pnpm accept ${item.id}\` passes in your checkout. Commit. In your report, list the files
you added and anything in the conventions you found unclear.
`,
      item: Entity,
      judge: { check: (item) => `bash -c 'pnpm typecheck && pnpm accept ${item.id}'` },
    }),
    integrate: {
      by: 'lead',
      checkout: true,
      brief: `# Integrate: put the four features into one app

Your private checkout already contains the foundation and the first feature. Your inputs
are the commits of the other features. Each passed its own acceptance tests alone, starting from
the tree you are in. Merge them into one commit on which all of them pass together.

## Do

1. Merge each feature commit. Each one touched only its own two folders, so the merges should be
   clean. A conflict means a worker left its fence: do not resolve it quietly; say which commit
   and which file.
2. Run \`pnpm typecheck && pnpm accept --all && pnpm build\`. This is your judge.
3. Start the app, sign in as the seeded user, and follow every link between features: customer
   to its vehicles, vehicle to its jobs, job to its invoice, and back. A link that one feature
   guessed and another built differently is the usual seam.
4. Read the four features side by side for drift from \`docs/CONVENTIONS.md\`: a different file
   layout, a different error message shape, a list that pages differently. Fix drift inside the
   feature folders so the four read as one person's work.

## Limits

You may change files only under \`server/src/features/\` and \`client/src/features/\`. You may not
change the schema, the shared types, the shell or the acceptance tests. If the features cannot
work together without changing one of those, stop and report the exact change needed in your answer;
that is a foundation fault and the leader decides what to rerun.

Do not add features, restyle screens or refactor working code that follows the conventions.

## Report

List what you merged, each seam or drift you fixed and in which feature, and anything you chose
not to fix. Commit once.
`,
      judge: { check: `bash -c 'pnpm typecheck && pnpm accept --all && pnpm build'` },
    },
    walkthrough: {
      by: 'builder',
      checkout: true,
      brief: `# Walkthrough: show the owner the app

The owner decides whether this app is right by reading your walkthrough. He runs a repair
workshop and will not read code. Show him every screen, in the order he would use it.

## Do

1. Build and start the app from your commit with a fresh database and the seeded staff user.
2. Work through this story, entering realistic workshop data: sign in; add a customer; add a
   vehicle for that customer; book a job on the vehicle and move it through its statuses; raise
   an invoice for the job, add line items, mark it sent and then paid. Then: search each list;
   edit one record of each kind; try to delete the customer and show the refusal; delete from
   the bottom of the chain upward; sign out and show that a signed-out visitor sees nothing.
3. Take a screenshot at every step, of the real running app. Save each as WebP under
   \`docs/walkthrough/shots/\`, numbered in story order.
4. Write \`docs/walkthrough/README.md\`: for each step, one or two plain sentences on what the
   owner is looking at, then the screenshot. Start with a table of the four features and whether
   each of list, search, view, create, edit and delete works.

## Honesty

- If a step fails or looks wrong, screenshot it as it is and say so at that step. Do not fix
  the app; you may change only \`docs/walkthrough/\`.
- Never reuse a screenshot for two steps, crop out an error, or describe something the
  screenshot does not show. A reviewer on another model compares every sentence with its image.
- Do not describe the code, the stack or how it was built.

## Stop

When every step of the story has its screenshot and sentence. Commit. In your report, give the
count of steps that worked and list those that did not.
`,
      judge: { review: walkthrough_real, by: 'judge' },
    },
  },
  plan: async ({ foundation, slice, integrate, walkthrough }, x) => {
    const base = await x.phase('foundation', () => foundation());
    const [first, ...rest] = base.out;
    if (!first) throw new Error('Foundation returned no entities.');
    const exemplar = await x.phase('exemplar', () => slice(first, { on: base, reads: [base] }));
    const built = await x.phase('slices', () =>
      Promise.all(rest.map((item) => slice(item, { on: exemplar, reads: [base, exemplar] })))
    );
    const slices = built;
    const whole = await x.phase('integrate', () =>
      integrate({ on: exemplar, reads: [base, exemplar, ...slices] })
    );
    return await x.phase('walkthrough', () => walkthrough({ on: whole, reads: [whole] }));
  },
});
