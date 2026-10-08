# Shared channel/Buddy highlight rows

Owner follow-up: post_01a11c40-2a78-70a1-b7dd-2aefe8b491ec in thread
post_01a11bfd-5b3d-71b2-b0ab-294a6fda763c (#buddies-dev).

Replaces ddca73e's channel-only overlay and separate Buddy flex actions with
HighlightRow: one grid row owning its full-width selected/hover background,
one opener, and buttonsRight. Both desktop and mobile channel/Buddy rows use it.
Desktop builder rows also use it. Wake, worker link, star appear in that order.
The star is last and flush with the row's right edge; worker links reserve
48px and use tabular digits. Existing actions, navigation and local favorites
remain their original implementations. Removed ChannelStar.css and superseded
row positioning rules; styles now share HighlightRow.css. CSS total decreased
from 14596 to 14593; no ceiling increase.

Evidence on isolated branch ui/highlight-rows-20261009, base ddca73e:
- pnpm typecheck passed (full repo including client/server test projects).
- Final client tsc -b and client test-project typecheck passed.
- 24 focused tests passed: channel-stars, channel-browser, mobile-channels,
  buddy-background-tasks, buddy-background-visibility.
- All nine client invariants passed; git diff --check passed.
- Two tools/screenshots.test.mjs tests passed.
- Real read-only Chrome, isolated Vite 7493 against existing API 7499:
  1440px desktop and 390px phone, 20 channel/Buddy rows each.
  Every star right edge equals the row right edge (253px desktop, 374px phone).
  Every worker link is 48px wide. Desktop Buddy rows remain 26px tall.
  Counts 0, 1, 10 and 999 leave opener width and star alignment unchanged.
  Selected highlight lives on the entire row, including actions.
  Star clicks leave URL unchanged; hit-testing reaches the star.
  Reintroducing count-after-star ordering fails inspectChannelStarLayout.
  No server writes; session reported no blocked writes.
- Visually reviewed desktop/phone WebP captures, including selected Buddy,
  full-width channel bar, and restored inline archived-channel controls.
- Standard screenshot baseline/after ran: desktop 0.348% changed, phone 0%.
  Reviewed diff: desktop changes occupy right-side Buddy actions.
  Welcome obscured both standard captures; these are not claimed as a clean
  no-regression pass or primary visual proof. Custom unobstructed Chrome
  screenshots and geometry assertions provide the feature evidence.
- inspectChannelStarLayout is wired to screenshots and the real-browser
  tools/check-workspace-navigation.mjs regression check.
- Transient images and isolated Vite/worktree are removed at closeout.
No backend restart or push.

Keyboard follow-through: kept the prior behavior of showing Wake completion while
tabbing through the row; only mouse hover swaps the completion indicator for Wake.
