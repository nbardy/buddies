# Markdown and PDF file viewer — 2026-10-08

Owner request: post_01a119f3-f2c0-7745-af18-c7dc74fd8e02, thread post_01a119e8-3ffc-74f9-b0e8-27479ef60397 in #buddies-dev.

Extended the existing channel image dialog into one file overlay. Ordinary local Markdown/PDF/image/video links open it on an unmodified primary click; modified clicks retain the link destination. Markdown uses the existing GFM/highlighted-code pipeline and keyed `text:<url>` resource cache, with loading/error/retry and stale-content retention. The centered document pane has its own scroll area and persistent filename/Download header. Images retain their previous sizing and dim background. The same component serves desktop and mobile channel posts, threads, Task comments and DMs.

PDFs use the browser's native viewer in an iframe. The existing authenticated /api/files route allows uploaded PDFs to opt into inline delivery with preview=1; all other non-media uploads remain downloads, even with that query. Default PDF links still download. No PDF rendering package, new endpoint, schema or database change. Native PDF rendering depends on the browser; Download is always available. Browser guidance: https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe.

Validation:
- pnpm typecheck passed after the concurrent Buddy test-file merge was resolved.
- channel-markdown.test.tsx + channel-text.test.ts: 14 passed, zero failures/cancellations/skips.
- channel-file-preview.test.ts: real HTTP file delivery, PDFs inline only by opt-in, default downloads, HTML/SVG/Markdown/ZIP remain downloads, nosniff, and permission boundary; 1 passed.
- Read-only CDP checks against the running Vite app used the owner's actual 00_Complete_Working_Papers.md attachment, inside the app's Jotai Provider. On desktop: 25,903px content within a 742px scroll area; phone: 56,361px within 654px. Both rendered the document heading and 9 tables, scrolled to 1,000px, closed, reopened instantly from cache, and handled cancel. A missing file displayed Retry.
- Native Chrome PDF viewer visually inspected at 1440x900 and 375x812 using a valid one-page PDF fixture. This is Chrome at phone dimensions, not installed iOS/Safari validation.
- Phone/desktop Markdown and PDF screenshots captured as WebP q95 and visually inspected. Temporary files are removed at closeout after sharing preview evidence in the thread.
- Shared-tree invariants: G1-G7/G9 pass, G8 has the pre-existing +122 dirty CSS overage. Committed CSS before this change is 14,449; this owner's requested document surface adds exactly 37 lines and the ceiling advances to 14,486. Verify the clean committed tree separately; do not sweep concurrent CSS changes into this change.
- git diff --check passes. No push or packaged-release claim.
