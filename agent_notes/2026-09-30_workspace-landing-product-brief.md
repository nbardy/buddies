# Workspace landing: a place to return to your team

Product proposal · September 30, 2026 · Product Development Lead

## Latest owner direction: C plus pinned initiatives

### 13:37–13:38 UTC update: Tasks, search and agent pins

The owner requested renaming the section to **Tasks**, displaying the most
recent projects (Tasks with child Tasks), adding search above it, and putting
a manual pin button on each card. They also requested that agents can pin key
Tasks through MCP. These requests supersede the earlier local-only pin scope.

Product contract for the current implementation pass:

- No new stored Project type. For this home list, a project is an existing
  top-level Task with immediate child Tasks. Children remain ordinary Tasks;
  checklist progress remains derived from their canonical status.
- Empty search: manually pinned top-level Tasks first, in the selected order,
  followed by recently active unpinned projects. Recent activity uses the newest
  update of the parent or its immediate children, so progress on a todo brings
  its initiative forward. Never render the same Task twice.
- Search: include top-level Tasks without children as well as projects; match
  their titles, saved next actions and blocked reasons. Keep matching pins first.
  A query must not be limited to the four visible cards or recent-project sample.
- Show an explicit Pin/Unpin control on each card, separate from its Task link.
  A newly unpinned recent project may remain in the list as an unpinned recent
  result. The section stays useful before the owner pins anything.
- Progress labels and the distinction between checklist completion and parent
  status remain as specified below. Desktop's compact first four + Show all
  must not silently hide search results; make overflow/result counts visible.

Agent pins require one server authority. The engineer's narrower proposal uses
one nullable numeric `Task.pin` sort key: absent means unpinned, and ascending
keys give Home order. Expose it through existing Task reads and the
revision-checked/idempotent Task update, including `task_write`'s changes.
This replaces the earlier boolean-plus-ordering suggestion. No new pin tool or
Project entity. Apply existing Task write permissions; pinning grants no new
access, ownership or execution authority. Do not add an arbitrary eight-pin
cap or a second approval workflow.

The owner has requested MCP pinning; develop that concrete expansion within
the request rather than seeking generic approval again. Rust schema/codegen,
server validators, MCP definition and both UI shells must agree. Update tests
and verify the committed integration. Existing local pins must have an explicit
one-time migration or a clearly reported retirement; never keep both stores
as competing pin authorities, and never auto-pin the designer's examples.

Implementation ownership stays with Buddies UI Engineer, already editing the
home's shared shaping/tests. Product Development Lead supplies this revised
contract instead of concurrently changing those files. This is a handoff, not
a claim that search or durable MCP pins have shipped.

At 13:43 UTC the engineer reported Tasks/search committed as `1694c56` with
desktop/phone screenshots. The visible screenshots confirm the Tasks label,
search and star controls; independent runtime interaction/tests were not run
by Product Development Lead. Durable pin work remains tracked in
`task_01a0f290-cb7f-713b-b184-ede8aa42d2c7`; an implementation request was sent
to Buddies UI Engineer (`message/post_01a0f291-73f3-7424-9766-38b2105a71fb`).
The engineer must report committed checks and runtime reload status separately.

The owner liked C's “What should the team build next?” headline, then requested
top-level Tasks pinned as projects, with progress bars at the bottom of each
card. Keep that headline in the tightened visual pass. The workshop layout
below is the earlier recommendation, not the owner's selected composition.

Recommended updated order: shorter C hero and composer, **Pinned projects**,
recent followed threads with previews, and compact owner requests/live runs.
Marketing Designer has supplied tightened desktop and phone renders with
example pinned projects, plus a no-Buddy render. At 12:15 UTC the owner directed
Buddies UI Engineer to implement this and add a Home link above Threads.
Implementation is now authorized and owned by that engineer.

The engineer's announced v1 uses device-local pins with no server/schema
expansion. This is an implementation choice, not an owner preference for
device-local storage. Product recommendation: ship that version with the
limitation visible in the pin picker (“Pins are saved on this device”). Key
the ordered Task IDs by workspace, start with no pins, and never automatically
apply the designer's example selections. Keep the existing UI-preference
authority. Desktop and phone on different devices will not share pins in v1.
The earlier recommendation for shared persistence remains a possible follow-up,
not a blocker to the authorized home implementation.

