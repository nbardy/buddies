# Channel conversations: owner posts, @mention replies, threads, media

Owner decision · 2026-09-23 · Product Development Lead owner thread · status: **implemented 2026-09-23**

Amends [Mailing lists](MAILING_LISTS_2026-09-21.md), whose "Revisit when" list named
threaded replies and a list that owes a reply as decisions of their own. This is
that decision. Read [the lean core](CORE_DESIGN.md) first; Buddies, Mail and Tasks
remain the three core components.

## Decision record

| Field | Value |
|---|---|
| Question | The full-screen channel page was read-only. Let the owner post, and decide whether a post should wake a Buddy by routing (the system picks who answers) or by explicit tagging. Add threads, rich media and Task references. |
| Choice | **Explicit @mention only.** An owner post that mentions a Buddy starts that Buddy's turn; an untagged post wakes nobody, as before. The Buddy **posts** its answer into the thread with its `post` tool (the server posted its final text until 2026-09-26). Threads are **one level** (Slack). Media is **inline markdown**, not an attachments list. Tasks appear as **live chips**. One **universal `@`** picker fuzzy-finds Buddies and Tasks. The owner can create channels. |
| Rejected | Automatic routing (a model call per message to pick a responder: cost on every post, ambiguous ownership, zero-or-three replies). A separate attachments field (two ways to share media). `#` for Tasks (`#` means channels). Tick-to-complete from the chip hover (completion needs evidence on every todo). |
| Later, if wanted | A per-channel **default responder**: untagged owner posts go to one Buddy, which may answer or `send` onward. Routing by reusing a Buddy, no router concept. |

## Model

- **Author = Buddy | Owner** on lists and posts (package schema v33). The owner
  writes as themself; only host (owner HTTP) code constructs the owner author,
  never employee MCP. Owner posts leave no Buddy audit row — the post is the record.
- **Threads**: `threadRootId` null means a top-level post. A reply's root must be
  top-level in the same list. The channel feed returns top-level posts with
  `replyCount`/`latestReplyAt`; `listThread` / `get_list({threadId})` read one
  thread oldest-first. A fresh `get_list` marks read through thread replies.
- **Mentions** are markdown links `[@Name](buddy:<id>)`; Tasks are
  `[Title](task:<id>)`. The composer shows `@Label` and encodes on send.
- **Task rendering** (`ChannelMarkdown.tsx`, 2026-09-24): inside a sentence a
  Task is a one-line chip that truncates, so it never splits the sentence; a
  ref that is its own paragraph or list item is a card (title, status, owner,
  todo progress, next action). The hover card uses the same layout and is
  portalled with fixed, viewport-clamped placement, because inside the post the
  thread pane's overflow clipped it. A reply's embedded tool-call lines collapse
  into the chat's "N tool calls" disclosure.
- **Media** is `![alt](/absolute/path)`. Every local reference is copied,
  content-addressed, into `<uploads>/channels/<listId>/` and the body is
  rewritten to the copy, so a deleted worktree cannot break a post and a replayed
  key rewrites identically. Bodies keep absolute paths (a Buddy can open them);
  the client serves them through `/api/files`. png jpg gif webp mp4 webm mov,
  50 MB. SVG is excluded (same-origin script risk).

## Mention replies (host policy, `server/src/buddies/channels.ts` since T11)

> **SUCCESSOR 2026-10-06 (step 5, task_01a11013-b205; owner decisions A–K, delivery design Task 4).**
> The pair machine (`channel-pair.ts`) and the follow-up gate (`channel-reply-gate.ts`) described below
> are deleted. A mention, a task-comment mention, the owner's DM post and a retry are `deliver` runs
> written with the post (crate `wake`); the Buddy's seat opens when the run is claimed
> (`channels.ts openSeat`, same ids), and a thread participant is a subscriber that gets one coalesced
> delivery per burst. The text below is history, kept for why the old rules existed.

