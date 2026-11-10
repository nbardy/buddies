# Receipt: record the one replay and hand over the candidate

You are continuing your own conversation. The host has run the boundary suite once, under the
guard, on your last commit. Its result is in your inputs. That was the only replay.

Change no source in this step. If you see something you would fix, write it under "Known
limits"; a source change now would make the receipt describe a commit that was never tested.

## Write

`agent_notes/2026-10-30_own_geometry/G0_RECEIPT.json`, from the host's stored result and not from
memory: the candidate commit, the exact command, the guard's `reason`, `returncode`, `elapsed`,
`peakRss`, `rssLimit`, `secondsLimit`, the number of tests run and passed, and the host's
reference for the raw output.

Then add to `agent_notes/2026-10-30_own_geometry/WORK.md`, under a dated heading:

1. **The receipt in one line**: commit, peak RSS against the cap, duration, result.
2. **Derived conditions and refusal cases**, as they are now implemented, each with the file and
   line that enforces it. Point to `DERIVATIONS.md`; do not copy it.
3. **Attempt history**: every round of this run and the earlier stops (270,024,704 B after
   1.42 s, exit -9, zero tests), with the mechanism each one showed.
4. **Operation-to-core map**: which rows of the REQUIREMENTS table this candidate now covers and
   which remain explicitly incomplete. General box, sweep and Boolean combinations remain
   incomplete.
5. **Known limits**, and what Product's receiving checks (edit, Undo, publish, cold reopen) still
   have to establish. Those are not claimed here.

## What good looks like

Someone who was not here can tell which commit passed, under which caps, and what was not shown.
A reviewer on another model will read the whole diff from the launch base, not only this note,
and will check the receipt against the host's record.

Commit and stop. Do not describe the geometry engine as complete; one finite boundary passed.
