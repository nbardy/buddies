# Foundation: everything the four features share

You build the part of the app that every feature depends on, and you fix the rules the feature
builders will follow. After you, four workers build one feature each in parallel, and they
cannot edit anything you wrote. What you leave unclear, they will each decide differently.

Read the owner's goal in the contract. It names the entities, their fields and their relations.

## Build

1. **Schema.** `db/schema.ts` for every entity, with foreign keys and the delete rule the owner
   asked for (a parent with children cannot be deleted), plus a migration. Types derived from the
   schema go in `shared/`; this is the only place a record's shape is declared.
2. **Auth.** Email and password sign-in, a session, and one guard that every feature route sits
   behind. A seed script that creates one staff user for tests and the walkthrough.
3. **Shell.** The server app and the client app with sign-in, navigation and an empty home page.
   Features are found by folder: the server mounts every `server/src/features/<id>/routes.ts`,
   the client adds every `client/src/features/<id>/` to the routes and the navigation. A builder
   must be able to add a feature without editing a shared file.
4. **Shared pieces** the features will all need: a list page with search, a record form, a
   confirm-delete dialog, the error shape for a refused delete.
5. **`docs/CONVENTIONS.md`**, one page: file layout of a feature, naming, how a route validates
   input, how errors are returned and shown, how a list searches and pages, which shared pieces
   to use, and the dependencies allowed.
6. **Acceptance tests**, `test/acceptance/<id>.test.ts`, one file per entity, written now and
   failing now. Each goes through HTTP against a real database: signed out is refused; create,
   read, update, delete; list with search; the refused delete of a parent with children. These
   are the builders' judge. They may not change them, so make each one exact and fair.

## Answer

Return the list of entities to build, each with an `id` (the feature folder name, lowercase) and
a `name`. Order it so that the first is the simplest entity with no parent: it is built first
and alone, and the others copy it.

## Check and stop

`pnpm typecheck && pnpm test` must pass: your own tests for auth, the guard and the feature
loader. The acceptance tests are not part of that run. Do not build any feature. If the owner's
goal leaves a field or a rule undecided, choose the plainest reading and list the choice in your
report.
