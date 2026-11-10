---
leader: game-design                # a named Buddy; it reflects and may rewrite the plan
repo: ~/git/room-runners-arena-lib
budget: { usd: 120, hours: 12 }
autoApply: { usd: 15 }             # a rewrite adding more new cost than this waits for the owner
pools:
  claude:  { slots: 4 }            # an agent call reserves the pool named for its provider
  codex:   { slots: 1 }
  gemini:  { slots: 2 }
  compile: { slots: 1, scope: machine }   # held only while a check builds and runs the game tests
  cpu:     { slots: 2, scope: machine }   # match batches; each batch runs up to 4 single-threaded shards at nice 15
  fresh-seeds: { uses: 1 }         # seeds 1001..1048: one confirmation run, then the set is spent
done:                              # the host evaluates these on ONE commit; nobody else may
  - check: python3 -I reports/tidewar-balance/targets.py --seed-start 1001 --seeds 48 --mirror
  - metric: { run: python3 -I reports/tidewar-balance/targets.py --seed-start 1001 --seeds 48 --mirror --json, field: median_minutes, atMost: 20 }
  - check: python3 -I reports/tidewar-balance/predictions.py --closed
  - review: { rubric: exploit-evidence, by: gemini/gemini-3.1-pro-preview/high }
  - owner: Do you accept the change set, the round's log and the owner decisions it asks for?
rules:                             # appended verbatim to every brief
  - Owner rulings are fixed. The flagship stays shielded until all three Inner towers are sunk. A lever that bends a ruling is proposed in the log, never applied.
  - Predict before you measure. The prediction row is written before the run. No bar is lowered after a result is seen.
  - A/B runs use the same seeds, 1..48. Seeds 1001..1048 are reserved; do not run them. A team-bias claim needs the mirrored run. An unfinished match is censored, never averaged at the cap.
  - Refuted results stay. Never delete a log row, a variant map or a run folder.
  - Compile only through keel/scripts/dev.sh (it takes the machine's compile lock). Run matches outside the lock at nice 15. Report no tick timing: the host is not idle.
  - Never deploy. Do not touch the production server or keel/deploy/.
---

# Goal

Tidewar is not fun to finish yet. On the shipped map, AI against AI, most matches are still going
at 45 minutes, there are almost no fights, and captains spend a third of their time doing nothing.

I want matches that land in 12 to 20 minutes, a Kraken about every 4.5 minutes, no advantage for
either team, and the fun numbers in range: lead changes, comebacks, fights, contested Krakens, low
idle time. Balance means fun. A balanced game that is dull has failed.

Round 1 spent 38 agents on 7 experiments and shipped nothing, and most of what went wrong was the
process: one deterministic AI made 48 seeds into one sample, exploits confounded every experiment,
two confirmed levers stacked into a biased game, and code fixes had no owner. Read
`notes/design/2026-11-01_balance_swarm_meta_prompt.md` and do not repeat it. Check the measuring
stick first. Hunt exploits before experimenting. Test one lever at a time, and never a lever that
the log already shows refuted unless something about it has changed.

AI against AI measures structure, not feel, so I will play the result myself before it merges.
If no lever earns its place, say so. A round that ships nothing but leaves an honest log, a
corrected theory and better lessons in the meta prompt is a result I accept.

## Not yet real

- `game-design` is an invented Buddy id. No Buddy with that id is known to exist.
- `reports/tidewar-balance/spread.py` does not exist. It should run 16 seeds and exit 0 only when
  first blood and first tower fall at different times across seeds.
- `reports/tidewar-balance/ab.sh` does not exist. It should build `keel_cli` at the commit through
  `keel/scripts/dev.sh build keel_cli --release`, run the frozen baseline map and
  `variants/<variant>.json` on seeds 1..48, plain and `--mirror`, under every persona, compare
  them with the existing `compare.py`, keep the raw per-seed lines in the repo's ignored
  `output/`, and print `{ "inTarget": int }` as JSON. Exit 0 means confirmed (shorter by the
  paired sign test, no team bias on the mirrored run, fun proxies not worse), exit 1 means
  refuted with the JSON still printed, and any other failure prints none. `compare.py` exists
  but only prints a table: it has no JSON output and no pass rule today.
- `reports/tidewar-balance/targets.py` does not exist. It should run the map compiled into the
  commit on the given seeds and exit 0 only when every owner target holds. Its `--json` output
  and the `median_minutes` field are invented with it.
- `reports/tidewar-balance/predictions.py` does not exist. It should exit 0 when every log row
  without a verdict has a prediction, a metric, an expected value and a refuted-if condition;
  with `--closed`, when no row is left without a verdict.
- `variants/stack.json` is a name this plan chooses. The existing `variants/r1-stack-confirmed.json`
  is round 1's.
- The pool shape `{ uses: 1 }` and `scope: machine` come from DESIGN.md §4; 01-gtm's contract
  does not show them.
- These exist and are used as they are: `keel_cli tidewar` and its flags, `compare.py`, the
  `pacing` knobs, `keel/scripts/dev.sh`, the compile lock in `keel/scripts/lib/build_gate.sh`,
  `tests/it/fairness.rs`, the theory doc and its sections 11, 14 and 15, and the meta prompt.
