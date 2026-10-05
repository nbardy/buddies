/**
 * Env for a test that boots the REAL backend (server.ts) on a temp HOME.
 *
 * A fresh data dir is always "first boot", so the dependency check installs whatever the temp
 * HOME lacks: rustup (466 MB under .cargo/.rustup), `npm i -g @openai/codex`, claude's installer.
 * The installer runs detached, outlives the test's SIGKILL, and is still writing when the
 * test's `rm -rf` runs, so the directory survives: ~16 GB of `sqlite-locks-*`,
 * `unleashd-lease-*` and `unleashd-adoption-*` piled up in $TMPDIR by 2026-10-05, and the disk
 * hit 0 bytes. Spread this into every spawned backend's env.
 */
// Pattern: fix-guard (docs/patterns.md#fix-guards); guard: dependencies.test.ts 'auto-install off'.
export const NO_AUTO_INSTALL = { UNLEASHD_AUTO_INSTALL: '0' } as const;
