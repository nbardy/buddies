# Desktop release candidate: 54b9f1f (2026-10-08)

Request: Delivery PM post_01a117a3 (owner #unleashd-2 post_01a117a1, "commit and push, bake the new build").
Cut confirmed by Product Development Lead (post_01a117a5): local main
`54b9f1fb37f98dd6d67336fe234856d9f8be9aa6` as-is, five commits over public `a453e61`
(55cd36c, dc299ec, 18f06ab, 3d60be6, 54b9f1f). Five dirty tracked files in the main tree
(commands.ts and Chat.css are format-only, plus a TaskPage/BuddyDetail/ChannelLanding restyle) are excluded and were not staged.

## Source
Clean detached worktree `/tmp/unleashd-desktop-app` at 54b9f1f, `git status --porcelain`
empty before and after the build, submodule `7a41287` (agent-cli origin/main).

## Gates (logs: /tmp/rel-54b9f1f-gates/)
| Gate | Result |
|---|---|
| `pnpm typecheck` | exit 0 |
| `tools/check-client-invariants.sh` | exit 0 |
| `pnpm test:client` | 254/254 |
| `pnpm test:desktop` | 4/4 |
| crates/unleashd-buddies `pnpm test` | cargo 80/0, node 2/0 |
| crates/unleashd-ingest `pnpm test` | cargo 60/0, node 3/0 |
| `pnpm test:server` (full) | 319 tests: 297 pass, 0 fail, 2 skipped, 20 cancelled |

The 20 cancelled:
- `auth.test.ts` "shared-secret auth (real server)" (18 subtests): `server did not start in 30s`
  with machine load average ~98 (other sessions' cargo/tsx runs). Rerun alone: **23/23 pass**.
- `ctrl-c-adoption.test.ts`, both tests: 300 s timeout. Known and root-caused in
  task_01a11636 (agent-cli `isOwnWrapper`'s `ps` dies on Ctrl+C, so the turn is marked lost).
  Already failing in full runs at 52dbbc0, 5a58839 and ae5881f, before this cut. The fix awaits the
  owner under the 2026-10-07 behavior freeze. It concerns Ctrl+C on `pnpm dev:server`, not the
  desktop app. Not rerun alone, because another session was running the same test against a
  second 54b9f1f checkout (/tmp/unleashd-rel-54b9f1f) at the same time.

## Artifact
`pnpm desktop:build` exit 0; payload smoke "ok listening after 2281ms".
**DMG sha256 `6c4e905edb6fe8f5fde49f6657bc9ff3eaf6db726fbdae00aa5fbf6e3f179ac4`, 161072584 bytes**
(copy at /tmp/rel-54b9f1f-gates/keep/Buddies-macos-arm64.dmg).
Installed app provenance: `buddies-core.node` sha256 64f0f1c5… and `ingest.node` dc19ded0…, the
same files the 54b9f1f build produced; bundled `server/dist/constants/timeouts.js` has
`BUDDY_BACKGROUND_TURN_MS` default 0, the dc299ec change (60 min at a453e61).

## Installed-app test (ditto from the DMG, Finder PATH, temp BUDDIES_DESKTOP_HOME, ports 7646/7647)
Script /tmp/rel-verify3.sh (rel-verify2 + wait for "Initial load complete"); log
/tmp/rel-54b9f1f-gates/install-verify.log.
- Server ready +2.85 s. `/` and `/api/dependencies` 200 without a key; claude and codex ready (d1).
- Onboarding: Welcome, then Setup, then Create your workspace form, then Kick off.
- Builder: first assistant text +8.0 s; Completed 42 s; hired Notes Engineer (codex gpt-6.1-sol) (d3).
- First DM reply: PONG at +6.4 s (d4).
- Builder reload: no recovery row, one hire, no duplicate lines before/after (b1, b2).
- Missing CLIs (temp HOME, installers suppressed): both `missing`, agent `none`; Setup shows
  install commands; DM shows "Couldn't start claude: the `claude` command was not found…" at
  +1.3 s (m2). Temp HOME held only `.cache` afterwards.

Seen, not blocking: the "Notes Engineer is replying…" indicator still showed in the d4 shot
taken right after PONG; the italic "Creating buddy" sidebar row remains after the Builder finishes
(seen before). One "LEFTOVER PROCS" on the missing-CLI quit, gone seconds later (orphaned relay,
task_01a10e30).

## Not verified (carried forward)
- Unsigned and not notarized: Gatekeeper first-open of a quarantined browser download has never
  been exercised. Needs the owner's Apple Developer ID.
- Never run on a real clean Mac without agent CLIs (missing-CLI path is simulated), on an Intel
  Mac, or on Windows (no build host).

## Public asset
Unchanged: desktop-v0.0.1 / Buddies-macos-arm64.dmg = source 2871789, sha256 86d48d6b…
Not pushed, not uploaded: both wait for the owner's OK.

## Consolidation with the PDL source-gate lane (2026-10-08)

Two lanes verified the same source, 54b9f1f. Only this lane produced and installed a packaged artifact.

| Lane | Checkout | What it proves | Logs |
|---|---|---|---|
| PDL source gate | `/tmp/unleashd-rel-54b9f1f` (rel/cand-54b9f1f) | typecheck, invariants, client 254/254, server run 2 315/0/2 cancelled (run 1 295/3/19, environmental; files pass alone), tools, crates; `pnpm build` dist manifest `10224496…` | `agent_notes/2026-10-08_release-candidate-54b9f1f.md`, worktree `.scratch/` |
| Release Engineer DMG (this note) | `/tmp/unleashd-desktop-app` detached 54b9f1f | the same gates (server 297/0/20 cancelled/2 skip, auth alone 23/23), plus **DMG built and installed-app tested** | `/tmp/rel-54b9f1f-gates/` |

- **The PDL note swaps the crate labels.** From the cargo logs: unleashd-buddies is Rust 80 (9+61+2+1+7), node 2; unleashd-ingest is Rust 60 (19+4+5+11+8+4+8+1), node 3. The totals match.
- **Isolated merge:** PDL's `1f2cd4c` merges 54b9f1f with origin/main b8a1e3d (tree `503cccff`, the same as `git merge-tree`). It is local only, not pushed; `rel/*` does not exist on origin. Its diff from 54b9f1f is `docs/index.html` only.
- **DMG validity for 1f2cd4c:** the desktop payload is `crates`, `server`, `node` and `client` (tools/desktop-build.mjs). `docs/` is not in it, so the app inputs at 1f2cd4c match 54b9f1f and the kept DMG `6c4e905e…9ac4` needs no rebuild.
- **Proposed publication under A:** push `1f2cd4c` to main (a fast-forward of origin/main b8a1e3d). Tag `desktop-v0.0.2` at 54b9f1f, the DMG's exact source; the release notes say 1f2cd4c only adds site docs.
- **Excluded:** local main 9360fb4 (a9c9b26, 17f5b8a, 9360fb4 updater work, unreviewed). Do not push local main.
