# Desktop updater: helper-fix cut aa0c483, replacement DMG, re-run journey

Request post_01a11818-558c (Product Development Lead), task task_01a117b8. Release Engineer, 2026-10-08.
Preparation and testing only: nothing pushed, tagged, uploaded or published; local/shared `main` untouched.
Prior run (048ec32, blocked): `2026-10-08_desktop-updater-installed-journey-048ec32.md`.

**Verdict: the helper fix works on the installed payload. First setup, Retry over the old failed
production-only tree, and the Release Manager's `--publish` all succeed under the app's inherited
`NODE_ENV=production`.**

The native leg and real Buddy replies were NOT re-run. The host degraded during the run:

- The lid is closed. cottontail crashes at window creation, and later aborts at start.
- LaunchServices returns `kLSNoExecutableErr`.
- configd/mDNSResponder are unreachable: no DNS, also outside the command sandbox.

Every app-level step below therefore ran the shipped helper exactly as the app spawns it, rather than through the GUI.

## Candidate

| | |
|---|---|
| Commit | `aa0c483b042e60bd54a999fc4b588c8ecc2ec37b` (branch `rel/updater-cand`, cambium `rel-updater`, `/tmp/unleashd-rel-updater`) |
| Shape | 048ec32 + `git cherry-pick -x 7d2340e 6c95e0d`. Clean applies: 9df1209 and aa0c483. aa19d5a is NOT included. |
| Tree | `36523c8e4b93d1fb8439a2351d75abef4dbef708` |
| Changed vs 048ec32 | `package.json`, `tools/desktop-source.mjs`, `tools/desktop-source-install.test.mjs`. Blobs are identical to 6c95e0d (f1bc45f, 814a687, 2c3cae0). |
| Gitlink | `vendor/agent-cli-tool` 7a41287 (unchanged) |

## Gates (`/tmp/rel-updater-gates-aa0c483/`)

`porcelain=[0]` before and after; see `summary.txt`.

| Gate | Result |
|---|---|
| bootstrap / typecheck / invariants / client / tools / build | exit 0 |
| test:desktop | 5/5 + 5/5 (includes desktop-source-install), 0 cancelled, 0 skipped |
| upstream.test | 7/7 |
| crates | buddies 80 Rust + 2 node; ingest 60 Rust + 3 node |
| server suite | exit 1: 319 tests, 315 pass, **1 fail**, 1 cancelled, 2 skipped |

Server-suite details:

- The fail is `dependencies.test.ts` "first boot installs missing tools once…" (codex `missing`; 1.5 s probe timeout under suite load). Alone it passes 3/3 runs, 4/4 each (`dependencies-alone-{1,2,3}.log`). It is not touched by the cherry-picks.
- The cancelled test is the known Ctrl+C adoption test.
- Auth had no cancellations this run.

## Artifact

- `pnpm desktop:build` from the clean worktree, kept at `/tmp/rel-updater-gates-aa0c483/keep/Buddies-macos-arm64-aa0c483.dmg`.
- SHA-256 `15153257abaf370a75b72b759116d37b1221d5ab5cab127c67cf8f08311be089`.
- Payload `source.json` = aa0c483 + `https://github.com/nbardy/buddies.git`.
- Payload `tools/desktop-source.mjs` and `desktop-source-status.mjs` hash-equal HEAD. The fix lines are present: `env.NODE_ENV = undefined`, `--config.confirmModulesPurge=false`.
- Supersedes e70c9f30…0f79 (048ec32), which is still in `/tmp/rel-updater-gates/keep/` until disposition.

## Harness and deviations

