# WebSocket contract notes

The wire contract is defined in [shared schemas](../shared/src/index.ts).
[Conversation WebSocket handlers](../server/src/transport/conversation-websocket.ts)
apply commands; the client's single `handleMessage` dispatcher in
[actions.ts](../client/src/atoms/actions.ts) reconciles their results.

## Conversation IDs are opaque strings

Use `ConversationIdSchema` for conversation IDs and references in snapshots,
events, commands and durable metadata. Owner-created chats normally use UUIDs,
but the Buddy executor reserves `buddy-run-${run.id}` before dispatch so retries
keep the same destination. The config store encodes IDs for filesystem safety.

A UUID-only wire field rejects these valid saved threads. Because the client
validates the whole `hello`, one such thread discards every conversation on
reconnect; later stream events and owner controls fail the same validation.
The real team-chain regression in `server/test/buddy-coordination.test.ts` (deleted in T11 with the
delegation chain it tested) now
round-trips its snapshots, runtime broadcasts and owner commands through the
shared wire decoders. Review-document UUIDs retain their UUID contract.

## Protocol v4: typed bodies on the v3 row/patch layout

T09 introduced rows, patches, and bodies on demand in v3 (2026-09-25). V4 keeps that layout and
changes transcript messages from a `content` string to a typed `body`. The server sends no duplicate
`content` field. Old v3 tabs must reload before reading v4 frames.

