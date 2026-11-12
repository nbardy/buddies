# Expeditions

One TypeScript plan runs a chain of agent turns, host commands and questions. A Buddy proposes
it; the owner launches its card. Its manager is the Buddy in `contract.leader`, with that Buddy's
normal tools and memory. The [ten examples](examples/README.md) are the authoring contract.

The base is `origin/HEAD` after a bounded fetch (or `HEAD`, explicitly disclosed, if absent), overridden by `contract.base`; the Launch card pins its commit and reports the ref and fetch result in the launch log too.
`propose {file:'repo/path',at:'base'}` gates a temporary copy from the workspace repository's base commit and carries that exact source and hash on the card, without writing into the shared checkout.

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
`leaderWake` sets only a dollar reservation; the normal Buddy request owns its deadline.

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
| author + child (including sandbox host) | 300 | 412 |
| engine | 220 | 447 |
| call + answer + worktree + command helpers | 300 | 522 |
| gates | 130 | 139 |
| manager | 70 | 23 |
| routes + tool | 200 | 145 |
| shared view/proposal | 80 | 52 |
| server + shared | **1,300 max** | **1,740** |
| client | **700 max** | 298 |
| expedition tests | **1,000 max** | 489 |

Deliberately absent: a kernel with ports; a separate run record store; versioned wire entry
schemas; per-call enforced/advisory grant reports (the card states Codex's advisory limits once);
a non-Buddy manager; extra proposal digests; draining or pending-approval states; a separate
read-only shelf; a standalone CLI. Phase grouping and rewrite `keep` are cut. Owner Stop cancels a step conversation through the ordinary turn stop path, holds a required call and wakes its manager with the cancelled result.
`x.phase` executes its body so the unchanged examples remain valid. Named `needs` resources share the same slot admission as harnesses; a waiting owner holds no slot.

The [lessons](LESSONS.md) preserve the five real runs' evidence. Proof commands:
`pnpm test:server expedition-small expedition-backend`, then `pnpm probe:expeditions --harness all`.
The real manager is exercised through its Buddy tool in the integrated test; there is no separate
manager prompt/CLI probe. Runtime and budget limitations must be reported with the final checks.

The cost/Stop follow-up removed repeated log scans (one append/boot fold now owns the index),
the Cambium add/remove forwarding wrappers, duplicate judge checkout cleanup, repeated option/cap definitions,
and the ignored wake-minute option. It removes 22 formatted source lines; the 1,300 cap is still
missed by 440. No behavior was moved outside this count to meet the cap. Remaining blocks:

| File | Lines | Capability retained |
|---|---:|---|
| answer.ts | 56 | Final JSON extraction without accepting nested fragments of truncated answers |
| author.ts | 278 | Inferred item/output types, strict definitions, defaults, keyed promises and questions |
| call.ts | 335 | Native turn grants, exact-commit checks/reviews, pricing, file containment and safe worktree release |
| cambium.ts | 39 | Bounded async Git capture, scrubbed environment and hooks disabled |
| checks.ts | 92 | Shell-free argv, scrubbed environment, process-group cancellation and output tails |
| child.mjs | 40 | Restricted imports and exclusive host IPC authority |
| child.ts | 94 | Permission-limited plan child, execution timeout, process cleanup |
| engine.ts | 447 | Durable replay index, resource/budget admission, owner answers, completion criteria, manager rewrites |
| gates.ts | 139 | Real TypeScript check, dry evaluation, contract parsing and first-wave reservation preview |
| manager.ts | 23 | Idempotent wake through ordinary Buddy mail |
| routes.ts | 35 | Owner launch/answer and read routes behind the existing auth gate |
| tool.ts | 110 | Workspace/manager authority, proposal cards, action parsing and authoring tool description |
| shared expedition.ts | 52 | Proposal wire parsing and shared result/view types |

Owner Stop writes the cancelled receipt, ends that plan evaluation and holds at the cancelled
call, even for `.try`. The normal manager wake names the cancelled step. A rewrite dropping
work or a manager stopping a run carries the engine's aborted signal and does not trigger
another manager wake. The backend guard is `owner Stop cancels a step and wakes its manager`.

Git's bounded output (16 MiB, error on overflow) and a host check's retained stdout tail
(1 MiB, successful exit preserved) are distinct policies. They retain their native process
implementations; merging them required more code than it removed. The real-process guard in
`expedition-gates.test.ts` keeps both behaviors.
