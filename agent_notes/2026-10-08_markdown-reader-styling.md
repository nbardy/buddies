# Markdown reader styling — 2026-10-08

Owner feedback: post_01a119fe-8c26-726e-9643-2459d30d2e81, attachment thread in #buddies-dev.

The file viewer inherited compact channel-message typography. Scoped document rules now provide a GitHub-style dark surface, 16px body text at 1.6 line height, a 32/24/18px heading hierarchy, section rules, blue links, muted blockquotes, code surfaces and striped tables. Desktop document width is capped at 980px; padding scales from 20px on phones to 40px on desktop. Channel messages retain their existing styling. The document still scrolls within the centered dim overlay, with a persistent filename/Download header.

Validation: read-only CDP session against the running app at localhost:7489, actual owner working-papers and previous file-viewer note attachments, desktop 1440×900 and phone 375×812. Visually inspected both sizes. Computed padding was 40px/20px; body text 16px and first heading 32px. Working papers rendered all 9 tables and overflowed only the document scroll area. Before/after screenshots are transient; final screenshots are copied into the owner thread. No TSX, file fetching or PDF-serving behavior changed. CSS ceiling increases only by this change's line delta; concurrent dirty CSS remains outside this commit.
