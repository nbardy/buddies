# Task page reading rework

Owner request: #ui-design post_01a100dc-ca93-7146-8c42-31537ea52c47. Screenshot shows TaskPage, not workspace Home. The giant experiments list is raw task evidence (file paths, commits, post ids).

Local changes: remove raw task and comment evidence arrays from the reading UI, keep stored data intact; compact task-specific typography/spacing, no Home composer glow; next action and blocker before completion criteria; expandable five-line long briefs; discussion before collapsed subtasks and execution history. Existing task edits and comment routing preserved.

Files: TaskPage.tsx, BuddyDetail.css, task-page.test.tsx. In the already-dirty screenshots.mjs, corrected the task-discussion selector from an arbitrary h3/parent to Discussion h2 and its actual scroll pane; all pre-existing edits retained.

Validation: focused task render tests 2/2; pnpm typecheck (before final copy-only edits), final client tsc -b; all nine invariant gates; Biome for changed TSX; git diff --check. Direct read-only CDP verified Read more expands actual content and Show less returns preview. Desktop/phone final images inspected: output/screenshots/task-rework-final/{desktop,phone}.png.

Four screenshot views captured with no skips in output/screenshots/2026-10-03T08-27-13. Baseline comparison exits 1 because this deliberately changes 14–22% of pixels; not a zero-diff consolidation. Sigil worker requests stayed pending on desktop in the existing screenshot runner. Initial task-discussion selector skipped after evidence removal; fixed and rerun with no skips. Source shared tree was already dirty, so this is local working-tree verification, not commit verification. No commit or push made.

## Follow-up: shared styling and exact owner task

Owner clarified the task pages should share styles/components and supplied task buddy_project_89bc73e6-9e8d-4c97-84c9-94267c15d9c2 in wave_sim/general. Read-only CDP captured that exact route before and after, both desktop and phone. Final images: output/screenshots/task-shared-style/{desktop,phone}.png. Both inspected.

TaskPage now imports TaskPage.css (layout only), not ChannelLanding.css. Shared ui-section headers, ui-choice controls, ui-badge status, ui-card/surface and ChannelComposer. Discussion uses shared ChannelRows.LeadRow (with a slot for task reply controls), giving the same author/DM action, timestamp, instance provenance, copy-link toolbar, retry and markdown as channels. TaskRows shared by BuddyWork/TaskPage now uses its own task-line classes and shared controls, not Home landing classes. Task-specific CSS removed from BuddyDetail.css; only shared TaskRows style stays there. Long brief previews are three lines.

Regression: task fixture includes a real post and raw evidence, checks shared message toolbar/reply and no Home style classes/evidence dump. Existing channel-restored Task filter test expected a retired picker and had no task detail resource; updated to exercise full task route and actual cross-channel permalinks. 14/14 task/channel/channel-restored render tests passed. Final client tsc -b passed; all nine gates passed (CSS 13970/13987), Biome and diff checks passed. Still local/uncommitted; tracked tree is dirty and not a verified commit.

## Follow-up: hierarchy still hard to read

Owner said the hierarchy remains rough. Changed the actual section structure: title/status header, dedicated Next action surface using ui-surface/ui-card and an accent edge, optional Blocker section, separate Done when criteria, then Discussion. Removed the redundant Task brief caption. Section headings use normal case, 18px token, full text-emphasis contrast; brief body uses 15px token; desktop title uses 32px token (phone 24px); task discussion removes redundant channel horizontal padding. Preview/copy actions and shared channel rows remain.

Exact owner task captured before/after via read-only CDP on desktop/phone. Inspected output/screenshots/task-hierarchy/{desktop,phone}.png; action surface and criteria/discussion separation visible. 14 task/channel tests passed; strengthened task render fixture with action and blocker and semantic reading-order guard, then focused 2/2 passed. Final client tsc -b, Biome, diff check and all nine UI gates passed (13975/13987 CSS lines). Local working tree only, no commit/push.
