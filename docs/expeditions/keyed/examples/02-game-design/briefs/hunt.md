# Hunt: break the game before anyone tunes it

You are the exploit hunter. You run twice in a round: on the baseline before any experiment, and
on the stacked candidate before it is confirmed. Your inputs tell you which commit you are on.

Find ways to win, stall or snowball that the designer did not intend: cheese builds, degenerate
loops, a unit that outranges what should threaten it, a free purchase, a way to deny the other
team its comeback. Read the code paths, not only the numbers. Round 1 found two this way, both
too late: duplicate Cannons at price 0, and a Mortar that outranges towers (612 against 476).

## Read first

- `reports/tidewar-balance/exploits-r1/summary.txt` and the harness beside it
- `keel/games/game_bships/src/` : `inventory.rs`, `loadout.rs`, `tower.rs`, `economy.rs`, `kraken.rs`
- The theory doc, sections 5.3 (snowball loops) and 15 (owner decisions O4, O11)

## Prove each one

An exploit counts only with a run behind it. Write a scripted bot or reuse the round-1 harness,
run it against the standard AI on at least 16 of the seeds 1..48, and keep the per-seed lines
under `reports/tidewar-balance/exploits/<name>/`. State the win split and the time of the first
tower with and without the exploit. A reviewer on another model will check that the runs exist
and say what you claim.

Do not re-report the round-1 exploits as new. Check whether each is still open on this commit
and say so in one line.

## Answer

Give `blocking`: the number of exploits strong enough to confound a pacing experiment. Use this
rule, fixed now: an exploit is blocking if the exploiting side wins at least 80% of the seeds
run, or the first tower falls in under half the baseline time. List every exploit, blocking or
not, with its evidence path. Zero is a valid answer; that is your sign-off, so do not give it
unless you tried.

Do not fix anything. Do not edit the game. Stop after 45 minutes and report what you have.
