# Owner steering at native tool boundaries — 2026-10-08

Decision-maker: owner for behavior; assistant for the transport implementation below.
Status: behavior accepted in Task task_01a11a68-4873-7712-8ca8-64b9b102f8a7; implementation under verification.
Request: post_01a11a68-7f62-7267-9915-23a8b206a9e5. Successor to aa19d5a's Buddy-tool response steering.

## Concrete gap and choice

The owner’s 3×3×3 correction waited behind Game Designer’s own thread turn while it used native tools / awaited native sub-agents. The owner twice required receipt after the next tool use, preserving the running task. This is an existing-contract correctness repair; no new Buddy tool, store, model controller or worker executor is added.

Use authenticated native post-tool hooks on the existing loopback Buddy endpoint. They call the same thread resolver and catchUpThread/take_unread fence as aa19d5a, not another delivery queue. The turn’s existing MCP bearer authenticates the hook, is passed in environment rather than argv, and is revoked at settlement. The submodule only exports its existing env-name function, with a contract test.

A parent hook takes the unread page only when it contains an owner post. Taking that page advances the canonical read cursor and consumes its queued deliveries, so no duplicate turn starts. A native child hook only peeks and remembers what it showed that child: the parent still takes the message after its wait/tool completes. Children continue; this path calls neither Stop nor restart. A backend restart may repeat a child's peek; the parent’s consumption remains durable.

The new native hook is triggered by owner posts, not Buddy chatter. When triggered, the parent receives the whole unread page: skipping an earlier Buddy post would mark it read unseen because a thread has one cursor. Existing Buddy-tool catch-up still includes Buddy messages. This is necessary fence behavior, not a new chatter wake policy.

## Harness capabilities (checked 2026-10-08)

