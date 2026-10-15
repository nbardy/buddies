# Markdown viewer actions — 2026-10-15

Owner request: post_01a13e1f-dd22-7570-a365-3dbf922202a6 in #general.

The shared channel document overlay now groups Download and Copy at the top right. Copy reads the same keyed text resource as the rendered document, stays disabled until text exists, and uses the existing clipboard action with Copied / Copy failed feedback. File-keyed mounting resets feedback when switching documents. Download keeps the authenticated file URL and native download behavior.

Validation against the running dev app at localhost:7489, using the real CORE_DESIGN.md file:
- Read-only CDP, actual ChannelMarkdown inside the app's Jotai Provider, at 1440×900 and 375×812; both screenshots visually inspected.
- Real browser gesture produced Copied. The argument sent to the native clipboard exactly matched the file HTTP response. Download points to that same file. No blocked backend writes.
- Repro and screenshots: output/screenshots/markdown-actions-20261015/{check.mjs,desktop.png,phone.png} (gitignored).
- pnpm typecheck passed; 14 targeted channel-markdown/channel-text tests passed; biome check and git diff --check passed.
- Client invariants G1–G7/G9 passed. G8 is already over budget in the concurrent dirty tree; this change adds one CSS line. The existing shared-tree overage was not absorbed by changing the ceiling.

Checks above ran in the shared dirty working tree. Commit inspection must confirm the new component, header wiring, CSS class, and pre-existing useCopyAction/useFileText dependencies; this is not a claim of a clean full-suite commit run or packaged deployment.
