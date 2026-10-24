# Thread model loading recovery — 2026-10-06

Owner report: #buddies-dev post_01a1118d-4b3a-713d-ba2d-2a9a204ebd16.
Affected thread: post_01a1102e-8324-72d6-8b9d-ee835717bcca, wave_sim #general,
Product Designer mention. Screenshot showed Loading model… and disabled Send.

## Evidence and limits

- Prior fixes e22ca8a and 49ea2a2 are present: every reply composer reads its own
  thread seats; failed HTTP reads map to a retryable model state.
- The live thread GET returned 200 with Product Designer's Claude seat. Both
  localhost:7489 and unleashd.localhost serve the composer with useThreadSeats.
- A fresh read-only CDP session on that exact permalink resolved the mention to
  Opus 5.5 and enabled Send. No post was submitted. The owner's original stuck
  tab had since navigated to a DM, so its original pending request is unavailable.
- Owner Chrome's tab logs contained repeated FILE_ERROR_NO_SPACE errors at
  14:12:42Z. This is a possible related environment issue, NOT proven to have
  caused the original model read to hang. cleanup_tools/disk.py status now reports
  16.3 GiB free; no cleanup was performed.
- During a later browser pass, Vite module requests also stalled temporarily;
  the successful repeat reached network idle and resolved the model.

## Defect reproduced and fixed

The shared resource cache had no deadline. A loader that never settled owned its
inFlight key forever: polls, reconnect reads and manual retries joined the same
promise. Separately, any loader AbortError was silently ignored even when the
cache's own controller was not aborted, leaving first-load state indefinitely.

Commit c9f9723 bounds every read to 30 seconds. It reports failure (retains cached
values as stale), frees the shared slot, and aborts the obsolete request. A late
answer cannot overwrite a retry. Only explicit cache cancellation suppresses
errors. Existing thread-seat failure rendering offers Model unavailable · retry
and allows Send, leaving server-side seat resolution authoritative.

This fixes demonstrated ways to get stuck, but the exact historical trigger for
this screenshot remains unconfirmed. No claim that Chrome disk errors caused it.

## Verification

- 240 client tests pass, including hanging-loader, retry/late-answer and AbortError
  regressions plus existing thread-seat rendering tests.
- pnpm typecheck passes (client tsc -b); nine client invariant gates pass.
- Biome passes for the two changed files.
- git diff HEAD for both changed files is empty after commit; HEAD contains the
  timeout and regression tests. Unrelated untracked agent notes remain untouched.
- Local dev serves the client change; no backend restart is needed. Not pushed.

Result posted as post_01a11194-0956-765a-b44b-28904faed2bc. Screenshot copied by
post tool to ~/.agent-viewer/uploads/channels/list_4bd52262-8f0b-465d-99e5-60cc33eb8565/997ef9371562abb80fdb70bcaffe4964.webp.
Transient browser probe and image dumps removed after posting.
