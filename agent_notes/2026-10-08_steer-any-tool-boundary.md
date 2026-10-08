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

## Verification successor — 2026-10-08 09:06Z

The initial real-CLI fixture needed stronger acceptance guards. A later Codex trial chose Buddy delegation instead of native spawn and was correctly denied; the fixture now names the native tool and asserts the native child exists. A later trial wrote the correct result but reached the fixture's one-minute background deadline: that is no longer accepted. Real-provider Stop calls are tracked, the original root run must complete successfully, and paid trials get a bounded five-minute test deadline while fake-provider deadlines remain unchanged. Native stores/cwd are under /tmp so the owner's existing safety hook permits the scratch shell writes; no safety hook is bypassed or edited.

One Claude child actually received the owner correction but ignored it after its parent delegated a literal 2×2×2 command and omitted the newest-owner rule. `claude-ignored-hook.json` preserves both the authenticated hook context and that refusal. Using the prompt-engineering skill, the observed failure was classified as delegated-context loss, not missing transport. The test now passes the newest-owner rule verbatim to the child and explicitly waits in the foreground. Production briefing/hook wording is unchanged. First-party [Claude prompting guidance](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices) was checked; the source of this particular diagnosis is the saved trace. Receipt does not guarantee a model follows a correction if its parent freezes conflicting data.

Stricter successful trials: Codex 6242406, 37.4 seconds, original native child writes 3×3×3, parent confirms, one successful run and no actual provider stop; Claude 586e4f5, 46.6 seconds, the child Bash hook injects at 08:56:21.920Z and the parent Agent hook injects at 08:56:27.775Z. The same child writes 3×3×3 and returns. Hashed native excerpts are in the strict-native-hooks JSON files.

A subsequent broad paid run encountered three distinct failures: ambiguous native-vs-Buddy delegation, a 30-second test wait / a refused macOS scratch redirect, and another release run's EADDRINUSE on 7553 despite this lane holding the required lock. Those failed runs are not counted as verification. The final locked serial server run is green: 325 pass, six skips, zero failures (`/tmp/steer-server-final.log`). Paid successful traces are retained separately.

Local main then advanced through fd716b9 with the model-picker / mention UI fixes. They were merged without changing server, shared, crate or provider code. Fresh combined client 260/260, typecheck and all nine invariant gates pass. Buddies line ceiling 11441/11441 passes. Earlier clean Rust and provider-harness results still apply: their sources are identical. The latest package / API checks are queued behind the test lock. Built-package smoke passed before the UI merge. Public API smoke found its pre-existing literal v3 assertion while the canonical wire was already v4 at base 4f16903; dc01bc8 corrects the test to PROTOCOL_VERSION. Final check and push results follow below.

## Final checks — 2026-10-08 09:10Z

All required checks are green on the committed implementation and its merged dependencies. Clean worktree 98deb61 has the same runtime, shared, crate, provider and test sources as the checked revisions; it only adds this evidence history. Server serial: 325 pass / six skips / zero failures. Combined client: 260/260. Typecheck, all nine client invariant gates, catalog check, Buddies 11441/11441 line gate, Rust suites and provider 291/291 tests pass. Fresh combined `pnpm test:package` passes (built server, catalog, client, owning Buddies write/read); public `pnpm test:api` passes 16/16. Logs: /tmp/steer-server-final.log, /tmp/steer-main-ui-client.log, /tmp/steer-main-ui-typecheck.log, /tmp/steer-main-ui-invariants.log, /tmp/steer-package-latest.log, /tmp/steer-api-verified.log, /tmp/steer-catalog-final.log, /tmp/steer-commit-crate.log, /tmp/steer-sub-final-tests.log.

Core commit definitions were checked directly at HEAD (`steeredThread`, `steerNativeTool`, `peekThreadUnread`, and submodule `mcpHeaderEnvName` export), not inferred from the shared dirty main tree. The upcoming fast-forward preserves unrelated main edits; the submodule export commit 6d45ede is already pushed. The native answer to request post_01a11a68-7f62-7267-9915-23a8b206a9e5 will record the exact main push hash.

