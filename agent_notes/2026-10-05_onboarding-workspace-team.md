# Welcome → Setup → Create your team

Owner: #buddies-dev post_01a10ac3-7391-70e1-8c4f-0ccf84149936.

Implemented locally (uncommitted): DependenciesPrompt is now a three-screen wizard.
The third screen uses WorkspaceTeamForm: folder autocomplete, project/team description,
then existing POST workspace → POST Builder(workspaceId) → correlated WS queue_message.
Navigation opens the setup conversation in that workspace's Buddy/DM surface after acceptance.
The Builder already supports team_admin staffing and selects the working directory's workspace;
no API, MCP, schema or briefing changes. Staffing creates Buddies; it does not start their work.

The empty-workspace New Buddy action opens the same creator on desktop and mobile,
with the existing workspace folder shown read-only above the description. Populated
workspaces retain the existing New Buddy behavior. A failed send retains the Builder
id and draft, and locks the folder so a retry cannot send into another workspace.
The folder must be nonblank even though PathAutocomplete reports a blank value as valid.

Files: client/src/views/dependencies/DependenciesPrompt.tsx,
client/src/components/buddies/WorkspaceTeamForm.tsx,
client/src/components/buddies/ChannelBrowser.tsx (also carries another session's changes),
client/src/mobile/channels/ChannelsMobile.tsx, tools/dependencies-layout.test.mjs.

Working-tree validation, not commit validation:
- Client tsc -b + Vite build and pnpm typecheck passed.
- Browser boundary regression passed: desktop/phone Welcome, Setup, team form,
  Back, Skip, Close/Escape, dismissal after same-origin fixture-server restart,
  Settings reopen, empty-workspace folder context and centered dialog.
- Dependency/workspace/view-boundary client tests: 5 passed.
- Real owner API regression 'builder opened from a workspace uses that workspace root': passed.
- Full client suite: 224 passed, 1 unrelated failure: channel-dm.test.tsx expects
  'Retry with a different harness', actual current button is 'Retry with model…'.
- Client gates G1–G7/G9 pass; G8 fails in concurrent shared CSS (14143 > 14077).
  This work adds zero CSS. Biome for this work and git diff --check passed.

Visual QA: inspected output/onboarding-2026-10-05/{welcome,setup,team}@{phone,desktop}.png
and empty-workspace-team@{phone,desktop}.png. Browser fixture is isolated/read-only;
no live team was created and no live agent was launched. Existing dev supervisor is running.
No commit, push or backend restart performed. RTK.md is absent in this checkout.

## Restyle (owner: "needs nice color box shadow, better text style and padding")
Card class `onboarding-card` in DependenciesPrompt.css (shared by the onboarding dialog and the
empty-workspace WorkspaceTeamDialog): 16px radius, blue/teal tinted surface, violet glow shadow,
Plus Jakarta gradient heading, numbered step pills, rounded fields with focus glow, gradient
primary button. On the Team step "Skip for now" is a quiet text button so "Kick off my Buddies"
is the only primary; the no-op "Welcome" back button is hidden on step 1. G8 ceiling +143.
Verified: tsc -b, vite build, tools/dependencies-layout.test.mjs pass, all 9 client gates pass.
Uncommitted.
Folder field is the shared PathAutocomplete (also New conversation + Workspace Home); dropdown tinted/rounded inside onboarding-team (+11 CSS, G8 ceiling 14298). Fixture screenshot verified.
Owner follow-up: hint moved into textarea placeholder, modal widened 420→560px (both dialogs); layout test bound 430→570.

## 2026-10-06: one form, onboarding lands on `/` (owner, #buddies-dev post_01a10d22)
Owner: `/` "doesn't look like Slack or the beautiful Home", cut "unleashd", and the onboarding
team modal and the create-workspace page should be ONE clean form; onboarding lands on that page.
- WorkspaceTeamForm is the only create form: folder → description → "Kick off my Buddies", plus a
  quiet "Just create the workspace" (folder only; name defaults to the folder; the Name field is gone).
- Wizard is Welcome → Setup; Setup's "Create your workspace →" dismisses and navigates to `/?new=1`
  (NEW_WORKSPACE_PATH in workspace-home.ts). Pill 3 "Workspace" names the page.
- `/` reuses ChannelLanding.css (.landing aurora hero, display type, card surface). The URL owns
  "creating" (`?new=1`), so arriving while already on `/` opens it; no workspaces → form always open.
- Wordmark removed from the page bar.
Verified (working tree): client tsc -b, vite build, 9 client gates (G8 ceiling +41),
tools/dependencies-layout.test.mjs (now asserts landing on `/?new=1` and the empty state),
client suite 230/231 (the known channel-dm "Retry with model…" failure). `pnpm typecheck` server
leg fails on client/src/utils/ids.ts `Crypto` (untouched file, pre-existing).
