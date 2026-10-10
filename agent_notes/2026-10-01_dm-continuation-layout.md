# DM continuation collapse

Owner report: #bugfixes post_01a0f63e-36dd-70c9-8a86-4331551155ac.

Cause: desktop `.channel-browser-message` uses a 36px gutter and a flexible text column. Channel continuations render a gutter time; DM continuations render only the content. Grid auto-placement placed that sole child into the 36px gutter. The previous width fix on the list did not prevent this.

Fix: explicitly place `.channel-browser-message-content` in grid column 2. Existing channel rows share the same placement. CSS line count stays flat.

Guard: `tools/lib/dm-layout.mjs`, called from the screenshot suite's DM view, compares lead and continuation text rectangles. For settled transcripts without consecutive messages, it temporarily probes a continuation using an existing real row/body and removes that probe before screenshot capture. It never changes server data. The suite records continuation counts and exits nonzero on layout failures.

Validation: all 8 channel-dm component tests pass. Product Development Lead DM inspected at 375, 768, 1024 and 1440px; guard passes at each size. Restoring `grid-column:auto` causes the guard to reject on both desktop-tree widths (1024 and 1440). Desktop and phone pictures visually inspected. Pictures: /tmp/dm-collapse-proof/*-after.png. Screenshot suite run: /tmp/dm-collapse-guarded.

Biome and git diff checks pass. Client invariant gates pass except G8: checkout already has 14006 CSS lines against a 13987 ceiling; this fix adds zero net lines. No backend changes or reload needed. Changes remain local/uncommitted. tools/screenshots.mjs already had unrelated dirty changes when this turn began; preserved those changes and did not stage them.
