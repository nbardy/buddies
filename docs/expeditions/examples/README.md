# Runnable expedition examples

| Case / file | What the owner wants | Shape | What makes it different |
|---|---|---|---|
| 01 [GTM](01-gtm.expedition.ts), [leader rewrite](01-gtm-rewrite.expedition.ts) | Traceable sales hypotheses and a buyer test | Wide collection → synthesis → three adversarial rounds → packet | Source anchoring; the rewrite adds practitioner voices without losing finished work |
| 02 [Game design](02-game-design.expedition.ts) | Fun, fair 12–20 minute Tidewar matches | Repair measuring stick → hunt exploits → wide levers → stack → one confirmation → playtest | Paired seeds, censored matches, one-use reserved seeds and human feel |
| 03 [Simulation autoresearch](03-sim-autoresearch.expedition.ts) | At least 15% more speed at matched error | A/A noise gate → three generations → local screen → Modal score → audit | Population search; preparation overlaps serialized GPU work; every reject stays |
| 04 [Frontier mathematics](04-frontier-math.expedition.ts) | A 10×–200× true-3D representation, or a precise no-go | Four blind discoveries → census → at most two serial falsifiers → hostile review | Blind invention, independent re-derivation, complete-cost accounting |
| 05 [Simulation capabilities](05-sim-capabilities.expedition.ts) | Forces, moving bodies and wind in one Engine E source | Wide rows, each serial diagnose → repair → local replay → paid strike; integrate → matrix | Two strikes per row; combined-source interference is measured |
| 06 [Deslop](06-deslop.expedition.ts) | One owner per fact, fewer than 80,001 source lines, behavior preserved | Wide inventory → target → waves of serial seams and wide slices → integrate → remeasure | Replace and delete; source/test deltas and screenshot baseline |
| 07 [CRUD SaaS](07-crud-saas.expedition.ts) | One consistent repair-workshop app | Foundation → exemplar → wide features → integration → walkthrough | Fixed pipeline; one schema, real HTTP acceptance and screens the owner can judge |
| 08 [Geometry engine](08-geometry-engine.expedition.ts) | Finite D2 analytic boundary passing unchanged caps | Derive → at most three continued probe rounds → one replay → receipt | One scarce suite replay, 256 MiB/60 s guard, memory proved before execution |
| 09 [Document model](09-document-model.expedition.ts) | A ratified model and a plan that retires what runs | Ledger → design → critique/referee → owner rulings alongside spikes → revise → ratify → retirement | Design argument across three providers; owner waits consume no seat |

A Buddy writes/adapts one file in its workspace, resolves the header’s **before launch** items, then calls the `expedition` tool with `propose { file: '<absolute path>' }`.
The owner reviews the card’s preview and advisory limits, then presses **Launch**.

Every file passes the real typecheck, contract and dry-run gates with
`pnpm test:server expedition-small` (no server or agents). This checks declarations,
not the existence or execution of target-repo tools. The free test does not resolve Buddy identities; replace slugs with real ids before launch. Each header names v1 limits:
concurrency pools do not enforce machine locks, dollar sub-budgets or lifetime-use counts;
write scopes and frozen graders need the stated independent checks. A useful no-go record can
still leave numerical contract criteria unmet; only the host declares done.

Author with `import { expedition } from 'expedition'` and plain `agents`/`steps` objects.
Item callbacks use the one optional `step({...})` wrapper for sibling Zod inference; there are no
builders. Names are `buddy:<full-id>` or `harness:model[:effort]`, checked against agent-cli's
catalog (no invented aliases). A normal call requires a pass; `.try` lets the plan branch on the
result union. Concurrency is ordinary `Promise.all(items.map(item => call.try(item)))`.
`x.checkin` wakes the leader; review judges remain `{review: rubric, by: who}`.
The preview's `defaults` reports resolved pools, rewrite/wake/review/call caps and every step's
caps, including unreached steps. See [the authoring contract](../DESIGN.md).

Briefs describe v1 directly: workers integrate only inside their supplied private checkout,
the owner merges; repo records are written from supplied call evidence; scopes and frozen
graders require the header's independent checks. No override rule supplies missing host features.
