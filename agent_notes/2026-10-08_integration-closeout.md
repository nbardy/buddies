# 2026-10-08 integration closeout — intermediate review at 11:14Z

Owned Task: `task_01a10beb-9257-7176-b819-bca4124fbadb`; assignment
`post_01a11b2b-0692-74c6-8c77-ee613c08deb4`. Owner-selected Codex Sol 6.1 medium.
This is evidence for the coordinated cut, not release sign-off or an all-bugs claim.

## Authority and decision history

PDL accepted atomic steering `acf0a1a0d538dc3727b70df014e552408f2bdfa8` and
readiness `1cc76099df01f6bb99ff9100a90518e4c0c7d0d3` for integration in posts
`post_01a11b2d-f67f-7146-b112-f7f20a27e644` and
`post_01a11b2d-f49b-74f2-a381-0f942e666822`. Preserved excerpt:
“This closes the patch-review dependency, not release sign-off.”
The release Task `task_01a117b8-fee8-742d-a2a4-1eee266b3073` remains HOLD;
its `f1011d0b4a954a8bee82292ea212768565baa4b3` artifact is historical evidence.
No alternative wake or cross-identity grant was used after the reported PDL denial.

Assistant correction: add an existing-store reopen guard because the atomic fix
only asserted the additive column in source. Test-only successor `e157efb3f8b58db8dd9d7ad7ba73972ea1c4b03a`
put the test in schema.rs; the line gate counts that file and failed 12152/12128.
Successor `ac32d8c` relocates it to `tests/steering_upgrade.rs`, leaving the
production ceiling unchanged. The test opens a temporary pre-column store through
the owning addon/crate, reopens twice, and asserts one column and retained workspace.
Removing the upgrade makes the relocated guard fail; restoring committed source passes.
No live store was opened. Revisit if a future migration changes the run layout.

## Exact candidates and evidence

- `acf0a1a` is one complete commit on `4fcc0be34ba3f0cf92123e45f9ed00e000344ee9`.
  Atomic guard/read at MCP, native tool, and Stop-hold boundaries; final-call
  unanswered owner input is re-delivered. Source, binding, declarations, regression
  tests, pattern rationale and decision note are committed together.
- Clean `e157efb`: full serial server 331 pass / 0 fail / 8 skipped; client 260/260;
  both Rust crates pass; client invariants 9/9. Typecheck/line fail because of
  the guard placement. This is not a green candidate. Earlier incomplete Cambium
  setup attempts failed missing dependencies; first server run was terminated
  after those failures. Their logs are retained as failures, not verification.
- Clean `44bc7d83f2abf05c8273e47ad866e56f977e83fa`: merges accepted readiness
  `1cc7609` (with `1a67b16`) and waiting `0d7d6ed9d17e375fc6c6653cd694db0a2db167b5`
  on the relocated guard. No conflicts. Typecheck, client 261/261, both crate
  suites and client invariants 9/9 pass. Addons match source. Relocated mutation
  fails, restored guard passes, then porcelain is empty.

Logs and reusable fresh-trial script are preserved under
`output/integration-2026-10-08/intermediate/` in the main checkout. In particular:
`e157-attempt/`, `setup-*-*.log`, `intermediate-{typecheck,client,crates,invariants,addons}.log`,
and `relocated-reopen-{mutation,restored}.log`. The lane is
`~/git/wt/integration-1008`, branch `review/integration-1008`.

Waiting branch source and worker logs were read: its committed note at `0d7d6ed`
records clean code/test SHA `2180e37`, backend 93/0 + 6 opt-in skips, crate 90 +
2 napi, client 261, invariants 9, typecheck/line 12225. These are worker checks,
not this reviewer's full combined suite. Stable hooks cannot retrofit old argv;
blocking tools and unsupported idle harnesses retain honest limitations. Child
notices are advisory at-most-once; ambiguous request-response crashes remain
at-least-once. No automatic kill/replay was added, and no new real Claude trial
was claimed. Evidence: `agent_notes/2026-10-08_waiting-paths.md` at `0d7d6ed`.

## Required successor before final-cut completion

Pending picker `task_01a105b0-2c7c-7527-bff6-aa092ec61da0` must supply its exact
SHA; its worker reproduced an old Claude subscription bypassing saved Codex choice.
Resolve any channels/runner overlap preserving both selection and delivery reach.
Rerun typecheck, both crate suites, full server suite, client suite and invariants
on the final clean commit; loop the thread-model pair and retain named regressions.
Then push the coordinated candidate without force and run the fresh-install trial
on that exact pushed SHA. Trial uses new stores, Claude-only PATH, Home/#general,
first DM visible answer/error, and desktop/phone WebP q95 evidence. No screenshots
have been produced for the final cut yet. RE must gate/package/install-test the
matching SHA; current release HOLD is retained. Main has not been pushed by this lane.