- Same mirrors and `GIT_CONFIG_GLOBAL` as before. Mirror main = A′ aa0c483, then B′ `47031262f1cb3ed44bd706c364693039fbf567b1`. B′ is aa0c483 + the c818d2c fixture: gitlink → nested B cd629df with `release-journey-marker.ts`. B2′ is `af7ebb8c…` (unused).
- The DMG was copied with `ditto` to `/tmp/rel-upd-journey/Applications-aa0c483/`.
- The self-extracting `launcher` hung 3.5 min with no WindowServer. I SIGTERMed it and unpacked its own `35l59k0jjqtup.tar.zst` in place. The self-extractor is kept as `Buddies-selfextractor.app`.
- Launch 1 (`open`, home t1) spawned the bundled server, then cottontail crashed at window creation: `cottontail-2026-10-08-045644.ips`, NSException in `createNSWindowWithFrameAndStyle`. `startSetup()` runs AFTER window creation, so automatic setup never started.
- Proxy for each helper run:
  - Spawn `payload/node/bin/node payload/tools/desktop-source.mjs` with cwd=home, as `startSetup` does.
  - Run 1 used the live app server's exact env, read via KERN_PROCARGS2 (`bin/run-as-app.py`).
  - Later runs used the env computed by the shipped `serverEnv` + `resolveLoginPath` + `selectedRuntime` with a Finder-like inherited env (`bin/app-env.mts`, `bin/run-helper.py`).
  - `NODE_ENV=production` in every run.
- The Release Manager (codex) could not run without DNS. Its steps ran as `bin/rm-standin.sh` with the app env, non-TTY: fetch + ff merge, then the instructed `pnpm install && pnpm build`, then `node "$BUDDIES_DESKTOP_PUBLISH" --publish`.

## Results

### 1. First setup, fresh home t1 (app env)

- Clone A′ and nested 7a41287.
- `pnpm install --frozen-lockfile --config.confirmModulesPurge=false` installed devDependencies (tsx, biome; +412). There was no "devDependencies: skipped".
- Build and typecheck passed.
- The harness's 10-minute job limit killed it during staging (`logs/envprobe.log`).

### 2. Interrupted → Retry, t1

- The shipped reader reports `failed: Setup was interrupted…` with Retry setup/Later/View setup logs. No `active-runtime.json`; the bundled server kept serving.
- Retry recovered the dead-owner lock and published aa0c483: smoke "listening after 1658ms; catalog, client, Buddies write + read" (`t1/retry-offline.log`).
- It took ~26 min because system DNS was down: `pnpm deploy --prod` retried every registry metadata GET (`ERR_PNPM_META_FETCH_FAIL`), then completed from lockfile + store.

### 3. Reopen selection

`selectedRuntime(t1)` = `runtimes/aa0c483…-c852cfb8`. View while still running bundled: "Source update ready — reopen Buddies…" with Quit to reopen/Later/View setup logs. View after reopen: "Source updates ready…" with OK.

### 4. Release Manager preliminary step under inherited production

On t1 (dev-complete) at B′, and earlier on s1/source:

- `NODE_ENV=production pnpm install` printed the purge prompt and exited 0 having changed nothing. `.modules.yaml` keeps devDependencies: true. Same result non-TTY and under a PTY with EOF (`logs/rm-prelim-install-{nontty,pty}.log`).
- `pnpm build` exit 0 (`logs/rm-prelim-build.log`, `logs/t1-rm-prelim-build.log`).

So the preliminary step cannot strip a dev-complete tree. It also does not install anything new; see finding 3.

### 5. `--publish` A′→B′, t1

- The helper reconciled nested 7a41287 → cd629df, then installed, built, typechecked, staged and smoke-tested: "Verified 47031262…" in ~60 s (`logs/t1-rm-publish2.log`).
- Status `ready`; `active-runtime.json` and `selectedRuntime` = `runtimes/47031262…-9f0e1534`.
- `release-journey-marker.js` exists in B′'s runtime and not in A′'s. A′ is retained; the lock is released.

### 6. Failed-install Retry, upgrade case, fresh home t2

- The OLD 048ec32 payload helper with the app env reproduced the defect: "devDependencies: skipped because NODE_ENV is set to production", `Cannot find module 'typescript/bin/tsc'`, status `failed: Command failed: pnpm build`, `.modules.yaml` devDependencies false.
- The NEW aa0c483 helper on the same home installed +59 dev packages (devDependencies true), built, typechecked, staged and smoke-tested, status `ready` (`t2/old-setup.log`, `t2/retry-new.log`).

## Findings (non-blocking unless the lead decides otherwise)

