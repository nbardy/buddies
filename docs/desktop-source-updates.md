# Desktop source updates

The desktop shell keeps a writable checkout at
`~/Library/Application Support/Buddies/source`. Chats and Buddies stores remain
in the separate `agent-viewer` and `buddies` directories; update tooling never
opens or copies those stores.

On first launch the bundled server opens normally, including offline. A separate
Node process clones the repository recursively at the exact bundled source
revision, installs pnpm 9.15.0 under the app's `toolchain` directory, installs
source dependencies (the existing preflight sets up Rust), builds and typechecks.
Node and npm ship in the bundle. Git and Apple's compiler/command-line tools
must work on the host; a missing tool or failed installation leaves the bundled
runtime usable. Setup progress and failures are in `source-update.log` and
`source-update.err.log`; setup retries when the app is reopened without a
verified runtime. `BUDDIES_DESKTOP_SOURCE_SETUP=0` disables automatic setup.

A successful build is deployed into a unique runtime directory and smoke-tested
using temporary stores, no agent installation, and no Buddy execution. Only then
an atomic `active-runtime.json` replacement selects it. The app uses that runtime
on its next launch. A running backend's files are never overwritten. Publishing
requires a clean checkout so the reported Git revision identifies the source.
Previous runtimes remain on disk. A setup lock prevents overlapping builds and
recovers after a dead setup process; source edits remain in the checkout.

Once activated, the existing upstream service discovers the managed checkout
rather than the immutable runtime directory. It bootstraps the normal Product
Dev / Upstream Release Manager workspace and fetch-checks every six hours.
Updates remain owner-requested. The Release Manager commits local edits, merges
upstream, builds, and runs the app's publishing helper (`node <bundled
payload>/tools/desktop-source.mjs --publish`). It reports the verified revision
and tells the owner to reopen the app. The helper repeats typecheck/build before
staging and smoke, so publishing is independently gated by actual build success.
Installing a different native release selects its bundled runtime while retaining
the checkout for the normal upstream merge workflow.

This updates the server and web UI. The native shell and Chromium still require
a DMG release. Retaining old runtime files is not a promise of database rollback:
a new version can migrate authoritative stores when opened. No automatic rollback
runs after a new backend has opened app data. Fully unattended merging, a visual
setup-progress panel, and native-shell auto-update are separate work.

Validation: `pnpm test:desktop` includes the filesystem/Git A→B publishing test,
failed smoke and dirty-source refusal, newer-native selection, and live/dead setup
lock tests. `server/test/upstream.test.ts` exercises the real API/crate boundary,
merge-request deduplication and desktop handoff with a path containing spaces.
DMG builds and managed source builds share `tools/desktop-runtime.mjs` and the
same isolated-store smoke boundary.
