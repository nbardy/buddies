# One reply failure status for DMs and channels

Owner request: #general post_01a1e904-8e1f-75fe-80a9-bea275326ad6.

DM system records previously rendered eleven permanent red errors for one failed response.
One status now replaces consecutive errors in an owner turn, says Retrying while the turn runs,
offers Retry after it stops, and disappears on explicit success. Manual retry uses the existing
conversation queue; alternative-harness retry preserves the existing new-DM generation path.
Channel failed replies use the same ReplyStatus component through ChannelPostContent in both
shells. The channel projection keeps the latest failure per trigger/Buddy and hides it when an
answer replaces it; durable posts are retained. Network/routing failures now qualify for the
existing channel retry endpoint.

Related corrections: reconnect notices no longer set a terminal failure hint, so a recovered
provider turn can succeed. Empty assistant headers and redundant replying indicators are removed.
Successful process notices no longer appear as red failures. Failed latest-attempt fallback text
keeps provider/token failures visible after restart. Obsolete failure-only markdown CSS was removed;
shared card/row/stack primitives keep CSS under the existing ratchet (13486/13490 lines).

Validation:
- `pnpm test`: passed (package build/smoke, 79/79 server processes, 272 client tests,
  dev supervisor, tools, agent-cli and 16 API checks; one agent-cli test skipped).
- `./tools/check.mjs` on every changed source/test path: passed.
- `bash tools/check-client-invariants.sh`: all nine gates passed.
- New regressions: conversation-runtime `reconnect recovery completes successfully instead of
  retaining a provider failure`; channel-dm `DM retry lifecycle replaces reconnect errors and
  clears the widget on success`; `channel reply status recovery keeps one failure per trigger
  and removes it after an answer`.
- Real reported Research Lead DM inspected on desktop and phone, read-only Chrome session:
  `output/reply-status/desktop.webp`, `output/reply-status/phone.webp`.
- Screenshot loop: `output/screenshots/reply-status-before` → `reply-status-after`: both DM sizes
  and desktop thread identical; phone thread had a text/sigil raster difference (2.770%, no layout
  movement). Immediate repeat `reply-status-after` → `reply-status-confirm`: all four 0% different.
  Sigil-worker requests remained pending in the screenshot manifests. No live Buddy work retried.

The original provider routing failure can still recur; this change fixes presentation/recovery and
false failed outcomes after reconnect recovery, not the external routing service.
