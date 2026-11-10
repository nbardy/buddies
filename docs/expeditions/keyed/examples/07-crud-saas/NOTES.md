# API gaps still open in this example

The API (`../../api/expedition.d.ts`) was not changed.

## 1. `protect` cannot guard a file written earlier in the same run

Needed: the builders must not be able to edit the acceptance tests that judge them.

`check(command, ...protect)` restores the protected paths from the launch base. The acceptance
tests are written by the `foundation` step, so at the launch base they do not exist and a
restore would delete them.

Written instead: each `slice` call's fence is narrowed to its own two feature folders, so a
builder cannot change the tests. `protect` covers only `tools/`, which holds the runner and
exists at launch. This relies on the fence being enforced, where `protect` is enforced by the host.

## 2. Assumed, not stated by the API

`integrate` receives the other features' commits through `reads`. The plan assumes a `Held` with
a commit in `reads` makes that commit fetchable inside the step's checkout.
