# 2026-10-08: launcher evidence for missing-provider errors

- Question: how can a working Codex turn be followed by an instruction to install Codex?
- Scope/decision-maker: owner requested root cause and correctness repair in #buddies-dev
  post_01a11acb-a00b-77f5-ad32-dbc476116199; Task task_01a11c04-cd0c-70d7-b5c9-1656e8b885c9.
  The lead authorized implementing the reproduced defect, explicitly keeping the original
  Wave_sim incident attribution unconfirmed (request reply post_01a11c0f-aa7c-746f-b517-3574571dda16).
- Status: assistant implementation choice within that correctness scope, ready for lead review;
  no owner decision to activate, merge main or publish is inferred.
- Concrete gap: a CLI's downstream command failure acquired a false provider-install instruction
  and durable `spawn_failed` cause. No new Buddy concept or controller is needed.

## Historical evidence

Outer base ddca73e0cfe87e5387324c9f8bb5855d2ca5757c points to agent-cli
6d45ede10f6468b5991f41ef4d6fc5d7708cb2b4. At that exact submodule commit,
`src/execute.ts`'s `missingBinaryError` tests exit 127, `stderr.includes(bin)` and
`/not found/i` anywhere in the provider stderr, then returns `spawn <bin> ENOENT`.
It does not establish that the provider failed to launch. A real executable named
codex emitting `codex: nested-tool: not found` then exiting 127 reproduces the false
classification, with or without previously emitted provider text.

The old `src/resolve.ts` caches the first resolved path by binary name for the process
lifetime. A separate baseline reproduction resolves PATH/one/codex, changes PATH to
PATH/two, and receives PATH/one/codex again. The repaired resolver returns PATH/two/codex.
This is independently proven; it is not asserted as the screenshot's trigger.

The owner-provided screenshot is at
`/Users/nicholasbardy/.agent-viewer/uploads/channels/list_4bd52262-8f0b-465d-99e5-60cc33eb8565/1791450909626_Screenshot_2026-10-08_at_5.15.07___PM.png`.
It proves the displayed message and preceding responses, not the failing process's
stderr, exit status, working directory or launch environment. Cross-workspace traces
were not read. Exact incident attribution needs a scoped export of that failed attempt
and the preceding successful one, including those facts.

## Choice and rationale

Agent-cli commit ef964ef4ec17341509487432dfafcca25c3e12a5 replaces the broad stderr
classifier with the journal wrapper's own command discovery result. The existing private
exit record gets optional `commandMissing` evidence alongside its status. No Buddy tool,
wire, database or public package-index schema/API changes. Only a failed wrapper lookup
produces the canonical ENOENT event the existing runner already consumes.

Old journals without this evidence stay unknown: preserve their provider failure, without
inventing launch provenance from stderr. An executable whose shebang interpreter is absent
is discovered, but its invocation fails; it is not labelled an absent provider on PATH.
The wrapper uses /bin/mv so recording an absent-command error does not itself require
coreutils on the failing PATH.

The shared lookup reads each launch's environment and requested cwd, without a process-wide
cache or a `which` subprocess. Cursor's existing legacy fallback is preserved. Public
resolveBinary keeps its original signature; the internal shared helper is not exported
from the package index. The launcher and direct process runner use the same lookup.

Alternatives: tightening a stderr regex still infers launch provenance from provider-owned
diagnostics; removing actionable missing-command errors regresses the fresh-install repair.
Restarting or replacing the backend could hide stale environment state, but would neither
repair the classification nor provide incident evidence. Neither was performed.

Tradeoffs: older genuine missing-command journals lack evidence and receive an ordinary
provider failure. Discovery and execution are not an atomic OS operation; removal between
lookup and invocation remains an ordinary invocation failure. Prefer honest uncertainty
over a false installation instruction. Revisit if a platform cannot supply wrapper-owned
discovery, or if an observed launch failure needs a distinct existing-contract diagnostic.

## Evidence and activation

Guards: agent-cli `test/launch-classification.test.ts` (real shell, PATH switches/removal,
relative PATH/cwd, broken interpreter, Cursor fallback, replay and legacy exit records),
`test/journal.test.ts` (adoption/Stop/lost groups), server `conversation-runtime.test.ts`
(real execute boundary, visible failures and durable causes), execution crash checker.
Final exact-commit logs and reproduction report: `output/codex-launch-2026-10-08/RESULT.md`.

Activation requires integration of the outer commit and its pushed submodule reference,
building agent-cli, and a release-coordinated backend reload at the safe relay boundary.
Source acceptance is not live activation. The main checkout, live backend/relay and live
SQLite stores were not modified by this lane.