| Server → client | Contract |
|---|---|
| `hello` | `protocol.version: 4`, `defaultCwd`, `loading`, `archivedBuddyIds`, and every conversation as a `ConversationRow` (id, kind, parent, resumedFrom, provider, cwd, label, createdAt, activityAt, messageCount, run, done). Rows travel encoded (`encodeRows`: each cwd and Buddy once per message); `decodeRows` rebuilds them. |
| `rows` | Upserts rows: startup batches, the disk poller, a creation seen by other sockets. |
| `removed` | Deleted ids. |
| `ready` | Startup hydration finished; `conversationIds` is the authoritative membership. |
| `patch` | `{id, patch: RowPatch}` — one field group: `run`, `done`, `label`, `activity`, `config` (with the setter's `commandId`), `queue`, `session`, `subagent`, `turn`. Row-level ones move the row; detail-level ones apply only where that detail is loaded. |
| `ack` | The one acknowledgement: `created` (with the new row, to the creating socket), `accepted` (queue/interrupt admitted), `rejected` (typed error; never a snapshot — the authoritative state goes out as a patch first). |
| `message` | `{conversationId, role, body}`. `body` is text or ordered typed parts (text, tool use, question, Buddy result/thread; a legacy `swarm_launch` part still decodes from old stored rows); renderers consume those parts without parsing marker text. |
| `chunk`, `message_complete`, `error`, `buddy_*`, `channel_changed` | Unchanged. |

Deleted: `init`, `conversations_updated`, `conversation_created`, `conversation_updated`,
`conversation_deleted`, `conversation_load_complete`, `status`, `session_bound`, `queue_updated`,
`subagent_start/update/complete`, `command_accepted`, `command_rejected`, and the client command
`send_message` (no caller).

Bodies and details load on demand: `GET /api/conversations/:id` (detail: config state, queue,
sub-agents, latest turn's observed model and usage) and
`GET /api/conversations/:id/messages?afterSeq=&limit=` (a `MessagePage`: `epoch`, `total`, messages
with seq > afterSeq, each with the same typed `body`). The epoch changes only when the server
REPLACED history (not an append), so a client refreshes a grown transcript by paging from its last
held message.

`create_conversation` carries `kind: {t:'chat'} | {t:'buddy', context} | {t:'fork', from}` — the one
kind encoding. A fork inherits its source's kind on the server.

**Version skew.** Every socket names its protocol in the upgrade URL. A v3 client facing a v4
backend gets close code `4426` with reason `protocol 4`, which shows its reload banner. A v4 client
facing an older v3 backend gets a skew state, keeps its rows, and reconnects until the backend
reloads. A v2 backend still greets with `init`; `classifyServerFrame` also treats that as skew.
Guards: `server/test/websocket-lifecycle.test.ts`, `client/test/protocol-skew.test.ts`.

## Pending commands are separate from server rows

`rowsAtom` contains server rows. New creations and config writes are commands in `commandsAtom`
(`atoms/commands.ts`); neither is a partial row. Config actions send the patch
and record pending state without overwriting the authoritative config optimistically; the `config`
patch carrying the command's id settles it.

Pending creations are in memory only since T19 (O5); a create lost to a full page reload keeps its
first message in `draft:<id>`. Preserve the original command and conversation IDs on
reconnect so retries stay idempotent. A matching `ack created` removes its pending record; a
rejection retains the error. Only retryable admission failures are automatically cleared for a new
connection.

On `hello`, the client reconciles pending creations with server IDs and clears pending config
commands from the previous socket epoch. A lost acknowledgement must not leave the UI saving forever.

## Rows are not transcripts

A row whose `messageCount` differs from a loaded transcript is how a client learns that history is
stale: the open conversation pages in its tail in place, any other loaded one does so when opened
(`bodiesStep` in `client/src/hooks/useConversationBodies.ts`, then `refreshTranscript`). The disk poller sends ONLY rows; until
2026-09-25 it pushed the full history (~400-500KB) of every still-growing external transcript to every
client every 5s. Guard: `client/test/summary-history-refresh.test.ts`.

`hello.loading` means historical loading is still in progress. The client keeps prior state while
batches arrive and marks completion on `ready`. Only WebSocket `create_conversation` bypasses the
startup barrier and is admitted while the server is `starting`. Other WS commands wait for that
barrier. HTTP mutations return `503 server_starting` until the server is `idle`. See
[architecture](architecture.md) for lifecycle ownership and failure behavior.

Every command takes its shutdown slot (`beginCommand`) BEFORE awaiting the barrier: the slot is
what the shutdown coordinator counts as active work. Until 2026-09-25 the barrier was awaited
first, so a parked command was invisible; a dev reload requested while `starting` exited the
backend as soon as startup completed, and a `queue_message` typed during boot woke into
`reloading` and was rejected with `server_draining`. Holding the slot keeps the backend `idle`
until the command finishes. The barrier also means "startup is over", not "succeeded": a
failure or SIGTERM during boot resolves it too, so only a backend that reached `idle` runs
commands on existing history. Guard: `a command parked on the startup barrier runs before a
reload queued during startup`.

A message command whose conversation is not held is REJECTED, never accepted: the composer
empties on submit, so accepting a message the server never admitted discards the text silently
(the old `registry.get(id)?.enqueue(...)` + unconditional accept did exactly that).

## Replay of `create_conversation` can send `ack created` THEN `ack rejected`

When a client re-sends `create_conversation` for an id the server already
holds (a reconnect replay), the server answers `ack created` as soon
as the config replay matches, and only THEN runs `dispatchInitialMessage`.
Dispatch rethrows Buddy-authority rejections, so the client can receive
`ack created` followed by `ack rejected` for the same
`commandId`. The conversation does exist in that case — only the initial
message was refused — so the client keeps the row it received with
`ack created` (v3 rejections carry no conversation snapshot).

Until 2026-09-06 that rejection, and a deleted-id tombstone, were both
reported with the fingerprint-mismatch text "Conversation ID already exists
with different configuration", so a refused Buddy message read to the user as
a config conflict on a conversation they had just been told exists.
`replayFailureMessage` in `server/src/transport/conversation-websocket.ts`
now picks the message by error type (`ConfigRevisionConflictError` →
mismatch text, `ConversationTombstonedError` → its own message, anything else
→ the failure's message). Guarded by
`server/test/buddy-conversation-contract.test.ts` ("replaying
create_conversation reports the real failure").

### Archived Buddy visibility

`init.archivedBuddyIds` supplies durable archived identities before conversation
views render. `buddy_archived` updates the same client atom through the existing
message spine. All conversation collections and per-ID views filter those owners,
so a late conversation snapshot cannot resurrect a hidden thread. Archival does
not tombstone transcripts. Existing-thread commands and inherited Buddy forks
reject archived owners server-side; public Buddy projections and deep search
omit them. The owner Settings DELETE disables schedules and cancels active runs.

## Message commands acknowledge AFTER admission work — composers must send optimistically

`queue_message` and `interrupt_and_send` carry a `commandId` and the server
answers with `ack accepted` / `ack rejected` (see `pendingMessageCommands`
in [actions.ts](../client/src/atoms/actions.ts)). But the ack is written only
after `ensureReady` (records-store read) AND the full
turn-spawn setup in `Conversation.sendMessageInternal` (Buddy store reads,
coordination claim, MCP matching, audit, child-process spawn) — see the
`queue_message` / `interrupt_and_send` cases in
[conversation-websocket.ts](../server/src/transport/conversation-websocket.ts).
On a loaded box that round trip takes seconds, and every feature that adds
per-turn setup makes it slower.

Until 2026-09-19 both composers (`Chat.tsx`, mobile `ComposerMobile.tsx`)
gated their UI on that round trip: the textbox cleared and Send re-enabled
only after the ack resolved. The result was a frozen composer — text stuck in
the box, Send busy and unclickable — that "sent" seconds later. The invariant
going forward:

- Clear the composer synchronously on send; never disable the textbox or Send
  on the outstanding ack. The queue strip carries the in-flight state.
- A rejection restores the draft text and surfaces the error — the
  retain-on-reject half is guarded by `client/test/message-command-ack.test.ts`
  ("draining rejection rejects the exact queued command so the composer can
  retain text").
- The clear must be synchronous on both the draft ref and the textarea DOM
  (`useConversationDraft.clear()`), otherwise a second Enter before the ack
  re-reads the old text and double-sends. Pending files stay in the tray until
  the ack so a failure keeps them.

Do not reintroduce an `isSubmitting`/`sending` flag that disables Send across
the ack wait. Do not move `sendCommandAccepted` ahead of admission to "fix"
the latency instead: the ack is the admission guarantee, and an ack followed
by a silent enqueue failure loses the user's message.

## Interrupt keeps the queue; Send-now promotes within it

Queue commands (`queue_message`, `interrupt_and_send`, `cancel_queued_message`,
`clear_queue`, `promote_queued_message`) all funnel into
`Conversation.enqueueMessage` / `interruptAndSend` / `promoteQueuedMessage` in
[runtime.ts](../server/src/conversations/runtime.ts), over the pure
[TurnQueue](../server/src/turns/queue.ts). The semantics, settled
2026-09-19 after interrupt silently discarded queued work:

- `interrupt_and_send` stops the active turn and sends the new message FIRST.
  Pending queued work is KEPT in order behind it. Only the killed turn's
  in-flight head is retired — and that retirement is load-bearing, not
  cleanup: the close handler consumes a `sending` head on its own, so a stale
  entry left behind strands everything after it (`processQueue` skips
  `sending`). `retireInFlightHead` exists for exactly this.
- `promote_queued_message` moves one pending message to the front and
  interrupts the active turn so it runs next. Unknown/non-pending ids are a
  no-op, like cancel. Fire-and-forget (no `commandId`); the `queue` patch is
  the confirmation.
- "Stop everything" is `endConversation` = `clear_queue` + `stop`, not bare
  interrupt. Do not re-add flushing of pending items to `interruptAndSend`:
  Clear is the destructive action; Interrupt is preemption with the queue
  intact. Guarded by `conversation-runtime.test.ts` ("interrupt keeps the
  pending queue", "promote moves a pending message first").

## `buddies_changed` is a debounced "something changed", not a diff

Every Buddy write runs in this process through the Rust core
(`crates/unleashd-buddies`, wrapped by `server/src/buddies/core.ts`) and
announces a `changed` event on the Buddy event bus (`buddies/events.ts`);
`server.ts` folds a burst into one `buddies_changed` event per 250ms. The event carries no
payload on purpose: the client refreshes its mounted Buddy views from cache
keys, and a payload would only tempt a second, per-event code path. Reads
(`get_*`, `list_*`, `recall`) never announce; a Buddy polling its inbox must
not make every open panel refetch.

`channel_changed {channelId}` is the exception. Three channel writes bypass all
three doors: the responder posts a mention reply straight to the store, posts a
`reply_failed` notice the same way, and keeps who is replying only in its
in-memory queue. So `server.ts` broadcasts `channel_changed` from the channel
post feed (`onChannelPost`, which every post door announces to) and from the
responder's `channelChanged` port (a queue entry added or removed, or a failure
notice written — a notice is not announced as a post, because announcing asks
the thread's other Buddies to follow up). `listId` only picks which cache keys
to refresh, and the client refreshes the channel list with them because its rows
count every post, plus any mounted Task-filtered feed (`/api/buddies/tasks/<id>/posts`),
which spans channels; there is still one refresh path. It is not debounced: the
client's in-flight join already folds a burst.

## Liveness

A laptop that slept, or a connection the dev port proxy holds open after the far end vanished,
leaves a half-open socket: no FIN arrives, neither side sees `close`, broadcasts go nowhere, and
the client never reconnects (reconnect is the only path to a fresh `hello` and resent pending
creations). `superviseLiveness` (server/src/transport/websocket.ts) pings every 20 s and
terminates a peer that did not pong since the previous ping; a browser answers pings at the
protocol level. Two ways a LIVE peer misses a pong, both found in review of 4d2b990: our own event
loop stalled (the overdue tick runs before the poll phase reads a pong that already arrived, so a
late tick is our fault), or a slow link is still downloading a large frame and our ping sits
behind it (a shrinking send buffer means bytes flow). A half-open socket shows neither. Guards:
`liveness terminates a half-open peer and keeps a responsive one`, `liveness does not terminate a
responsive peer when the server loop stalls`.