Deployment limitation: launch-time hooks apply to new CLI processes; an already-running CLI does not acquire them in place. The owner backend is not forcibly restarted and no live turn is stopped. Parent-in-an-unfinished-wait, hosted Codex tools, explicit queued model picks, and the declared Buddy-tool-only harnesses retain the limits above. Native receipt is independently proved; a model can still mishandle a correction if its delegation freezes conflicting dimensions. This change does not invent authority from an incoming post.

## Successor — 2026-10-08 ~09:40Z: atomic pick guard, and the last-tool-call rule (criterion 6)

Decision-maker: assistant (implementation choices below), under the lead's reopened criterion 6 of task_01a11a68 (request post_01a11acf-3d0d-70d1-8968-8de84966f967). Status: proposed, on branch `fix/steer-atomic-guard`, pending PM review. Earlier sections above still hold; this amends "Explicit model picks" (its guard was not atomic) and adds the last-call rule.

**What changed.** RE reproduced 6/40 timeouts of the thread-model pair at f1011d0 and showed the cause (agent_notes/2026-10-08_f1011d0-full-suite-rerun.md, "1–2: reproduced"): `steeredThread` checked queued picks with `listRuns` and the read happened later in `catchUpThread`, two core calls. A pick posted between them was steered into the running turn on the old model and its own delivery was fenced `consumed`. At 83fd4e1 the Stop-hook hold (`holdStoppedTurn`) used the same split, so all three take sites had it.

**6a choice: one crate authority.** New crate call `take_steering(actor, runId, root, trigger, limit)` checks, in ONE write transaction: the run is still live; no queued delivery for this Buddy in the thread carries a config (pick); then takes the unread page (`any_post` at a Buddy tool call, `owner_post` at a native hook / Stop hold). It returns a typed `taken | pick_queued | quiet`. The pick guard was removed from `steeredThread`; `takeOwnerSteering` and the `catchUpThread` steering call are gone. Why atomic holds: a post and its delivery run (with the pick config) are written in one transaction (`wake`), and SQLite serializes writers, so the take sees the post with its pick or not at all. Alternative considered: "never steer while the Buddy has any queued delivery in the thread". Rejected: that disables steering for every ordinary owner post, because each one queues a delivery. Rejected too: wrapping the old calls in a host lock. The poster is a different code path, so a lock would not cover it.

