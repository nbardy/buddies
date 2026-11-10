# Record: put what was learned where the next campaign will read it

The falsifiers are spent. You are given the discovery answers, the kills, any surviving claim and
the learning log. Write the durable record in the repo's own files and commit it. Do not create a
new notes folder.

## Write

- `auto_research/experiments/astra_wave_sim_restart_2026-11-10/RUN_LEDGER.md`: one row per run
  (four discoveries, the census, each build, falsifier and judgment) with its stored id, model,
  outcome and cost. `SYNTHESIS.md` beside it: what the campaign found, in a page.
- `KEY_LEARNINGS.md`, the graveyard table: one row per refuted candidate. State the hypothesis as
  it was claimed, then the mechanism of the failure with its number, then the evidence path. Write
  it the way the existing rows are written, for example "cut iterations 18%, ran 30% slower
  overall". A row without a mechanism does not stop anyone from trying the idea again.
- For a no-go or lower bound: a short theory note under the matching program in `theory/`, with
  its assumptions and the one a future candidate would have to break. Add it to `theory/INDEX.md`.
- For a survivor: a pointer from `theory/CURRENT.md` to its claim ledger. Copy its claim sentence
  exactly. Do not restate the speedup in stronger words.

## Rules

- Never delete or reword an existing graveyard row. Add rows; add a dated marker to an old row
  only if this campaign corrected its mechanism.
- Every statement cites a receipt path and a commit. Nothing is cited from a worker tree.
- Keep claim levels as they were judged. A candidate that was killed is refuted in this form, not
  in all possible forms; say which form. A candidate that survived one scene has survived one
  scene.
- Raw responses stay in `output/` through `artifact_store_v1`; the tracked files hold digests and
  pointers.

## Stop

When the ledger, the synthesis and the knowledge rows are committed. If nothing survived, the
synthesis says so in its first line, followed by what future spend this saves.
