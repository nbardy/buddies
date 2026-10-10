# PM review: bundled floor and direct helper handoff

Disposition: close both code blockers at f1011d0b4a954a8bee82292ea212768565baa4b3. Keep packaged managed-source task task_01a117b8-fee8-742d-a2a4-1eee266b3073 in review pending final-cut release evidence. No publication approval is established by this review.

Independently inspected the five-file committed diff. The canonical publisher checks bundled-revision ancestry before staging or changing active-runtime.json. Refusal leaves preserved source and runtime selection intact; the real-Git regression covers existing active manifest and failed-first-setup/no-manifest, then a preserving merge succeeds. Desktop upstream request now invokes the safely quoted helper directly after the authorized merge; ordinary source-checkout instructions retain their existing build path.

Independent fresh git archive of the exact SHA: output/pm-f1011d0-20261008/committed. Host dependency directories linked for test execution; this is scoped exact-source testing, not a clean dependency/bootstrap or full release gate.

- pnpm test:desktop: desktop 5/5 and managed-source 6/6; exit 0, no skips/cancellations. Includes real pnpm production-parent fixture with newly added build dependency and changed lockfile, plus existing recursive gitlink preservation coverage. Log: output/pm-f1011d0-20261008/desktop.log.
- Upstream HTTP/core boundary: 7/7; exit 0, no skips/cancellations. Confirms actual posted desktop request contains direct --publish and no preliminary pnpm install/build. Log: output/pm-f1011d0-20261008/upstream.log. Does not prove model obedience.
- Independent mutation copy removing only ancestry guard: targeted stale-checkout regression exits 1 with Missing expected rejection. Log: output/pm-f1011d0-20261008/ancestry-mutation.log.

Release Engineer next action: include this reviewed fix in the final isolated cut, rerun affected and required gates, build/hash/stamp the final DMG, and retain native setup/Ready/Retry/Quit/reopen, first real reply, update/data-retention/failure/interruption evidence outside /tmp. Older 4f16903 gate results are prior-cut evidence. Host prerequisites and actual clean-Mac/Gatekeeper coverage remain distinct. No installed app or UI was rerun by PM in this review. Shared dirty edits were left intact; no commit, merge, push, tag or upload performed.
