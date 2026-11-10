# Instrument: make the benchmark able to tell A from A

The A/A runs in your inputs are the same commit timed against itself on the same device. They
should agree. They do not: at least one frozen case shows a spread above 3%, or failed to produce
a number at all. Until that is fixed, no A/B ratio from this benchmark means anything, and the
search is paused behind you.

This is a sub-goal of the expedition, not the expedition. You are repairing the measuring stick.
You are not making the engine faster.

## Read first

- The A/A reports in your inputs: per case, per ABBA block, the timings and the device.
- `tools/speed_search_v1/abba.py` and its tests.
- `KEY_LEARNINGS.md`, section "2026-10-05 — Fast Modal GPU iteration" (a 157.8 s smoke held 1.1 s
  of compute), and the immutable-RHS graveyard row (the false 0.842×).
- `tools/gpu_fastlane_v1/README.md`, for how cached images and sessions are meant to remove
  install and compile time from the measured window.

## Find the cause before changing anything

Say which of these the data supports, and show the blocks that support it: setup or compile time
inside the timed window; cold versus warm container; the first block differing from the rest;
too few steps for the timer's resolution; readback counted in one arm and not the other; A and B
on different containers. If the data cannot separate two causes, say what one extra A/A run would
separate them, and stop there with that as your report.

## Change

Only files under `tools/speed_search_v1/`. Do not touch the protocol file, the reference fields,
the error metric or the engine. Keep the report fields the same; add fields if you need them.
Every repair gets a unit test that fails on the old behaviour, using recorded or synthetic
timings, with no GPU.

## What good looks like

One cause, named, with the evidence. A small change. The harness's own tests pass. The sub-goal's
check is then run by the host, not by you: A/A on every frozen case on Modal from your commit,
passing only if the worst spread is at most 3%. You do not run Modal or the local GPU yourself.

Write one `learn` row: family `benchmark-noise`, the cause as the idea, your predicted spread
after the fix, and leave `measured` for the re-run. Stop when the tests pass and you have committed.
