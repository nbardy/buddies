# HTML channel file viewer — 2026-10-08

Owner report: clicking the Great Wave exploration HTML attachment in post
post_01a11b45-525c-75da-8207-49bf7affff29 downloaded it.

HTML/HTM local paths and authenticated file links now open the existing channel file overlay.
HTML is fetched through the keyed text cache and rendered as srcdoc in an opaque-origin iframe
(sandbox allow-scripts allow-downloads; never allow-same-origin). Standalone HTML scripts work,
while access to the parent document/cookies and persistent origin storage is denied. The Great
Wave page catches unavailable localStorage and offers Export. Fragment navigation uses an
about:srcdoc base. Relative external assets are not resolved against the attachment directory;
this owner-linked page embeds its assets. Download retains the original authenticated URL.
The server's HTML/SVG attachment delivery policy is unchanged.

Validation: 10 channel Markdown tests, 4 channel text tests, server file-delivery test and
pnpm typecheck passed. The shared-tree invariant check passes 8/9 gates; G8 fails on pre-existing
concurrent CSS changes (14709 vs ceiling 14587); this change edits no CSS.

Browser regression: tools/check-channel-html-viewer.mjs accepts BASE_URL PAGE_PATH LOCAL_HTML_PATH
OUTPUT_DIR. It uses the repository's read-only CDP session and closes Chrome in finally. Real
owner-linked page checked at desktop 1440x900 and phone 375x812: open/close, Download href, scripts,
57 generated select options, Swap button behavior, parent-document denial and fragment base.
Screenshots posted to the owner thread; transient output removed after posting.

Commit 969e585 was checked directly with git grep for the classifier, overlay and text-hook
references. Its archived client source passes all nine invariant gates (14587/14587 CSS lines).
Browser results are retained in agent_notes/2026-10-08_html-channel-file-viewer-checks.json.
