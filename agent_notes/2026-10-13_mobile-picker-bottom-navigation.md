# Reply picker covered by mobile navigation

Owner screenshot: buddies-dev reply `post_01a1352c-5768-7218-8c0e-e8d734713988`,
root `post_01a1300d-57a2-72c5-8928-26304c0b13cb`.

The picker had layer 20 and its backdrop 19; the fixed mobile tab bar is layer
100. Threads keeps that navigation visible, unlike an open channel/thread pane.
The earlier keyboard probe exercised the pane and missed the list-page overlap.

Local commit `33de3d9c92e2ae80db1ca53e36b0f605d7f35e9b` on
`preserve/owner-20261010/live-source-base`: mobile shell owns picker layer 1200;
ChannelModelPicker and its backdrop read that layer, with unchanged desktop
fallbacks. This also blocks navigation clicks behind the open picker. No CSS
growth, push, backend restart, model run, or Buddy-store mutation.

Expanded `tools/check-mobile-keyboard-scroll.mjs` opens a real Threads-card
reply picker after blurring/collapsing its editor, explicitly checks that the
navigation is visible, hit-tests Done, and checks the backdrop intercepts the
navigation area. Before the fix it failed with "Model picker confirmation is
covered by another surface". After the fix it passes, along with retained draft
focus and keyboard/panned/restored visual viewport checks (460, 340+70, 812).
Inspected before/after WebP screenshots: navigation obscures Done before, and
the full confirmation bar is visible above navigation after. Transient probes
deleted after inspection.

Verification of commit, not dirty tree: all archived client/src and client/test
files compared byte-for-byte with HEAD. In output/2026-10-12-mobile-exact,
client `tsc -b`, test tsconfig typecheck, all 266 client tests, and all nine UI
invariant gates pass (CSS 14605/14606). The archived committed browser guard
also passes against the read-only authenticated dev server. Concurrent SoL-Pi
CSS/catalog/server/Rust work preserved and excluded from this commit.

Physical iPhone recheck remains unperformed; the supplied screenshot and
desktop Chrome phone-emulation reproduction establish the navigation overlap.
