> Superseding disposition — 2026-10-08 09:18 UTC: HOLD f1011d0 release recommendation pending a reviewed fixed SHA. The subsequent exact-cut full rerun remained red (319 passed / 3 failed / 0 cancelled / 2 skipped), and isolated thread-model cases reproduced a product steering consumption race in 6/40 iterations. An explicit owner pick can be steered into the old running turn between separate guard/read calls, after which its queued delivery is silently cancelled. Final-tool-call steering also risks an unanswered consumed post. Earlier isolated-pass reassurance and qualified early-access recommendation below are superseded. Installed updater implementation/journey acceptance remains evidence for f1011d0 only; this is not an updater regression or a new PM test run.
>
> Dependency: Development Lead's existing steering task (task_01a11a68 per Product Development Lead) owns atomic protection, deterministic explicit-pick regression and final-boundary unanswered-post disposition. Release Engineer holds the artifact and owns the separate probe-test budget correction plus clean final-SHA gates, replacement DMG/hash/provenance and matching installed verification. Do not substitute a timeout increase for the product fix or an old DMG for changed source. Product Development Lead coordinates the final cut and existing owner decision; PM will review closure evidence. Source: agent_notes/2026-10-08_f1011d0-full-suite-rerun.md and post_01a11ace-4f53-7775-962a-5cbd1c0a6a29. No publication or peer task-status mutation.

# Delivery PM disposition: exact f1011d0 installed updater

Review of request post_01a11aba-3c9f-7788-9d79-5cc0da7bac81, 2026-10-08.

PM accepts the updater workflow acceptance criteria on exact
`f1011d0b4a954a8bee82292ea212768565baa4b3`, with qualified release readiness.
The retained DMG is eligible for an explicitly owner-approved, limited Apple
Silicon early-access cut. This is not an unconditional public-launch sign-off,
an all-green server gate, or publication authorization.

## Independently inspected this turn

- Rehashed retained `output/release-f1011d0/keep/Buddies-macos-arm64-f1011d0.dmg`:
  `5962cf177da60e54cc71a7b9578ce55c26afa64461d1e8a2d001b61c0623c473`.
- Candidate worktree HEAD is exact f1011d0, with empty porcelain status.
  Shared checkout is dirty and was not used as test evidence.
- Read RE's installed verification note, gate summary, payload provenance,
  actual RM update request/answer and PONG-RB record, interruption/dirty results,
  and full-suite failure records. Viewed actual Ready and stale-refusal pictures:
  instructions are readable and Ready names f1011d0.
- RM record reports actual direct-helper publish to fixture B=01cdcc68, including
  nested gitlink 90f8da9, then asks for reopen. Correlated Buddy reply PONG-RB
  arrived after reopening. Selection stayed unchanged for killed publish and
  dirty refusal in retained result records.

RE's retained journey supports automatic production-parent setup, immutable
runtime activation, Quit/reopen, real replies on A/B, data/identity retention,
interruption/Retry, stale/dirty refusal and offline bundle/log access. This turn
reviewed existing records; it did not repeat the installed journey or tests.
The A/B remotes are local mirrors. Public-origin update success is unproven.

## Server qualification

Both complete invocations failed: initial 302 passed / 1 failed / 19 cancelled /
2 skipped; serial 319 passed / 3 failed / 0 cancelled / 2 skipped.
Serial run-lease failures explicitly show EADDRINUSE on 7552 and 7554. The
serial thread-model case timed out waiting for the explicit reply. Initial
auth startup and Ctrl+C timed out; the missing-provider visible-message case
asserted on an empty message. Every affected case passed in retained isolated
reruns, without a source/test change. This reduces suspicion of a reproducible
updater regression but does not establish full-suite compatibility or prove all
non-port failures were environmental. Do not summarize these gates as green.

RE next action: reserve an uncontended exact-f1011d0 test lane and obtain one
complete server invocation with no failures/cancellations, or investigate any
reproduction. A test-only rerun needs no replacement DMG when source is unchanged.
If the owner elects early access before that evidence exists, the publication
decision must explicitly retain this qualification rather than imply PM waived it.

## Cut and publication boundaries

Observed local origin/main ref is fee9b120 and excludes f1011d0 (no fresh fetch
this turn). Newer public main alone does not require discarding this tested cut:
an owner-approved separate exact tag/branch and matching retained DMG can be used.
The candidate revision must be available from the configured public repository
before distribution because managed first launch checks out that revision.
Do not overwrite main. This evidence does not cover merging the candidate into
newer main or the subsequent real-public-main update. If the intended release is
current main, PDL/RE must integrate the fix, define the final SHA, rerun matching
gates, rebuild and verify its matching installed artifact.

Clean-Mac prerequisite installation and browser quarantine/Gatekeeper remain
unverified; signing is ad hoc and native version is 0.0.1. The development host
had CLT/Git/Rust, caches and authenticated providers. Native automation briefly
touched the default app home; its cleanup caveat remains, with no claim that
default state was untouched or safe DB rollback was proved.

Existing updater task stays in review under PDL for final cut/publication choice.
RE owns server-gate qualification and distribution evidence; PDL routes the
exact candidate and caveats through the existing owner approval request. No
push, tag, upload, merge or live-store operation was performed by this review.

Evidence root: `output/release-f1011d0/`; detailed source:
`agent_notes/2026-10-08_release-f1011d0-installed-verification.md`.
