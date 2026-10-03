# Memory curation benchmark

This is the entry point for maintaining the Buddy memory reviewer evaluation.
Read it before changing reviewer prompts, tool descriptions, fixture inputs or
grading. Project agents discover it through the root `AGENTS.md` and
`docs/test-strategy.md`; it does not depend on a particular Buddy's private memory.

| Resource | Purpose |
|---|---|
| [Cases and rubrics](cases.ts) | Synthetic inputs, expected behavior and assertion flags |
| [Live harness](../../buddy-memory-curation.test.ts) | Runs the production `createMemoryReviewer` (real `executeCommand`, real ladder, real MCP endpoint, real `BuddiesCore` on a temp DB) on each case. Ported 2026-09-26 (M4) after T11 removed the stdio harness |
| [Frozen original control](baseline-2026-09-13.txt) | Pre-curation instruction text; retain unchanged |
| [Current reviewer](../../../src/buddies/memory-review.ts) | Candidate instructions, runtime configuration and the reviewer's tool schema (`doc_read`/`doc_write`, `server/src/buddies/mcp.ts`) |
| [September 13 report](../../../../docs/memory-curation-evaluation-2026-09-13.md) | Method, selection rationale, results and known misses |
| [Historical evidence](../../../../docs/benchmarks/memory-curation/2026-09-13/README.md) | Prompts, grades and hashes; raw runs and source snapshots are local-only |
| [September 26 run, archived September 27](../../../../docs/benchmarks/memory-curation/2026-09-27/README.md) | 28 reviews, original automated outcomes, limited rubric review and Cursor infrastructure correction |
| [Thread preservation](../../../../docs/benchmarks/memory-curation/2026-09-13-closeout/README.md) | Lessons, private-corpus boundaries and six prepared fresh-session fixtures |

The September 13 selected prompt scored **19/20** manually graded case runs
versus **16/20** for the original control. Those are historical observations,
not an expected score for every rerun or a production reliability estimate.

**2026-09-26 change (M3).** `MEMORY_REVIEW_INSTRUCTIONS` was
rewritten around the two docs and "update when relevant" (in-flight → working,
resolved → removed from working, lasting preference/lesson → long_term, nothing
new → NONE, read workspace files read-only to check a claim, never write). The
live harness was ported in M4 and ran 14 cases twice on September 26: 25 automated
checks-passed, two fixture-related checks-failed and one infrastructure failure.
The [archived report](../../../../docs/benchmarks/memory-curation/2026-09-27/README.md)
keeps those counts separate from semantic quality; A.r2 passes checks but misses
its frozen rubric. The 19/20 above describes the September 13 prompt, not this
one. Four other variables changed in the same
commit and must be labelled separately on the next rerun: the transcript now
carries tool-call lines (name + input capped at 400 chars), the reviewer runs in
the Buddy's workspace root with read-only file tools per harness, and the
runtime limit is 300 s per ladder rung.

## What it measures

Each Buddy has ONE working doc and ONE long-term doc, shared by every turn. After a completed
turn the reviewer reads both and updates them when relevant. The benchmark feeds the real
reviewer one synthetic completed turn per case and records what it saved.

- **A-J** (September 13 analogues): curation quality — duplicate cleanup, decision provenance,
  corrections, qualified evidence, no-ops, truncation, quoted injection.
- **K-O** (relevance, 2026-09-26): does the right thing land in the right doc?
  K in-flight work waiting on the owner → working; L a resolved item leaves working (the turn
  carries the edit as a `toolCall`, and the edited file is seeded in the workspace so the
  reviewer can read it); M a lasting owner preference → long-term; N small talk → no writes,
  report NONE; O a different conversation continues an item from earlier → updated in place,
  not duplicated.

Private Buddy memories and conversations are not copied into these fixtures. `cases.ts`
defines inputs, `checks` and `rubric` before execution; the model never sees either. The
runner ignores repository/user instructions: `AGENTS.md` guides the engineer, not the reviewer.

There is no baseline arm any more: `createMemoryReviewer` has no instruction override, so the
harness measures the current `MEMORY_REVIEW_INSTRUCTIONS` only. `baseline-2026-09-13.txt`
stays frozen for a future comparison, which needs a test-only instructions seam first.

## Setup and execution

Normal dependency setup (Node >=22.5, pnpm, initialized `vendor/agent-cli-tool`, `pnpm run
bootstrap`). A live run needs the authenticated reviewer CLIs of the ladder (codex, then
cursor-agent, claude, muse; `MEMORY_REVIEW_MODELS` in `server/src/buddies/memory-review.ts`).
No Unleashd server is needed: every run gets its own temp DB, workspace and MCP endpoint.

Default mode (what `pnpm test:server` runs) is **skipped** and makes no model calls. A skipped
live test is not a benchmark pass:

```sh
pnpm exec tsx --test server/test/buddy-memory-curation.test.ts
```

Pilot one case first (1 review):

```sh
UNLEASHD_LIVE_MEMORY_CURATION=1 \
UNLEASHD_MEMORY_CURATION_CASE=K-inflight-to-working \
UNLEASHD_MEMORY_CURATION_REPEATS=1 \
UNLEASHD_MEMORY_CURATION_RESULTS=/tmp/memory-curation-pilot-NEW-RUN-ID \
pnpm exec tsx --test server/test/buddy-memory-curation.test.ts
```

Full run:

