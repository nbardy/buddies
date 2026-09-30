# Task page and task discussion

Owner request: #channels-feature, post_01a0f3d9-eedd-7775-83d3-c8e8fb3bc72f.

Gap: Home task links opened a cross-channel message filter, hiding the actual Task detail.
The existing task-comment form was plain text, and the server deliberately skipped task-channel
mention dispatch. No new database model, API or MCP contract was needed.

Implemented a shared TaskPage for desktop/mobile using the existing task detail API, task post
feed, ChannelMarkdown and ChannelComposer. The page links its parent project and child tasks,
keeps criteria/evidence/settings available in a disclosure, displays paged chronological
comments, and keeps the composer visible while the detail scrolls. Reply targets retain their
own channel and root, including public-channel posts associated with this Task. Task links also
work without a public channel in the workspace. The Home link edit was included by a concurrent
Home-polish commit (7358800); it is present at HEAD.

Task-channel posts now use the existing bounded mention/seat/follow-up dispatch. A real temp-store
server integration test confirms a mentioned Buddy writes its reply in the same task thread,
with the task id preserved. The live backend needs its next safe source reload to run this code;
no restart was forced while agent turns were active.

Validation of the local changes:
- pnpm typecheck passed; client tsc -b plus the client test tsconfig also passed.
- 13 focused client tests passed (task page, mobile channels and prior task comments).
- 3 focused server boundary tests passed (task mention, DM reply, seat authority).
- Biome for the changed source/tests, git diff --check and all 9 client invariant gates passed.
- Real phone/desktop screenshots were rendered and inspected. The phone review caught grid
  intrinsic-width overflow in long comment paths; min-width: 0 on the list and items fixes it.
- Screenshot artifacts: output/screenshots/2026-09-30T20-06-04 (phone detail and discussion plus
  desktop detail). Earlier complete four-shot run: output/screenshots/2026-09-30T20-02-57.
  A final run is being captured with the corrected discussion-only internal scroll prepare.

The additions to tools/screenshots.mjs remain unstaged because that file already contained
another session's changes (Home lower-section capture and image-viewer repair). No partial-file
staging or unrelated changes were included. No push was requested for this change.
