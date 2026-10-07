# Client state patterns

The state core is [atoms/conversations.ts](../client/src/atoms/conversations.ts)
(atoms), [atoms/actions.ts](../client/src/atoms/actions.ts) (the WS spine and
reads) and [atoms/commands.ts](../client/src/atoms/commands.ts) (client-owned
commands). Components call exported actions; all `jotaiStore.set` calls stay
inside `client/src/atoms/`. Design: `06-target-client.md` §1 (T19).

## The atoms

Base:

| Atom | Holds |
|---|---|
| `connectionAtom` | `{ socket: connecting \| open{send} \| closed, server: unknown \| skew{version} \| v3{defaultCwd, loadComplete} }`. A send while not open is a typed outcome (`sendNow` → `'closed'`), never a silent drop. |
| `rowsAtom` / `rowFamily(id)` | List rows (protocol v3), one atom per id (`keyedAtoms`). `null` = the client does not hold it. Archived Buddies' rows are dropped at ingestion, so no reader filters them. |
| `transcriptFamily(id)` | `absent \| loading \| loaded{epoch, messages, detail} \| failed{error}`. Read with `messagesOf` / `detailOf` / `queueOf` / `subAgentsOf` (stable empty fallbacks). |
| `streamFamily(id)` | Live text of one streaming reply. |
| `commandsAtom` | In-flight `create` / `set_config` / `send` commands, keyed by commandId. In memory only; a hello resends creates with their original ids. |
| `prefsAtom`, `seenAtom` (`atoms/ui.ts`) | Device-local prefs (read `useAtomValue(prefsAtom).field`) and last-seen message index per conversation. |
| resource cache (`atoms/resources.ts`), outbox (`channel-outbox.ts`) | Unchanged. |

Derived:

| Atom | Gives |
|---|---|
| `listIndexAtom` + `listField(key)` | ONE pass over the newest-first list: `order`, `idSet`, `recentDirs`, `latestCwd`, `inbox`, `gallery`, `childrenOf`, `folders`, `runningByFolder`, `buddyEntries`, `builders`, `buddyThreads`, `workspaceActivity`, `workersByProject`. Each field keeps its identity while its content is unchanged; subscribe to the field, not the index. |
| `groupsFamily(id)` | Chat response blocks including live text (tail regroup). |
| `commandFor(id)` | `{ create, config }` in flight for one conversation. |
| `unreadFamily(id)` | The NEW badge (`row.messageCount` past `seen[id]`). |
| `childRowsFamily(id)` | Child-session rows for the sub-agent panel. |
| `buddySidebarAtom` (`buddy-sidebar.ts`) | Buddy projects, groups, count and channel rows (roster ⨝ `buddyEntries`). |
| `swarmWorkersByProjectAtom` (`swarm/swarm-workers.ts`) | Worker rows per project root, over `workersByProject`. Swarm code only. |

## Subscriptions

| UI needs | Subscribe to |
|---|---|
| One conversation's row | `rowFamily(id)` |
| A sorted or filtered collection | A field of the list index: `listField('inbox')`, `listField('folders')`, … |
| "Can I link to this conversation?" | `listField('idSet')` (AGENTS.md Link rule) |
| Chat blocks / live text | `groupsFamily(id)` / `streamFamily(id)` |
| Bodies, detail, queue | `transcriptFamily(id)` through `useConversationBodies(id)`, which also loads it |
| Pending creation or config command | `commandFor(id)` |
| Connected? load complete? default cwd? | `connectionAtom` (`loadCompleteOf`, `defaultCwdOf`) |
| The active conversation | The route (`/chat/:id`); nothing persists it |
| Persisted UI preference | `useAtomValue(prefsAtom).field` |
| Any read-only server view (Buddy panels, swarm runs, catalog, git log) | `usePolledFetch` over the keyed cache in `atoms/resources.ts` |
| Buddy directory / detail | `useBuddyOverview`, `useBuddyDetail`, `useBuddyPage` in `hooks/useBuddyData.ts` — both shells |
| A Buddy page's derived model + `talk` / open-project actions | `useBuddyPage` in `hooks/useBuddyData.ts` — the shells only render |

Never call `useAtomValue(rowsAtom)` in a component. For lists, subscribe the
parent to a list field of ids and have each row subscribe to its own
`rowFamily(id)`, wrapped in `React.memo` with stable callbacks, so an event
re-renders only the row it is about. Sidebar (`SidebarConversationRow`) and
Gallery (`GalleryCard`) are the models. A component that needs only "are
there any conversations?" reads `listField('idSet').size` — never `order`,
which moves on every re-sort (the isolation test caught Chat doing that).

