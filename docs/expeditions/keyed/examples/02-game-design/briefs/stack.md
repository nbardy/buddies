# Stack: combine the confirmed levers into one candidate

Your inputs are up to three levers. Each was changed alone and confirmed alone on seeds 1..48.
Put them together in one commit. The host then measures the stack again, because confirmed levers
interact: in round 1 two of them stacked into a biased, snowballing game.

## Do

1. Merge the code of each lever's commit onto your starting commit. Your inputs hold each
   lever's change and its measurement. The changes touch the same file,
   `keel/games/game_bships/src/pacing.rs`, so expect conflicts there and resolve them by keeping
   every knob. All knobs still ship off in code.
2. Write `reports/tidewar-balance/variants/stack.json`: the frozen baseline map with each
   lever's knobs set exactly as its own variant map set them. Change no value.
3. Apply the same `pacing` block to the shipped map, `keel/content/tidewar-map.json`. This is the
   candidate the owner will play. It merges only if the stack is confirmed, the exploit hunter
   signs off, the reserved seeds confirm it and the owner's playtest passes.
4. `keel/scripts/dev.sh check game_bships`, then
   `keel/scripts/dev.sh test game_bships --test it`. The suite is your judge. A test that pins a
   shipped value you changed on purpose (a map constant, a knob default) may be updated to the
   new value, with a comment naming the lever. `tests/it/fairness.rs` is restored before the
   suite runs; do not edit it.

## Do not

- Retune. If two levers obviously fight, stack them as they are and say so; the measurement
  decides, and the leader chooses what to drop.
- Add a lever that was not in your inputs, or leave one out.
- Run match batches, or run seeds 1001..1048 for any reason.

## Report

List the levers stacked, the final knob values, and every conflict you resolved and how. Say
which interactions you expect between the levers and which metric would show each one.
