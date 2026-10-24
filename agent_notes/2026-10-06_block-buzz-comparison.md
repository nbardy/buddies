# Block's Buzz vs Unleashd Buddies (research, 2026-10-06)

Asked by: Owner, #buddies-dev thread post_01a11018-73cb-70a0-89cc-23101904987c
("seems like it might basically be the same thing but hosted? and multi-tenant?")
Status: research only. Nothing in here is a decision.

## What Buzz is (sources read 2026-10-06)

- Launched 2026-07-21 by Block. Apache-2.0. Hosted at buzz.xyz (free beta, 180-day
  retention default) or self-hosted.
- A Slack-and-GitHub replacement for teams of humans plus agents, built on Nostr. Every
  message, patch, review and merge is a signed event in one append-only log. Humans
  and agents each hold a keypair. An owner signs a scoped authorization for an agent, so
  the agent stays the author.
- Relay: Rust (Axum) on Postgres (events, membership, search), Redis (pub/sub, presence)
  and S3 (media, git objects). Built-in git forge (content-addressed packfiles plus a
  CAS manifest pointer, model-checked in TLA+). Voice, file sharing, DMs, threads.
- Multi-tenant: "The relay URL selects exactly one community." The README says
  multi-tenant deployments scope state by a host-derived community across Postgres,
  Redis and S3.
- Agents: `buzz-acp` runs on the USER's machine (laptop, VM). It connects to the relay
  over NIP-42 auth and spawns Claude Code, Codex or goose as local subprocesses over
  ACP (Agent Client Protocol). Turns start from a `#p`-tagged mention (a structured
  field, not parsed text), an edit that adds a mention, a workflow approval or a
  reminder. At most one prompt is in flight per channel. `--agents N` (max 32) runs
  channels in parallel. All N processes share one bot identity.
- Context comes from channel history. Memory and cost records are encrypted, and the
  server sees routing metadata only. `buzz-persona` provides "persona packs".
- Still unfinished (🚧): YAML workflows (message, reaction, schedule and webhook
  triggers) and mobile (Flutter). Permissions stop at channel membership, with no
  per-tool authorization.

## Comparison

| | Buzz | Unleashd |
|---|---|---|
| Users | Many humans and many agents | One owner, many Buddies |
| Hosting | Hosted relay or self-host. Agents still run on the user's machine | Local backend. Agents run on the owner's machine |
| Tenancy | Communities per host | One install |
| Agent identity | Keypair. Persona pack | Buddy with a soul, working and long-term memory, and a memory reviewer |
| Wake | Structured `#p` mention, reminders, approvals | @mention link, DM request, answers, schedules, worker runs |
| Work tracking | Channels plus git events. Workflows 🚧 | Tasks, runs with leases, request/answer delivery, schedules |
| Durability of a turn | Not documented | Execution journal, adopted after a backend restart |
| Code | Built-in git forge and signed merges | The owner's own git checkout |
| Harness seam | ACP (open standard) | vendor/agent-cli-tool (our own) |

## Takeaways (assistant proposals, not decisions)

1. "Hosted and multi-tenant" holds for the chat layer only. Buzz hosts the relay.
   Agent execution stays on each user's machine through `buzz-acp`, the same place ours
   runs.
2. Buzz's agents are thin: a persona plus channel history. Unleashd's depth sits in the
   per-agent runtime (memory, tasks, delivery, leases, adoption). Buzz leaves that layer
   mostly unbuilt.
3. Mentions are a structured `p` tag. That supports making a mention a structured
   field of the `post` tool, as opposed to relying on text parsing
   (task_01a10ff9-c64b-7548-a636-d9f57a5d6102).
4. "One prompt in flight per channel" is the same rule as our per-conversation
   TurnQueue.
5. ACP is worth looking at as the harness seam for agent-cli-tool. Not evaluated yet.

## Sources
- https://engineering.block.xyz/blog/buzz
- https://github.com/block/buzz (README)
- https://github.com/block/buzz/tree/main/crates/buzz-acp (README)
- https://thenextweb.com/news/block-buzz-humans-ai-agents-workspace
- https://rohitraj.tech/notes/block-buzz-agent-collaboration-platform-guide-2026 (third-party)

## Follow-up (same day): "thinner" and ACP vs agent-cli-tool

Owner asked: what does "thinner" mean, and is ACP like our shared agent CLI lib?

- `buzz-agent` README (read 2026-10-06): "a minimal LLM agent implementing ACP". It is
  "Not persistent" and "Not a framework". "Everything is in-memory, per-process. No
  SQLite." The `buzz-acp` README says all N agents behind one harness "authenticate as
  the same Nostr bot identity".
- ACP (agentclientprotocol.com, read 2026-10-06) is JSON-RPC over stdio with one
  long-lived agent process.
  - Client to agent: `initialize`, `session/new`, `session/load` (optional),
    `session/prompt`, `session/cancel`, `session/set_mode`.
  - Agent to client: `session/update` notifications, `session/request_permission`,
    and optionally `fs/*`, `terminal/*` and `elicitation/create`.
  - Claude Code and Codex speak ACP only through adapters (`claude-agent-acp`,
    `codex-acp`). Codex's adapter needs a flag to persist sessions so that
    `session/load` can resume them.
- agent-cli-tool (README at the submodule HEAD) spawns each CLI's own headless mode.
  It normalizes events and token usage per harness, keeps a model catalog, and
  journals each execution to disk, so a running turn survives a backend restart.
- Assistant view (not a decision): ACP covers the same layer as agent-cli-tool, but as
  an open protocol, where ours is a library. What it adds is two-way traffic during a
  turn: tool permission requests, mid-turn mode or model changes, plan and diff
  updates. Open risks are the adapter dependency, whether the usage numbers we
  normalize survive an adapter, and whether a long-lived child bound to stdio can be
  adopted after a restart. Possible next step: add ACP as one more harness behind
  agent-cli-tool, rather than replacing it.
