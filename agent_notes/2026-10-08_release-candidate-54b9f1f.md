# Release candidate 54b9f1f — isolated gate (2026-10-08)

Requester: Coordinating Delivery PM, post_01a117a4-7784-7115-9cf4-af96a69eb6bd.
Candidate: `54b9f1fb37f98dd6d67336fe234856d9f8be9aa6` = origin/main a453e61 + 55cd36c, dc299ec,
18f06ab, 3d60be6, 54b9f1f. Submodule vendor/agent-cli-tool 7a41287 (already on its origin/main).

## Isolation
Cambium ephemeral worktree `/tmp/unleashd-rel-54b9f1f` (branch rel/cand-54b9f1f, apfs-clone),
`git status --porcelain` empty before and after every gate and after build → checks are of the
commit. None of the five dirty files (commands.ts, Chat.css, BuddyDetail.css, ChannelLanding.css,
TaskPage.css) differ between a453e61 and 54b9f1f; the candidate contains none of them.

## Gate (logs in the worktree's .scratch/)
- bootstrap (frozen lockfile, offline): 0; addons cache hits buddies 83390c8ff59f, ingest 6b04edf83027
- pnpm typecheck: 0
- tools/check-client-invariants.sh: 0 (9/9)
- pnpm test:client: 254/254
- pnpm test:server run 1: 295 pass / 3 fail / 19 cancelled. Failures were environmental:
  auth.test.ts real server "did not start in 30s", run-lease EADDRINUSE 127.0.0.1:7553, swarm
  timing assertion, ctrl-c-adoption 300 s timeout; load average ~20.
  Each file re-run alone: auth 23/23, run-lease 3/3, swarm-read-model-routes 4/4,
  ctrl-c-adoption 6 pass + 1 skip.
- pnpm test:server run 2: 315 pass / 0 fail / 2 cancelled (both ctrl-c-adoption, 300 s
  timeout; load average 115) / 2 skipped.
- pnpm test:tools, test:dev-supervisor: 0
- crates/unleashd-buddies `pnpm test` (cargo --no-default-features + node boundary): Rust 80/80, node 2/2
- crates/unleashd-ingest `pnpm test`: Rust 60/60, node 3/3
  (Corrected 2026-10-08: first version swapped the two crates. Per-file recount of
  .scratch/pkg-buddies.log and pkg-ingest.log; matches the packaged-lane logs in /tmp/rel-54b9f1f-gates/.)
- biome ci: 94 errors repo-wide, pre-existing. On the 31 candidate-touched files: 1 error + 1
  warning, both blamed to commits already in origin/main (1b7a1c86, a38bdc28). Biome is not part
  of `pnpm test`.

## Build artifact
`pnpm build` in the worktree: exit 0 (vite chunk-size warning only). Manifest of 682 files under
server/dist, client/dist, shared/dist: `2026-10-08_release-candidate-54b9f1f/dist-manifest.sha256`,
manifest sha256 1022449680ce751e1e928213282a8655c97e99cc78a5b01922a6c41ecca86ee7.
Not a published or desktop artifact; no DMG built, nothing uploaded.

## Drift observed during the gate (not in the candidate)
- origin/main moved a453e61 → b8a1e3d (docs/index.html site copy only). `git merge-tree` with
  54b9f1f: clean, tree 503cccff. 54b9f1f is no longer a fast-forward of origin/main.
- Local main moved 54b9f1f → 9360fb4 (a9c9b26, 17f5b8a, 9360fb4: desktop bootstrap/runtime work)
  from another session. Pushing local main would ship these unreviewed; they are outside this cut.

## Not done
No push: the Release Engineer has no standing push-main grant; it needs explicit owner authority.

## Merge candidate 1f2cd4c (Development Lead post_01a117d1-1099; preparation only, no publish authority)
`1f2cd4caabf6fae1848e7733ff289fdb022baa52` on branch rel/cand-54b9f1f in the same worktree:
`--no-ff` merge, parent1 54b9f1f, parent2 origin/main b8a1e3d. Tree 503cccff85972dbe297c05ac1d0240d2ed678172
(identical to the earlier merge-tree prediction). `git ls-tree -r` sha256 17c14130…2299d. Gitlink
vendor/agent-cli-tool 7a41287. Diff vs tested 54b9f1f: docs/index.html only (equals origin's
copy). Excludes a9c9b26, 17f5b8a, 9360fb4. Shared main not touched, no rebase.
Affected gates at the merge, worktree clean throughout: typecheck 0, invariants 0 (9/9), client
254/254, test:tools 0, pnpm build 0. docs/index.html is referenced by no app/test code (only
product/releases/launch-2.0/edit/src/Close.tsx), so the server and crate suites were not re-run;
their 54b9f1f results stand.
Build manifest: 682 files, `dist-manifest-merge.sha256` = 1022449680…a86ee7, byte-identical to
the 54b9f1f build. The desktop bundle takes node + server/client/addons, not docs/, so its app
inputs are unchanged. A DMG from the 54b9f1f build exists (see 2026-10-08_desktop-release-54b9f1f/README.md),
but none was built at 1f2cd4c, so there is no DMG built from that exact commit.
