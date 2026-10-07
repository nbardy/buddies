# Copied mentions: diagnosis and proposed replacement

Owner question: #buddies-dev post_01a11730-9da5-77ab-8f97-5683504be9de.
Status: source-confirmed diagnosis and proposal; no implementation or browser verification.

## Current workflow

`ChannelComposer.tsx` owns visible `text` and separate `picked` references. Autocomplete
updates both. The native textarea paste updates only text; its paste handler handles files
only. `channel-text.ts` derives highlighting and send encoding from `pickedReferencePattern`
over the hidden picks. `mentionedBuddies` also requires a picked entry even when pasted
text already contains a canonical Buddy token. Drafts persist text plus picked snapshots
(`shared/src/buddy-channel-posts.ts`), but the clipboard carries no such application state.

`ChannelMarkdown.tsx` renders stored `[@Name](buddy:id)` as a named React Router link.
The textarea consumes plain clipboard text, not that link's identity. Selecting rendered
text and pasting therefore loses the identity even if the browser also supplied HTML.
No claim here about what the external Slack application actually put on the clipboard.

The server also has two ingress policies: MCP `post` calls `resolveMentions` against the
workspace roster; `publishOwnerPost` in `routes.ts` canonicalizes media, but not names.
It computes wakes from canonical link syntax only. Thus plain owner `@Name` is not rescued
by the October 6 tool-post fix.

## Proposed replacement

One draft document owns reference identity. A reference segment is
`{kind:'buddy', id, label}` or `{kind:'task', id, label}`; ordinary text is
`{kind:'text', text}`. Example: text `Ask `, Buddy `{id:'buddy_…', label:'Product Development Lead'}`,
text ` to review`. Model overrides remain a separate map keyed by Buddy ID, because execution
configuration is a different fact. Current model/status data comes from the existing directory.

Autocomplete inserts a reference segment. Paste is one ingress adapter: preserve known local
reference IDs from canonical markdown or recognized app links; for plain `@Name`, resolve only
an exact unique workspace name. Unknown/ambiguous names remain ordinary text, with a resolution
notice when appropriate. Never equate a Slack user ID with a Buddy ID. Code and email are text.

Highlighting, chips, draft persistence and Markdown serialization derive from that document.
Send serializes once to the existing stored Markdown contract; no post-store migration or new
delivery controller. Clipboard text stays readable; rich clipboard data preserves references
for local round trips. Browser selection boundaries and textarea/display offset mapping need
explicit implementation work, not an assumed free conversion.

Share the name-resolution definition across client preview and both server ingresses, with
server workspace/authority validation before storage and wake creation. Dispatch reference
segments exhaustively by kind; text needs no identity lookup. Server remains authoritative
about which current recipient can be addressed.

Retire draft `picked` snapshots, label-based `pickedReferencePattern`, and send-time
`encodeReferences`; replace `mentionedBuddies` with IDs derived directly from the document.
Keep directory ranking, model choices, task references, attachments, outbox and idempotency.
Migrate existing device-local drafts at read time, retaining explicit picked identities.

## Preservation evidence required

Real browser copy → paste → highlight/chip → submit → stored canonical body → one delivery,
on desktop and phone. Include duplicate names, renamed/removed Buddies, IDs copied across
workspaces, partial selection, multiline/code/email text, repeated mentions, canonical tokens,
draft restore and explicit model choices. API tests must prove owner and MCP paths apply the
same resolution and replay creates no second delivery. Required screenshot review still applies.

This is the complete replacement design, not a claim that a rich editor is already implemented.
An interim resolver-only change should be described as a repair, not removal of dual draft state.

---

## Implementation decision (2026-10-08, owner-authorized): the draft IS the canonical Markdown

Leaner than a segment document, same ownership. The draft is ONE string in the stored-Markdown
contract (`[@Name](buddy:id)`, `[Title](task:id)`). The textarea shows a projection (token → `@Label`);
an edit is a splice of the old display range into the raw string, and a splice that lands inside a
token dissolves only that token to plain text. Why not segments: a segment array needs a second
parser for the stored contract and a second serializer; the Markdown string already has both
(render, wake, MCP). Identity therefore lives in text only — no `picked` snapshot exists to drift.

One shared module, `shared/src/body-references.ts`, owns interpretation for composer, owner route
and Buddy MCP: `pieces` (tokenizer: text | opaque code/link | buddy | task), `findNames` (exact unique
roster names, longest first, word boundary, code/email/link protected, ambiguous stays text),
`resolveMentions` (= canonicalization: tokens validated against the roster and relabelled to the
current name, unknown/foreign ids dissolved to text, then names resolved). Mention IDs for wakes,
chips and highlight all derive from `pieces`+`findNames`.

Deleted: `picked` in draft state/schema (read-time migration only), `pickedReferencePattern`,
`encodeReferences`, `composerReferenceMarks`, `mentionedBuddies`, `completesPickedReference`,
`insertReference`, server `resolveMentions`/`mentionedBuddyIds` bodies (moved to shared).
Clipboard: composer copy/cut writes `text/plain` (display text) + `text/html` with
`<a data-unleashd-ref="buddy:ID">`; rendered mentions carry the same attribute. Paste reads the
anchors' IDs in order, matches their `@Name` text in the plain text, then canonicalizes.