### An event costs what it changed (2026-09-25, T05 → T19)

There are ~1,200 conversations in real use, and every event (status, queue,
message, each 5 s poller batch) used to run ~10 full-list passes and re-render
the open Chat for whichever conversation it was about. Work now follows the ids
an event touched:

- **Per-id records.** `rowsAtom` is a `keyedAtoms` store
  (`atoms/structural.ts`): one primitive atom per conversation, and a write sets
  only the ids it touched. Transcripts and streams are keyed the same way.
- **One list index.** `atoms/conversation-index.ts` keeps a
  `ConversationListEntry` per conversation (only the fields views filter, group
  and sort on) and one newest-first list. A write rebuilds entries for the
  touched ids only and moves a changed one by binary search. `buildListIndex`
  then derives every collection view in one pass, and `reuseUnchangedFields`
  hands back the previous reference for each field whose content is equal.
  Queue, sub-agent and streaming events never touch the list.

If a view needs a field the entry lacks, add it to `ConversationListEntry`
(`buildEntry` and `sameEntry`), then add the view as a `ListIndex` field.
Per-directory facts (`folderGroupKey`, worktree and temp checks) come from
`directoryFacts(dir)`, which runs each regex once per distinct directory.

`client/test/conversation-event-isolation.test.tsx` guards this. It renders Chat
for B, records every atom Chat reads, then drives events for A through
`handleMessage`. It fails if any of those values changes (which would re-render
Chat), if an atom labelled for B recomputes, or if a queue, sub-agent or stream
event recomputes a collection view. Label new per-id atoms `name:<id>` so the
test covers them. `client/bench/conversation-event.bench.ts` times one event at
1,200 conversations (numbers in the T05 and T19 reports).

Other rules for per-item work:

- The kind accessors read `row.kind` directly; the wire schema already
  validated it. Do not re-add a zod parse on that read path.
- A component that needs a conversation only inside an event handler (the
  gallery's message search, the sidebar's "seed from latest thread") calls
  `readConversation(id)` from actions at that moment instead of subscribing.

## Mutations and state ownership

Row writes go through `putRows` / `removeConversations` in actions.ts, which
patch `rowStore` for the named ids only. Never replace the whole map from an
event. Transcripts go through `putTranscript`; streams through the chunk
buffer. Add a separate atom for new high-frequency state and document its
clearing or commit boundary; do not put it into the row.

Commands (`commands.ts`) are client-owned and never fabricate a row: a pending
create lives in `commandsAtom` until its `ack` carries the rows. A hello
rejects in-flight sends (the composer keeps its text), drops config commands
(revision-checked; their result is in the detail) and resends creates the
server does not hold with their original ids; a create rejected with
`server_draining` / `server_starting` becomes `sent` again, any other
rejection stays failed (`client/test/pending-creations.test.ts`).

Restart recovery is deliberately client-owned. Non-empty queue patches are
mirrored under `restartRecovery:{conversationId}` in localStorage; an empty
queue does not erase them because that is also what a replacement server
reports after losing its runtime queue. A successful `message_complete`,
explicit dismissal, or conversation deletion clears the mirror.

[actions.ts](../client/src/atoms/actions.ts) owns the single WebSocket message
spine. See [WS contract notes](ws-contract-surprises.md) for replay and
reconciliation.

## Streaming and hydration boundaries

`chunk` frames skip the full ServerMessage Zod parse: `parseServerFrame`
(`hooks/useWebSocket.ts`) checks the type tag and two string fields, and every
other frame still gets the whole schema (`stream-frame-validation.test.ts`).
Chunks accumulate in a buffer outside React state; the animation-frame flush
writes only `streamFamily(id)`. Never append chunks to the transcript. The flush
also has a 100 ms timer, because a hidden tab never gets an animation frame and
the server sends every conversation's chunks to every tab: before 2026-10-08 a
background tab buffered them without bound (`chunk-flush-hidden.test.ts`).

A frame rebuilds only the last message group (`withStreamingTail` in
`utils/chat-message-groups.ts`); every earlier group is the settled object, so
`TranscriptGroup` (memoized on group identity) skips it. Settled groups
recompute only when the records array changes, and an appended record
regroups from the last group (`regroupChatMessages`). Until 2026-09-25 each
frame regrouped the whole transcript and replaced all ~300 groups of a
600-record chat. `client/test/chat-message-groups.test.tsx` checks group
identity across frames and compares the incremental regroup with a full pass
for every prefix of random transcripts.

`message_complete` flushes buffered chunks synchronously and folds the
streamed text into the last assistant record, as the server did; a `run`
patch that leaves `streaming` clears the stream atom.

