# Desktop setup detection — owner report

Owner thread: post_01a10b92-ac79-73f7-9509-523b6fd094e9 in #general.
Screenshot showed Rust/Cargo, Claude and Codex all missing while browser use worked.

Read-only inspection at 2026-10-05 10:21Z:
- Current desktop spike is /private/tmp/unleashd-desktop-spike/desktop; main process starts a separate bundled backend with its own data directory and ephemeral port, not the browser development backend.
- Current backend PID 37930 uses port 59723, HOME=/Users/nicholasbardy, inherited PATH=bundled node:/usr/bin:/bin; BUDDIES_DESKTOP_HOME=/tmp/buddies-desktop-dm.1b6O/state. It launched 10:18:55Z, after the owner's screenshot.
- Authenticated GET /api/dependencies from this backend returns Rust ready, Claude ready, Codex missing. No POST retry or live agent probe was initiated for this investigation.
- Host command resolution: Rust ~/.cargo/bin/rustc, Claude ~/.local/bin/claude, Codex ~/.bun/bin/codex (symlink to ~/.local/bin/codex-cow).
- The packaged providers/dependencies.js appends ~/.cargo/bin and ~/.local/bin, but not ~/.bun/bin. This explains current Codex false-negative; it does not establish why the earlier screenshot showed all three missing.
- Desktop launcher source: desktop/src/main/index.ts lines 79–98 creates the restricted server PATH. Server detection mutates the inherited environment so detection and subsequent turns share PATH.

Release handoff: fix Finder-launched executable discovery for both probes and real turns, covering user Bun and npm/node-manager installation paths without silently choosing a different harness. Packaged Rust is a source-build tool, not a desktop runtime prerequisite; desktop already suppresses its auto-install through a marker workaround, yet still displays it as required setup. Replace that with an explicit source-build applicability policy. Validate using the actual packaged binary under a Finder-like environment and installed host tools, not a fixture screenshot. Include a boundary regression. Do not reinstall the owner's existing tools or restart the live dev backend as a workaround.

No source change, build, push, app restart or store access performed. RTK.md absent in checkout and parent paths inspected.
