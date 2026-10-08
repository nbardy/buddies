# Visible Buddy action tooltips — 2026-10-09

Owner thread: post_01a11bfd-5b3d-71b2-b0ab-294a6fda763c; follow-up post_01a11c5f-52d1-7462-be36-3a578a230939 showed no tooltip.

The previous native title implementation (a848319) had correct DOM text but no demonstrated painted tooltip. Replace it with shared ActionTooltip for desktop and mobile Wake and worker links: immediate pointer/focus visibility, aria-describedby, Escape dismissal, pointer persistence over the text, and a body portal outside the scrolling rail. The component adds no layout wrapper, preserving the shared full-width highlight and far-right stars from c880926. Running/queued count authority stays in buddyWorkerCountsFamily.

Verification on the isolated current-source Cambium worktree:
- pnpm typecheck passed; final client tsc -b and test-tsconfig typecheck passed.
- 22 targeted client tests passed (buddy-background-tasks, channel-browser, mobile-channels).
- All nine client invariants passed (CSS 14606/14606).
- node tools/check-buddy-tooltips.mjs project_26fce156-5c5d-4dd9-a9d6-4b527a50af3c http://localhost:7493 passed real CDP pointer hover, visible in-viewport portal geometry, pointer persistence, focus, Escape and zero attempted server writes for both actions. Optional screenshots are WebP q95.
- wake.webp and workers.webp visually inspected and attached to the owner thread before transient cleanup.

Browser used an isolated Vite frontend on 7493 proxying the existing backend on 7499. No backend restart, production permission change, live DB access or push. The client source change becomes available through the existing Vite server after local integration; installed builds require their normal update path. Browser interaction evidence is desktop; mobile reuses this component and its render tests passed, but a phone hover interaction was not claimed.
