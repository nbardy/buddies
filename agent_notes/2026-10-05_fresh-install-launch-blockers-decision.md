# 2026-10-05 — Fresh-install trial: what blocks the public launch

Decision-maker: Buddies Development Lead (assistant recommendation). The go/no-go on the
public launch stays the owner's; nothing here is an owner decision.
Status: proposed (readiness call), accepted by the lead for task routing.

## Question

The Release Engineer trialled `fix/buddies-bootstrap-rename` @ 4b0f71ddc3333a065fd7d88c538f9189328e9c76
as a fresh install (answer post_01a10aca-f36b-7773-9715-2c4b2f495a12, request
post_01a10ac0-8ce2-7577-b09b-283f4625993c). The branch passed its own scope. The trial
also reproduced two first-run defects that predate the branch. Do they block the launch?

## Prior history

- 2026-10-04, #unleashd-2 thread post_01a10112-930c-7691-92c0-c43f20499441: the owner asked
  "You think we're ready to release?". The Release Engineer answered "hold" for two reasons
  (post_01a106fd-3c8d-7615-9b57-354129781e28): (1) new workspaces have no `#general`, so Home
  has no composer; (2) no real fresh-install → first agent reply pass yet. The owner did not
  rule on the hold; the thread moved on to Setup styling. The hold is therefore an assistant
  recommendation, not an owner decision.
- `agent_notes/2026-10-04_onboarding-dependency-checks.md` line 137 records the same `#general`
  gap (crate `create_workspace` inserts no channel; `ChannelBrowser` renders no composer
  without `#general`).
- todo_57268f4b-dadf-4812-bb5f-68d124f170ab (opened 2026-09-26) already names the
  hardcoded-codex bootstrap Buddies.

## Decision

Both defects block a launch-readiness claim. Reason: the launch promise is "install it and talk
to a Buddy". On a fresh install the trial found:

1. **No composer on Home.** The first screen a new user lands on has no input.
   Evidence: `agent_notes/2026-10-05_fresh-install-trial-4b0f71d/shots/d5-workspace-home-desktop.png`
   sha256 fd560a78e83ac4e44ea8d58eacc774151adb7d4099fa83c78a101d3a8421eef3 (untracked).
2. **The first DM fails silently.** The Buddy runs Codex, which is not installed, while the picker
   labels Claude "default". The user sees an empty bubble; the only trace is
   `Provider error: Process failed: spawn codex ENOENT` (`server2.log` lines 29–31,
   sha256 6dc7e1b985dd2aa9afa8e8713ffd2e8c85c8983e15bc589648010adedd0b6ac0; screenshot
   `d9-dm-default-model-send.png` sha256 87218c7028cf919897485753b8c1edc38a19b782c4ad6e1c790782d88dc3f493).

Item 2 is three separable defects. Each gets its own owner:

- **a. Wrong provider:** the bootstrap Buddies carry a hardcoded provider. → todo_57268f4b.
  This needs design, not a direct fix. The first-boot installer runs asynchronously, so "pick the
  installed one at creation" can race the install. It also interacts with the owner's
  model-selection rule (2026-10-04: most recent model in the conversation, else the Buddy
  default). Worker: Opus.
- **b. The picker shows a model that does not run.** This is the defect fixed on unmerged
  `fix/unified-thread-model` @ 27027d637ebd86eaa4c1b30b6fc53d1b0487b3d2 (task_01a105b0). The trial
  ran on main's parent, so that fix was absent. No new task; it needs a merge.
- **c. A failed spawn is silent.** This holds independently of a and b: any missing or removed
  binary gives an empty bubble. New task. Worker: Sonnet (clear acceptance).

`#general` gets its own task. Lead choice: every workspace has `#general`, created in the
same crate write as the workspace (one write path; the client never find-or-creates).
Backfilling existing workspaces touches live stores, so it is an open question the worker
reports on and does not implement. Worker: Sonnet.

Not blocking, but logged: a plain-text `@Product Dev` does not parse as a mention (the trial
did not test the picker-inserted form). Also, a malformed channel-create POST returns 500
instead of 400.

## Alternatives considered

- **Launch with `#general` missing, since a DM still works.** Rejected. Home is the landing page,
  and the DM path is the one that failed (2a/2c).
- **Fix 2a by changing the hardcoded provider from codex to claude.** Rejected: it moves the same
  failure to Codex-only users.

## Revisit when

The owner rules on the hold, or a scripted fresh-install trial (todo_b4d7809f) passes from
install through the Home composer to a first reply with only one agent CLI installed.

## Successor, 2026-10-05: #general implemented on a branch; backfill proposed, not decided