### Pinned project cards

- “Pin to workspace home” applies to an existing top-level Task (`parentId`
  absent). Unpinning only removes its home placement; it does not change the
  Task, its ownership or its todos. No separate Project entity is needed.
- Each card shows the Task title, accountable Buddy, actual Task status and
  next action or blocked reason. Clicking opens the existing Task view.
- A thin bottom bar shows **done immediate child todos / non-cancelled
  immediate child todos**, with an explicit label such as “6 of 10 todos done
  · 60%”. This is a checklist count, not an estimate of time or effort remaining.
  Review, blocked and in-progress todos are unfinished. Cancelled todos are
  excluded. Nested descendants are not counted a second time.
- No todos: show “No todos yet” without a percentage. If all todos are cancelled,
  show “No active todos” without a percentage. Do not imply zero progress from
  a failed or incomplete data load.
- A full bar does not automatically mark the parent done. Its stored status
  remains visible until its existing completion criteria are accepted. Adding
  or reopening a todo can lower the bar because the scope changed.
- Keep completed pinned projects until explicitly unpinned, showing their
  status. This preserves the visible result of an initiative finishing.
- Recommended ordering: owner-controlled and stable. New pins append; let the
  owner move a pin earlier/later through a menu that works with keyboard and
  touch, alongside Unpin. Task activity never silently changes the order.
- Desktop shows the first four, with “Show all (N)” only when there are more.
  Expand the same section to show remaining pins; do not cap the number stored.
  On phone, the horizontal row can expose all pins in the same owner order.
- Segments may show done, in progress and blocked shares, all using the same
  non-cancelled denominator. Only done contributes to the displayed percent or
  accessible progress value. Include text counts for unfinished colored shares;
  color alone must not communicate their status. Remaining open/review shares
  stay neutral. A fully colored strip can still mean less than 100% done.
- Use the stored parent next action/blocked reason where available; otherwise
  show the first unfinished, non-cancelled immediate todo by stored position.
  Never invent a next step from a stale project description.

### Earlier persistence decision (superseded by the MCP-pinning request above)

Source inspection: `Task` has `parentId` and stored `status`; `list_tasks` in
`crates/unleashd-buddies/src/tasks.rs` returns all statuses, including completed
children. The existing workspace Task GET can supply parents and children in
one request. Group once by parent ID and derive progress from that response;
do not fetch every pinned card's detail or store a second progress number.

Current contracts have no home pin list. Recommended persistence is an ordered
list of existing Task IDs on the workspace, written only by the owner. This
would make the same selected initiatives appear on desktop and phone. Exact
before/after: workspace identity/path is currently stored without home pins;
add that one selection field with an empty default, plus a revision-checked,
idempotent owner write path to pin/unpin/order. Reuse workspace reads and the
existing change feed. No Buddy MCP changes or new execution authority.

The initial v1 used device-local UI prefs, avoiding server storage changes
but leaving selections separate between desktop and phone. The owner's later
explicit MCP-pinning request now authorizes work on shared Task pin state.
Use the current contract at the top of this brief; the old workspace pin-list
proposal here is historical, not an additional approval gate.

Visual examples must use actual parent/child counts or explicitly mark sample
numbers. Include a blocked initiative, a text-only project, no todos, no pins,
and narrow phone cards with the progress label readable.

Owner thread: `post_01a0f226-5fd0-70c7-b623-5b33f6adfef3` in #general.
Marketing Designer's current direction is the tightened C composition. This brief supplies
workflow and data constraints for that design. Implementation authority comes
from the owner's 12:15 UTC message, not this brief; this document does not claim
the screen has shipped or passed verification.

## The gap

The attached screenshot is the workspace's Channels home, not the all-workspaces
page at `/`. Its main pane repeats the channel names already in the rail.
Returning to a project gives the owner no work to inspect and no obvious next
step beyond choosing a channel.

The home should answer three questions: what can I pick up, does the team need
me, and where can I begin something? Let actual discussions and deliverables
give the page its character. Keep navigation in the existing rail.

## Earlier workshop composition

1. **Workspace identity.** Show the workspace name prominently, a quiet folder
   path, and a small row of Buddy sigils linking to their existing DM views.
   Give the content room without a large decorative banner.
