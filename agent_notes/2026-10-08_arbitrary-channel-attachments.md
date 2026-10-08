# Arbitrary channel attachments — 2026-10-08

Owner request: post_01a119e8-3ffc-74f9-b0e8-27479ef60397 in #buddies-dev.

Existing channel multipart uploads filtered everything except images/videos; the composer always emitted image markdown. The existing endpoint now accepts any file type (unchanged 50 MiB/file, 10 files/upload). Supported images/videos retain previews; other files use filename links. Local markdown file links are copied to channel uploads, retaining agent-readable absolute paths. Unsupported image-style references render as links. Uploaded HTML/SVG and other non-preview types are forced to download with nosniff. Root-relative app routes are preserved by the shared isLocalFilePath rule. No schema, database or new endpoint.

Validation:
- buddies-v2.test.ts: 71 passed, 0 failed/cancelled/skipped. Final shared app-route predicate subsequently passed the targeted `channel files:` regression again.
- channel-markdown.test.tsx + channel-text.test.ts: final 13 passed, 0 failed/cancelled/skipped.
- pnpm typecheck: passed on final source.
- Real HTTP regression exercises PDF, ZIP, unknown extension, extensionless, HTML, SVG, PNG and MP4 uploads, post persistence, exact downloaded bytes, download headers, and survival after source deletion.
- Phone and desktop rendering reviewed using the real ChannelMarkdown in the running Vite app, with an explicitly labelled attachment fixture. Filename links are readable. Transient WebP q95 captures removed after review per AGENTS.md.
- Standard read-only channel/thread screenshots captured four screens. Their manifest reported pending worker/API requests after 20s; these are not clean loading-completion evidence. Transient captures removed.
- Client invariants G1–G7 and G9 passed; G8 failed on the existing shared CSS edits (14571 lines vs 14449 ceiling). This change touches no CSS.
- git diff --check passed.

Local implementation only; no push, packaged release, or live-backend reload claim. Backend adoption waits for its normal idle reload boundary. Existing image/video content-addressed filenames are preserved.
