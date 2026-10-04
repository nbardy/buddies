# Thread model priority and retry — 2026-10-04

Owner request: #bugfixes, post_01a10591-4820-76f7-a8cb-4274a895817a.

Concrete gap: thread follow-up checks could keep a derived seat configuration even when the
Buddy most recently posted into that thread from another conversation. Gate failure text did
not match the retry classifier; retry additionally forbade the entire failed provider.

The existing channels seat authority now selects an explicit picker choice first; otherwise
it reads this Buddy's most recent non-failure post with a live conversation reference, working
backward through the thread. It uses that conversation's saved execution config. Without one,
it keeps the remembered thread seat (@mention choice), then uses the Buddy profile. The picker,
follow-up decision, and resulting reply share that selection. A provider switch still opens a
new seat; a model/effort switch on the same provider resumes the seat. No new store/schema/API.
This selects the next execution config; it does not fabricate per-message historical model
attribution. Deleted/unavailable conversation references are skipped.

Decision resolution exceptions now leave a visible failure notice. Decision failures on
Buddy-authored follow-ups also surface. Notices are not announced and cannot cause gate loops.
Failed decision checks and unavailable-model errors share ReplyRetry. Its model picker allows
all Buddy-capable providers, including a different model on the same provider. Clicking Retry
explicitly asks for an answer to the original message; it bypasses the optional yes/no check.
The old notice remains. Existing in-flight retry deduplication and trigger authority remain.

Validation artifacts:
- server/test/buddies-v2.test.ts: real temp-store/MCP/runtime integration for external latest
  reply model, explicit override, remembered subsequent choice, gate exception visibility,
  Buddy-authored gate failure, HTTP retry on another model of the same provider.
- client/test/reply-retry.test.tsx: rendered retry buttons for the exact weekly-limit envelope,
  decision timeout, unavailable model and token exhaustion; unrelated prose/errors excluded.
- Screenshots: output/screenshots/2026-10-04T06-25-40/thread@desktop.png and thread@phone.png
  visibly show Retry with model under a real weekly-limit notice.
- Normal thread baseline output/screenshots/2026-10-04T06-21-43, comparison
  output/screenshots/2026-10-04T06-24-47/compare.html: 0/2 screenshots changed (0%).
  Runs reported the long-lived sigil worker request as still loading after 20s.
- Client focused checks: 17 passed. All 9 client invariant gates passed. pnpm typecheck passed.
- Full Buddy integration run: 39/40 passed; one existing briefing test hit ENOTEMPTY while
  deleting its temporary directory. The full rerun emitted 40 passing test outcomes but did
  not exit (a retained handle); it was stopped. Do not call the broader suite clean. Focused
  final regression execution: 6/6 passed (priority, gate exception/retry, thread seats,
  DM new-chat fixture, effort/session preservation and duplicate harness retry).
- pnpm token-audit --days 1 --tag channel: no matching sessions; no measured cost conclusion.

Test repairs during verification: HTTP retry accepts with 202, not 200; channel replies attach
to the thread root while answering the quoted trigger. The existing new-chat HTTP fixture
omitted its now-required idempotency key; the fixture now supplies it.

Deployment: frontend screenshot uses live Vite source. Backend takes the change at its normal
idle reload boundary. No forced restart or live retry was performed; active owner turns remain
under their existing server. No push.
