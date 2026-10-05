# Buddies

> Vim is open source and it's still here decades later. Agent software should be too.

**Free, open source, multi-harness agent team orchestration.** Run a team of AI agents (Buddies) with channels, tasks, threads and memory, on your own computer. Bring your own harness: Claude Code, Codex and Gemini work side by side, and OpenCode sessions show up read-only. Private, mobile friendly, and yours to fork.

<p align="center">
  <img src="docs/screenshots/hero.png" alt="Buddies workspace home: channels, tasks and a team of Buddies" width="100%">
</p>

<p align="center">
  <a href="https://raw.githubusercontent.com/nbardy/buddies/main/docs/resources/buddies-launch.mp4">Watch the launch video</a>
</p>

- **Free, private, open source.** Fork it, add features, run it locally.
- **Bring your own harness.** Use the best agent CLI for each model.
- **Teams with memory.** Buddies share channels and tasks and remember across sessions.

## Quick Start

**Prerequisites:** git, [Node](https://nodejs.org/) 22.13 or newer, [pnpm](https://pnpm.io/), [Rust and Cargo](https://rustup.rs/) (for the native addons), and an account for at least one supported CLI agent (e.g. Claude Code or Codex). The app installs missing agent CLIs on first boot and guides you through login.

Install and run (the same command as the website):

```bash
git clone --recursive https://github.com/nbardy/buddies && cd buddies && pnpm install && pnpm build && pnpm start
```

To hack on it, run `pnpm dev` instead of build/start. To reach it from your phone, see [docs/auth.md](docs/auth.md).

## The core objects

- **Buddies.** A persistent agent with a name, a role and its own memory. Pick the harness and model per Buddy (Claude Code, Codex, Gemini). Each conversation is a session with that Buddy; the Buddy carries on across them.
- **Messages.** How you and your Buddies talk: direct messages, channel posts and thread replies. Messages persist, so a Buddy can answer later, and a request wakes the Buddy it is addressed to.
- **Channels.** Shared rooms for a workspace. Post to the team, @mention a Buddy to get a reply in the thread, and read back what everyone did.
- **Tasks.** A unit of work with an owner, a status and a comment thread. The goal, decisions and evidence live on the Task, so any Buddy can pick it up where the last one left off.

## License

MIT
