# Expeditions

One TypeScript plan runs a chain of agent turns, host commands and questions. A Buddy proposes
it; the owner launches its card. Its manager is the Buddy in `contract.leader`, with that Buddy's
normal tools and memory. The [ten examples](examples/README.md) are the authoring contract.

The server runs the plan in a permission-limited child with no inherited environment, writes or
process spawning. Each call is keyed by its name and rendered inputs. A settled answer comes
from `log.jsonl`; otherwise its cap is reserved, its harness slot is acquired, and `runTurn` executes
it. Its durable key joins an adopted turn after restart. Re-evaluation supplies finished answers
from the same log after a restart or rewrite. When the plan returns, the server evaluates `done`.
The child uses native TypeScript loading, verified on Node 24; older declared Node versions
were not checked. Its permission model does not block sockets, so it is not network isolation.

A checkout gets its own branch, Git commit metadata and private temp directory. Its commit remains
when the worktree is removed. Host checks run in detached checkouts with scrubbed environments;
reviews receive the exact judged commit and diff. Answers use the proven final-message JSON
reader and schemas. Reported usage uses canonical pricing; unavailable usage charges the cap.
Manager requests use ordinary Buddy admission and conservatively charge their wake cap;
`leaderWake.minutes` is reported but does not replace the Buddy request deadline.

The folder is `<APP_DATA_DIR>/expedition-runs/<id>/`: `plan.expedition.ts`, immutable
`plans/vN.expedition.ts`, and the server-written `log.jsonl`, with inline results and per-step work
folders. The log is the only expedition store. The Buddy execution gate refuses every write on
disabled stores; their views remain readable. Owner questions have one answer route. The manager
edits the live plan file and calls `rewrite`: typecheck, dry evaluation and unchanged contract are
checked inside the call. Extra first-wave cost above `autoApply` asks the owner. Dropped running
steps are cancelled. Manager wakes tell it to record lessons in its ordinary Buddy memory.

Measured source (`wc -l`, formatted); predictions are the owner's original budget. This candidate
is over the server budget and must not be represented as meeting it. No minification is used.

| Group | Prediction | Actual |
|---|---:|---:|
| author + child (including sandbox host) | 300 | 420 |
| engine | 220 | 447 |
| call + answer + worktree + command helpers | 300 | 533 |
| gates | 130 | 142 |
| manager | 70 | 23 |
| routes + tool | 200 | 145 |
| shared view/proposal | 80 | 52 |
| server + shared | **1,300 max** | **1,762** |
| client | **700 max** | 298 |
| expedition tests | **1,000 max** | 489 |

Deliberately absent: a kernel with ports; a separate run record store; versioned wire entry
schemas; per-call enforced/advisory grant reports (the card states Codex's advisory limits once);
a non-Buddy manager; extra proposal digests; draining or pending-approval states; a separate
read-only shelf; a standalone CLI. Phase grouping, rewrite `keep`, and app-side Stop are cut.
`x.phase` executes its body so the unchanged examples remain valid. Named `needs` resources share the same slot admission as harnesses; a waiting owner holds no slot.

The [lessons](LESSONS.md) preserve the five real runs' evidence. Proof commands:
`pnpm test:server expedition-small expedition-backend`, then `pnpm probe:expeditions --harness all`.
The real manager is exercised through its Buddy tool in the integrated test; there is no separate
manager prompt/CLI probe. Runtime and budget limitations must be reported with the final checks.
