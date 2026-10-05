# Onboarding dependency checks

Owner scope: #unleashd-2 thread post_01a10112-930c-7691-92c0-c43f20499441;
request post_01a1027a-5a97-7069-9758-67700fac888e, renewed 2026-10-04.
Implement Rust installer preflight and Claude/Codex availability and response checks.
The other onboarding proposals (workspace defaults, Builder defaults, nav/copy) are outside this change.

## Behavior

- Source-install preflight verifies Rust and Cargo. If missing, runs `brew install rust`;
  absent Homebrew, asks installed Claude to install stable Rust via rustup, with Bash
  permission, no sudo and no project edits. Verifies tools afterward; failures print
  manual install/login guidance and fail installation. Installer timeout: 10 minutes.
- Install-time agent version checks warn for missing Claude/Codex. Packaged prebuilt
  installs skip Rust installation (no .gitmodules).
- Both addon builds and response checks find ~/.cargo/bin even if the calling shell
  predates rustup's PATH update.
- Server starts asynchronous checks once per launch. GET status is read-only and cached;
  POST check explicitly retries. Parallel retries share the pending check.
- Each agent runs in an empty temporary directory, asks for only Yes, and must exit
  successfully with an exact Yes (case insensitive, optional punctuation). Claude uses
  no tools, no MCP servers and no session persistence; Codex uses ephemeral, read-only
  execution outside a Git repository. Each probe has a 45-second deadline; process
  groups are killed at timeout and at canonical server shutdown. Raw CLI diagnostics
  are not forwarded to the browser.
- One native dialog in App, shared by both shells, shows checking/ready/missing/failed,
  installation/login guidance, Check again and Continue. Reads use the existing keyed
  resource cache. Continue/Escape dismiss and stop polling. README explains behavior.

## Validation

- `pnpm build`, `pnpm typecheck`, `pnpm test:tools`: passed.
- `pnpm exec tsx --test server/test/dependencies.test.ts`: passed. Real executable
  fixtures + real HTTP cover absent binary, Yes success, Yes with nonzero exit,
  incorrect answer, timeout, concurrent refresh and POST retry.
- Installer test runs real fixture executables for both brew and Claude routes,
  validates command arguments, and rejects a fake successful installer that does
  not actually make rustc/Cargo available. No host Rust install or live agent probe
  was performed during verification.
- `bash tools/check-client-invariants.sh`: passed.
- `pnpm test:client`: 221/222 passed; existing unrelated failure in
  channel-dm.test.tsx expects "Retry with a different harness" but HEAD's
  HarnessPicker.tsx renders "Retry with model…". Both mismatch strings are in HEAD,
  and neither file is changed here.
- Screenshots: output/dependencies-2026-10-04/missing@phone.png,
  missing@desktop.png, ready-fixture@phone.png. Inspected missing-state phone and
  desktop images. Real app runs against empty temporary HOME/data/Buddies stores
  on port 17589, with no real agent CLIs on PATH. Ready screenshot uses explicit
  fake executables answering Yes, not live authentication evidence. POST retry
  returned 202; Continue removed the dialog. Browser session refused no writes.
- RTK.md is absent in this checkout; no changes made to concurrent dirty files.

Official flag references reviewed:
https://developers.openai.com/codex/cli/reference
https://code.claude.com/docs/en/cli-reference

Live installation/authentication remains an owner-environment smoke test; the live
backend was not forcibly restarted and no push was performed.

## Owner correction: centered window, visual status, setup actions (2026-10-04)

Owner rejected the bottom-aligned, text-only presentation and reasonably read the
empty-environment screenshots as an inaccurate statement about their installation.

Changes:
- Center the native dialog on phone and desktop, with explicit green checkmarks,
  red crosses and human status labels: Yes — ready / No — not installed /
  Installed — needs attention / Checking.
- Missing dependencies offer readonly selectable commands, Copy buttons, official
  installation links, and agent sign-in commands. Installed response failures do
  not claim that the binary is missing.
- Classify usage-limit, authentication and connection errors into fixed public
  copy; raw subprocess diagnostics remain private. Remove the inherited Claude
  nested-session marker for the independent probe and explicitly resume streams.
- SSR card regression covers ready/missing/quota markup and actionable links and
  commands. Real child/API regression covers quota on stderr and the nested marker.
- Add native mouse clicks to the existing read-only CDP screenshot driver so
  clipboard checks use browser user activation rather than synthetic element.click.
  A native click on the actual Copy button returned Copied. A proposed clipboard
  helper change was discarded: the original passed the native-click check, and the
  apparent failure was from the synthetic test gesture. The helper is unchanged.

Real host results from the dependency-only preview: Rust/Cargo ready, Codex answered
Yes, Claude installed but returned a usage-limit failure. This preview runs only the
new checks and static client, with actual host credentials/PATH; it opens no stores
and starts no Buddy scheduler. Prior live API agreed on Rust/Codex ready and Claude
failed, but the prior code hid the reason. No production restart or login change.

