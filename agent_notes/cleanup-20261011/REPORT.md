# Unleashd ref and worktree cleanup — 2026-10-11

Authority: owner post `post_01a12906-811e-72ef-bd60-d0c3a08a4e2a` and main-integration post `post_01a12648`; lead assignment `post_01a12976-a20a-752d-a8c9-9486d8eeb01a`. The before/after manifests were collected from current Git and `ls-remote`, not inferred from the 2026-10-10 audit. `removed.json` maps **every deleted local and remote name, full tip SHA, and surviving remote recovery ref**. The recovery SHA or ancestry was checked again after deletion.

## Useful missing work integrated

The only newer finished code absent from `main` was the emoji hover layout fix. The source branch `fix/emoji-hover-layout` ended at `75722e52d3ccfd56292e96dc080d9f3e6e8da112`. Its three code commits were cherry-picked into a clean main checkout as `87ff11a`, `b54910b`, `36dac06b4bc3df62e98cab9095f20809dd0cf1fd` and pushed to origin/main. The changed CSS, TSX, and real-browser guard are byte-identical to the live source branch at `aa17b1a`; its separately authored evidence note remains on the live branch. The original branch tip is recoverable at remote `preserve/owner-20261011/emoji-original`.

Exact committed checkout verification at `36dac06` (clean `git status --porcelain`): `pnpm typecheck` passed; all nine `check-client-invariants` gates passed, including CSS 14606/14606; `pnpm test:tools` passed 13/13. `node tools/check-reaction-layout.mjs` passed read-only desktop hover/focus and phone visibility/hit testing on real posts; its session reported one blocked diagnostics POST. The live dev server serves the same three source files, but this was not an isolated built-server or installed-app test. No server-suite rerun was needed for this CSS change. The earlier full server gate remains non-green: 335 passed, 0 failed, 1 cancelled, 8 skipped due to the known pre-SIGINT lost-chat liveness case.

## Ref and worktree disposition

| Item | Before | After | Action |
|---|---:|---:|---|
| Local branches | 139 | 41 | Deleted 98 redundant names after recovery checks. |
| Remote branches | 79 | 43 | Deleted 38 obsolete feature/history names after recovery checks. |
| Git worktree registrations | 5 | 2 | Cambium removed three missing `/private/tmp` registrations. |
| Cambium broken metadata entries | 83 | 83 | All paths were absent; Cambium refused each because Git no longer calls the path a worktree. No force or manual metadata edit. |

Thirty-seven distinct non-main historical tips remain under 37 remote `preserve/owner-20261010/history/*` refs. They include unfinished WIP, diagnostic controls, release predecessors and patch-equivalent but non-ancestral tips whose exact SHA needs a recovery ref. Two duplicate history aliases were removed in favor of an exact surviving alias. The remote also retains the dirty snapshot `f8b5a251`, delivery evidence `a35e3fa4`, the live source branch `aa17b1a`, emoji-original `75722e5`, and the superseded core review note `c9f30a1` under `preserve/owner-20261011/core-review-predecessor`. The original `c9f30a1` note is superseded by the expanded review on main, so its feature name was removed. Intentionally failing `ca672e4` and `6a826c0` are preserved solely as diagnostics, not integrated.

The live root was dirty at `aa17b1a` with 94 porcelain entries, 43 ignored `output/` entries, and two dependency links inside ignored evidence that point to its `node_modules`. Its dev supervisor, backend and Buddy MCP relay were active. No root source, dependency, ignored output, process, Buddy data or SQLite store was touched. The main checkout at `~/git/_wt/owner-completion-1010` remained clean and registered through evidence publication; it has its own dependency install and ignored integration evidence. The historical Cambium refusal list is in `cambium-refusals.json`. Removal of the finished main lane is attempted only after the evidence commit is pushed. No forced workaround is used.

`df -k /System/Volumes/Data` available blocks rose from 55,783,316 to 55,793,972 KiB (+10,656 KiB) between snapshots. This lane removed stale registrations and refs, not a material on-disk checkout; concurrent disk activity prevents attributing that delta to cleanup.

## Remaining work

The active backend still runs from the dirty preserved source checkout. Handover to pushed main requires an idle relay/source boundary and belongs with runtime ownership. The phase-2 liveness freeze and the goal-provenance diagnostic remain separate source decisions. Native DMG matching this main SHA, installed verification and PM publication review have not occurred. The 83 Cambium metadata refusals need a tool repair that can forget entries whose paths and Git registrations are both absent; they were not forced away in this lane.