```sh
unset UNLEASHD_MEMORY_CURATION_CASE
UNLEASHD_LIVE_MEMORY_CURATION=1 \
UNLEASHD_MEMORY_CURATION_REPEATS=2 \
UNLEASHD_MEMORY_CURATION_RESULTS=/tmp/memory-curation-NEW-RUN-ID \
pnpm exec tsx --test server/test/buddy-memory-curation.test.ts
```

**Cost: cases × repeats reviews.** With 14 cases and 2 repeats that is **28 reviews = 28 model
calls** when the first rung (codex) has credits. A review climbs the ladder only on
`out_of_tokens` or a rung timeout, so the ceiling is 4 calls per review (112 for the full run).
Up to 2 reviews run concurrently. Each rung has `MEMORY_REVIEW_TIMEOUT_MS` (300 s); each
subtest allows every rung its timeout plus margin.

The ladder is production's and it is NOT disabled here: a result may come from a fallback
model. Every row records the receipt's `model` and `fallbackFrom`; group and grade by model,
never mix them silently.

Controls:

- `UNLEASHD_MEMORY_CURATION_CASE`: one exact case ID from `cases.ts` (unknown IDs fail loudly).
- `UNLEASHD_MEMORY_CURATION_REPEATS`: 1–3, default 2.
- `UNLEASHD_MEMORY_CURATION_RESULTS`: JSON results directory; omitted creates a temp one (its
  path is printed as a test diagnostic).

Use a new results directory per invocation; files are named `<case>.r<repeat>.json` and are
overwritten. Freeze source during a run.

Each result JSON holds provenance (commit, dirty flag, sha256 of the instructions, `cases.ts`
and the harness, the ladder, the rung timeout), the case input, reviewer warnings and a
`result` that is one of:

- `reviewed`: the receipt (status/model/fallbackFrom/writes), before/after snapshots of soul,
  working and long-term (content + revision), every rung's streamed text, bounded redacted CLI stderr
  and tool uses, the
  final report and one `verdict` per check.
- `infra`: a setup crash (`receipt: null`) or a review that did not complete (failed,
  interrupted, skipped receipt). Infra rows are never graded and never dropped.

`summary.json` lists every run as `infra`, `checks-failed` or `checks-passed`. The JSON is saved
before assertions, so a failing subtest still leaves its evidence. Copy results you rely on
into a dated `docs/benchmarks/` subdirectory (git-ignored); commit only its README, grades and
`sha256.json`.

## Grading and comparison

Automated verdicts, per run: `soulUnchanged` and `withinLimits` (working ≤ 2,000, long-term ≤
4,000 chars) always, plus each case's `checks`:

| Check | Passes when |
|---|---|
| `noWrites` | neither memory doc gained a revision |
| `unchanged` | that doc's revision is unchanged |
| `includes` / `excludes` | the case-insensitive pattern matches / does not match the final doc |
| `occursOnce` | exactly one match (continued in place, no duplicate) |
| `reportsNone` | the final report contains `NONE` |

Patterns are deliberately loose; a check pass is necessary, not sufficient. The `rubric` lines
are graded manually from the saved docs: record each judgment, a short reason and evidence,
plus case, repeat, model, result path and grader. A case passes only when its checks AND
rubric hold. Keep automated and semantic outcomes separate, and report infra failures per
case alongside them.

Unsupported owner policy, lost valid knowledge, invented completion, stale pending items left
in working, duplicated items, and preferences written to working are failures. Define the
acceptance bar before tuning. Small repeated synthetic cases are a development regression
set, not a production reliability estimate. The historical September 13 grades were manual
and unblinded; they do not describe the current prompt.

## Extending or changing the benchmark

1. Add a minimal synthetic `CurationCase` to `cases.ts` with a stable unique ID,
   `working`, `longTerm`, `messages` (with `toolCall` entries when the turn acted),
   `checks` and a rubric fixed before execution. Optional `files` seeds the Buddy's
   workspace. Do not copy private production memory.
2. `checks` are the machine-checkable flags (table above); add a new `CurationCheck`
   kind with its handler in the harness's `judge` only when no existing kind fits.
3. Preserve old IDs and the frozen baseline. Date/version changes to existing
   inputs or rubrics and report changed case sets separately. Never silently
   regrade old results with a new rubric.
4. Run deterministic boundaries, a live pilot when needed, then the full run on
   identical fixed inputs with repeats. Preserve unsuccessful attempts too. Record
   command/filters, prompt/tool/fixture/harness hashes, code commit plus dirty
   snapshots, CLI/package versions, model/effort, outputs and grades.
5. A control arm needs a test-only instructions seam on `createMemoryReviewer`
   (none exists). Use an isolated checkout; never swap a running server's prompt.
6. Write a new dated report with the decision-maker, rationale, acceptance bar,
   failures, tradeoffs and artifact hashes. Link it here and retain earlier reports.
   Native Buddy projects own current task status; private notes supplement the
   portable repository evidence.

Model, tool-contract, retrieval and runtime changes are separate experimental
variables. Changing them in both arms changes what the baseline measures; label
that difference and do not attribute all effects to prompt text. Failed-turn
admission, cross-audience learning and production activation need separate proof.

## Availability to future agents

An agent reading this checkout's `AGENTS.md` gets the direct entry point. A new
clone gets only committed files: include the harness, fixtures, runbook, report,
archive and index changes when delivering the implementation. Evidence under
`product/**` or `/tmp` alone is not a clone-safe handoff. A separate `MEMORY.md`
would duplicate this runbook without adding discovery beyond the `AGENTS.md` link.
