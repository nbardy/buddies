---
leader: product-dev                # a named Buddy; here it is woken only when a step fails
repo: ~/git/shop-desk
budget: { usd: 40, hours: 6 }
autoApply: { usd: 5 }              # a rewrite adding more new cost than this waits for the owner
pools:
  claude: { slots: 4 }             # an agent call reserves the pool named for its provider
  gemini: { slots: 1 }
done:                              # the host evaluates these on ONE commit; nobody else may
  - check: pnpm typecheck && pnpm accept --all && pnpm build
  - review: { rubric: walkthrough-real, by: gemini/gemini-3.1-pro-preview/high }
  - owner: Does the walkthrough show the app you asked for?
rules:                             # appended verbatim to every brief
  - One type source. Table shapes live in db/schema.ts and the types derived from it in shared/. Nothing else declares the shape of a record.
  - Follow docs/CONVENTIONS.md. If it does not cover your case, copy the nearest existing feature. Do not invent a second way.
  - Test through the real boundary, HTTP against a real database. No mocked database, no mocked router.
  - Use pnpm. Add no dependency that docs/CONVENTIONS.md does not list.
  - No deploy, no real email, no real payment. I deploy it myself.
---

# Goal

I run a small repair workshop and I want a plain web app to replace the whiteboard and the
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
screen and I will tell you whether it is right.

## Not yet real

- `~/git/shop-desk` does not exist. The use-case brief names no target repo; the workshop app is
  invented so that the example has concrete entities.
- The run assumes a scaffold is already committed at the launch base: a pnpm workspace with
  `server/`, `client/`, `shared/`, `db/`, `test/` and `tools/`, and the scripts `pnpm typecheck`,
  `pnpm test`, `pnpm build` and `pnpm accept`. None of them exists. The launch dry run refuses a
  check that cannot run, so the scaffold comes before the expedition.
- `pnpm accept <feature>` is invented. It should run `test/acceptance/<feature>.test.ts`. With
  `--all` it should run every acceptance test and fail when a feature folder is missing.
- `tools/` holds that runner. The checks protect it, so it must exist at the launch base.
- `docs/CONVENTIONS.md`, `db/schema.ts`, `test/acceptance/` and the feature loader are written by
  the `foundation` step. They do not exist before it.
- `product-dev` is an invented Buddy id (the buddies repo mentions a "Product Dev" Buddy; its id
  was not checked).
