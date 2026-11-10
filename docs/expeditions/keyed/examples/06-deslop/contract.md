---
leader: product-dev                # a named Buddy; it reflects and may rewrite the plan
repo: ~/git/buddies
budget: { usd: 150, hours: 16 }
autoApply: { usd: 15 }             # a rewrite adding more new cost than this waits for the owner
pools:
  claude: { slots: 4 }             # an agent call reserves the pool named for its provider
  codex:  { slots: 1 }
  gemini: { slots: 1 }
  checks: { slots: 2, scope: machine }   # full test runs; the machine is shared with other sessions
done:                              # the host evaluates these on ONE commit; nobody else may
  - check: pnpm typecheck && pnpm test:server && pnpm test:client && bash tools/check-client-invariants.sh
  - check: node tools/deslop/shots.mjs --baseline output/deslop/base
  - metric: { run: node tools/deslop/measure.mjs --json, field: sourceLines, atMost: 80000 }
  - review: { rubric: retired, by: gemini/gemini-3.1-pro-preview/high }
  - owner: Does everything you use still behave the same, and is the code that is left the code you want to own?
rules:                             # appended verbatim to every brief
  - Every slice replaces AND deletes. A new interface with nothing retired is preparatory work, not a simplification.
  - Change only files inside your fence. If the right fix is outside it, stop and report the seam; do not reach across.
  - Verify the commit, not the working tree. Other sessions leave dirty files in shared checkouts; never stash, never reset.
  - Never open ~/.buddies or ~/.agent-viewer, never run the Buddies CLI without BUDDIES_HOME at a tmpdir, never format vendor/.
  - Do not weaken, skip or delete a test to get green. A test goes only when the path it tests goes, and the deletion is listed.
  - Keep every fix-guard comment and its regression test (docs/patterns.md#fix-guards) unless the guarded code itself is retired.
---

# Goal

The September lean rewrite cut this repo from 133,955 lines to 99,841 and made it much faster, but
it missed its own 3–4× target, and the same facts are still defined in more than one place. I want
the next cut done properly: one canonical owner for each fact in the data model, every superseded
path deleted along with its tests, and the types unified so the compiler carries the distinctions
instead of `if` ladders and optional fields.

Measure before anything is changed. Then write the lean target with line budgets and a named owner
per fact, and cut toward it in waves of small, file-fenced slices that each pass the real checks on
their own commit. I do not want another large branch that verifies green against a dirty tree.

Everything I use must keep working: chats, Buddies, channels, expeditions, the mobile tree. Report
the net source delta with tests counted separately, the deletion list per slice, and anything you
chose to keep and why. If the 80,000-line bar turns out to be wrong, say so with the numbers; do
not hit it by moving code into places the count does not look.

## Not yet real

- `tools/deslop/measure.mjs` does not exist. It must print JSON with `sourceLines` and `testLines`
  for the tracked tree (source and tests counted separately, `vendor/` and generated files out).
- `tools/deslop/target-lint.mjs` does not exist. It must check `TARGET.json`: fences are disjoint
  within a wave, every slice names what it retires and what it keeps, budgets are present.
- `tools/deslop/slice-gate.mjs` does not exist. Given `TARGET.json` and a slice id, it must fail
  a commit that deletes a test the slice did not list or adds net source lines. (The fence itself
  is enforced by the host, per call.)
- `tools/deslop/shots.mjs` does not exist. It would wrap the real `pnpm screenshots` /
  `pnpm screenshots --baseline` so the host can run it: start a throwaway server on a spare port
  against a COPY of the stores (execution disabled), take the shots, compare, stop the server.
- `agent_notes/2026-11-10_deslop/` and its `TARGET.json`, `TARGET.md`, `INVENTORY.md`,
  `CLOSEOUT.md` are written by this expedition; none exists.
- The `product-dev` Buddy id is assumed from the "Product Dev" Buddy the server bootstraps. Its
  provider must not be gemini, or the dry run refuses the closeout's reviewer.
- The 80,000-line bar and the dollar and hour budgets are illustrative, not measured.
- The seat model names are copied from example 01, not checked against the catalog.
- The real commands used as they exist today: `pnpm typecheck`, `pnpm test:server`,
  `pnpm test:client`, `bash tools/check-client-invariants.sh`, `pnpm screenshots`.
