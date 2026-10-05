# Desktop agent detection fix (task_01a10b94)

Branch fix/desktop-agent-detection (worktree ~/git/_wt/desktop-agent-detect), commits 2f7fca7 (spike baseline, as-is) + dafbda9 (fix).

Decision: resolve the login-shell PATH once at launch (`$SHELL -ilc`, fenced output, 8s kill timeout) rather than extend a directory list. Failure is a typed `fallback` (logged as PATH FALLBACK) with well-known dirs, not silent.
Rust: server `UNLEASHD_SOURCE_BUILDS=0` drops rust from checks entirely (not probed, installed or shown); desktop sets it; rust.attempted marker removed.
Test: desktop/test/login-path.test.ts (`pnpm test:desktop`) + server/test/dependencies.test.ts: 5 pass.
Packaged evidence: Buddies.app launcher sha256 b175d7a2…8262d9 (build/stable-macos-arm64), launched via `open -n` (launchd env), temp state; /api/dependencies = claude ready, codex ready, no rust; desktop.log shows PATH from /bin/zsh incl ~/.bun/bin.
Not established: why the earlier screenshot showed all three missing (no evidence kept; likely an older spike payload).
