---
leader: market-research            # a named Buddy; it reflects and may rewrite the plan
repo: ~/git/wave_sim
budget: { usd: 60, hours: 8 }
autoApply: { usd: 10 }             # a rewrite adding more new cost than this waits for the owner
pools:
  claude: { slots: 6 }             # an agent call reserves the pool named for its provider
  codex:  { slots: 1 }
  gemini: { slots: 2 }
  cpu:    { slots: 2 }
done:                              # the host evaluates these on ONE commit; nobody else may
  - check: python tools/gtm/audit_ledger.py business/research/2026-11-10_gtm
  - metric: { run: python tools/gtm/coverage.py business/research/2026-11-10_gtm --json, field: orgs, atLeast: 25 }
  - review: { rubric: traceable, by: gemini/gemini-3.1-pro-preview/high }
  - owner: Do you accept the packet and the buyer-test plan?
rules:                             # appended verbatim to every brief
  - No paid scraping or enrichment, no GPU, no outreach, no publication. Nick does all external sending.
  - Tag every claim VERIFIED, CLAIMED or SPECULATION. A polished report does not establish PMF.
  - Keep RL/data evidence and design-partner evidence separate. Generic data or CAD vendors are comparators, not proof of demand.
  - Raw page bodies go to output/ through artifact_store_v1. Tracked files go under business/research/2026-11-10_gtm/.
---

# Goal

Follow the raw evidence → difficult questions → adversarial revision → buyer conversations method.

Produce one falsifiable engineering RL/data sales hypothesis and one separately judged
design-partner hypothesis. The blocker today is that we lack evidence connecting actual buyer
workflows and buying triggers to an offer we can deliver.

I want traceable conclusions, the actual coverage (or candid gaps), the adversarial reasoning kept
on the record, and a buyer test I can run myself.

## Not yet real

- `tools/gtm/anchors.py`, `audit_ledger.py` and `coverage.py` do not exist in wave_sim. They are
  small scripts to write first; the launch dry run refuses a check that cannot run.
- The `market-research` Buddy id is assumed from the packet's "Market Research owns the research".