Implementation: `fix/workspace-general` @ b99a894dec88f5dac4a1dae654ba2880325a10e6 (code
37036b1d688aae12463f0b2d17b1c15e0a9b0119, base 654032b), worktree `../_wt/ws-general`. Sonnet
worker, run `buddy-run-run_01a10acc-dd72-7008-9d97-105973bfaf4d`. Lead checked the commit
itself (clean worktree, `git show`): one INSERT inside the `Store::create_workspace` transaction
in `crates/unleashd-buddies/src/team.rs`, with a fix-guard comment; bootstrap and
`POST /api/buddies/workspaces` both reach it, so `unleashd-home.ts` is untouched and there is
no conflict with 4b0f71d. The worker reports `new_workspace_has_general_once`, cargo 41/41,
test:server 245 pass / 0 fail / 1 skipped, clean typecheck, and temp-store screenshots in
`agent_notes/2026-10-05_workspace-general-shots/`. The lead did not rerun the tests.

Criterion 3 limit: a renamed `#general` frees the name, and re-registering an existing folder
does not recreate it (the existing-workspace path returns early). That is accepted: the
guarantee is "born with #general", not "always has one".

**Backfill (open, owner decision).** Worker options and live-store risk:
- On bootstrap: covers only the `unleashd` workspace; an unreviewed live-store write at restart.
- On open: covers all workspaces but turns a read path into a write, racing concurrent sessions
  on the live store.
- Home affordance ("Create #general" when missing, through the existing create-channel route):
  no startup or read-path write; costs one click and one UI state. An archived `general` needs a
  restore hint instead.

Lead recommendation (proposed): the Home affordance. Asked the owner, together with merge timing
(a merge reloads the live backend).

Revisit if: the owner prefers automatic backfill (then a one-time owner-run migration on a COPY
first, skipping workspaces with an archived `general`).

## Successor, 2026-10-05: installed-provider default implemented as option (b); lead accepts, owner merge pending

Question: what provider does an unpinned bootstrap Buddy run when the first-boot install is async
and may land only Claude, only Codex, or neither?

Choice (worker recommendation, accepted by the lead; not an owner decision): **(b) store nothing,
resolve at conversation open.** Unset provider resolves to the first of `codex, claude` executable
on the runner's PATH (incl. `~/.local/bin`, `~/.cargo/bin`), else a typed `no-agent` state that
refuses the DM visibly and disables the @mention chip. Owner pins (explicit provider, or a model
naming exactly one harness) win before the install is consulted and are never rewritten. The
owner's 2026-10-04 model rule is unchanged: a conversation's prior model still wins, so installing
a second CLI later moves only NEW conversations of unpinned Buddies.

Root cause correction: the hardcoded Codex was not in the bootstrap; it was the unset-provider
fallback in shared `buddyExecutionPreferences`, which feeds DMs, background runs, thread seats,
the reply gate and the client picker.

Alternatives rejected (worker's reasoning, lead agrees): (a) pick at seat creation — a stored
guess is indistinguishable from an owner pin; (c) sticky install default — extra state for little
gain. Readiness probes not used: they read `checking` for 45 s after start and can flap.

Evidence: design note `agent_notes/2026-10-05_installed-provider-default-design.md` @ 4495c62
(sha256 of blob 30a79173671a2c43eeed9a25e4d6ef379d0249fb906e91bf92a39c98da6c4ab6); branch
`fix/installed-provider-default` @ 4495c62, code 57994a7 + d03dde6, base 27027d6 merged with main
654032b (0742c2e). Lead verified the commits, both ancestors, and the remaining hardcodes with
`git grep`; the lead did NOT rerun tests. Worker reports: fresh-clone trials claude-only and
codex-only replied with matching picker, no-agent refused visibly with zero spawns; typecheck +
invariants pass; test:client 227/2 (both fail on base); test:server 248/1/1 (first-boot installer
test, passes 5/5 alone; load flake). Transcript: the worker run that answered
post_01a10acd-2cba-7423-bbc0-0c370eb92600.

Note: this branch contains 27027d6, so merging it also merges `fix/unified-thread-model`.

Open (same defect class, not yet fixed): Buddy Builder `buddy-creation-service.ts` hardcodes
`provider: 'codex'`; the memory reviewer hardcodes `harness: 'codex'` (gpt-6-luna low, the
owner-directed reviewer model) and logs `spawn codex ENOENT` after each turn on a Claude-only
install. Lead proposal: Builder uses the same resolver; the reviewer keeps the owner's model when
Codex is installed and otherwise SKIPS with a recorded reason (no silent substitute model). Picking
a Claude reviewer model would change an owner direction, so it is the owner's call.

Revisit if: the readiness probe becomes stable enough to replace the PATH check, or the owner
wants a remembered per-install default.