**6c choice: re-delivered as its own run (not "answered in-turn").** Reason: the backend cannot make a model answer. A tool result is always followed by a model step, but at the LAST tool call (often the reply's own `post`) the reply is already written, and the model typically ends. "Answered in-turn" would be a claim we cannot enforce. Rule: a take that includes an owner post stamps the run `steered_at`. At settle (complete, or failed for a delivery; not on an owner Stop), if the Buddy wrote no post in that thread with `created_at > steered_at` (ignoring `reply_failed` notices), the newest owner post it took gets the next attempt of its delivery, in the steered run's conversation, which holds all the steered text. A later attempt shows its trigger even though it is read (existing `compose` rule), and skips the follow-up gate. The fence now exempts `attempt > 1`: that attempt exists because its post was read, and without the exemption any later read in the thread cancelled it before it ran. That same exemption also stops a later read from cancelling an owner's queued retry (`retry_delivery`), which was the same latent hole. Owner posts only: re-delivering steered Buddy chatter could ping-pong between Buddies. The comparison is strict: a reply written in the same tool call as the take predates it. A later model step cannot fall in the same millisecond.

Cost: when a steered owner post is left unanswered, the owner gets one extra turn. When the turn did reply after the take, there is no extra turn. Schema: additive `run.steered_at TEXT` (`ensure_column`, so an older build still opens the file).

**6d.** The two thread-model tests now wait for the previous run's actual settle (`settled()`: no lead run `running`/`queued`) before the next owner post, with no sleeps. They no longer depend on the post landing after the reply's tool call has closed.

**Residual, not changed:** an explicit `channel_read {follow}` read (`follow_thread`/`catch_up_thread`) still advances the cursor without a pick guard. That is the model reading on purpose, not steering. Revisit if a pick is ever lost that way.

Revisit when: a harness gains a way to confirm the model handled injected text (then "answered in-turn" could be enforced), or the owner asks for picks to steer inline. That second case needs the pick to be stored outside the consumed run.

Evidence: mutation proof /tmp/steer-atomic/mutation-proof.log (copied to agent_notes/2026-10-08_steer-atomic-guard-evidence/). Loop and gate logs are listed in the same directory.

## Successor — 2026-10-08 ~10:30Z: rebased onto 4fcc0be; request-addressed messages keep their own take path

Decision-maker: assistant (implementation choice), on the lead's request post_01a11ae5-f852-7564-aa8f-1cb8855fb085. Status: proposed, on branch `fix/steer-atomic-guard` (rebased onto origin/main 4fcc0be, force-pushed branch only). The ~09:40Z section still holds unchanged; this records how it composes with 4fcc0be ("Message a live request's worker or parent", agent_notes/2026-10-08_request-addressed-messages.md).

**Question.** 4fcc0be's request messages also reach a live turn at its next tool boundary, through a three-step collector in mcp.ts: `pendingMessages` → show → `acknowledgeMessages` on the response's close. That is check-then-act like the old split steering guard. Should it be folded into `take_steering`?

**Choice: no fold; it cannot lose a pick or a delivery, and a crate test pins why.**
- No pick to lose: a message is refused if it carries `worker` (run config), mentions, a task, or kind request (`messages.rs require_plain`), and the owner cannot send one (`parent` refuses an owner request). Its receipt run is enqueued with `config: None`.
- No delivery to lose: `acknowledge` settles the exact run ids that were shown (and only still-`queued` ones of that conversation). It is not a cursor, so a message sent inside the window is not among them and stays queued for the next boundary or the idle turn. The steering race existed because the thread mark IS a cursor: one take covered posts the check never saw.
- The two paths do not fence each other: `take_steering`'s page and the thread fence skip addressed posts and runs (`not_addressed!`, `delivery_scope = 'thread'`), even when the take moves the shared mark past them. The conflict resolution keeps both conditions on the fence (`delivery_scope = 'thread' AND attempt = 1`), and adds `delivery_scope = 'thread'` to `pick_queued` and `redeliver_unanswered` for the same reason (no behaviour change today: addressed runs carry no config and no owner author).
- The worst case is a repeat, not a loss: two concurrent boundaries are deduplicated by the in-memory `offered` set, and a restart between show and acknowledge repeats a message once. That is 4fcc0be's stated at-least-once contract.
- Folding would couple two independent authorities (a per-thread cursor and per-conversation receipts) in one call for no lost case; rejected.

Message turns (an idle destination running a `Message` run) get no thread steering (`steeredThread` only steers `deliver`/`post` runs), so they never stamp `steered_at` and settle with no re-delivery; `after_settle` lists `Message` with the no-op arms.

**Migration order.** One order, the order the columns shipped: `delivery_scope` (4fcc0be), then `steered_at`. `RUN_TABLE` lists them in that order and `open` runs `ensure_column` in that order, so a fresh file and a migrated one agree. Both are additive; no rebuild.

Guard: crate test `a_request_message_sent_inside_a_boundary_window_is_never_lost` (tests/core.rs), mutation-proved: dropping `delivery_scope = 'thread'` from the fence, or making `acknowledge` settle every queued message, each fails it.

Evidence: agent_notes/2026-10-08_steer-atomic-guard-evidence/rebase/ (copied from /tmp/steer-atomic-rebase/).