Screenshots in output/dependencies-correction-2026-10-04:
actual-host@phone.png / actual-host@desktop.png show real host check results;
missing-fixture@phone.png / missing-fixture@desktop.png are explicitly labeled
missing-dependency fixtures to demonstrate the install links and Copy controls.
Underlying workspace UI is hidden in the dependency-only preview screenshots, since
this preview deliberately serves no workspace data. The dialog's bounds were centered
in both dimensions (desktop 560px wide; phone 370px wide).

Claude native install command confirmed from:
https://code.claude.com/docs/en/quickstart

## Compact visual redesign (owner follow-up)

Owner rejected the broad, flat board and inconsistent text alignment. Replaced
it with a 420px centered dialog (366px on the 390px phone), a raised navy surface,
soft shadow, strong title hierarchy, tinted status icons, and one fixed icon/text
grid for every provider. Status labels now sit under names in the same column.
Ready rows drop duplicate prose; failed rows retain the reason. Setup commands
and official links stay available. The body scrolls independently, so the header
and primary Continue / secondary Check again footer remain visible on phones.
Close is explicit and Escape remains supported.

Screenshots: output/dependencies-redesign-2026-10-04/host-snapshot@desktop.png,
host-snapshot@phone.png, install-fixture@desktop.png, install-fixture@phone.png.
Host images replay this turn's previously measured host results; no extra agent
probes were billed for this visual iteration. Missing-state images are fixtures.
Inspected desktop host and phone install state. Phone actions remain above the fold.

Validation: client build (includes tsc -b), SSR dependency card regression, all
client invariant gates, and new real-browser layout regression. The browser guard
uses the built app through HTTP, checks compact width, centering, a shared name
column, visible footer on desktop/phone, native-click Copy (Copied), and Close.
Run it after building the client: node --test tools/dependencies-layout.test.mjs.

## First-boot install / restart login checks (owner follow-up, 2026-10-04)

Owner requested automatic first-load dependency installation and authentication checks on every server start. Missing tools now get one automatic installation attempt on the first server boot: Claude official native installer, Codex npm with user-local prefix, Rust Homebrew or official rustup. Exclusive per-tool marker files under the canonical app data directory (`dependency-setup`) are written before spawning; installed tools also get markers, so later disappearance does not silently trigger installation. Restarts and Check again perform readiness probes without repeating installers. Installer processes are bounded, tracked and killed at normal server shutdown; downloads use direct argv and private temp scripts.

The server environment includes ~/.local/bin and ~/.cargo/bin so normal agent turns discover the installed binaries too. Claude/Codex response checks still run on each server start, including usage/network classification. Explicit auth failures show Login required and copyable login commands. Source-build Rust preflight remains in place before addons are built.

Verification: real subprocess/filesystem fixture regression covers missing Rust/Claude/Codex installation, newly installed binary discovery using the same environment, login failure, restart probes, no repeated installation and no reinstall after a tool disappears. Render regression covers installing/login labels. Browser regression validates both screen sizes, centered alignment, visible actions and copy behavior; login screenshots in output/dependencies-firstboot-2026-10-04/ are explicitly fixtures, not host authentication results. Actual downloads/account logins were not exercised; existing host tools were not replaced. No push or forced live restart.

Source-install follow-through: when Homebrew is absent and Claude is missing or unable to install Rust, preflight falls back to the official rustup download directly, without requiring an agent account before source builds can start. Executable-fixture regression verifies both rustc and Cargo appear under ~/.cargo/bin. The server first-boot regression additionally exercises missing Rust through Homebrew. Installer downloads remain fixture-tested rather than live downloads.

## Setup header and release assessment (2026-10-04)

Owner requested one Setup heading in place of the eyebrow/title/subtitle. Removed all three prior lines and retained the close control beside Setup. No server behavior change.

Release assessment remains conditional: actual installer downloads and login-to-first-response onboarding are unverified. Current workspace create route delegates directly to the crate; create_workspace in crates/unleashd-buddies/src/team.rs inserts only the workspace, without a default channel. ChannelBrowser still derives Home's composer target from #general and explicitly has no composer when it is absent. The dependency-check work does not resolve that original onboarding blocker. Recommend a release candidate for validation, not a public-launch readiness claim.

## Flat Setup surface (2026-10-04)

Owner requested removal of row boxes, rounded corners and the bottom paragraph. Replaced row cards with inset horizontal dividers, removed outer border/gradient/shadow and backdrop blur, squared controls, and made command fields flat with a bottom rule. Setup remains centered with scrollable rows and visible actions. Removed the footer quota paragraph; README still documents probe quota. No dependency-check behavior changed. Verify the committed client with its browser-boundary regression and inspect phone/desktop fixture screenshots against the prior Setup renders.

## Setup visual hierarchy refinement (2026-10-04)

Owner found the flattened presentation unattractive. Kept square edges, inset dividers, a single Setup heading and no footer paragraph. Refined hierarchy with larger lighter heading type, tool names and compact statuses on one line, quieter separator contrast, a neutral dark surface with restrained depth and a narrow accent edge. Login commands now precede help links; copy actions have a distinct accent and Continue has a clearer primary treatment. Initial focus goes to the dialog instead of making Close appear selected, while native focus trapping and keyboard controls remain. Readiness behavior is unchanged. Browser checks and phone/desktop visual inspection must use fresh builds, not previously saved screenshots.