1. **A stale checkout pins an older revision.** After the t2 Retry, the published runtime is 048ec32, the revision the failed checkout was cloned at, under bundle aa0c483. The helper reuses an existing `source` and does not move it to the bundle revision.
   - Harmless here: the diff is helper-only, and 048ec32 was never published.
   - In general, a user whose setup failed at release N and who installs N+1 runs N's server until the Release Manager merges.
   - Design question for the lead: should the bundle revision be a floor?
2. **Offline staging is slow and looks stuck.** `pnpm deploy --prod` without `--prefer-offline` sat ~26 min at "Verifying the staged runtime" with DNS down, then succeeded from the store. Consider `--prefer-offline` for deploy, since the frozen install has just populated the store.
3. **The RM's preliminary `pnpm install` is a silent no-op under inherited production.** That is safe for a dev-complete tree, but if an update changes the lockfile, the preliminary `pnpm build` may fail before the RM reaches the fixed `--publish`. Not exercised here: it needs the registry.
4. **The helper's main guard silently no-ops on a symlinked path.** It compares unresolved `argv[1]` with the realpath'd module URL, so invoking it via `/tmp/...` (a symlink to `/private/tmp`) exits 0 doing nothing. The app passes a resolved path, so this only hit the harness, but silent success contradicts "no silent fallbacks".
5. **Leaked pending runtime dir.** The interrupted setup's `runtimes/aa0c483…-8af921d0.pending` is never removed after a successful Retry.
6. **task_01a10e30 reproduced again on aa0c483.** `buddy-mcp-relay.mjs` (pid 7334) survived the server's SIGTERM.
7. Copy nit, unchanged: "your current version is still available" appears twice in the failed dialog.

## Not done (explicit)

- Automatic first launch through the app (cottontail must survive window creation). Native ready dialog, Quit to reopen, native Retry click, offline failed dialog, View setup logs. All need a display.
- Real Buddy replies, a real codex Release Manager turn, and an online offline-dialog capture. All need DNS.
- True clean Mac (no CLT/Rust/pnpm, quarantined browser download) after an owner-authorized push of the exact revision.

## Next

With the lid open and the network up:

1. `source /tmp/rel-upd-journey/lib2.sh; launch $T/t3 47830`. `open` may need LaunchServices to recover first.
2. Capture the automatic setup → ready dialog → Quit to reopen → reply on A′. On t1 (already B′-ready), reopen and send `dm2.sh`. Run an offline launch with `gitconfig-offline` for the failed dialog → Retry.

The same DMG is reusable; no rebuild is needed unless code changes.

Cleanup after disposition:

- `cambium remove rel-updater`.
- `/tmp/rel-upd-journey` (6.8 GB).
- `/tmp/rel-updater-gates*/keep` once superseded.

## Continuation 2026-10-08 15:23 (request post_01a11a65): blocked, artifact lost

- Host now OK: built-in display online, clamshell open, console user logged in, `open -Ra Finder` OK, DNS resolves github.com and registry.npmjs.org, AC power.
- **Blocker:** the host rebooted at 15:04 (`last reboot`), and macOS emptied `/private/tmp`. These are all gone:
  - `/tmp/rel-upd-journey` (harness, unpacked app, t1/t2 homes, logs)
  - `/tmp/rel-updater-gates-aa0c483/keep` (DMG 15153257…be089)
  - `/tmp/unleashd-rel-updater` (worktree, now `prunable`)
  - `/tmp/rel-54b9f1f-gates/keep` (A-lane DMG 6c4e905e…9ac4)
- No surviving DMG matches. `~/Downloads/Buddies-macos-arm64.dmg` = 86d48d6b… and `output/desktop-source-2026-10-08/candidate/.../macos-arm64-Buddies.dmg` = bf61b6df… (92a5ea6).
- Surviving: commits aa0c483 and 1f2cd4c with branches `rel/updater-cand` and `rel/cand-54b9f1f`, plus this note.
- No rebuild was done: the request forbids a duplicate build. A rebuild from aa0c483 would produce a new, different DMG hash. Native validation is stopped pending the lead's decision.
- Lesson: keep release artifacts outside `/tmp` (for example `output/` or `~/rel-keep/`).
