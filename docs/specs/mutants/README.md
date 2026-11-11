# Mutants

Each `.diff` breaks one guard in a committed model. A mutant must make its target invariant or
`quint test` fail; if it passes, the invariant does not check what it claims.

Apply one to a copy and run it (Rust backend):

```bash
patch -o /tmp/m.qnt ../expedition-v3.qnt < v3-m4.diff
quint run /tmp/m.qnt --backend=rust --invariant=notStuck --max-samples=3000 --max-steps=40
```

- `v3-m1` … `v3-m10`: the mutants listed in `../../expeditions/v3-first-principles-kernel.md`
  (target invariant and seed per mutant are in that doc).
- `v4-m1_flip` … `v4-m7_oldstrikes`: the mutants listed in
  `../../expeditions/v4-first-principles-search.md`. They were cut from an earlier revision of the
  model, so each diff also carries about 48 lines of drift (two later `quint test`s are missing).
  `v4-m6_readsneeds` is caught by `quint test` (`reduceOverDeadReadTest`), not by `run`.

Saved 2026-11-09 from the session scratchpad; both a V3 and a V4 diff were checked to apply and
typecheck.

Host model (`../expedition-host.qnt`, 2026-11-10), each caught in 3000 samples, 40 steps:

| Mutant | Breaks | Target invariant |
|---|---|---|
| `host-m1_noreserve` | start ignores outstanding reservations | `budgetHard` |
| `host-m2_rerun` | replay re-runs a journaled call | `noDoubleRun` |
| `host-m3_askslot` | an owner ask takes an agent slot | `asksHoldNoSlot` |
| `host-m4_nocas` | weaken applies to a version the owner did not see | `weakenOnSeenVersion` |
| `host-m5_anysha` | met counts passes on any sha | `metHonest` |
| `host-m6_onepool` | start checks only the primary pool (`alsoHolds` ignored) | `poolCaps` |
