# Packaged desktop managed source updates — review evidence

Owner request: post_01a117b7-4fdc-70f7-aee3-4b30444fa323 in the launch thread.
Task: task_01a117b8-fee8-742d-a2a4-1eee266b3073.

Implemented and committed locally:
- a9c9b26: managed checkout, pinned app-local pnpm with bundled Node/npm, shared
  payload staging/smoke, immutable runtime selection and upstream manager handoff.
- 17f5b8a: build fresh clone dependencies before the extra test typecheck.
- 9360fb4: opt-in real fresh-clone bootstrap regression.

Final candidate: 9360fb42fb1cb56e214a98d8dce798d8f4d95937.
The original five dirty client files were excluded. The candidate was cloned
locally into output/desktop-source-2026-10-08/candidate, its submodule checked
out at the committed gitlink, and bootstrapped. Tracked content matches HEAD
(`git diff --exit-code HEAD`); native tooling additionally generated the
untracked desktop/.cottontail-tmp directory. Direct HEAD symbol checks proved
all staged runtime/selection/handoff definitions are committed.

Artifact (not uploaded):
`output/desktop-source-2026-10-08/candidate/desktop/artifacts/macos-arm64-Buddies.dmg`
SHA256: `bf61b6df0226c5b2eddf62fe6926983c1b9813772fe690e8c4bc943a5ab2e5e1`.
Payload source.json stamps the final candidate above. Full clean-clone build
ran at 17f5b8a; the final 9360fb4 changes only add the bootstrap test. The final
DMG was restaged/rebuilt from 9360fb4 with --skip-build, reusing those identical
compiled application sources. No push, upload, live-backend restart or default
store access was performed.

Passed:
- pnpm test:desktop: 5 desktop/PATH/environment tests plus 2 managed-source
  filesystem/Git tests (A→B selection, failed smoke retention, dirty-source
  refusal, new-native selection, live/dead setup locks).
- pnpm exec tsx --test server/test/upstream.test.ts: 7 real Git/crate/API tests,
  including update request deduplication and quoted desktop publishing handoff.
- pnpm typecheck and pnpm build in the isolated candidate clone.
- Both final desktop staging and native Electrobun packaging. Payload smoke:
  bundled Node, no agent auto-install/execution, temporary stores; catalog,
  client and Buddies write/read.
- BUDDIES_TEST_BUNDLE=<candidate>/desktop/stage/payload node --test
  tools/desktop-source-bootstrap.test.mjs: fresh recursive clone of local
  candidate 9360fb4, bundled Node/npm, actual pinned pnpm installation,
  source build, test typecheck, deploy and real isolated-store smoke. Passed
  in ~100 seconds. HOME retained the host's existing Rust toolchain; this
  was not a clean-Mac prerequisite-install test. The app home contained spaces.
- Native launcher on temp app stores with setup disabled: bundled fallback
  opened a window and served the authenticated catalog.
- Native launcher selected an immutable runtime fixture on temp app stores:
  its managed source override (symlink to the clean candidate) bootstrapped
  the expected workspace, #upstream and two Buddies. The fetch status was
  still pending when the assertion ended; fetching is covered by the API test.
- Scoped Biome checks and git diff --check. pnpm token-audit --tag buddy ran;
  the new desktop update prompt has no production-turn comparison yet.

Operating contract: docs/desktop-source-updates.md. First setup runs behind
bundled startup; the first managed activation requires reopening. Later checks
reuse the six-hour upstream loop; merges remain owner-requested, and successful
publishing requires reopening. Native shell/Chromium updates still need a DMG.
Build failures never overwrite a selected runtime or app stores. Old runtime
retention is not a database rollback promise.

PM review decisions / limits:
- Host Git and Apple command-line tools must work. A true clean Mac, toolchain
  setup from nothing, browser-download Gatekeeper flow and first real Buddy
  reply remain unverified.
- Setup progress/failure is currently in source-update.log / source-update.err.log;
  a visual setup-progress panel is not included. Decide whether this holds launch.
- Native build remains the existing unsigned/not-notarized release path.
- The final revision must be published to GitHub before the shipped source
  bootstrap can clone that exact bundled commit from the public remote.
- This artifact is for review; it has not replaced the public download.
