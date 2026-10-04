# unleashd

A SWARM FIRST ADE (Agent Development Environment) for running and managing agent swarms across Claude Code, Codex, Gemini, and OpenCode.

<p align="center">
  <video
    src="https://raw.githubusercontent.com/nbardy/unleashd/main/docs/resources/unleashd.mp4"
    poster="https://raw.githubusercontent.com/nbardy/unleashd/main/docs/screenshots/gallery.png"
    controls
    muted
    playsinline
    preload="metadata"
    width="100%">
  </video>
</p>

<p align="center">
  <a href="https://raw.githubusercontent.com/nbardy/unleashd/main/docs/resources/unleashd.mp4">Download the unleashd demo video</a>
</p>

## The problem

You run agents from different CLIs — Claude Code, Codex, Gemini, OpenCode. Each has its own terminal, its own session history, its own way of showing what happened. When you're running a swarm of agents across a codebase, there's no single place to see what's going on, steer the work, or review what was done.

## What unleashd does

Two things:

**1. Visibility and organization across all your agents.**
See every conversation from every CLI agent, organized by project. Search across all of them. No more flipping between terminals trying to remember which agent you asked to do what.

**2. Launch and manage long-running agent swarms.**
Swarms are treated as two things at once:

- **Background jobs** — they run in a loop, autonomously, without interruption.
- **Artifacts** — they can be inspected, discussed, and steered through conversation.

Swarms continue without you. But you guide them. From the same chat interface, you can launch a swarm, check its progress, debug a failing worker, or review its output.

### Swarm Analytics

Track multi-agent swarm runs — iterations, merges, rejections, per-worker timelines.

![Swarm Analytics](docs/screenshots/swarm-analytics.png)

## Quick Start

**Prerequisites:** git, [Node](https://nodejs.org/) 22.13 or newer, [pnpm](https://pnpm.io/), [Rust and Cargo](https://rustup.rs/) (for the native addons), and at least one supported CLI agent installed and authenticated (e.g. `claude`).

Install and run (the same command as the website):

```bash
git clone --recursive https://github.com/nbardy/unleashd && cd unleashd && pnpm install && pnpm build && pnpm start
```

The install preflight checks Rust, Claude Code and Codex. If Rust is missing it runs
`brew install rust`; without Homebrew it asks an installed Claude Code to install
Rust via rustup. If that fails, it prints the manual install steps. Packaged
installs with prebuilt addons do not require Rust.

At app launch, the **Dependencies** window checks Rust and asks Claude and Codex
to reply “Yes” once (this uses a small amount of agent quota). Missing agents and
failed responses show installation/login guidance. Log in from your terminal
with `claude auth login` or `codex login`, then click **Check again**. You can
continue into the app while resolving dependencies.

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
