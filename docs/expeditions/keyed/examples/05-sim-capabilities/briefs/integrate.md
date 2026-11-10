# Integrate: one source that passes every closed row

Your inputs are the repair commits that each closed one row on Engine E, alone. Each started from
the launch base plus its own failure-class page, so none contains the others. Produce one commit
that contains all of them. The host then re-scores the whole matrix on your commit, every cell.

This step exists because of what the owner said about these engines: no single source combines
the rows. A set of rows that each pass on their own branch is not that.

## Do

- Change source under `prototypes/eulerian_mac_mg_v0/cuda_body_forces_v1/` only. Carry each row's
  page in `agent_notes/2026-11-10_capabilities/` across unchanged.
- Apply the repairs one at a time, in this order: forces, then moving bodies, then wind. After
  each, run the directory's `test_*.py` tests.
- Where two repairs touch the same kernel or the same boundary term, read both failure-class
  pages in `agent_notes/2026-11-10_capabilities/` before resolving. Keep both mechanisms. If they
  cannot both hold, that is the finding: stop, and report which two rows conflict and in which
  term.
- Keep each repair's own unit test, unchanged.

## Do not

- Re-tune a repair to make the merge easier. The paid score each row earned was for the repair as
  committed; a retuned one has not been scored.
- Add anything new: no clean-up, no refactor, no extra fix for a row that did not close.
- Edit the gates, the scoring tools or the saved failures.
- Launch Modal or the GPU. You cannot know whether the combined source still passes each row, so
  do not say it does.

## Report

List the commits you combined, every conflict you resolved and how, and any place where two
repairs now run in an order that one of the failure-class pages did not assume. If you received
only one commit, check it builds on the base, run the tests, and say there was nothing to combine.
Stop when the tests pass and the result is one commit.
