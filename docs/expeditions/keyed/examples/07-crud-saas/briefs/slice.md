# Slice: build the {{name}} feature

You build one feature, `{{id}}`, end to end: its API and its screens. Other workers build the other
features from the same starting commit, most of them at the same time as you.

## Read first

- `docs/CONVENTIONS.md`, whole. It decides layout, naming, validation, errors and which shared
  pieces to use.
- `test/acceptance/{{id}}.test.ts`. This is your judge and you cannot change it. Read it before
  writing anything; it states exactly what the API must do.
- `db/schema.ts` and `shared/` for the shape of a {{name}} record and its relations.
- If a finished feature is already under `server/src/features/`, read its code. Build yours the
  same way: same file names, same structure, same handling of errors. Where it and the
  conventions disagree, follow the conventions and say so in your report.

## Build

Only inside `server/src/features/{{id}}/` and `client/src/features/{{id}}/`:

- Routes for list with search, read one, create, update and delete, behind the auth guard,
  validating input with the shared types.
- A list screen with search, a screen for one record, and a create and edit form, built from
  the shared list, form and confirm-delete pieces.
- Where {{name}} belongs to a parent, the form picks the parent and the record page links to it.
- A refused delete shows the server's message to the user.

## Do not

- Edit anything outside your two folders. The schema, the shared types, the shell, the
  conventions and the tests are fixed. The app finds your feature by its folder; there is no
  list to add it to.
- Add a dependency, a second way to fetch data, or your own copy of a shared piece.
- Build screens for another entity because yours links to it. Link to where it will be.

If the schema or a shared piece is wrong or missing something you need, do not work around it:
stop, call `flag`, and say exactly what is missing.

## Done

`pnpm typecheck && pnpm accept {{id}}` passes in your checkout. Commit. In your report, list the files
you added and anything in the conventions you found unclear.
