# Change: implement one lever, {{id}}

Family: {{family}}

The lever: {{idea}}

You implement exactly this and nothing else. You do not measure it. When you commit, the host
builds your commit and runs the A/B on the frozen seeds; you will not see the numbers and you
cannot adjust to them.

## Read first

- This lever's prediction row in section 11 of
  `notes/design/2026-11-01_tidewar_balance_theory.md`. Do not edit the doc.
- `reports/tidewar-balance/README.md`, "Making a variant" and "Pacing knobs".
- The learning rows for this family in your inputs: what was tried and how it failed.

## Do

1. Copy the frozen baseline map, not the live content file:
   `reports/tidewar-balance/baseline/map.json` to `reports/tidewar-balance/variants/{{id}}.json`.
2. Set only the knobs of this lever in its `pacing` block. Leave every other field identical.
   This is the only variant map you can write; the others belong to other workers.
3. If the lever needs a knob that does not exist, add it in `keel/games/game_bships/src/pacing.rs`
   as a typed field that ships off, so the shipped map plays exactly as before. Content before
   code: write code only when no existing knob expresses the lever.
4. If you wrote code, `keel/scripts/dev.sh check game_bships`. Do not build `--release` and do
   not run match batches; the host does both.
5. Commit the variant map and any code.

## Do not

- Tune. If the stated setting looks wrong to you, implement it as stated and say why you doubt it.
- Touch a second lever, the shipped map `keel/content/tidewar-map.json`, the AI, or the tests.
- Change anything behind the flagship shield rule.

A reviewer on another model reads your diff and passes it only if it is this one lever.

## Report

State the knob values you set and the files you changed, and what you expect the measurement
to show. Do not write a learning row for the lever: the host writes keep or reject from the
measurement.
