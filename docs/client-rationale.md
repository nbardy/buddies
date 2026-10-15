# Client rationale

Long reasons moved out of client code comments. Each code site keeps a
1-3 line summary and points here by anchor.

<a id="polled-fetch"></a>
## usePolledFetch: a view over the keyed cache

From `client/src/hooks/usePolledFetch.ts`.

Read a server resource into the shared keyed cache (`atoms/resources.ts`).

This hook owns no data. It subscribes to one cache key, asks for a refresh
when appropriate, and hands back the cache variant as a {@link PolledState}.
Consequences worth knowing:

  - Remount on a cached key renders instantly and revalidates behind the
    scenes. `loading` is the variant only when there is genuinely nothing
    to show, so navigating back to a page no longer flashes a spinner.
  - A failed refresh never takes data away: it is `stale`, which still
    carries `data`. Render the page from `data` and the failure as a notice.
  - Two components on the same key share one request and one entry.
  - Stale-response races are structurally impossible. The old hook needed
    abort-on-source-change so the SLOWEST response could not win; a keyed
    cache is stronger — a late response lands on its own key, which whoever
    switched away is no longer reading. In-flight requests are therefore
    allowed to finish and populate the cache (that is prefetch).
  - The effect keys on the resource KEY, not on the source object's
    identity, so an unstable inline fetcher no longer refetches every render.

Retained from the pre-cache hook: pause/resume on `visibilitychange` for a
backgrounded PWA, and an immediate refresh on WS reconnect once the init
snapshot has landed.

NOT tanstack-query — one Map in a jotai atom plus setInterval.

@param source - fetch URL, a keyed {@link Resource}, or null to disable
@param intervalMs - polling interval in ms. 0 fetches on key change only.
@param enabled - when false, no fetch and no interval (default true)

<a id="polled-source"></a>
## PolledSource: URL or keyed Resource, never a bare fetcher

From `client/src/hooks/usePolledFetch.ts`.

A poll source is either a plain URL (the common case — one GET per cycle) or
a {@link Resource} for callers that issue multiple requests per cycle (e.g.
one fetch per project root) and merge them into a single T.

A bare fetcher function is deliberately NOT accepted: without a key there is
no identity to cache under, and the un-keyed form is what forced call sites
to hand-roll "is this response for what I'm showing?" guards. Wrap one with
{@link resource} and give it a key derived from its inputs.

<a id="polled-state"></a>
## PolledState: failed vs stale are different variants

From `client/src/hooks/usePolledFetch.ts`.

What a polled view renders from: the cache variant itself, with the value
it holds surfaced as `data` on every variant (null where none is held).

A sum, not the `{data, loading, error}` this hook returned until 2026-09-25.
That product put a first load that failed and a background refresh that
failed into the same `error` field, so a view that tested `error` before
`data` swapped a page it was already showing for its full-screen failure:
on a slow server one "Failed to fetch" replaced a loaded Buddy page on the
phone with "Could not load buddy" (2026-09-24), and the Buddies directory,
team settings and swarm reviews blanked the same way. Here the two are
different variants, and `error` exists only on them, so reading it means
saying which one you mean:

  failed — nothing to show; the error IS the view.
  stale  — `data` is still the view; the error is a notice beside it.

<a id="conversation-draft"></a>
## useConversationDraft: one draft path for both composers

From `client/src/hooks/useConversationDraft.ts`.

Portable draft persistence + focus — merging desktop Chat.tsx and mobile
ComposerMobile.tsx into one clean path.

Both trees previously drove `localStorage` key `draft:{conversationId}`
independently:
 - Desktop (Chat.tsx): uncontrolled textarea via ref callback, `draftValueRef`,
   `saveDraft` reading refs, `textarea.focus()` in attach callback.
 - Mobile (ComposerMobile): controlled `draft` state + `draftRef`/`draftKeyRef`
   + debounced `writeDraft`, flush on `useEffect` cleanup.

Mobile documented the subtle stale-closure bug: an effect keyed on
`[conversationId, draft]` closes over the *previous* draft (`''`) and its
cleanup deletes the key the load just read — silently eating forked drafts.
Fix: `writeDraft` reads refs, never state.