2. **One clear action: “Start a conversation”.** Open the existing #general
   composer with focus; if that channel does not exist, offer a channel or Buddy
   choice. Show the destination before the user sends anything. Preserve the
   existing @mention rules. No automatic delegation from a new home input.
3. **“Pick up where you left off”.** Three recent followed threads, each with
   its real opening text, channel, participants, latest activity, reply count
   and a direct thread link. A genuine posted image can provide a preview;
   text-only discussions should still look intentional. Do not derive a
   “shipped” label from a confident Buddy reply.
4. **“Waiting on you”.** Compact unresolved requests addressed to the owner,
   with the requesting Buddy and an excerpt of the actual question. Open the
   original DM or thread to answer. Hide the section when there are none;
   unread messages and tasks in review are different facts.
5. **A quiet “Working now” strip.** Only current runs, linking into the existing
   workspace Buddy/worker view. Say running or queued according to stored
   state. Keep it secondary to the work itself.

On desktop, recent threads get the main column and requests a narrower adjacent
column. On phone, requests precede recent threads when present, followed by
the activity strip. No new permanent sidebar sections are needed.

Illustrative content from this workspace: the workspace-home design discussion,
the queue-stall handoff, and the Unleashd 2.0 launch script. These are examples
for the visual proposal, not assertions that they occur in the owner's current
followed-thread feed. A handoff explicitly awaiting merge must remain labeled
as a handoff, never as a completed fix.

## First-use and quiet states

For an empty workspace, show its name, the existing Buddies and “What would you
like to work on?” with the same conversation action. A brief helper can explain
“Choose a Buddy or post in a channel and @mention your team.” Channel creation
and Buddy creation remain the rail's existing actions.

For an established but quiet workspace, retain recent threads. No fabricated
activity, generic productivity slogans or empty statistic tiles. A loading or
failed inbox must not render as “Nothing needs you”.

## What current code can support

Inspected in the working checkout on September 30; no runtime verification of
these sources is claimed.

| Content | Existing authority / surface | Constraint |
| --- | --- | --- |
| Workspace identity and team | `/api/buddies/overview`, `useWorkspaceDirectory` | Keep workspace scoping; use existing DM routes. |
| Requests needing the owner | Workspace inbox, `inbox.requests` and `inboxRequests` | Requests are global in the inbox contract; filter to this workspace's channel IDs. |
| Recent followed discussions | `/api/buddies/workspaces/:id/threads` | This is followed threads, not all workspace activity. It orders unread first; any “recent” selection must deliberately sort by latest tail. |
| Images and linked work | Existing post bodies, `evidence`, `ChannelMarkdown` | Preview only actual attachments/links; no new artifact registry. Root text is available; reply content may require the existing thread endpoint. |
| Live runs | `/api/buddies/runs?liveInWorkspace=:id` | Finished execution does not establish Task completion. |
| Tasks, if later needed | `/api/buddies/tasks?workspaceId=:id` | Read status from Tasks; do not infer owner action from `review` alone. |
| Links | `channelLinkPath`, `postLink` | Preserve channel, thread and reply identity across desktop and phone. |

The lean first version can use these existing contracts. A complete cross-channel
results feed is a separate proposal: the current followed-thread response does
not provide every recent result or the text of each latest reply. Do not crawl
every channel and thread at every page mount to manufacture it. Any new aggregate
API would need its concrete contract and impact reviewed under CORE_DESIGN.md.

## Boundaries and review

The replacement target is `ChannelHomePane` in
`client/src/components/buddies/ChannelBrowser.tsx`, with the equivalent mobile
home rendering reviewed together. `WorkspaceHome.tsx` is the all-workspaces
screen and is outside this proposal.

The discussion/request/activity sections require no new Buddy controller,
summarizer run or memory write. The owner's later pinned-project request adds
the selection persistence proposal described above. Use the resource cache and existing push invalidation;
workspace switches must never display another workspace's content. Merely
previewing work on home must not mark its original channel/thread read.

Before building, compare Marketing Designer's visual directions against this
workflow. For an implementation, review actual desktop and phone screenshots
with populated, empty, loading and failed states. Verify that opening a card
lands on its exact thread, requests remain until answered, and worker activity
stays in the Buddy workspace UI.
