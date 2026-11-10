# API gaps still open in this example

The API (`../../api/expedition.d.ts`) was not changed. Each item says what the case needed and
what the plan does instead.

## 1. `wide` reads a judged "no" on its pilot as a broken pipeline

Needed: measure every lever with `ab`, piloting one measurement first, where exit 1 means
"refuted". `tests` makes the host write the learning row from the judgment (passed is keep,
failed is reject), so the command has to fail on a refuted lever.

`wide` refuses the rest when the pilot "did not pass". A refuted first lever is a valid result,
but it would stop the other measurements. There is no way to say that only `errored` (nothing
measured) should stop the width.

Written instead: `wide` for the `change` step, where a failed pilot does mean a bad brief, and
`Promise.all` for the `ab` measurements. The first measurement is not piloted. The `spread`
command earlier in the plan already proves that the build-and-run path works on this machine.

## 2. A pool is held for a whole command

Needed: the machine's compile lock for the minutes `ab.sh` spends building, and a `cpu` slot for
the longer match batch after it. The repo's rule (`keel/DEV_LOOP.md`) is that simulations run
outside the lock.

Agent steps no longer hold `compile`: the pool is on the `SUITE` check. A command step still
reserves its pools for its whole run, and nothing says a build made by one command survives for
the next command on the same commit, so "build" and "run" cannot be two steps.

Written instead: `ab`, `spread` and `confirm` need only `cpu`, and the build inside them goes
through `keel/scripts/dev.sh`, which takes the repo's own lock for the build alone.

## Smaller points

- `tests` is on `ab`, so the dry run's refusal of an already-rejected family comes after the
  `change` call for that lever has been spent. Putting `tests` on `change` would write the row
  from the diff review, which is the wrong verdict. The theorist's brief is the earlier guard.
- `plan.ts` is 90 lines against a target of about 70. Removing the `on` threading was offset by
  landing each fix as it passes and by naming the gate at which a stack is dropped.

## Changed after this was written

`wide` no longer stops the rest when the pilot's judge says no; only an errored or refused pilot
does. The gap above about a failed pilot refusing the rest is closed. The plan still uses its
workaround and could now use `wide` directly.
