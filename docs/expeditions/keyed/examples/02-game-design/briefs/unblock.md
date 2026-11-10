# Unblock: fix what stops the round from measuring anything

You own code fixes in this round. Nobody else may edit the game or the match runner before the
experiments start, so if you do not fix it, it stays broken.

Your inputs say what is blocking. It is one of two things.

**The measuring stick.** A spread check ran 16 seeds and found that they play the same early
game (in round 1, first blood fell at 55 s on all 48 seeds). The seeds are then one sample, and
no A/B result means anything. Make different seeds give different early games: seeded opening
variation from `DetRng`, and the persona brains in `keel/games/game_bships/src/ai/`. Both exist
after round-2 prep; find out why the spread check still fails before writing anything new.
`reports/tidewar-balance/README.md` has the instrumenter's note on what the seed drives.

**A confounding exploit.** The exploit hunter's report lists exploits marked blocking: ones
strong enough that every pacing experiment would measure the exploit, not the lever. Close each
one with a typed knob in the `pacing` block (`src/pacing.rs`), or use a knob that exists
(`duplicate_guns`, `tower_range`). Where closing it changes a rule a player would notice, ship
the knob off and write the owner decision it needs; do not turn it on.

## How to work

- Read the code path first and write down what you expect the tests to say. Compiling is the
  slow part: a small release rebuild has taken 8 minutes on this machine.
- `keel/scripts/dev.sh check game_bships`, then `keel/scripts/dev.sh test game_bships --test it
  <module>::` for what you changed. Use `--fast` builds. Do not build `--release`.
- When your fix passes, it is merged to main and every later step starts from it.
- Add a test that fails on the old behaviour. The crate's `it` suite is your judge, and
  `tests/it/fairness.rs` is restored before it runs, so do not edit that file.
- Keep the fix small. You are not tuning the game. Change nothing that moves match length.

## Report

Say what was wrong, what you changed, and which test proves it. Record the cause with the `learn`
tool, family `measuring-stick` or `exploit`. If the block cannot be fixed without bending an
owner ruling, stop and say so; that is the leader's and the owner's decision.
