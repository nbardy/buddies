---
leader: document-model-lead        # a named Buddy; it reflects and may rewrite the plan
repo: ~/git/wave_sim
budget: { usd: 120, hours: 72 }    # hours are mostly the owner's latency; an ask holds no seat and no budget
autoApply: { usd: 10 }             # a rewrite adding more new cost than this waits for the owner
pools:
  claude: { slots: 1 }             # an agent call reserves the pool named for its provider
  codex:  { slots: 2 }
  gemini: { slots: 1 }
  cpu:    { slots: 2 }
done:                              # the host evaluates these on ONE commit; nobody else may
  - review: { rubric: covers-ledger, by: gemini/gemini-3.1-pro-preview/high }
  - review: { rubric: replaces-running, by: gemini/gemini-3.1-pro-preview/high }
  - owner: Do you ratify this model and its retirement plan as the replacement for what runs in the app today?
rules:                             # appended verbatim to every brief
  - studio/DOCUMENT_MODEL.md owns the facts about what runs today. Older design documents are history, not instructions.
  - Every ledger row ends each round as covered (with the section that covers it), scoped out (with the reason and who decided), or open for the owner. No row is dropped silently.
  - Owner rulings are fixed inputs, quoted with their date. A design may propose changing one; it may not assume the change.
  - Tag every claim VERIFIED (run, or read in the code at a commit), CLAIMED or SPECULATION. A claim about Zoo or Onshape needs a source you opened.
  - No changes to app, kernel or solver code. Spikes live under the expedition's spikes folder and are thrown away.
  - A design that would sit beside the running model is not a result.
---

# Goal

I want one document model for Studio that I can ratify and that actually replaces what runs: the
capacity of Zoo or Onshape for the things we do, behind a much leaner interface.

We have designed this roughly eight times. Authoring v1–v4 and v7, L6, Marine v0.5,
feature_program, PR146, ae4487, DG and cleanroom: none of them replaced what runs in the app. I do
not want a ninth design document. I want the argument had properly, on the record, against the
requirement rows and use cases we already wrote down, by models that do not share each other's
blind spots, and then I want the questions that are really mine put to me with options and a
default.

The result is a model I ratify, with every inherited requirement row either covered or explicitly
scoped out, plus a retirement plan that names what gets deleted and in what order. If the critique
and the design cannot be reconciled, or I do not ratify it, tell me exactly what the open
disagreement is. That is a useful result. A polished design nobody adopted is not.

## Not yet real

- The `document-model-lead` Buddy id is assumed from the "Document Model Lead" owner named in
  `product/MASTER_TASKS.md` §7. Its provider must not be gemini, or the dry run refuses the
  ledger's reviewer.
- `agent_notes/2026-11-10_document_model/` and everything in it (`LEDGER.md`, `MODEL.md`,
  `COVERAGE.md`, `ROUNDS.md`, `RETIREMENT.md`, `spikes/`) is written by this expedition; none exists.
- There is no command that checks ledger coverage. Coverage is judged by a reviewer against the
  `covers-ledger` rubric, which is weaker than a script; see NOTES.md.
- Spike commands are whatever each spike writes. No benchmark for Z5 (column evaluation within 3×
  of plain JS) or Z9 (agent productivity) exists as a runnable command today.
- The seat model names are copied from example 01, not checked against the catalog. The budget
  figures are illustrative.
- Real paths this expedition reads, as they exist today: `studio/DOCUMENT_MODEL.md`,
  `studio/design_kernel/09_ADJUDICATION.md`, `product/MASTER_TASKS.md`,
  `agent_notes/2026-10-09_document_model_parity/REQUIREMENT_CONTRACTS.md`,
  `agent_notes/2026-10-11_model_comparison/` (`DESIGN_GOALS_AND_USE_CASES.md`, `COMPARISON.md`,
  `design_v1/`), `agent_notes/2026-10-12_reset/PLAN.md`,
  `agent_notes/2026-10-14_document_model_owner_decisions.md`.
