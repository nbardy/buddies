# Managed source build environment and non-TTY install recovery

Request/finding: post_01a11814-53a8-74fa-a06c-6d67d263e56f; Task task_01a117b8-fee8-742d-a2a4-1eee266b3073.

Fix: 7d2340e (helper environment/install + regression), 6c95e0d (strengthened existing-production-tree fixture). Only tools/desktop-source.mjs, tools/desktop-source-install.test.mjs and package.json changed; concurrent client edits excluded. Both setup and --publish share buildSource, which now strips NODE_ENV from child processes via an undefined spawn environment value, while preserving the app/parent production environment. Frozen install passes --config.confirmModulesPurge=false so a previous production-only installation is actually replaced without a non-TTY confirmation. Server runtime environment is unchanged.

## Evidence

Exported exact commit 6c95e0d1ba7cd16c9506e1f5d33c3bcf469e127f to /tmp/desktop-install-verify-20261008 (host node_modules linked for desktop TS test dependencies). pnpm test:desktop passed 5 desktop tests + 5 managed-source tests, no failures/cancellations/skips. Scoped Biome and git diff --check pass.

The new default regression uses actual Git and pnpm9.15.0 with local fixture packages, no registry downloads. It pre-installs a production dependency while omitting the dev tool, then spawns prepareSource from a process with NODE_ENV=production and non-TTY output. The helper really installs the dev tool, runs build/typecheck scripts asserting NODE_ENV absent, stages a fixture artifact, verifies it and atomically selects it; parent production environment remains unchanged. Git checkout stays clean. Stage/smoke are fixture adapters, not the full application.

Mutation checks on a separate exported source copy: retaining NODE_ENV fails (exit1); removing confirmModulesPurge=false fails (exit1, missing dev tool after pnpm's zero-exit prompt). Early fixture without a production dependency tree did not reproduce purge; it was strengthened before final verification. Fixed source passes.

## Release handoff

Cherry-pick only 7d2340e and 6c95e0d onto Release Engineer's isolated 048ec32 candidate. Do not merge current shared main: intervening aa19d5a is unrelated live-thread steering, outside this updater cut. Retain website b8a1e3d and reviewed status/gitlink fixes. Release Engineer owns exact combined gates, replacement DMG and first-launch/native journey rerun. Existing e70c9f30 DMG remains blocked and unmodified. No DMG built in this fix turn; no push/tag/upload/publication.

This closes the code-level production/purge findings, not installed validation. Full server suite at prior048ec32 still had 19 cancellations. Native display availability and true clean-Mac test/public recursive revision remain outstanding. Existing owner A/B decision remains pending. Upstream Release Manager's preliminary manual pnpm install/build still inherits production; this fix guarantees its canonical --publish helper uses development build dependencies, and the installed rerun must verify the full handoff.