This hook is the canonical implementation:
 - Storage reads/writes go through refs (never state closure).
 - Debounced write (500ms) + flush on `pagehide`, `visibilitychange`, and
   effect cleanup (conversation switch / HMR unmount).
 - Applies draft to textarea and auto-heights, then restores focus without
   stealing focus from another input. HMR-safe: uses `useLayoutEffect`-ish
   timing via `requestAnimationFrame` so Vite Fast Refresh patching Chat.tsx
   without a DOM unmount still re-focuses.

Portable: both Chat.tsx (desktop, maxHeight 300) and ComposerMobile
(mobile, maxHeight 120) consume this. `controlled` mode drives React state;
`uncontrolled` mode writes directly to `textarea.value` (desktop).

<a id="composer-submission"></a>
## useComposerSubmission: a submission is a value addressed to its conversation

From `client/src/hooks/useComposerSubmission.ts`.

useComposerSubmission — the one send path for desktop Chat.tsx and mobile
ComposerMobile.tsx. Do not reintroduce per-shell send/restore handlers.

A submission is a VALUE addressed to the conversation it came FROM. It is not
re-derived from whatever composer state happens to be on screen when the
server finally answers. Two 2026-09-20 defects came from the older shape and
are unrepresentable against this type:

 - Taking a submission clears text AND attachments together, so the composer
   is genuinely `empty` afterwards. Previously only the text was cleared, so
   `pendingFiles.length > 0` kept both the empty-guard false and the Send
   button enabled: an attachment with no text was queued twice by clicking
   again before the ack. A submit latch would also hide this; making the take
   total removes the second submission instead of racing it.

 - A rejection returns the submission to `submission.conversationId`.
   Previously it called the live draft setter, which writes through to
   whichever conversation the composer is bound to NOW — and `/chat/:id`
   renders one <Chat /> across param changes (App.tsx), so a reconnect after
   the user moved on pasted the old thread's text into the new thread and
   overwrote its draft. `rejectPendingMessageCommands` (atoms/actions.ts)
   settles every in-flight command at once, so this is the common path on a
   reconnect, not a corner case.

<a id="invalidate-channel"></a>
## invalidateChannelResources: which keys a channel_changed refreshes

From `client/src/atoms/resources.ts`.

One channel changed — a post, a read mark, or who is replying (server
`channel_changed`; its `channelId` is the id of a channel of ANY kind: public,
direct or task). Every per-channel key is a URL under
`/api/buddies/channels/<id>` (built in components/buddies/channel-data.ts),
so one prefix selects its posts and responders.

The push names only the channel, so keys that are not addressed by it
refresh whenever they are mounted — in practice the one of each on screen:
  - threads (`/api/buddies/posts/<rootId>/thread`), keyed by their root;
  - the owner's inboxes (`/api/buddies/workspaces/<ws>/inbox`, and the
    counts-only `/api/buddies/unread` used by the title, sidebar and
    mobile tab): unread counts, requests and DMs span every channel,
    and the server pushes `channel_changed` when the owner marks one read,
    which is what clears it on other devices;
  - task details (`/api/buddies/tasks/<id>`), whose comments are the task
    channel's posts.
  - the Task filter's feed (`/api/buddies/tasks/<id>/posts`), which spans
    channels; without it a filtered view waited out the backstop (T22).
A Buddy's mention reply is announced only here, never by `buddies_changed`,
so without these the rail lagged by up to the 30 s backstop.

<a id="invalidate-resources"></a>
## invalidateResources: mounted keys only

From `client/src/atoms/resources.ts`.

Re-run the loader for every MOUNTED key the predicate selects.

This is the hook for "the database changed" pushes: a server event maps to
one call here instead of to twenty call sites. Entries are refreshed in
place, so a subscribed view updates without flashing a spinner.

Unmounted keys are deliberately left alone. A remount always revalidates
(stale-while-revalidate), so refreshing them here buys nothing — and a
burst of events against a few hundred retained Buddy keys, three requests
each, is exactly the request storm a phone cannot afford.

<a id="resource-cache"></a>
## Keyed resource cache

From `client/src/atoms/resources.ts`.

=============================================================================
Keyed resource cache — the one local store behind every read-only HTTP view.

