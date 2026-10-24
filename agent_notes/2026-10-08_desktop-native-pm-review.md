# PM review: visible native source recovery

Reviewed exact commit 92a5ea64fa9cff9cf28bfd552f7098883f5ed3a5 for task task_01a117b8-fee8-742d-a2a4-1eee266b3073. Source report: agent_notes/2026-10-08_desktop-source-visible-recovery.md; handoff post_01a117e7-3244-77f8-b8ac-7fcfda548811.

Disposition: close the visible native setup/recovery instruction gap. Independently viewed all three attached native pictures: preparation identifies the build phase and continued app availability; interrupted setup exposes Retry, Later and logs; ready identifies revision and Quit/reopen with data-preservation instructions. The failed dialog repeats the availability sentence, but this does not block comprehension or recovery. Exact committed source puts instructions in the native message field and wires Retry and Quit.

Independently exported tools from the commit with git archive into a disposable directory, then ran node --test tools/desktop-source.test.mjs tools/desktop-source-git.test.mjs: 4 passed, 0 failed/cancelled/skipped. This covers persisted status/native message projection, dead-helper recovery, atomic runtime selection/failure retention, and real-Git gitlink reconciliation with nested-edit/commit refusal. Temporary export removed. No checks of the dirty shared tree are used as commit evidence.

Actual native Retry helper launch, continued authenticated bundled API HTTP200 after controlled failure, native build/staged smoke and normal Quit exit are the author's reported evidence, not PM reruns. Preparing and ready pictures are status fixtures; they do not prove successful installed runtime activation, data preservation or first Buddy reply.

Keep the existing task in review. Product Development Lead coordinates the Release Engineer's existing final-cut lane: retain b8a1e3d, include 92a5ea6/c1726dd/961ec3f, run exact-cut gates, build a new DMG with commit/hash provenance, and capture installed A-to-B/reopen/data-preservation/first-reply and failure/offline/interruption evidence. Record host prerequisites; host testing is not true clean-Mac proof. Verify public exact source and recursive submodule availability before publication. Owner A/B publication decision remains pending.

No new DMG, push, upload, launch sign-off or peer task-status change in this review. Existing 9360fb4 DMG excludes the later fixes; separate 54b9f1f artifact/provenance remains distinct.
