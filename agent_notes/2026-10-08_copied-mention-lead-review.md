# Copied mentions — lead review

Candidate: `55cd36c8f7cbea9547886f3553baea0a09ac9a7c`.
Owner thread: post_01a11730-9da5-77ab-8f97-5683504be9de.
Task: task_01a11762-b1be-7450-b15d-8668367bc270.

The lead read committed shared resolver, composer draft and owner route using `git show`.
The chosen replacement is one canonical Markdown draft plus a display projection; picked
identity snapshots and send-time label substitution are retired. Shared resolution precedes
owner model-config validation and wake extraction.

Independent visual inspection: `desktop-1-plain-paste.webp` shows the pasted Product
Development Lead name highlighted and its GPT-6.1 Sol chip below the textarea; email and
inline code remain unhighlighted. `phone-3-real-copy-paste.webp` shows the copied Buddies
Development Lead name highlighted in the fullscreen composer with the Opus 5.5/high chip.
The worker's report.json records matching canonical drafts and no blocked writes. Browser
scope was Chrome, no actual sends; phone used prepared clipboard HTML, not touch selection
on iOS. Server delivery tests and isolated-commit suite results remain worker-reported.

Review failed one identity invariant: the resolver's unknown explicit Buddy-ID branch removes
the ID, appends its label to prose, and then resolves that label again. A missing/archived
Buddy named Lead can silently retarget to a different active Buddy named Lead. The tests
currently EXPECT that retarget. This was also flagged during implementation in task post
post_01a11777-9d1c-776b-9a3d-8efa540ff370.

Focused repair requested in post_01a11785-0cd2-72c8-9556-d8fece12c873 (Sonnet 5.5): preserve
explicit unknown identity and fail clearly before write/delivery; never silently substitute
another Buddy. Require idempotent resolution and client/server regressions. Also preserve
rendered task-chip identity through the existing clipboard representation if bounded.

No completion accepted, no push, no live-backend restart. Disposable screenshots remain in
output/mention-qa-2026-10-08 until final review closes; delete that exact directory at close.

## Final review — repair accepted

Repair `18f06ab` preserves unknown explicit tokens and reports `rejected`; the server's
`resolveForWorkspace` refuses before write/delivery. Composer drops foreign references from
chips, explains the failure and blocks Send. Rendered Task chips carry their reference IDs.
Lead checked definitions and their consumers directly in HEAD with git show/git grep, and
confirmed the relevant tested source files match committed `3d60be6` (git diff empty).

Independent reruns: 20/20 client resolver/draft/render tests; 2/2 server boundary tests
(`owner and Buddy posts store the same canonical mentions, and wake once even on replay`,
`an explicit id that is not on the roster is refused, never retargeted to a same-named Buddy`).
These use temporary stores and fake agent sessions, not real owner deliveries.

New read-only Chrome CDP check on desktop and phone pasted a missing explicit ID whose label
equals the real Product Development Lead. Both retain the missing ID in the saved draft,
show a foreign mark and workspace warning, have zero model chips, disable Send, and attempt
no writes on Enter. The lead inspected both actual captures after dismissing onboarding.
No iOS Safari/touch selection claim. Disposable artifacts: output/mention-review-2026-10-08.

The repair added one selector line, causing G8 to fail even in an exported clean commit:
14450 against 14449. Consolidated Task/foreign styling via one `:is()` selector with the
same specificity and declarations. All nine invariant gates then pass on the exported
candidate, at 14449 CSS lines. Other dirty-tree CSS remains untouched.

Implementation is accepted. Client is live through HMR; the server still requires the normal
backend reload. No forced restart or push. QA observations remain here after disposable
captures and scripts are deleted.
