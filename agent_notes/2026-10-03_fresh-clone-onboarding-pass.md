# Fresh-clone onboarding pass (2026-10-03)

Owner asked (#unleashd-2): what is the "fresh clone, no workspaces" experience like before the
launch video.

## Method

- `git clone --recursive` of local HEAD a6bf51a into `/tmp/onboard-fresh-*/unleashd`,
  `pnpm install`, `pnpm build`.
- Started `node server/dist/server.js` with `env -i HOME=<empty tmp home>`, `PORT=7591`, and a
  PATH holding only `node` + system dirs, so no agent CLI was on it. That makes it an empty
  `~/.agent-viewer` + `~/.buddies` and no agent history. No live store was touched.
- Clicked through in a headless browser: home, New workspace (a git-init'd `~/code/my-app`),
  workspace Home, New Buddy (the Builder), one Builder send.
- Separate clone with no `rustc`/`cargo` on PATH to test the addon step.
- Screenshots: `output/onboarding-2026-10-03/` (gitignored).

Caveats: install/build took 12 s only because both Rust addons came from the shared cache
(`~/.cache/unleashd/.addon-cache`). On a real new machine cargo has to compile two crates, and
I didn't time that. I didn't test with a harness installed and logged in.

## Findings (ranked)

P0
1. Rust is a hidden prerequisite. README lists git/Node/pnpm/agent CLI only. Without `rustc`,
   `tools/ensure-addons.mjs` dies with a raw Node stack trace (`spawnSync rustc ENOENT`,
   from `rustc -vV` in the cache key). `tools/preflight.mjs` doesn't check for it.
2. Nothing tells the client which harnesses are installed. The server logs
   `[agents] 0/6 available` (`server/src/audit.ts`) and stops there. The Builder defaulted to
   GPT-6 Astra (Codex), and the first send failed with `Process failed: spawn codex ENOENT`,
   shown twice. There's no "install Claude Code / Codex" guidance anywhere in the UI.
3. The new workspace Home asks "What should the team build next?" with no input box.
   `ChannelLanding.tsx` renders the composer only when `generalChannelId !== null`, and a new
   workspace gets no channels. The note under it still says "Posting saves a thread…". The
   auto-created `unleashd` workspace has only `#upstream`, so it has the same problem.

P1
4. The first screen lists one workspace: unleashd's own source checkout, with Product Dev
   ("Owns the product roadmap and development of this Unleashd install") and Upstream Release
   Manager. A new user who came to work on their own project sees the tool's repo instead.
5. A new workspace is empty: "No channels yet." / "No Buddies yet."
6. The Builder example copy hard-codes "…for unleashd…" inside the my-app workspace.
7. The New-workspace form has no recents for a new user, so they must type an absolute path, and
   there's no browse button. The Name input renders as an unstyled browser-default grey box.

P2
8. `/chats` empty state says `Click "+ New Conversation"`, but the button reads `new +`.
9. On the phone first screen the desktop top nav (Chats/Buddies/Workers) sits on top of the bottom
   tab bar (Home/Channels/Swarms/Buddies/Search). The same area is named "Workers" in one and
   "Swarms" in the other.
10. `pnpm install` on a fresh clone prints `WARN Failed to create bin … agent-cli` (dist isn't
    built yet at link time).
11. Every onboarding string says "unleashd". This is where a Buddies rebrand would show first.
