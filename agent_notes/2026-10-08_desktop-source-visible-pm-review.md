# PM re-review: native source setup/recovery

Reviewed commit: `92a5ea64fa9cff9cf28bfd552f7098883f5ed3a5`.
Task: `task_01a117b8-fee8-742d-a2a4-1eee266b3073`.
Evidence supplied: `agent_notes/2026-10-08_desktop-source-visible-recovery.md` and post `post_01a117e7-3244-77f8-b8ac-7fcfda548811`.

Disposition: accept the visible native instruction gap as resolved at this commit; retain overall installed/public-source release hold.

## Independently reviewed

- Viewed all three supplied WebP pictures: preparing displays phase and continued-use guidance; interruption displays Retry/current-version availability; ready displays revision, quit/reopen and data-preservation instructions. Text is readable and buttons are visible. Interrupted copy repeats current-version availability; minor copy polish, not a closure blocker.
- Inspected committed native wiring and status projection with `git show`, independent of the dirty shared tree. Dialog consumes `view.message`, which now includes the detail instructions; Retry calls setup and Quit calls native quit.
- Extracted only committed tools from `git archive 92a5ea6` into a temporary directory and ran `node --test tools/desktop-source.test.mjs tools/desktop-source-git.test.mjs`: **4 passed, 0 failed/cancelled/skipped**. This covers persisted phase/interruption/reopen message behavior, failed staging retaining the previous selection, lock recovery and real-Git A→B gitlinks plus preservation/refusal of nested edits. Temporary extraction removed after run.

## Evidence limits and handoff

Native Retry helper launch, controlled failure with bundled API HTTP200, normal Quit exit, desktop 5+4 checks, staged payload smoke and native build are the implementer's recorded observations; PM did not rerun native interaction or packaging. Preparing/ready screenshots use status fixtures and do not demonstrate activation or a verified build in that preview. The reported earlier preview instance may have touched default app data; final release validation must use explicit isolation and record it.

Release Engineer remains responsible for the existing isolated final-cut packaging lane: pin the final merged commit (preserving public docs changes), committed-cut gates and its own DMG, then installed A→B/reopen/data-preservation/first Buddy reply plus offline/failure/interruption evidence. Keep host prerequisites explicit and true clean-Mac/Gatekeeper proof separate. Public exact source/submodule availability and owner release decision remain outstanding.

No new DMG, push, upload or launch approval resulted from this review. Original updater DMG remains 9360fb4 and excludes later status/gitlink fixes; 54b9f1f artifact provenance remains separate. No peer task/run state changed.