Bodies load on open. `useConversationBodies(id)` is the only caller:
`bodiesStep` says `load` for an absent transcript and `refresh` for a loaded
one whose length differs from the row's `messageCount` (an external CLI wrote
to it, or a `message` event was missed). `refreshTranscript` pages in only the
last held message and after, keeping the history on screen; a moved epoch
reloads it. The WS spine never fetches bodies, so a count moving on a chat
nobody shows costs nothing (`summary-history-refresh.test.ts`).

Loaded transcripts are capped: past `LOADED_TRANSCRIPT_LIMIT` (24, above the
prefetch's 12) the least recently written one returns to `absent` and its
derived groups are released, and `bodiesStep` reloads it if it is opened again.
The one just written, a streaming reply and an in-flight load are pinned. Until
2026-10-08 a tab held every chat it had opened until the socket reconnected
(`transcript-eviction.test.ts`).

## Server resources: one keyed local store

Conversations arrive over the WebSocket and live in `rowsAtom`. Every
OTHER read-only server view — Buddy panels, swarm runs, git log, usage — goes
through the keyed cache in
[atoms/resources.ts](../client/src/atoms/resources.ts), read via
`usePolledFetch`. Desktop and mobile share it; there is no second mechanism.

A `Resource<T>` is `{ key, load(signal) }`. The key is the identity of the
DATA, not of the component asking:

```ts
usePolledFetch<Overview>('/api/buddies/overview', 30_000);        // URL is the key
usePolledFetch(resource(`buddy-detail:${buddyId}`, load), 0);     // multi-request load
```

Why this and not component `useState`:

- **Remount is free.** A cached key renders immediately and revalidates behind
  the scenes. `loading` is the state only when there is genuinely nothing to
  show, so navigation never blanks — the mobile "every page makes me wait" symptom.
- **One request per key.** Two panels on the same key share one fetch.
- **Cross-key races are unrepresentable.** A late response for buddy A lands on
  buddy A's key; a component showing buddy B reads B's entry and cannot see it.
  This replaced three hand-rolled "is this response mine?" guards
  (`RoutedBuddyData` in `useBuddyDetailData`, `live.data.key === result.key` in
  `BuddyTeamConfiguration`, `data.cursor === cursor` in `BuddyTaskComments`).
  Do not add a fourth — put the varying input in the key instead.
- **The effect keys on the KEY, not the source object**, so an unstable inline
  resource no longer refetches every render.

The cache entry is a sum, not `{data, loading, error}`, and `usePolledFetch`
hands the same sum to the view (`PolledState` in
[hooks/usePolledFetch.ts](../client/src/hooks/usePolledFetch.ts)), with the
value as `data` on every variant:

| Variant | Meaning | The view shows |
|---|---|---|
| `idle` | no resource requested (disabled / null source) | nothing |
| `loading` | first load, nothing cached | its loading state |
| `ready` | value in hand | `data` |
| `failed` | failed with nothing cached | its failure, in place of the page |
| `stale` | failed refresh over a value we still hold | `data`, and the failure as a notice |

`error` exists only on `failed` and `stale`, so reading it means naming which
one. Render the page from `data`; replace it only on `failed`. Until 2026-09-25
the hook flattened this to `{data, loading, error}`, one `error` field for both
failures, and views that tested `error` before `data` threw away pages they
held: on 2026-09-24 one "Failed to fetch" on a slow server replaced a loaded
Buddy page on the phone with "Could not load buddy", and the desktop directory
(one failed Sidebar poll of the shared overview key), team settings, swarm
reviews and the mobile Automations tab blanked the same way. A stale page says
so quietly (`MobileRefreshNotice` on mobile, a "Could not refresh" line under
the heading on the desktop Buddy page). Guarded by
`client/test/failed-refresh-keeps-page.test.tsx`.

`stale` is also why `useSwarmProjects` no longer keeps a `prevProjectsRef`
shadow copy: retaining the last-known value across a failed refresh is the
cache's job, and the error is still reported rather than silently swallowed.

A successful refresh is **structurally shared** with the value it replaces
(`settledEntry` in resources.ts): an equal answer writes nothing, so no
subscriber re-renders, and a changed answer keeps the identity of every part
that did not change. Array elements pair by `id` when they have one, because a
"latest 50" window shifts every index on each new post. Until 2026-09-25 every
poll handed React a fresh tree, and an open channel re-rendered all 50 rows
and re-parsed their markdown every few seconds with nothing new. Keep derived
values keyed on `data` identity (`useMemo(..., [feed.data])`, `memo` on heavy
leaves such as `ChannelMarkdown`) so the sharing reaches the DOM.

Every owner feed pages back by keyset through one hook, `useChannelFeed` in
components/buddies/channel-data.ts, over a `PostFeed`: a channel's posts, a
thread's replies, or a Task's posts across channels (the Task filter and the
Mailbox reader's Task chips). All three routes answer the same query
newest-first (`limit`, `before=<post>`, `from=<post>`; server
`channel-pages.ts` `readFeed`). A feed reads its newest page until the reader
nears the top, then reads `from=<oldest loaded post>` down to the newest, so
the window grows at the bottom and never slides. Re-reading the newest page
after paging back would push the oldest post out above the reader on every new
post and leave a gap between the pages. The switch to the new key is seeded
(`seedResource`) with the posts already held plus the fetched page, so it
renders without the loader and revalidates behind it. Paging state belongs to
the feed it paged: picking another Task starts that feed from its newest page.

A thread reads the other way up (root on top, oldest reply first) but pages
the same way: it opens on its newest replies and pages back toward the root,
which comes with every read. A reply permalink (`post=`) opens the thread
`from=` that reply instead, or a reply older than the newest page would not
render. The Mailbox reader lists newest-first with its composer below, so it
asks for older posts with a button (`OlderPostsButton`) rather than on reach.
Until 2026-09-25 a channel read its newest 50 posts, a thread its first 200
replies and a Task filter one page, and nothing past them was reachable.

Every Buddy read model is declared once in
[hooks/useBuddyData.ts](../client/src/hooks/useBuddyData.ts) and consumed by
both shells. `BuddiesDashboard` (desktop) and `BuddyDetailMobile` used to each
carry a private copy of the three-request detail assembly plus generation
counters; the Sidebar, SearchPalette, BuddiesMobile and BuddiesDashboard each
fetched `/api/buddies/overview` their own way. Now they share one key each.
The same applies to `useProviderCatalog` (was a hand-rolled
`useSyncExternalStore` cache) and `useSwarmRuntimeSnapshots` (one swarm view
per screen since T20, so one caller per page). If you add a Buddy read,
add it there — not as a `fetch` in a component.

`useBuddyPage` goes one step further: the memos and `talk` that both shells derived from the detail bundle live
there once. Its one consumer is `components/buddies/BuddyPage.tsx`, the single
Buddy page view both trees mount (T20, 2026-09-26). The shell picks
`layout: 'wide' | 'narrow'` and passes its own `openConversation` (mobile
threads route state through it); the view never asks which device it is on.

Push invalidation (`invalidateResources`) refreshes MOUNTED keys only. A remount
always revalidates, so touching retained-but-unmounted keys would only turn a
burst of WS events into a request storm against every cached Buddy.

Keys are retained up to a bound (LRU, mounted keys exempt) so a long-lived PWA
session cannot grow without limit, and the per-key atom is removed on eviction.

### Prefetching and push invalidation

`init` ships conversation SUMMARIES, so the first open of each chat costs a
round trip. [atoms/prefetch.ts](../client/src/atoms/prefetch.ts) warms the most
recent chats once the server reports its load complete — idle-scheduled and
concurrency-bounded, because a burst of parallel GETs from a phone is slower
than a lazy load. It reuses `loadConversationDetails`, so a warm request that
collides with the user opening that chat joins it rather than racing it.

`invalidateResources(predicate)` re-runs the loaders for matching MOUNTED keys
in place, so subscribed panels update with no spinner. While the tab is hidden it
does nothing: `usePolledFetch` refreshes every mounted key when the tab becomes
visible, and a hidden tab used to refetch and re-diff on every push all night. `invalidateBuddyResources()`
is the named predicate for Buddy data. It fires from the WS spine on
`buddies_changed` — the server's debounced change feed
(the Buddy change bus in `server/src/server.ts`), which announces every Buddy-store write
whether it came from an owner route, an owner MCP tool, a Buddy's MCP tool or
the scheduler — and on create/delete of a Buddy-context conversation, which the
client already knows about. `channel_changed {channelId}` is the precise one:
`invalidateChannelResources` refreshes only keys under
`/api/buddies/lists/<listId>/` (posts, threads, who is replying) plus the
channel list, whose rows count and sort by every post, and any mounted
Task-filtered feed (`/api/buddies/tasks/<id>/posts`, cross-channel, so `listId` cannot
select it), so channel views poll
just as a 30 s backstop (`CHANNEL_BACKSTOP_MS`). An invalidation
that lands while that key's load is in flight marks it to load once more when
it settles, because the running request may have read the server before the
change. **Add new push refreshes here, not at call sites** — that is the whole
reason the cache is keyed centrally.

## Assistant response model

`Message` records are provider transcript fragments. The derived
`groupsFamily` projects consecutive assistant records into one
`AssistantResponse`: ordered content/tool parts, original records, and full
`copyText`. The response is one virtual item, one message container, one heading,
and one Copy action. User or system records end it; completion metadata and
interactive widgets do not. Every prose part remains visible. Consecutive tools
collapse within the response and preserve their full inputs.

Desktop chat, worker chat panes and mobile consume this same projection. Live
embedded tool lines and hydrated separate tool records normalize to the same
part types. The projection never rewrites persisted records or commits stream
buffers into the conversation snapshot.

## Rendering markdown and long threads

Chat (desktop and mobile) and channel text render through
[utils/markdown-pipeline.ts](../client/src/utils/markdown-pipeline.ts), never
react-markdown's `<Markdown>` component. `<Markdown>` builds and freezes a new
unified processor on every render, re-running every plugin attacher; opening a
1,099-message conversation on mobile blocked the main thread 1,321ms (4x CPU,
2026-09-25), ~391ms of it `freeze()`. Declare a `defineMarkdownFlavor(...)` as a
module constant, take the pipeline from `useMarkdownPipeline(flavor)` and call
`renderMarkdownCached(pipeline, text, components)` for settled text. Finished
hast trees sit in an LRU keyed by pipeline and text, bounded by entry count AND
total source characters, so remounted rows skip parse and highlighting. The
message a streaming turn is still growing MUST use `renderMarkdownLive` instead:
each animation-frame flush is a new string, and caching those retained a tree
per prefix (334MB heap for one 18KB reply, 2026-09-25) and evicted every settled
tree. The response row that knows the turn is live picks the renderer for its
last part. The pipeline turns raw HTML into text and applies the URL policy
before a tree is cached. Cached trees are shared, so never mutate a `node`
passed to a component override — outside production builds they are
deep-frozen, so a mutation throws. `client/test/markdown-pipeline.test.tsx`
keeps the output byte-identical to `<Markdown>` and guards both cache bounds.

Desktop virtualizes the message list. Mobile keeps a flat scroller for iOS
momentum and mounts groups from a pinned first index: the newest 30 when the
conversation opens, 30 more per "Show earlier" (keeping the reader's distance
from the bottom). New groups append below without unmounting the top one — a
count-from-the-end window did, which shifted content above the reader on Safari
(no scroll anchoring).

Only the two list CONTAINERS differ. Both render the same row view,
`views/transcript/TranscriptGroup`, and pick where a row's actions live with
`presentation`: `hover` (desktop, Copy revealed on hover/focus) or `footer`
(mobile, time plus a permanent Copy pill, since touch has no hover). The
markdown overrides (file previews, code copy, LaTeX delimiters) live beside it
in `views/transcript/markdown-components.tsx`.

## Persisted UI state

[atoms/ui.ts](../client/src/atoms/ui.ts) holds device-local preferences and
NEW-badge seen indexes in `localStorage`; none of it syncs. Subscribe to
per-field atoms and mutate through exported actions, never the slice atoms.
Facts about a conversation belong on the conversation, not here: done/hidden is
`conversation.done`, owned by the server record and changed with
`set_conversation_done`. See [mobile view tree](mobile-view-tree.md) for the
fields and why the synced blob was retired.

## Shared view helpers

- Relative times ("3m ago"): call `useTimeTick()` (`hooks/useTimeTick.ts`) in the
  component that renders the label. It is one 30 s clock for the whole app.
  A tick in a parent does not reach memoized rows, which is how the mobile chat
  list's times went stale.
- Display paths: `shortenHomePath()` from `utils/directories.ts`, never an
  inline `/^\/Users\/[^/]+/` regex. It is for display only.
- Swarm workers: `swarmWorkersByProjectAtom` in `swarm/swarm-workers.ts`
  (`.get(root) ?? NO_WORKERS` for one project; grouped by project root,
  promoted workers excluded). Do not regroup
  `isWorker` conversations in a component.

## Hook ordering and stable values

All hooks must run before any early return. Guard unavailable data inside a hook
callback, then return a loading/empty state after the hooks. Keep fallback arrays,
objects, and sets as module constants so missing data does not allocate a new
subscription value every render.

Before committing, check per-conversation subscriptions, derived collection
views, isolated streaming state, stable fallbacks, and hook order. Run
`pnpm check:client-invariants` plus the relevant client checks from
[test strategy](test-strategy.md).
