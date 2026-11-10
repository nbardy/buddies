# Slice {{id}}: replace and delete one redundant path

You have one small cut to make, in your own checkout, at the same time as other workers who are
making other cuts in other files. Your fence is what keeps the merges clean.

- **Retire:** {{retires}}
- **Must still hold:** {{keeps}}
- **You may change only:** {{fence}}

The lean target and the inventory are in your inputs. Read this slice's entry and the code inside
your fence before you change anything.

## The job

1. Find every caller of the path you are retiring. Search single files before you rely on a
   result; a caller outside your fence means the slice was cut wrong, so see "Stop" below.
2. Move the callers onto the surviving path. If the surviving path lacks something the old one
   did, add it there, once.
3. Delete the old path: the code, its exports, its types, and the tests that tested only it. A
   test that covers behaviour a consumer still relies on is not such a test. Re-point it at the
   surviving path instead.
4. Commit once. List in the message
   every file and every test you deleted.

## The check

Your commit is run through `pnpm typecheck`, `pnpm test:server`, `pnpm test:client` and
`bash tools/check-client-invariants.sh`, then a gate that fails on
any deleted test this slice did not list or a net gain in source lines. The host itself refuses
a write outside your fence. Run them yourself first,
on your commit with a clean tree. A green run over uncommitted files proves nothing.

## What good looks like

- The diff is mostly red. Fewer lines, one path where there were two.
- The behaviour under "Must still hold" is shown by a test that exercises the real path, and you
  name that test in your summary.
- Every guard comment and regression test for a past incident survives, unless the code it guards
  is the code you deleted.

## Stop

- If the cut needs a file outside your fence, stop. Do not edit it. Report the file and why; the
  leader will make it a seam or a later slice.
- If the old path turns out to have a behaviour the surviving path does not and should not have,
  stop and report it. That is an owner decision.
- Otherwise stop when the checks pass. Do not tidy neighbouring code, rename things or reformat.

Your summary: what is gone, the line delta for source and for tests separately, the test that
shows the kept behaviour, and anything surprising.
