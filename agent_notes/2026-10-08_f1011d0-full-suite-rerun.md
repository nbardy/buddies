# f1011d0 complete server suite rerun (PM request post_01a11abc-8bce)

Exact `f1011d0b4a954a8bee82292ea212768565baa4b3`, lane `~/git/_wt/rel-f1011d0`
(`rel/cand-f1011d0`), porcelain 0 before and after every step. Submodule
`vendor/agent-cli-tool` 7a41287. No source/test change, no DMG rebuild.
Evidence root: `output/release-f1011d0/logs/rerun-20261008T165934/`
(script `output/release-f1011d0/full-suite-rerun.sh`).

## Result: NOT green

`pnpm test:server` under the shared `/tmp/unleashd-test-ports.lock` (waited
16:59→17:03 WITA behind another lane's suite), fixed ports 7527/7551-7554 free
at start: exit 1, 324 tests, **319 pass / 3 fail / 0 cancelled / 2 skipped**
(live memory-curation benchmark, manual real-claude Ctrl+C), 199 s
(`server.log`, `meta.txt`).

Ports were uncontended; the CPU was not. Load average rose 6.9 → 35 on 10 cores
(`contention.log`): other lanes ran a full server suite without the lock, a
run-lease file, buddies-v2 files and rustc builds. No unrelated process was stopped.

All earlier full-run failures PASSED this time: auth real-server startup (7.7 s),
missing-provider visible message (0.6 s), Ctrl+C queued message (14.3 s), both
run-lease cases (15.8 s / 20.5 s).

## Failures

1. `buddies-v2` "an effort pick keeps the seat's session; a provider pick opens a
   new seat": timed out waiting for reply 3.
2. `buddies-v2` "latest thread reply model drives the picker…; explicit picks win":
   timed out waiting for the remembered follow-up. The same test failed in the
   earlier serial run with "explicit reply".
3. `dependencies` "readiness requires a successful Yes…": `['missing','failed','missing']`
   instead of `['ready','ready','missing']`.

### 1–2: reproduced; a real intermittent race in live-thread steering (product code)

The two cases were run alone in the lane, 20 iterations each
(`repro/loop-*.log`). Machine load was 9–19 throughout.
- 6 of 40 cases timed out at the 30 s limit.
- Passes were bimodal: 0.4–2 s or 5.8–7.3 s.
- The stalled post never reaches `executeTurn` (no spawn logged).

Cause: `liveThreadPosts` (`server/src/buddies/mcp.ts:807-845`, added in aa19d5a,
2026-10-08) runs after every tool call of a live thread turn. In separate core
calls it lists the queued runs, checks the "queued delivery with a pick: don't
steer" guard, then calls `catchUpThread`, which marks the thread read. An owner
post written in that window is steered into the running turn. When its own
delivery is claimed, `deliverPosts` returns `consumed`, and `deliverJob` cancels
it silently with "every post it would show was already read" (`runner.ts:483`,
`runner.ts:609`): no notice, no retry. The fake model ignores steered text, so
the test waits forever.

Proof (`repro/probe-*.log`): an untracked copy of the test logged whenever a fake
turn's `post` result carried steered posts. The copy was deleted afterwards; the
lane's porcelain was 0 again. Iterations 1–9 passed with 0 steered posts.
Iteration 10 failed with exactly one: turn 3 received the owner's "Continue
without repeating the model".

Product impact:
- For a post without a pick, steering is the intended route-at-send behaviour,
  and the tests' "separate turn" assumption is timing-dependent. But a post
  steered into a turn's last tool call is consumed even if the model ends without
  answering it.
- For a post WITH a pick (effort, model or provider), the guard is meant to
  prevent steering but is check-then-act. In that window the owner's pick is
  silently not applied: the message goes to the running turn on the old model,
  and the pick's delivery is cancelled.
- Window: an owner post landing while the seat's turn is still inside a tool
  call. It is wider under load.

Scope:
- Present in f1011d0, in prior cut 4f16903 and in current origin/main fee9b120.
  Absent from 54b9f1f.
- Not updater code.

Fix direction (not applied):
- Do the pick guard and the read in one atomic crate call, or never steer while
  that Buddy has any queued delivery in the thread.
- Add a deterministic regression test that posts inside the tool-call window.
- Make the tests wait for the previous run to settle before posting.

Fixing it changes source, so it needs a new SHA, matching gates and a new DMG.

### 3: test-only probe budget, not reproduced as a product issue

The test injects a 1,500 ms probe timeout (production default 45 s,
`server.ts:597`). The case took 3,052 ms, which is two probe timeouts.
- rustc/cargo timed out (non-zero exit) and read as `missing`.
- The claude "Yes" probe timed out and read as `failed`.

Real `/bin/sh` probes exceeded 1.5 s at load 35. Fix direction: give the
readiness assertions a larger budget and keep 1.5 s only for the hang assertion.

## Qualification statement

Three complete invocations at exact f1011d0 have each failed:
- 302 / 1 / 19 cancelled / 2
- 319 / 3 / 0 / 2 (serial)
- 319 / 3 / 0 / 2 (this rerun)

Port collisions, auth, Ctrl+C and missing-provider did not reproduce with
uncontended ports. The thread-model family is a reproduced, root-caused
intermittent product race, inherited from aa19d5a and also on current main;
it is not explained by the environment. The full server gate is not green and
must not be summarized as green.