| Harness | Wired in this change | Primary source and evidence |
| --- | --- | --- |
| Claude | inject at native tools: PostToolUse and PostToolUseFailure, inline --settings | [Hooks](https://code.claude.com/docs/en/hooks), [CLI flags](https://code.claude.com/docs/en/cli-reference); saved real Claude 2.1.294 probe returned PINEAPPLE after Bash, and child hook sequence is preserved in the evidence directory. |
| Codex | inject at native local tools: PostToolUse, inline -c hooks.PostToolUse; features.hooks=true | [Hooks](https://learn.chatgpt.com/docs/hooks); real temp-backend Bash and native-child regressions pass. Codex also has [app-server turn/steer](https://learn.chatgpt.com/docs/app-server), but our harness uses exec. No app-server migration is necessary. |
| Gemini | buddy-tool-only capability declaration; Buddy launch is separately unavailable because the harness cannot encode required per-turn MCP | [AfterTool](https://geminicli.com/docs/hooks/reference/) can add context, but our Gemini adapter has no isolated per-turn settings/MCP encoder. No user/project settings are edited to pretend otherwise. |
| Cursor | buddy-tool-only in the current adapter | [postToolUse](https://prod.cursor.com/docs/hooks) describes context injection. Isolated headless hook setup has not been verified here; therefore it is not enabled by this change. This is an implementation limit, not a claim that Cursor lacks hooks. |
| Muse | buddy-tool-only in the current adapter | [Hooks](https://meta-models.github.io/muse-code-sdk/next/guides/extend/hooks/) describes hooks. The saved local PostToolUse probe ran its command but the model returned NONE despite additionalContext=PINEAPPLE; no working injection contract is claimed. |
| OpenCode | buddy-tool-only | Existing adapter exposes MCP only; no native hook transport is verified in this assignment. |

Native hooks fire when the tool produces a result, not while a long synchronous tool is still executing. The recorded Claude foreground-Agent probe fires child hooks during the wait and a parent Agent hook only when the child returns. Codex's native-child trial likewise demonstrates child receipt before return, then parent receipt. Neither is claimed to wake a blocked parent inside an unfinished wait. Tool-free thinking receives the next available boundary or the durable delivery when idle. Codex hosted tools (e.g. hosted WebSearch) and specialized opt-out paths do not run local hooks, per its official tool-coverage table.

Claude stream-json input is documented, but this adapter closes its prompt stdin and its durable execution journal is a finite turn. A streaming-input transport would require changes to process ownership/adoption, acknowledgment and the fence; it is not assumed to interrupt a foreground child wait and is not added without that evidence.

Hook errors remain visible to the CLI and leave unread delivery intact. On a buddy-tool-only adapter, the existing Buddy MCP boundary handles it, otherwise its visibly queued delivery runs once the turn is idle. The UI now reads the claim gate’s real reason: conversation_busy is waiting for the current turn; only pool_full says run limit. An older backend with no waiting field renders generic queued, never an invented limit.

## Explicit model picks

Decision 3 of the Task allows a documented reason with a regression. Preserve the existing suppression: a queued explicit pick owns its next turn. Its config is stored only on that run. Advancing the thread cursor inline would consume that run and silently discard the pick. Tests cover BOTH native and Buddy-tool boundaries and prove the next turn uses the picked provider and correction. No second model-setting store is introduced.

## Evidence and revisit conditions

Evidence directory: `agent_notes/2026-10-08_steer-any-tool-evidence/`. Native Codex rollout excerpt records a hooks.additional_context developer message at 08:09:41.116Z containing the actual owner correction from 08:09:40.882Z, before the next tool writes 3×3×3. The real child trial's original child continues and reports corrected output; there is one backend turn and no consumed delivery retry.

Failing-first: disabling the native-hook route makes both native boundary regressions fail on HTTP 405; restoring it passes. Deterministic coverage also checks child peek vs parent take, failure-tool output, owner-only triggering, repeated boundaries, settlement revocation, model-pick preservation and the actual busy-reason projection. Rendering coverage distinguishes busy, full pool and an older backend.

Claude’s first backend trial was blocked before any tool by its session limit (reported reset 16:30 Asia/Makassar), so it is not counted as a successful production-boundary demonstration. The earlier successful probe is capability evidence only. Complete live verification will be appended below; no claim that the user's already-running turn acquired the new hook.

Revisit when an isolated Cursor/Muse/Gemini transport is proved; when the owner requires parent wake while no hook can fire; or when model picks must also steer inline (that needs preserving their config outside a consumed run). Native children using inherited Buddy MCP tools can still advance the Buddy cursor through explicit channel_read/normal tool catch-up; the new peek guarantee covers the native hook, not an independent read the child explicitly performs.

Prior evidence frozen 2026-10-08: agent_notes/2026-10-08_live-thread-steering.md, SHA-256 `d45da714b0a58a3b4d32885248fa3412845cf5f534eda5c57c81987dca4ce8da`. Relevant preserved excerpt:

> Owner request: restore graceful messages during a live thread reply and investigate conversation_busy.

Prior evidence frozen 2026-10-08: agent_notes/2026-10-08_conversation-busy-thread-inject.md, SHA-256 `f9069a3477b822310458e69f42587c2bfbbb51041fef7a240d234e83ad6cab18`. Relevant preserved excerpt:

> Status: owner direction (accepted), lead diagnosis (proposed until the regression test confirms it).

## Verification successor — 2026-10-08 08:35Z

Claude's session limit reset and the committed 7f10986 backend trials both passed: after Bash and during one foreground native child. Preserved `claude-native-hooks.json` records the owner's correction at 08:30:34.442Z, the original child's Bash hook at 08:30:34.675Z, and the parent's Agent hook at 08:30:48.774Z. The same child wrote 3×3×3 and returned; the parent confirmed it. One backend turn, zero Stop calls, and the queued delivery was consumed. The Bash-only hook injected at 08:30:11.405Z before the next tool. A pre-existing local safety hook blocked the attempted second Bash redirect under macOS /var/folders; Claude used Write to create the new temporary result instead. This does not weaken the first-Bash receipt evidence, and the test does not claim the second result was written by Bash.

On clean committed 7f10986: typecheck passed; client 258/258; server serial 325/325, six skipped (four paid trials opt-in); all Rust suites passed; invariant gates 9/9; desktop checks passed. Submodule 6d45ede passed typecheck and 291/291 tests on a clean commit. A broad concurrent server run previously hit two load-dependent existing failures (dependencies boot and swarm context timing); the required lock plus serial run is green. `pnpm token-audit --tag channel` found zero matching sessions, so there is no measured cost comparison.

Screenshot review used the repository's read-only CDP helper on phone and desktop. The temporary test world served its real owning core through ownerHttp; Vite proxied its HTTP API. The native-boundary test was paused before consumption solely to expose the actual queued run, then restored byte-for-byte to HEAD. Both screenshots visibly show “Lead is waiting for the current turn…” beside the running turn, with the owner's 3×3×3 correction. No DOM text or API response was fabricated. Read POSTs and the client-diagnostic POST were blocked. Screenshots were WebP q95 and are transient; hashes and visible text are preserved in `ui-review.json` before deleting them. Separate real-install thread screenshots also ran; live data drift prevents a zero-pixel comparison claim.

Remote main then advanced to fee9b12 (hung-turn provider progress clock). It was merged after this verification and is receiving a fresh combined-commit server/typecheck run, including all four real CLI trials. This paragraph records the sequencing, not a success claim for that new commit. Final results follow below.