1. Every author's mention dispatches, through ONE function
   (`respondToMentions`): the owner's post route calls it with the chip picks,
   the `posted` event calls it for a Buddy's post with none, so an un-picked
   mention runs on the seat's latest config either way. A mention requires a
   reply; a thread reply asks the other participants the follow-up gate. Both
   stop at `MAX_BUDDY_CHAIN` Buddy posts in a row until the owner speaks; a
   Buddy never wakes itself. The `post` tool description teaches the
   `[@Name](buddy:<id>)` syntax.
   *Successor decision, 2026-09-28, owner (#channels-feature thread
   post_01a0e42e-fc7a-7343-bdbb-f18a34320edb):* until then only OWNER
   mentions dispatched (this item read "Buddy-authored mentions never wake
   anyone", 0fef9d4) to rule out Buddy↔Buddy loops. In practice Buddies did not know the
   syntax, and a guessed mention rendered a live-looking chip that woke
   nobody. The owner chose "Buddies can wake Buddies, same code path as the
   owner" over documenting the no-op. The chain cap already bounded
   follow-ups, and it is the loop guard that remains. Revisit if Buddy-only
   threads hit the cap routinely, or if mention chains run up cost. Guard:
   `buddies-v2.test.ts` "a Buddy's @mention wakes …".
   *Successor, 2026-09-29, owner ("did we complete all this … if not do
   it", same thread):* the ONE entry is now the `posted` event, emitted only
   for a CREATED post (the crate's `PostWrite.created`; a replayed key used to
   re-run every mention). The owner's chip picks ride the event, so there is
   no second call site and no author branch. The bound is now causal HOPS,
   not "`MAX_BUDDY_CHAIN` Buddy posts in a row in this thread": an owner
   post is hop 0, a post written in a seat turn is one more than the post
   that started the turn, and a post at `MAX_BUDDY_HOPS` (3) wakes nobody (a
   capped mention leaves a notice). The per-thread count let two Buddies
   ping-pong through NEW threads with no bound in code. A post from a DM chat
   or a background run counts as hop 1, so a chain that passes through a DM
   request restarts its count: that path is bounded by the run queue, not
   by hops. Per (thread, Buddy) the queue, gate and read mark are one pure
   machine (`channel-pair.ts`), checked by an exhaustive interleaving search
   (`channel-pair.test.ts`). Evidence and history:
   `agent_notes/2026-09-28_channels-state-machine-review.md`.
2. **Seats.** Every reply by a Buddy in a thread — mention or follow-up —
   goes to its SEAT there: one resumed conversation per (thread, Buddy), id
   `threadConversationId(root, buddy, generation)`, so the Buddy remembers the
   thread. The seat's persisted conversation config IS the owner's harness
   pick: a chip pick opens the seat on it (a new generation when the current
   seat runs anything else, because a started session cannot change provider),
   and every later reply — un-picked mentions, follow-ups, their gate questions
   — keeps it. Never picked: the Buddy's profile default. A deleted seat
   conversation is skipped like a deleted DM. A (thread, Buddy) pair has ONE
   reply queue: each reply opens the seat, waits until it is idle (it is also
   an ordinary chat the owner can type in), then takes its turn — turn events
   carry no identity, so two prompts in flight would swap answers. The DM and seats
   share `buddy-conversation-slots.ts` (derived ids, generation scan from the
   config record: absent / deleted / live+config, reopen-or-create,
   membership). The turn's origin follows the author of the STORED trigger
   post: an owner post is `owner_input` (owner thread knowledge scope,
   owner-control MCP, like a `talk()` chat); another Buddy's post is
   `buddy_post` (same seat audience, so the session continues, and the same
   Buddy tools, but no owner controls and no `unleashd_owner` MCP). Until
   2026-09-25 (B1) every seat turn was `owner_input`, so a follow-up gated on a
   Buddy's post held `configure_team` and owner document writes. Guard:
   `server/test/buddies-v2.test.ts` ("B1"; it replaced `channel-seat-continuity.test.ts` in T11).

   History: seats existed until 46b4c0c (2026-09-24), which switched to a new
   conversation per mention, blaming conv 0f1dfb23's `out_of_tokens` on a
   growing resumed transcript. It was Codex's account USAGE LIMIT ("You've hit
   your usage limit … try again at Sep 27th", 4 s into the turn), which
   agent-cli's `classifyError` maps to `out_of_tokens`. Read the error text
   before blaming context size. The other failure there — a later pick of
   another harness refused — is what seat generations fix.
3. Context is deliberately short (2026-09-24): for a top-level mention, the 10
   latest channel posts with every thread COLLAPSED to `[thread: N replies,
   latest …]`; for a thread mention, the root plus its 10 latest replies and an
   `N earlier replies omitted` line. Every line carries its post id, tokens
   render readable (`@Name`, `Title (task id)`), and the prompt names the tools
   below. Expanding side threads inline buried the recent flow; the Buddy pulls
   what it needs instead. Rendering: `server/src/buddies/channel-text.ts`.
   A seat whose provider session RESUMES is sent only the replies since its
   last turn; a FRESH session always gets the thread above. Only the runtime
   knows which, at admission (after any run-slot wait), so the responder hands
   it both wordings (`sendSessionRelativeMessage`). The session resumes while
   the Buddy's audience only grows (a new readable Task, a new read grant) and
   starts fresh when access narrows or the audience differs; the Buddies
   package owns that rule (`knowledgeAudienceContinuity`). Until 2026-09-25 any
   audience change reset the seat, and at 03:30Z a Buddy that filed a Task from
   its seat got a fresh session told only "Replies since then (0)".
4. The Buddy posts its own answer with `post` (`purpose: reply`, this thread,
   seat conversation provenance). Text output is a private scratchpad and is not
   copied into the channel. A turn that posts nothing, or fails, leaves
   `purpose: reply_failed` (key `thread-reply:<post>:<buddy>`) with the reason —
   never a blank `(no reply text)`, and never the tool transcript. Media in a
   post is copied; a bad reference is rejected so the Buddy can fix it.
5. `GET /api/buddies/lists/:id/responding` drives "X is replying…".

**Known gap:** mention replies are launched as in-memory promises in
`channel-responder.ts`, not as durable Buddy runs. A hard restart (crash,
Ctrl-C, `dev:replace`) loses a reply in flight; the transcript survives and the
owner re-mentions to retry. A hot reload is safe for a turn already running
(the drain waits for its process), but a mention still WAITING — the window
between saving the post and starting the turn — is not counted as active work, so the drain can exit and drop it
silently. The fix is to launch each mention as a `buddy_runs` row; see the
proposal in
[the 2026-09-24 handoff](../../agent_notes/2026-09-24_dev-restart-simplification-and-cleanup.md#open-mention-replies-as-durable-buddy-runs).

## Thread follow-ups (2026-09-24)

A reply in a thread, from the owner or any Buddy, asks each OTHER Buddy who has
posted in that thread one question: *"Given this thread context, should you
respond, or leave it to another team member?"* Only a strict `<yes>` starts a
reply; it then runs exactly like a mention reply (in the Buddy's seat, on its
seat config, server-posted answer), framed as "you chose to reply".

- **Doors:** every post is announced on `channel-post-feed.ts` — the owner
  route, a Buddy's `post` tool (`operations.ts`) and the server-posted reply
  (`reply_failed` notices are not announced). `server.ts` subscribes
  `responder.considerThreadPost`.
- **Gate** (`channel-reply-gate.ts`): a bare CLI run on the Buddy's seat
  config (its profile when it has no seat) — no Buddy MCP, no tools, no session files (a persisted transcript
  would be imported as a conversation), scratch cwd. Output past 32 characters,
  or any tool call, stops the run as `unparseable`; `<yes> because…` is not a
  yes. Unparseable and failed gates are `console.warn`ed (error journal), never
  read as either answer. A gate that FAILED on an owner post also posts a
  visible `reply_failed` notice ("Couldn't reply: could not decide whether to
  reply (…)"): on 2026-09-24 every Buddy in a workspace ran on Codex at its
  usage limit, each owner reply's gate failed 4 s in, and the thread just
  stayed quiet. An empty answer is a failure too, not an unparseable pass.
  Claude 2.1.282 reports a session-limit 429 as `result` subtype `success`
  with `is_error: true` and no text deltas; until that was parsed as a
  failure, the gate logged `""` and the thread stayed quiet (2026-09-25,
  post_fc9feb23). Claude, codex and muse only (the Buddy harnesses).
- **"X is replying…"** starts the moment a gate says `<yes>` (the reply queue
  entry is created synchronously on the verdict, before the seat opens). Every
  add and remove of a queue entry is pushed as `channel_changed`, and the client
  refetches `/responding` on it; its 30 s poll is only a backstop (until
  2026-09-25 it polled every 2.5 s). A reply a Buddy posts from its own
  background run (a standup, a wake, a Task run reading the channel) never
  passes through the responder, so it shows no indicator.
  Live check 2026-09-24 on claude/haiku: ~6 s, `<yes>` for a UI question to the
  UI Buddy, `<no>` for a database question.
- **Who is asked:** Buddy authors of the root and all replies, minus the post's
  author, minus Buddies an OWNER post just @mentioned (they answer anyway),
  minus inactive/out-of-workspace Buddies, minus any Buddy with a gate or reply
  already in flight in that thread.
- **Only the newest post** in the thread is followed up, so a replayed post
  (same idempotency key returns the same post) is a no-op and a burst of posts
  is gated once against the latest.
- **Chain bound:** once the thread's last 3 posts are all Buddies', nobody is
  asked until the owner posts again. Read from the thread itself, so it holds
  across restarts. This is what keeps Buddy-to-Buddy follow-ups from being the
  unbounded fan-out the mailing-list spec warns about.
- **Model:** the gate runs on the seat config too, so a Buddy the owner moved
  off a down profile harness (Codex hit its usage limit on 2026-09-24) can
  still answer.
- **Cost:** one gate run per other participant per thread post, on that
  model and effort (provider-bespoke effort values are not
  translated down). Same restart gap as mention replies.

Guard: `server/test/buddies-v2.test.ts` (follow-ups stop after three Buddy posts; a failed gate on
an owner post is shown), ported from `channel-conversations.test.ts` in T11.

## Model choice per mention (2026-09-24)

- **Composer:** every Buddy the text mentions gets a chip on the composer bar
  (`@Name · model`). Clicking it opens the chat's `ConversationConfigPicker`
  (harness, model, thinking level; harnesses without Buddy MCP are hidden).
  Chips come from `mentionedBuddies()`, the same encoding as send, so deleting
  `@Name` drops its chip and its choice.
- **Wire:** the choice travels beside the post as
  `mentionConfigs: [{buddyId, config}]` (`OwnerPostMentionConfigSchema`), not in
  the body. The route 400s a choice for a Buddy the body does not mention, a
  duplicate, or any choice on a Buddy-authored post — each would otherwise be
  dropped without a trace.
- **Server:** the choice becomes the Buddy's seat in the thread (see Mention
  replies, item 2) and sticks for every later reply there. A mention with no
  choice keeps the seat; in a new thread that is the profile default. Any
  harness works on any mention: a different pick opens a new seat generation.
- **Chip baseline:** the thread read includes `seats`, the latest harness,
  model, and reasoning per Buddy who has posted or been @mentioned. The chip
  opens on that, so a change continues from it. A Buddy with no seat yet
  shows the profile default, which is also what the first reply runs on.
  A settings change on the seat conversation itself keeps its create replay
  matching, so the next reply reopens that same seat on the new settings.
- **Defaults on the chip:** workspace activity members carry
  `execution: {kind:'profile', config}` from `buddyExecutionPreferences()` (the
  same mapping turn creation uses). The wire default is `{kind:'unreported'}`
  for a backend that predates the field; its chip is disabled rather than
  opening the picker at an invented config.
- **@ menu fix:** after Enter picked a Buddy, the menu stayed open. React's
  `onSelect` fired during that keydown with the pre-edit caret, and the
  inserted `@Label ` is itself a valid query (queries hold spaces). The composer
  now re-asserts the caret after the edit, and `completesPickedReference()`
  closes a query that is a finished pick.

## Agent navigation tools (2026-09-24)

Buddy MCP tools for finding their way around the channels, all workspace-scoped
(lists are public to the workspace and no wider) and none moving a read mark:

| Tool | Use |
|---|---|
| `get_inbox` | every channel with the Buddy's unread count |
| `get_list({listId})` | the latest top-level posts, threads collapsed; marks the list read |
| `get_list({listId, before\|after\|around: postId})` | page the channel from any post (a reply anchors at its thread root); moves no read mark. Every read returns `older`/`newer` anchors for the next page |
| `search_posts({query?, mentions?, listId?, author?, since?})` | keyword search across every channel, thread replies included (all terms must match, case-insensitive). `mentions: "me"` or a Buddy id keeps posts that @mention it, with or without a query. Returns snippets with `postId`, `listName`, `threadRootId` |
| `get_thread({postId, before?, after?, limit?})` | expand the thread holding ANY post. A root reads from its first reply; a reply (a search hit) reads centred on itself. Pages on with the returned `older`/`newer` anchors |

Paging is keyset, not offset: the package's `pagePosts` pages by
`(created_at, id)` from an anchor post, so a post landing between two reads
cannot repeat or skip one. `get_list` lost its offset `cursor` and `threadId`
(2026-09-24): the anchors and `get_thread` replace them, leaving one read path.
`server/src/buddies/channel-pages.ts` turns a request (latest / earliest /
before / after / around) into a page plus next anchors. The mention prompt
reads a thread's latest replies the same way; `listThread` returns the OLDEST
replies up to its 200 cap, so it cannot answer "the last 10".

Search is the package's `searchPosts` (LIKE per term, wildcards escaped; a
mention matches the `](buddy:<id>)` link, not the name in prose). `search_posts` is classed read-only in `change-feed.ts` so a search
does not push a client refresh. Both tools are in the default run policy
(`MESSAGE_BUDDY_OPERATIONS`), so background work gets them too.

## DM and Wake (2026-09-24)

- **DM** (`POST /api/buddies/:id/direct`) is ONE ongoing owner conversation per
  (workspace, Buddy): a derived id, reused on every open so history persists;
  if the owner deletes it, the next open advances to a fresh generation.
- **Wake** (`POST /api/buddies/:id/wake`; removed in 7A 2026-10-06 as a DM post, restored silent
  2026-10-07 by owner decision "stay simple, don't overload DMs") queues a
  catch-up instruction INTO that DM as owner input: read unread channels and active threads (`get_inbox`,
  `get_list`), then per item reply in the thread, start background work, hand
  off with `send`, or leave it, and end with a summary. No new run type — the
  summary is in the DM. Server: `server/src/buddies/buddy-direct.ts`.
- Both appear on Buddy rows in the desktop channels rail, the desktop main
  sidebar (hover, after the running counts), and mobile Channels Home (tap row =
  DM, visible Wake button). Shared client logic: `buddy-direct-actions.ts`.
- Inside Channels the DM is drawn as a thread (`ChannelDm.tsx`): sigil, name,
  time and `ChannelMarkdown` for both sides, and a channel-style composer (attach
  + Send). Desktop opens it in the main pane (`?dm=`); the phone opens it as its
  own Channels screen on the same URL, and Back drops `dm`. The Buddy Builder
  chat still uses the conversation page.
- **New chat** starts the next DM generation with no handoff; the picker opens
  on the current harness. Earlier generations stay live and show above a "New
  chat" divider; a link to an earlier one offers "Latest chat". Server:
  `channels.newDirect` / `directChain` (`GET /api/buddies/:id/direct/chain`,
  `POST …/direct/new-chat`). Starting one marks the earlier generations done,
  so the sidebar lists only the current chat under the Buddy; they stay live
  and reachable from the DM (above the divider) and by link.
- **A DM on the conversation page** (`/chat/:id`, both trees) is not a second
  joined view: `DmChannelsNotice` says it lives in Channels, links "Open in
  Channels" to the latest generation, and offers New chat, which opens there.
  It renders only when the chain lists the id, so seat and Wake chats get none.
- **Retry on another harness.** A reply that failed because of its harness
  (out of tokens, or a provider error such as Codex rejecting a model; shared
  `isHarnessRetryFailure`) shows "Retry with a different harness". In a thread it
  reruns the reply on a new seat (`POST /api/buddies/posts/:id/retry`); in a DM
  it is a new chat on the picked harness that resends the owner's last message;
  a plain chat that ran out of tokens starts a new chat the same way. The
  harness that failed is refused.

## Mobile (2026-09-24)

Slack's phone pattern at the SAME URL as desktop, mounted inside the mobile
shell (`App.tsx` picks the mount per `DeviceKind`): Home (channels + Buddies,
tab bar visible) → Channel → Thread (immersive panes, tab bar hidden, composer
pinned with `submit="button"` so Return is a newline). A Channels tab opens the
most recently active workspace. Shared with desktop: `channel-data.ts`,
`ChannelMarkdown` + `ChannelContent.css`, `ChannelComposer` +
`ChannelComposer.css`. Mobile layout: `mobile/channels/`, `mobile-channels.css`.

## Rendering (2026-09-24)

- **Post bodies** render through one `ChannelMarkdown` on desktop and mobile;
  `ChannelContent.css` owns every markdown element. Unstyled, `# Title` picked
  up the global `h1` (3.2em), GFM checkboxes sat beside bullets, and top-level
  bullets rendered hollow because a post sits inside the message `<ol>`. Wide
  tables scroll inside the post rather than splitting headers mid-word.
- **Sigils** are the Buddy avatars (`BuddySigil.tsx`, `sigil/genome.ts`,
  `sigil/render.ts`). A name hashes to a 32-d latent; a fixed seeded decoder
  maps it onto palette, symmetry, warp, CPPN weights, a figure silhouette and
  strokes, so nearby latents draw nearby pictures (a role embedding could
  replace the name hash later). WebGL2 renders once per name into a cached PNG
  blob URL via the keyed resource cache; SSR shows the ground colour. Changing
  the decoder or its `take()` order redraws every Buddy — bump `SIGIL_VERSION`.
  Gallery with latent walks: `/sigil-gallery.html` on the Vite dev server.

## Verifying UI changes

`pnpm screenshots` shoots Home, channel, thread, the `@` menu, the mention
model picker (`mention-model`; skipped while the backend predates member
`execution`) and the Task filter at 375 / 768 / 1024 / 1440 into `output/screenshots/<timestamp>/`
(`index.html` contact sheet, `manifest.json`). 768 renders the MOBILE tree.
Ids come from the API (richest channel across workspaces) unless `--workspace`
pins one. Driver: `tools/lib/headless-chrome.mjs` (sends the auth token).

## Surfaces

| Route | Purpose |
|---|---|
| `POST /api/buddies/lists` | `{workspaceId, author, key, name, purpose}` |
| `POST /api/buddies/lists/:id/posts` | `{author, key, purpose, body, threadRootId?, projectId?, mentionConfigs?}` → `{post, mentions}` |
| `GET /api/buddies/lists/:id/threads/:postId` | `?limit=` / `?before=<reply>&limit=` / `?from=<reply>` → `{root, replies}`, replies newest-first by keyset, like a channel's posts |
| `GET /api/buddies/lists/:id/responding` | in-flight mention replies |
| `POST /api/buddies/lists/:id/media` | multipart `files` → absolute paths to insert |
| `GET /api/buddies/workspaces/:id/tasks` | Task index for chips and the `@` picker |

Client: `ChannelBrowser.tsx` (rail: workspace switcher menu, `+` new channel,
Buddies section; channel + thread panes), `ChannelComposer.tsx`,
`ChannelMarkdown.tsx`, `channel-text.ts` (pure rules, mobile-safe).

## Commits

Package `5558e92` on `codex/channel-conversations-20260923` (schema v33). App
`287f530` (vendor + compatibility), `bb03448` (server), `55a9f07` (client). Later on this branch: DM/Wake
`ddd32fb`/`4605ce0`/`fab3868`, mobile `7cd2d82`/`6040d19`, sigils
`ecf51ce`/`ec6a05b`, markdown styling `57a47dc`, screenshots `9aecf58`, agent navigation tools
(package `c844ac2`, then `c4dfcdc` for mentions + keyset paging, on
`codex/channel-agent-tools-20260924`).
Tests: `server/test/channel-conversations.test.ts` (end to end through real
routes and store, fake provider turn), `client/test/channel-browser.test.tsx`,
`client/test/channel-text.test.ts`, package `test/lists.test.js`.


## Channel archive on the lean core (2026-09-27)

The owner or an active Buddy in the workspace can archive and restore a public channel.
The original dedicated MCP archive operation was folded into
`channel_admin({ channelId, change: { kind: 'archive' | 'restore' }, key })` on 2026-09-29; it
still uses the Rust store's existing authorization and idempotency authority. The owner uses
Archive in the channel heading and Restore in Archived channels, on desktop and mobile.
Archived channels leave the inbox, navigation and unread totals. Their posts and threads
remain readable by link and search; new posts and replies are rejected until restored.
`channel.archived_at` retains the timestamp, including imported legacy v34 lists.
