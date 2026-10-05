# Buddies

> Vim is open source and it's still here decades later. Agent software should be too.

**Free, open source, multi-harness agent team orchestration.** Run a team of AI agents (Buddies) with channels, tasks, threads and memory, on your own computer. Bring your own harness: Claude Code, Codex, Gemini and OpenCode work side by side. Private, mobile friendly, and yours to fork.

<p align="center">
  <img src="docs/screenshots/hero.png" alt="Buddies workspace home: channels, tasks and a team of Buddies" width="100%">
</p>

<p align="center">
  <a href="https://raw.githubusercontent.com/nbardy/buddies/main/docs/resources/unleashd-2.mp4">Watch the launch video</a>
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

The install preflight checks Rust, Claude Code and Codex. If Rust is missing it runs
`brew install rust`; without Homebrew it asks an installed Claude Code to install
Rust via rustup. If Claude is missing or cannot install it, the official rustup
installer runs directly. Failed installs print manual steps. Packaged
installs with prebuilt addons do not require Rust.

On first server boot, missing Claude Code and Codex are installed automatically
using the official Claude installer and npm (Codex goes in `~/.local/bin`).
Missing Rust uses Homebrew, or rustup when Homebrew is unavailable. Each tool's
first-boot attempt is recorded in the app data directory, so restarts and
**Check again** never repeat installers. Failed installs keep manual setup guidance.
On **every server start**, Claude and Codex are asked to respond “Yes” to verify
that they can actually answer. The **Dependencies** window shows progress and
**Login required** with a copyable login command when authentication is missing.
Usage limits and connection failures stay separate from login failures. Response
checks time out after 45 seconds and use a little agent quota; installation steps
allow up to 10 minutes each. You can continue while resolving a check.

To develop on it, use `pnpm install && pnpm dev` instead of build/start.

Development uses [http://localhost:7489](http://localhost:7489) by default. Run `pnpm local-domain:setup` once if you prefer [http://unleashd.localhost](http://unleashd.localhost), and `pnpm local-domain:remove` to remove it. The setup command installs a persistent, loopback-only macOS port proxy; dev startup only detects it and never prompts for administrator access. Unleashd itself always runs as your normal user. In dev, the API server stays on port `7499` behind the Vite proxy.

Frontend edits reload immediately. Backend edits are coalesced by the development watcher: if Codex or another provider has active turns, the current backend keeps owning their event streams until they finish, then exits and starts the updated server. An explicit `Ctrl-C`, `SIGTERM`, or `pnpm dev:replace` remains an intentional shutdown and stops active turns.

### Production

```bash
pnpm build
pnpm start     # serves built client + API on port 7489
```

### Access key

By default both servers bind loopback only and no key is required. To reach
unleashd from another device (Tailscale, LAN), set a shared secret first:

```bash
openssl rand -hex 32 | tee ~/.agent-viewer/auth-token
```

With a key configured, every request and the WebSocket require it, and the dev
server starts listening on all interfaces. Without one, binding a non-loopback
address is refused at startup rather than silently exposing the API.

Sign in through the form at any URL, or bookmark `http://<host>:<port>/?token=<key>`
on a phone — it stores an HttpOnly cookie and strips itself from the URL. Scripts
use `Authorization: Bearer <key>`.

A shared key is a bearer credential, so it is only as private as the wire. Over
Tailscale it travels inside the WireGuard tunnel; over plain http on a LAN it is
cleartext. See [docs/auth.md](docs/auth.md) for the threat model and the
one-command Tailscale https setup.

## Buddies (persistent employees)

Buddies run on the in-repo Rust core (`crates/unleashd-buddies`, loaded as the
`@unleashd/buddies-core` addon; `pnpm addons` builds it). Buddy identity, work,
memory docs, channels and runs live in `~/.buddies/buddies-v3.sqlite`
(override with `UNLEASHD_BUDDIES_DB`).

Each Buddy also has a private curated `MEMORY.md` plus append-only journal
notes. Unleashd injects the bounded curated summary and recent journal excerpts
into the first turn of each Buddy conversation. The `remember` operation
records material outcomes, failures, durable decisions, and reusable lessons;
`compact_memory` reconciles repetitive or stale history with source
references. `BUDDY_SOUL.md` remains a stable, owner-reviewed behavior and
authority contract: Buddies may record `SOUL_CHANGE_PROPOSAL` journal entries,
but cannot silently rewrite their own Soul.

A missing database fails every Buddy call with the import command; ordinary
chats keep working. Importing a v33 `~/.buddies/buddies.sqlite`, backup and the
live swap are in [crates/unleashd-buddies/README.md](crates/unleashd-buddies/README.md)
("Import and verify", "Deploy").

## Supported Agents

| Agent | Disk path read | Live spawn |
|-------|---------------|------------|
| [Claude Code](https://docs.anthropic.com/en/docs/claude-code) | `~/.claude/projects/` | Yes |
| [Codex](https://github.com/openai/codex) | `~/.codex/sessions/` | Yes |
| [OpenCode](https://github.com/opencode-ai/opencode) | `~/.local/share/opencode/` | No (read-only) |
| [Gemini CLI](https://github.com/google-gemini/gemini-cli) | `~/.gemini/tmp/` | Yes |

The server auto-discovers conversations from each agent's disk format. No configuration needed — if the CLI has been used, its sessions show up.

## Project Structure

```
client/     React + Vite frontend
server/     Express + WebSocket backend
shared/     Shared types (Zod schemas)
```

## License

MIT
