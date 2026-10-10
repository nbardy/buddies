# Local branch merge audit — 2026-10-10

Observed after `git fetch origin`: main `40400bc09aa4c199daa20bd2c94e1c1bc5dd8816`, origin/main `40400bc09aa4c199daa20bd2c94e1c1bc5dd8816`. Main has 0 unpublished commits. Read-only investigation; no merges, deletions, staging, runtime changes or push.

## Integration candidates

- `fix/codex-launch-classification` @ aafdd82: one unmerged commit, submodule ef964ef4. Existing Task task_01a11c04-cd0c-70d7-b5c9-1656e8b885c9 in review. Buddies Development Lead accepted source candidate from saved exact-cut artifacts; Product Development Lead owns integration disposition. Original Wave_sim attribution remains unconfirmed.
- `fix/test-feedback-profile` @ c351432: latest successor containing speed77c7729/integration6cb0f9d. Existing Task task_01a11b4b-e260-778f-91dc-be5347867547 in review. Retain default pool4; split/higher fan-out rejected. Full final suite 333 pass/1 cancelled/8 skipped; known false execution-lost Task task_01a11636 unresolved. Integrate once, not all three related branch tips.
- `diagnostic/codex-goal-provenance-20261009` @ ca672e4: diagnostic + reproducer only, deliberately failing desired regression, no production repair. Existing Task task_01a11cae-1e3c-7481-abd1-0558c260b3e4 awaits provenance evidence. Preserve; not a completed fix.

## Historical/preservation branches

Raw ancestry and patch equality are clues, not proof that a branch should merge. Old launch/search/adoption/desktop/steering branches include rewritten or superseded work. `feat/durable-pending*`, continuity WIP and five rescue tips need owner comparison/disposition before integration. Do not replay obsolete implementations over current authorities. UI stars/highlights/tooltips, connect-mobile and release/updater tips have equivalent patches or merged successors on main.

## Dirty work and worktrees

Six tracked outer files modified (commands.ts, four CSS files, generated catalog), submodule catalog.jsonc modified, and untracked notes. None attributed or modified by this audit. Three old /private/tmp worktree registrations point to missing directories; no extant secondary worktree shown by Git. Branch refs retain commits; no cleanup performed.

## Full local branch ancestry inventory

