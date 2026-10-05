# Buddy tool calls during a backend outage: measurements and mechanism (2026-10-05)

Task task_01a0f65c (request post_01a10bcf). Base `continuity/p1-state-main` @ 3a21efd, branch
`fix/outage-tool-delivery`. Ctrl+C proof case 4 (agent_notes/2026-10-01_ctrl-c-proof.md): a Buddy MCP
call made while no backend runs gets `ECONNREFUSED`, and nothing retries it.

## Step 1: what each CLI's MCP HTTP client does (measured before any code)

Harness: `2026-10-05_outage-tool-delivery/fake-mcp.mjs` (a streamable-HTTP MCP server with one
`ping` tool) plus `run-claude.sh` / `run-codex.sh`. Each run is one real model turn asked to call
`ping` once and never retry, so any second request would come from the transport, not the model.
Models: `claude-haiku-4-5` (Claude Code 2.1.289) and `gpt-5.6-luna` at low effort (codex-cli
0.160.0). `gpt-5.4-mini` is refused on a ChatGPT-account codex. 16 real turns in total.
Per-run elapsed times: `2026-10-05_outage-tool-delivery/summaries.txt`.

| Shape of the failure at `tools/call` | claude | codex |
|---|---|---|
| Connection refused (listener closed after `tools/list`, reopened 20 s later) | immediate tool error `ECONNREFUSED: Unable to connect…`, one attempt, no reconnect | immediate tool error `Transport send error…`, one attempt |
| 503 + `Retry-After: 5` | immediate tool error `Error POSTing to endpoint: backend restarting` (shows the body), no retry | immediate tool error (transport error), no retry |
| Socket accepts, holds 30 s / 55 s, then answers | **waits**, gets `pong (held)` | waits, gets it (55 s) |
| Holds 65 s | **times out at 60.0 s** (`The operation timed out.`; the fake saw the client close at +60 s) | waits, gets it |
| Holds 65 s with `MCP_TOOL_TIMEOUT=120000` | waits, gets it | n/a |
| Holds 130 s | not run | waits, gets it (no ceiling found at 130 s) |
| 200 with a JSON-RPC `error` `{code:-32000, message}` | tool error showing exactly `message` | tool error `Mcp error: -32000: <message>` |

Conclusions:

1. Neither CLI retries a refused connection or a 503. A refusal is a tool error the model sees at
   once, and whether it tries again is the model's choice (case 5 retried only because its prompt
   said to).
2. Both CLIs wait on a request that has been accepted and not yet answered. Claude waits up to
   60 s (MCP SDK default request timeout, overridable by `MCP_TOOL_TIMEOUT`); codex waits at least
   130 s.
3. So holding the request is the mechanism that needs no model cooperation. The holder has to answer
   before claude's 60 s: a hold of **55 s**, then a JSON-RPC error whose message both CLIs show
   verbatim.

## Step 2: mechanism

### What has to outlive the backend

A Ctrl+C kills the whole terminal process group: pnpm, dev-supervisor, watch-server runner and
backend (ctrl-c-adoption.test.ts asserts the group is empty). Only the detached execution groups
(agent-cli journal wrapper + CLI) survive. So whatever holds the port must be **detached from the
terminal's group**. The dev-supervisor dies on Ctrl+C, so a supervisor-owned relay would cover only
watch reloads and not this case.

### Chosen: one detached loopback relay that owns the stable MCP port

- The backend spawns `server/src/buddies/mcp-relay` detached (its own session and group, like an
  execution) the first time it finds no relay. The relay listens on the stable port that P1 already
  persists in `buddy-mcp.json` and writes that file itself (port, pid, attach key, version; 0600).
- The backend serves its MCP handler on an OS-assigned internal loopback port. It then **attaches**:
  it holds open a request to the relay that carries the relay's attach key and the internal port.
  The relay forwards to the attached port only while that connection is open. When the backend dies
  (even by SIGKILL) the kernel closes the socket, and the relay knows at once that no backend is
  there. It never forwards to a stale port that another process may have reused.
- A `/mcp` request is buffered (MCP bodies are small) and held until a backend is attached, for up
  to 55 s, then forwarded with its headers unchanged. If the forward fails before any response byte
  arrives (the backend died mid-call), the relay holds the request again and resends it. That is
  safe because every writing tool takes an idempotency `key` (docs/patterns.md#idempotency-keys),
  so a resent call replays the first result instead of writing twice. After 55 s with no backend
  the relay answers with a JSON-RPC error: "Buddy backend unavailable … not delivered".
- Authority does not move. The relay passes the turn's bearer through and never interprets it. The
  backend's existing grant lookup decides every call, so a turn that was Stopped (durably `stopping`,
  grant never restored at boot: holdsGrant) gets its 401. The relay never sees the owner secret: it
  is a different listener from the gated Express app, and the attach key is its own random value.
- The relay exits on its own after 5 minutes with no backend attached and nothing held, so test
  servers on temp stores do not leave relays behind for long. Version skew: the relay's version is
  in its file. A backend that finds an older relay stops it (pid checked against its command line)
  and starts the current one on the same port.

### Alternatives and why they lost

| Alternative | Why not |
|---|---|
| Briefing/prompt contract ("if a Buddy call fails, wait and retry") | Forbidden by the brief, and it makes delivery depend on the model (case 5). |
| Relay inside dev-supervisor | Dies with the Ctrl+C group (above). Covers watch reloads only, and `pnpm start` has no supervisor. |
| Per-execution relay in the agent-cli wrapper | One extra process and port per turn. Moves HTTP and retry policy into the submodule, which is meant to stay a thin wrapper. Every turn's MCP URL would need a port chosen before spawn. |
| Backend listens on a unix socket in APP_DATA_DIR and the relay forwards to it (no attach protocol) | macOS limits socket paths to 104 bytes. Temp-store paths in tests run ~113. A hashed path under `os.tmpdir()` works but adds a second location to clean up. |
| Relay forwards to a backend port read from a file | A SIGKILLed backend leaves the file behind. If another process reuses that port, the relay would hand it the turn's bearer. Attaching over a live connection rules that out. |
| Raise claude's timeout (`MCP_TOOL_TIMEOUT`) and hold for 60 s or more | Works (measured), but needs a turn-env change in the harness and exists only for claude. 55 s fits both CLIs unchanged. Revisit if outages of 55-60 s turn out to matter. |
| Server-side retry/queue | The server is the thing that is down. |

### Revisit if

- A CLI version starts retrying refused connections on its own: the relay becomes redundant.
- Claude's MCP client timeout drops below 60 s: lower the hold (`HOLD_MS` in mcp-relay).
- A writing tool without an idempotency key appears: the resend after a mid-call death would
  duplicate its write.