Before this module every `usePolledFetch` call site held its result in
component `useState`, so a route change unmounted the data and the next
mount refetched from zero behind a spinner. On mobile that is the whole
"every page I open makes me wait" experience: the bytes were already on the
device a moment ago and got thrown away by React, not by the server.

State lives here instead, keyed by request. Three properties follow:

  1. Remount is free. A cached key renders immediately and revalidates in
     the background (stale-while-revalidate), so navigation never blanks.
  2. Cross-key races are unrepresentable. A late response for buddy A
     writes to buddy A's entry; a component now showing buddy B reads B's
     entry and cannot see it. Call sites used to hand-roll this check
     ("is this response for what I'm displaying?") three different ways.
  3. Push invalidation has exactly one entry point. `invalidateResources`
     re-runs the loaders for live keys; nothing else has to be taught.
=============================================================================

<a id="list-index"></a>
## The list index: one pass for every collection view

From `client/src/atoms/conversation-index.ts`.

=============================================================================
The list index: every collection view, built in ONE pass over the list.
Pattern: one-store-one-index (docs/patterns.md#one-store-one-index)

Until T19 each view was its own derived atom (about 20: ids, id set, recent
directories, inbox, gallery, children, three Buddy-sidebar atoms, running
counts, workers, per-Buddy lists…), each re-walking the list when it moved.
Now one pass builds them all, and a field whose content is unchanged hands
back its previous value, so a subscriber of that field (through
`listField`) does not re-render. The pass runs only when the LIST moves (a
list field changed); message, queue, sub-agent and stream events never
reach it (guarded by client/test/conversation-event-isolation.test.tsx).
=============================================================================

<a id="conversation-index"></a>
## Conversation list index (incremental)

From `client/src/atoms/conversation-index.ts`.

=============================================================================
Conversation list index
Pattern: one-store-one-index (docs/patterns.md#one-store-one-index)

Every collection view (sidebar groups, gallery, inbox, buddy sidebar, running
counts, swarm workers, child sessions) filters, groups and sorts on a handful
of fields. They used to read `Conversation` objects straight out of the map,
so each of ~10 views re-ran a full pass on EVERY conversation event — message,
queue, sub-agent and every 5 s poller batch — at n ≈ 1,200 (03-app-core §6.2).

The index keeps one `ConversationListEntry` per conversation holding only
those fields, and one list of entries sorted newest-first. It is updated
incrementally from the ids a write touched:
  - an entry is rebuilt only for a touched conversation, and replaced only
    when one of ITS list fields changed (otherwise the old entry is kept);
  - the list is a new array only when some entry was replaced, and a
    replaced entry is moved by binary search, not by re-sorting.
So an event that changes no list field (messages, queue, sub-agents, session
binding, streaming) leaves the list reference untouched and no view
recomputes. Views that do recompute go through `stableAtom`, so their
subscribers only re-render when the view's own output changed.
=============================================================================

<a id="device-ui-state"></a>
## Device UI state (localStorage)

From `client/src/atoms/ui.ts`.

=============================================================================
Device UI state — browser localStorage only, never synced to the server.

  prefs ('unleashd-ui-local') — view state: gallery expansion, list
    toggles, last directory, promoted workers. The route owns the active
    conversation; nothing restores it from prefs.
  seen ('unleashd-seen-message-index') — NEW badge: last viewed message
    index per conversation. Its own key because
    it changes on every viewed message; the prefs blob should not be
    rewritten at that rate.

Done (hidden) is NOT here: it is a fact about the conversation, stored on
the server's conversation record and read as `conversation.done`. It used to
live in a server-synced blob keyed by `sessionId ?? id`; the server rotates
sessionId, and the blob's debounced snapshot POST lost writes on refresh
and reconnect — hidden conversations kept reappearing (2026-09-23).

Mutate ONLY via the exported action functions — jotaiStore.set lives inside
atoms/ (gate G1).
=============================================================================

<a id="markdown-pipeline"></a>
## Markdown pipeline: one frozen processor per flavor, cached settled trees

From `client/src/utils/markdown-pipeline.ts`.

Markdown rendering with the unified processor built ONCE per plugin config,
not once per message.

Why this exists: react-markdown's `<Markdown>` builds a fresh
`unified().use(...)` chain on every render and `parse()` freezes it, which
re-runs every plugin attacher — remark-gfm/remark-math re-assemble their
micromark extensions and rehype-highlight builds a new lowlight instance
with every bundled grammar. Measured 2026-09-25 opening a 1,099-message
conversation on mobile (4x CPU throttle): react-markdown was 1,060 of the
1,255ms commit, ~391ms of it in unified `freeze()` alone. Desktop paid the
same per virtualized row (66 of 158ms).

The shape: a `MarkdownFlavor` is a module constant (remark plugins + URL
policy); `markdownPipeline(flavor, rehypePlugins)` returns the one frozen
processor for that flavor and rehype plugin list (the lazy katex/highlight
list from `useLazyMarkdownPlugins` is itself stable, so this is a WeakMap
hit). The finished hast tree per (pipeline, content) of SETTLED content is
kept in a bounded module LRU, so a row that remounts — virtualizer scroll,
mobile "load earlier", re-opening a conversation — skips parse + highlight
entirely and only pays the hast→React conversion. A message a streaming turn
is still appending to goes through `renderMarkdownLive` and never enters it.

Cached trees are shared across renders and handed to components as `node`,
so they must never be mutated after `compileCached()` finishes. Everything
react-markdown's post-pass did in place (raw HTML → text, URL policy) is done
once here, before the tree enters the cache.

<a id="mobile-group-window"></a>
## Mobile transcript window: pinned first-group index

From `client/src/mobile/conversations/ConversationView.tsx`.

Render window: groups from `firstShown` on mount. The list stays a flat
scroller (iOS momentum) instead of a virtualizer, but mounting all of it
was the cost — opening a 1,099-message conversation blocked the main
thread 1,321ms (4x CPU, 2026-09-25), nearly all markdown parse for turns
nobody had scrolled to.

The window stores the INDEX of the first shown group, not a count from the
end: with a count, every new group unmounted the oldest mounted one, so
content above the reader shifted mid-read (Safari has no scroll anchoring).
It is pinned the first render the history is present (React's
adjust-state-during-render pattern — no effect, no flash of every group)
and moved only by "Show earlier". Switching conversations re-pins because
the stored id no longer matches.

<a id="conversation-view"></a>
## ConversationView: layout contract and creation states

From `client/src/mobile/conversations/ConversationView.tsx`.

ConversationView — the one mobile conversation pane.

Extracted from ChatMobile so plain chats and buddy conversations render the
SAME transcript + composer instead of drifting into two implementations.
`ChatMobile` is now a thin route wrapper around it; any buddy surface that
wants an inline thread embeds this directly.

LAYOUT CONTRACT (this is what made the composer invisible on phones):
this component fills its PARENT, it does not size itself to the viewport.
It renders inside ShellMobile's `.mobile-content`, which is already
`100dvh − tab-bar`. The old `height: 100dvh` here made the pane 56px taller
than its scrollport, pushing the composer underneath the bottom tab bar with
no way to scroll to it — the message list swallowed the gesture. Keep this
`height: 100%` and keep `.mobile-content__inner` a stretched flex column.

CREATION STATES: a freshly created conversation exists only in
`commandsAtom` (a `create` command) until the server confirms it over WS. Rendering
"not found" for that window is wrong — it is the bug that made every new
plain conversation look broken while buddy threads (created synchronously by
`POST /api/buddies/builder`, so already in `rowsAtom` before the
route changes) looked fine. Mirror Chat.tsx: only claim "not found" once the
conversation list has finished loading AND there is no pending creation.

<a id="code-classification"></a>
## Code content classification (fenced vs inline, path blocks)

From `client/src/views/transcript/markdown-components.tsx`.

=============================================================================
Code Content Classification

react-markdown v10 calls the custom `code` component for BOTH fenced code
blocks (`<pre><code>`) and inline code (`<code>`). There is no `inline` prop
in v10 — the only signals are:
  - className: present when a language tag is specified (e.g. ```python)
  - text content: fenced blocks have newlines, inline typically doesn't

We classify code content into a discriminated union (CodeContent) and dispatch
to one handler per variant. This avoids the old fallthrough chain where a
rejected parsePathBlock silently fell to getPreviewType, which treated entire
multi-line blocks as a single image path (the "many lines as one line" bug).

CONSTRAINT: parsePathBlock used to be all-or-nothing — if ANY line (like "...")
wasn't a valid file path, the entire block was rejected. classifyPathBlock
replaces it with per-line classification: valid paths → FilePreview with hover,
non-path lines → plain text. The block qualifies as a path_block if at least
one line is a valid file path.

CONSTRAINT: getPreviewType only handles single-line text (rejects newlines).
Multi-line text MUST go through classifyPathBlock, never getPreviewType.
=============================================================================

<a id="preview-type"></a>
## getPreviewType: single-line only

From `client/src/components/FilePreview.tsx`.

Returns 'image' | 'html' | 'video' | 'markdown' | null for a given text string.
Matches absolute paths (`/foo/bar.png`) and relative paths with at least one
directory separator (`test_outputs/render.png`). Bare filenames like `foo.png`
are rejected to avoid false-matching inline code in prose.

IMPORTANT: This function handles SINGLE-LINE text only. Multi-line code blocks
must go through classifyPathBlock() in VirtualizedMessageList.tsx, which calls
getPreviewType per-line. Do NOT remove the newline guard below — it is defense
in depth against a bug where a multi-line code block like:

  ```
  /path/to/img1.png
  /path/to/img2.png
  ...
  /path/to/img3.png
  ```

was passed as ONE string to this function. Since the string has no spaces,
contains "/", and ends with ".png", it matched — rendering the entire block
as a single FilePreview (all paths collapsed into one line, no hover).

<a id="file-preview"></a>
## FilePreview

From `client/src/components/FilePreview.tsx`.

FilePreview — inline file path preview for images, HTML, video, and markdown in chat messages.

Detects file paths (in inline code) ending in previewable extensions and renders
them as: icon + clickable link + hover popup preview.

Supports both absolute paths (`/data/runs/.../00000.png`) and relative paths
(`test_outputs/ssim_debug/render_00000.png`). Relative paths require at least
one `/` directory separator to avoid false-matching bare filenames in prose.
When a `workingDirectory` prop is provided, relative paths are resolved against
it for the API URL while the original relative path is displayed as link text.

The popup renders via React Portal to document.body so it escapes parent
overflow:hidden / overflow:auto containers (e.g. .messages-container).

Wired into react-markdown via the `code` component override in
VirtualizedMessageList.tsx.

<a id="remark-breaks"></a>
## remarkBreaks (inline plugin)

From `client/src/utils/remark-breaks.ts`.

=============================================================================
remarkBreaks — inline remark plugin (replaces the `remark-breaks` npm package)

Standard Markdown collapses single newlines into spaces within a paragraph.
This means plain-text output (e.g. file path lists NOT in code fences) renders
as one long run-on line. This plugin converts soft newlines to <br> hard breaks
in the mdast, matching chat-UI expectations where each \n is a visual line break.

Shared by chat (VirtualizedMessageList) and channel posts (ChannelMarkdown).

SCOPE: Only affects text nodes inside paragraphs/lists/blockquotes. Does NOT
affect code blocks — those are `code` nodes in mdast with a `value` string
(no children), so this visitor skips them. Code block whitespace is preserved
by the <pre> element's `white-space: pre` CSS.

WHY INLINE: The `remark-breaks` npm package does the same thing, but pnpm
workspace install was broken by an unrelated server dependency. This is ~20
lines and has zero external deps.
=============================================================================

<a id="lazy-markdown-plugins"></a>
## Lazy katex/highlight plugins

From `client/src/utils/lazyMarkdownPlugins.ts`.

ONE loading path for the heavy markdown rehype plugins (katex + highlight.js)
used by the transcript rows (`views/transcript/TranscriptGroup.tsx`), which
both the desktop and mobile trees render.

Why this exists: `rehype-katex` pulls in all of KaTeX and `rehype-highlight`
pulls in highlight.js with every bundled language. Statically imported from
the desktop path they landed in the entry chunk (~1.32 MB), so first paint
paid for math typesetting nobody had asked for yet. A *dynamic* import on
both paths is what actually lets Rollup split them out — one static importer
anywhere is enough to pin them back into the entry chunk, so do NOT add a
top-level `import 'rehype-katex'` / `'katex/dist/katex.min.css'` /
`'highlight.js/styles/*.css'` anywhere in client/src.

Behavior: markdown renders immediately with the remark plugins only, then
re-renders with syntax highlighting + math once the chunk lands. No spinner,
no layout gate.

<a id="new-conversation-form"></a>
## NewConversationForm layouts

From `client/src/views/new-conversation/NewConversationForm.tsx`.

NewConversationForm — the one new-conversation form. The desktop Sidebar
shows it in its centered modal (`layout="modal"`), mobile in a bottom sheet
(`layout="sheet"`, mobile/components/NewConversationSheet). The container
owns the title and dismissal; the form owns the fields and the create.

Both layouts share: the directory field with fuzzy recent-folder + filesystem
suggestions and path validation (PathAutocomplete), the default directory
(latest activity → last used → server cwd), Chat and Swarm actions, the
disconnected note and the error. Layouts differ only as data (LAYOUT):
  - modal: autofocus the path, full provider/model picker inline.
  - sheet: no autofocus (the phone keyboard would cover the sheet), tappable
    recent folders (typing a path on a phone is miserable), and the catalog
    default provider — ChatMobile's header picker changes it before the first
    message, and the picker's option CSS lives in the desktop Sidebar.css.

<a id="clipboard"></a>
## Clipboard in a non-secure context

From `client/src/utils/clipboard.ts`.

Clipboard writes that survive a non-secure context.

`navigator.clipboard` is secure-context gated, exactly like
`crypto.randomUUID` (see utils/ids.ts). Over `http://<lan-ip>:7489` — how a
phone reaches the dev server — the whole `clipboard` object is `undefined`,
so `navigator.clipboard.writeText(...)` throws a TypeError before it can
reject. It works on `localhost` because loopback counts as secure, which is
why this never showed up in dev.

Falls back to the legacy `document.execCommand('copy')` path, which has no
secure-context requirement. Returns whether the text actually landed, so
callers can show a failure instead of a success state that never arrives.

All clipboard writes must go through here; gate G5 enforces it.

<a id="upload-drain-retry"></a>
## uploadFilesWithDrainRetry: keep the dropzone callback unary

From `client/src/hooks/usePendingAttachments.ts`.

POST the attachments, retrying only while the server reports a drain.

SUBTLE — the retry counter lives HERE and not as a defaulted second parameter
on the hook's callback. `handleFilesUpload` is handed straight to
react-dropzone as `onDrop` (Chat.tsx), and react-dropzone invokes it as
`onDrop(acceptedFiles, fileRejections, event)`. A `(files, attempt = 0)`
signature therefore receives `fileRejections` (an array) as `attempt` on every
drag-and-drop, so an `attempt === 0` guard is false on the first try and the
retry silently never runs — paste retried, drag did not. TypeScript cannot
catch it: the hook's public type declares one parameter, and a 1-arg function
is assignable to a 3-arg callback slot. Keep the public callback unary.

`fetchImpl`/`sleepImpl` are seams for the regression test only.

<a id="upload-backoff"></a>
## Upload retry backoff

From `client/src/hooks/usePendingAttachments.ts`.

Backoff schedule for a retryable upload rejection, in ms.

Sized against a real dev restart, not a reconnect blip: the server refuses
every non-GET with 503 `server_draining` while `state === 'reloading'`
(server.ts), then the replacement process refuses with `server_starting`
until it finishes rehydrating persisted conversations. A single ~1s retry
lands squarely inside that second window and fails anyway; ~7s of total
patience covers a normal restart.

<a id="keyed-atoms"></a>
## KeyedAtoms: per-key subscriptions

From `client/src/atoms/structural.ts`.

A map of per-key values that readers subscribe to ONE KEY at a time.

A plain `atom(new Map())` read through `atomFamily(id => atom(get =>
get(mapAtom).get(id)))` recomputes every mounted per-id atom on every write,
whatever key changed. Here each key has its own primitive atom and a write
sets only the keys it touched, so a reader of key B does no work at all when
key A changes.

- `all`: read the whole map (imperative reads); write replaces the whole map,
  diffing by `Object.is` to find the touched keys.
- `patch`: set and remove named keys without visiting the others.
- `byKey(key)`: the per-key atom; `absent` when the key is not present.
- `onCommit`: runs inside the same write with the touched keys, for indexes
  that must move in step with the map.

<a id="channel-outbox"></a>
## Channel outbox

From `client/src/atoms/channel-outbox.ts`.

=============================================================================
Channel outbox — owner posts shown before the server has them.

Sending used to wait for the POST and then a feed refetch before the message
appeared. Under load (2026-09-25: load average 232, owner-reported "slow
delay") each of those took seconds, so Send felt broken. Now the composer
files the post here the moment Send is pressed and the feed renders it
straight away; the server copy replaces it when a refetch returns it.

  Sending — the POST is in flight; rendered from the draft.
  Sent    — the POST returned this post; rendered until a refetch includes
            it. Dropping it on the POST response instead would blink the
            message out until the refetch landed.
A failed POST removes the entry and the composer gets its text back.
=============================================================================

<a id="prefetch"></a>
## Prefetch of conversation details

From `client/src/atoms/prefetch.ts`.

=============================================================================
Prefetch — warm what the user is about to open, before they open it.

`init` ships conversation SUMMARIES, so the first visit to each chat costs a
round trip for its history. That is fine on desktop over loopback and very
much not fine on a phone over the LAN, where it is the whole "why is opening
a conversation slow" complaint. The data is small and already on the machine;
the only reason to wait for it is that nobody asked early.

Two rules keep this from making things worse:
  - Idle only. Prefetch must never compete with the view actually on screen.
  - Bounded concurrency. A burst of parallel GETs from a phone is slower
    than a lazy load, not faster.
=============================================================================

<a id="folder-group-key"></a>
## folderGroupKey vs normalizeFolderDirectory

From `client/src/utils/directories.ts`.

Grouping key for the sidebar's recent-folder groups: the project a
conversation belongs to, not the exact directory it ran in.

Worktrees are per-iteration scratch dirs (`<project>/.ws<swarm>-w3-i7`), so
keying groups on the raw working directory gave every iteration its own
header — 1,107 groups for room-runners-arena-lib alone on 2026-09-06, all
rendering as the same truncated `~/git/room-runners-aren…`. Folding them onto
the project root matches what `recentDirectoriesAtom` already does for the
"pick a directory" surfaces.

Deliberately NOT folded into `normalizeFolderDirectory`: that one answers
"which directory did the user mean", and silently rewriting a worktree the
user typed into its parent repo would start conversations in the wrong tree.

<a id="client-ids"></a>
## Client ids without a secure context

From `client/src/utils/ids.ts`.

Client-owned id generation.

`crypto.randomUUID()` is gated on a secure context. The dev server is reached
over a plain-HTTP LAN IP from phones (http://192.168.x.x:7489), where
`crypto.randomUUID` is `undefined` — every creation path threw
"crypto.randomUUID is not a function" on mobile Safari while working fine on
localhost. `crypto.getRandomValues` is NOT secure-context gated, so it is the
fallback and covers every browser this app runs in.

All ids must come from here. A bare `crypto.randomUUID()` call site is a
mobile-over-LAN crash waiting to happen; `tools/check-client-invariants.sh`
gate G4 enforces it.

<a id="fork-transcript"></a>
## Fork is a soft handoff

From `client/src/utils/conversation-transcript.ts`.

Plain-text transcript of a conversation, and the draft seeded into a fork.

Extracted from Chat.tsx so the mobile conversation view forks with identical
semantics. Chat "Fork" is a SOFT HANDOFF — a new conversation carrying the
prior transcript as its draft, created with `kind: {t:'fork', from}` for
lineage. The server upgrades the first send to a provider-session fork (CLI
`--fork` / emulateFork) only for same-provider FORK_CAPABLE_PROVIDERS pairs;
see shared/src/index.ts around the FORK_CAPABLE_PROVIDERS block.

Because it is text-only, fork works across providers — the draft is all the
next CLI receives, so it must stand alone.
