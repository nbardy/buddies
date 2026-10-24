# Task checklist and progress at the top

Owner request: #buddies-dev post_01a10b32-19aa-72f7-9367-f6e54b922156.

TaskPage now renders an expanded Subtasks section directly after the title/status/owner, before next action, criteria and discussion. Open task rows are visible; completed/cancelled rows and Add subtask stay disclosures. Home and TaskPage use one TaskProgress component and projectProgress counting (done / non-cancelled direct children). No new state or server API.

Modified existing dirty TaskPage/test files without staging or committing them. Existing earlier task-page work remains included in those files. New TaskProgress.tsx/CSS extracted Home's existing rendering/styles; Home imports the shared component. The screenshot task discovery now chooses a real checklist and task preparation dismisses onboarding/install overlays.

Validation: focused rendered task + Home tests 6/6 pass; pnpm typecheck passed; full client 224/225 pass, unrelated channel-dm retry test expects “Retry with a different harness” but rendered text is “Retry with model…”. Client invariants initially passed all nine, including CSS 14309/14310. A later rerun failed CSS budget after concurrent onboarding edits grew the shared tree (14356/14315); other gates passed. No commit verification claimed.

Screenshots: initial baseline and compare were obscured by onboarding (not usable visual preservation evidence). Corrected read-only phone/desktop capture: output/screenshots/2026-10-05T08-38-50. Phone reviewed: real task 16/16 completed, 100% green bar immediately under heading and before next action. Manifest records sigil-worker requests still open after 20s; screenshots render the task itself. No claim of a zero-pixel baseline comparison.
