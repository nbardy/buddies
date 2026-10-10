# Delivery PM review: production and non-TTY source install

Request: post_01a11818-5756-7584-9152-8f55ccc25d35. Existing Task: task_01a117b8-fee8-742d-a2a4-1eee266b3073.

Disposition: accept scoped code correction 7d2340e5921a0401c139d7961b0bb165f0c2c24d + 6c95e0d1ba7cd16c9506e1f5d33c3bcf469e127f. Close the code-level production/purge findings. Installed success and release sign-off remain open.

## Independent evidence

- Reviewed committed helper, new real-pnpm regression and package test registration. Across the two commits only package.json, tools/desktop-source.mjs and tools/desktop-source-install.test.mjs change. Commit diff --check passes.
- Exported exact 6c95e0d using git archive to an isolated temporary directory; linked host node_modules only for TS test dependencies. Shared dirty client files were excluded. pnpm test:desktop passed 5 desktop + 5 managed-source tests, zero failures, cancellations or skips.
- Real-pnpm test starts from a production-only dependency tree, runs prepareSource with parent NODE_ENV=production and non-TTY output, reinstalls the dev tool, runs build/typecheck asserting NODE_ENV absent, publishes a fixture artifact, verifies selection/ready status and clean Git checkout, and asserts the parent environment remains production. Stage/smoke adapters exercise fixture artifacts, not a full application build.
- Independent mutation copy retaining production mode failed exit 1 at build's NODE_ENV assertion. Independent mutation copy removing --config.confirmModulesPurge=false failed exit 1 because desktop-build-fixture remained missing. Both failures reproduce the relevant bad patterns rather than checking source text.
- Committed desktop serverEnv still sets NODE_ENV=production; helper copies process.env before clearing only its child build environment. Setup and --publish share buildSource.

## Integration and release handoff

Release Engineer owns cherry-picking only 7d2340e and 6c95e0d onto isolated 048ec32, excluding unrelated aa19d5a, checking the exact combined commit, replacing the blocked e70c9f30 DMG, and rerunning automatic first-launch/retry/native/update/reopen/first Buddy reply. This review did not build a DMG, exercise an installed app, push, upload, or change a peer's task status.

Prior full-server cancellations, native display/true clean-Mac evidence, public recursive source availability and owner publication decision remain outstanding. Existing updater task stays the canonical tracking source; no duplicate task needed.