| Branch | Tip | Commits absent from main ancestry |
|---|---|---:|
| `connect-mobile` | `07aa6a5` | 1 |
| `continuity/adopt-wip-2026-09-30` | `cf24d45` | 4 |
| `continuity/ctrl-c-proof` | `c98b9ce` | 4 |
| `continuity/execution-adoption` | `26d9e28` | 3 |
| `continuity/p1-adopt` | `811f758` | 7 |
| `continuity/p1-state` | `d92c477` | 15 |
| `continuity/p1-wip-2026-10-02` | `333dc0a` | 8 |
| `desktop-spike` | `9cf9a3d` | 3 |
| `diag/lost-liveness` | `e975553` | 0 |
| `diagnostic/codex-goal-provenance-20261009` | `ca672e4` | 1 |
| `feat/channel-search-fuzzy` | `1c96cba` | 4 |
| `feat/durable-pending` | `2cb2549` | 8 |
| `feat/durable-pending-w1-wip` | `4c22edc` | 10 |
| `feat/request-addressed-messages` | `4fcc0be` | 0 |
| `fix/background-runtime-cap-20261008` | `dc299ec` | 0 |
| `fix/codex-launch-classification` | `aafdd82` | 1 |
| `fix/composer-thread-seats` | `e22ca8a` | 0 |
| `fix/deps-readiness-budget` | `1cc7609` | 0 |
| `fix/desktop-gitlink-handoff` | `f5142da` | 1 |
| `fix/desktop-gitlink-integrated` | `ed0c22f` | 1 |
| `fix/hung-turn-liveness` | `fee9b12` | 0 |
| `fix/idle-background-delivery` | `83fd4e1` | 0 |
| `fix/lease-heartbeat` | `1ad0781` | 8 |
| `fix/missing-cli-visible-error` | `b6054e6` | 3 |
| `fix/no-waiting` | `0d7d6ed` | 0 |
| `fix/owner-first-admission` | `7344d4c` | 0 |
| `fix/persistent-thread-model` | `8a35150` | 0 |
| `fix/plaintext-mentions` | `9f6a4ed` | 0 |
| `fix/reply-failed-fanout` | `5214ecc` | 0 |
| `fix/run-active-buddy-index-20260930` | `2fe67e6` | 2 |
| `fix/steer-any-tool` | `a4696ed` | 0 |
| `fix/steer-atomic-guard` | `d70d0a8` | 1 |
| `fix/test-feedback-profile` | `c351432` | 10 |
| `fix/test-feedback-speed` | `77c7729` | 6 |
| `fix/thread-busy-gate` | `f509912` | 1 |
| `fix/thread-reply-inject` | `b8a1e3d` | 0 |
| `integrate/branch-sweep-1008` | `4f16903` | 0 |
| `integrate/launch-1005` | `a4ee3fb` | 7 |
| `integrate/launch-1005-with-missing-cli` | `a4ee3fb` | 7 |
| `integrate/launch-final-2` | `2a0d882` | 2 |
| `integrate/launch-wave2` | `2194144` | 19 |
| `integrate/launch-wave2b` | `a732c3a` | 5 |
| `integrate/test-feedback-speed-20261008` | `6cb0f9d` | 7 |
| `main` | `40400bc` | 0 |
| `refactor/buddies-core-review` | `e975553` | 0 |
| `rel/cand-4f16903` | `4f16903` | 0 |
| `rel/cand-54b9f1f` | `1f2cd4c` | 1 |
| `rel/cand-f1011d0` | `f1011d0` | 0 |
| `rel/updater-cand` | `aa0c483` | 3 |
| `release-verify-a453e61` | `a453e61` | 0 |
| `rescue/2026-10-04/unleashd-ctrlc` | `0ad1cc8` | 8 |
| `rescue/2026-10-05/unleashd-p1guard811` | `e46aa17` | 8 |
| `rescue/2026-10-05/unleashd-thread-follow` | `0711d5e` | 1 |
| `rescue/2026-10-06/_wt-missing-cli` | `b3b3249` | 4 |
| `rescue/2026-10-09/_wt-lost-liveness` | `fdf7714` | 1 |
| `review/integration-1008` | `d094cf3` | 0 |
| `site/muse-cursor-harnesses` | `b8a1e3d` | 0 |
| `steer-atomic-rebase` | `acf0a1a` | 0 |
| `test/deps-readiness-budget` | `19f5ea3` | 1 |
| `test/test-feedback-parallel` | `a0bb159` | 0 |
| `tmp/no-waiting-baseline` | `4f70a73` | 1 |
| `tmp/p1-guard-811f758` | `811f758` | 7 |
| `tmp/rc-trial-1005` | `e6dcbad` | 10 |
| `ui/action-tooltips-20261009` | `786849f` | 1 |
| `ui/buddy-stars-20261008` | `ef047ce` | 1 |
| `ui/highlight-rows-20261009` | `8274001` | 2 |
| `ui/visible-action-tooltips-1009` | `7add35e` | 1 |

Evidence commands: `git branch -vv`, `git worktree list --porcelain`, `git log main..<branch>`, `git cherry main <branch>`, exact Task get and committed candidate diffs. This audit reviews saved verification claims; it does not rerun gates or establish merged-commit verification.


## Owner-authorized integration successor — 2026-10-10 14:48 UTC

Owner post `post_01a12648-4b8f-71a3-b087-ae7d758f2eeb` authorizes merge/commit/push completion. Current observed main and origin/main both `40400bc09aa4c199daa20bd2c94e1c1bc5dd8816`; prior 14-unpublished observation is superseded.

One tracked technical lane assigned to Release Engineer in request `post_01a12649-146a-704d-9fe1-f3128efd298d`. PDL notified to avoid duplicate main integration. Assignment includes concrete pending candidates, disposition of all historical refs, preservation/attribution of dirty work and submodule-first publication, final clean-commit checks and push. Delivery PM retains independent evidence review. Work is requested, not reported merged.

PM read saved candidate RESULT.md artifacts this turn: classification repair exact CLI292/runner43/selected adoption1 and typecheck recorded green; profile full-final exit1 remains333pass/1cancelled/8skip. No fresh tests performed by PM. Current submodule main pin is6d45ede; classification candidate pin isef964ef4, based on6d45ede. Dirty submodule catalog adds Haiku5.5 and generated outer catalog matches that work; this is a substantive model change requiring attribution/disposition, not just formatter residue. Five other outer tracked files are the older formatting residue pending engineer confirmation. Do not sweep them into candidate verification.
