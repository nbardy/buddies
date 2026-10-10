# Starred rail spacing and worker placement

Local commit: 50f5b40 (not pushed).

Both shells share HighlightRow.css: an 8px margin appears only between a starred row and its following unstarred row. Buddy actions now render Wake, Star, then background workers, putting the existing running highlight at the far right.

Validation: pnpm typecheck passed. tools/check-workspace-navigation.mjs passed at 375px and 1440px with real data, including updated inspectChannelStarLayout guard (last-action geometry, count stability, boundary-only gap). Screenshot review exercised local stars and inspected desktop and mobile output. Transient WebP review captures removed after inspection. Stock screenshot before/after runs were obscured by fresh-profile onboarding, so their zero diff is not visual preservation evidence.

The four committed files exactly match the checked working files (git diff HEAD --exit-code scoped to them); HEAD contains the gap rule. Shared tree is dirty. Client invariants G1–G7 and G9 passed, G8 failed on existing shared-tree CSS line excess; this commit adds zero net CSS lines. No server/Buddy execution changes.
