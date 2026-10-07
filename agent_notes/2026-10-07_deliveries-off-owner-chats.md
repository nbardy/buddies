# Deliveries stay out of owner chats: the background branch (implementation note)

Date: 2026-10-07. Author: Opus worker for Buddies Development Lead (request post_01a1153f-d634).
Task: task_01a1153f-9ad7-748e-b403-5ed9f05fb02f. Branch: `fix/deliveries-off-owner-chats` from
origin/main `0387ada`. NOT merged, NOT pushed.

Owner decision (ACCEPTED, 2026-10-07 07:23Z, #case-studies post_01a1153e-e5f3): "it should be out
of our chats should show up as background worker". The decision record is the last successor in
`2026-10-06_buddies-target-system-review.md`. Everything below is a **worker decision**, an
engineering choice, not an owner or lead decision.

## The three seams

1. **Where the subscription is redirected: at the write (route-at-send).** The grant carries
   `subscribes: 'self' | 'branch'` (grants.ts). `startTurn` sets `branch` when the turn runs under an
   admitted chat run, meaning the owner typed it. The MCP `post`, `answers` and `follow` handlers
   ask `subscriber(deps, grant)` (mcp.ts), which opens the branch on first use and returns its id as
   `fromConversationId` / the follow conversation. The crate is unchanged.
   - Rejected: redirecting only when the delivery runs. That would keep post provenance and handle
     legacy rows, but the delivery run is enqueued on the owner chat's id. Every delivery would wait
     behind the owner's running turn (`conversation_busy`), which is exactly what decision A's
     `owner_first` and Stop-cancel were managing. The subscription would also flip back to the chat
     at every post.
   - Rejected: a separate `subscriber` field in the crate's PostInput/AnswerInput. It keeps
     provenance, but it is a crate API and napi change for one link. Revisit if the owner wants a
     post's conversation link to open the chat rather than the branch.
   - Rejected: opening the branch when the owner's turn starts. Every owner chat would then list an
     empty worker.
   - **Cost:** a post the lead writes from an owner chat records the branch as its conversation, so
     its channel link opens the branch, which is where its replies run.
2. **Where the branch is created: `BuddyCreationService.openBranch`.** It uses a stable id
   (`stableConversationId('branch:' + chatId)`), Buddy kind `visibility: 'background'`, and
   `context.parentBuddyConversationId = chatId`. That field already existed in the schema and the
   records crate and was unused, so there is no schema change. It also sets
   `resumedFromConversationId = chatId`, so its first turn forks the chat's provider session
   (native when the harness supports it, otherwise the soft handoff), on the chat's config. An
   existing branch is reused as is: its creation fingerprint holds its first config. The runtime
   derives `parentConversationId` from that context field, so the row's `parent` is the chat after a
   restart too (app-created records load at boot).
3. **Which worker UI is reused: the chat's child rows.** The branch's row has `parent` = the chat,
   so `childRowsFamily(chat)` already lists it in the chat's Sub-agents panel (`SubAgentPanel`,
   desktop tree and mobile cards) with running/done. No new UI concept.

## Other changes

- **The branch never holds owner authority.** `runCoordination` gives `owner_input` only when the
  conversation is not a branch. B1 holds even when every delivered post is the owner's.
- **Legacy subscriptions** (decision A let owner chats subscribe themselves since 2026-10-06): a
  delivery whose subscribed conversation has a chat run runs in that chat's branch instead
  (`runner.ts outOfOwnerChat`). `bindRun` then moves the subscription, so this fires once per
  thread.
- **Removed:** `owner_first` (crate claim-gate clause, `RunWaiting::OwnerFirst`, two crate tests);
  `ownerStop` / `ownerStopped` / `cancelQueuedDeliveries` (runtime, turn policy, port, runner, WS).
  The WS Stop calls `stop()` again.
- **Left in place:** the `gate()` rule that an owner message waits for the previous run's settle.
  It still stops a chat turn starting without a run of its own, and `feat/durable-owner-messages`
  edits that code.

## Not done in this turn (honest status)

See the answer to post_01a1153f-d634 for the current list. At the time of writing: the client link
from the Sub-agents row to the branch, the collapsed rendering of legacy delivery inputs in owner
chat history (criterion 4), and the screenshots.

## Revisit if

- the owner wants the lead's posts to link to the chat (then option 2 above);
- one branch per chat proves too coarse (for example, two unrelated workers' answers interleave
  confusingly in one branch);
- the branch's single fork goes stale: it forks once, at its first turn, and later chat context does
  not flow into it.
