# Mobile picker keyboard and tap-to-top

Owner request: buddies-dev root `post_01a1300d-57a2-72c5-8928-26304c0b13cb`.

Local commits on `preserve/owner-20261010/live-source-base`: f32558e (implementation),
27f700d (browser guard accounts for older-history paging), a1cd28a (existing rendered
channel test expects the new accessible title action). No push or deployment performed.

Changes:
- Channel reply picker and mobile conversation settings sheet follow VisualViewport
  height/offset, keeping confirmation above the keyboard while options scroll.
- Opening the channel mention/model chip no longer explicitly blurs the draft;
  pointer-down preserves focus.
- Mobile list pages, including Threads and Channels Home, scroll the document rather
  than a nested overflow container. The bottom navigation stays fixed. This removes
  the page lock that prevented the browser's native status-bar tap-to-top path.
- Open channel/thread panes retain their pinned composer and gain an accessible title
  button that jumps to the top of loaded history and disables bottom-following.
  Older history still pages through the canonical feed and preserves reading position.
  Native OS status-bar behavior in these inner panes has NOT been demonstrated.

Validation:
- Exact committed client source archived at output/2026-10-12-mobile-exact, with only
  dependency symlinks to the working checkout. Updated guard/test files match the two
  follow-up commits; application source is unchanged after f32558e.
- All 266 client tests pass; client `tsc -b` and test tsconfig typecheck pass.
- All nine client invariant gates pass on committed source, CSS 14605/14606 lines.
  Dirty checkout's unrelated Buddy/Task CSS exceeds the ceiling; preserved untouched.
- `node tools/check-mobile-keyboard-scroll.mjs project_88cdc98e-13d1-426a-9544-7e7830a2b5c6 list_3c37ba8c-cf15-49e0-bd3b-7e2e605e538e`
  passes against the read-only authenticated dev browser: document scrolling, real
  channel-title hit testing and synchronous top jump, no repin after history load,
  retained draft focus, Done hit-test/geometry at visual viewport height 460,
  height 340 + offsetTop 70, and restored height 812.
- Inspected actual phone screenshots of the channel and short-viewport picker.
  Temporary WebP probe images deleted after inspection. The standard before/after
  screenshot runs contained a Welcome overlay; their list diff is not valid visual
  preservation evidence. No real iPhone software keyboard/status-bar gesture test.

No model workers started, backend restarted, Buddy data mutated, or remote branch pushed.
