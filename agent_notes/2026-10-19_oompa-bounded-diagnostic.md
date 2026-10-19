# Bounded diagnostic in an existing Oompa run

The owner-authorized blocker is an idle live host that cannot execute the next
explicit diagnostic for an already selected Task. Extend the existing `oompa`
execution operation and journals; no task queue, model CLI, task completion,
acceptance, force-hold or provider-session mutation belongs to this operation.
The proposed request pins run/swarm/task/revision, registered clean source HEAD,
tracked source hashes, exact argv and at most 600 seconds within the original
deadline. Only an owner-authored principal may add it. Scheduled launch Buddies
retain status/stop only.

Cheapest check is the existing temp-store real MCP test boundary with a real
bounded child. Pass means exactly one execution per key, fail-closed scope,
revision, source pins and idle proof, no implementation/validator overlap,
reload recovery, parent stop/expiry childtree cancellation and exposed logs.
Stop on unproven idle state, unbounded ownership or credential inheritance.
Diagnostic exit success never means canonical Task completion or physics/beta
acceptance. This note records implementation intent, not live execution evidence.

Implemented request:
`{action:{kind:'continue',runId,swarmId,taskId,baseRevision,workspacePath,sourceCommit,command,sourceFiles,maxSeconds},key}`.
`swarmId` is explicit; sources are a nonempty relative-path/SHA-256 map. Each
request is recorded beneath its existing parent execution with its exact argv,
source/task identity, key and deadline. Replay never spawns another diagnostic.
An interrupted pre-spawn request is failed on adoption rather than re-executed.

The exact current swarm is bound by the parent startup output, pinned config path,
started PID/process group, and started continuation-control directory. Every
original worker must first be fresh and idle, then acknowledge the matching
request in its existing worker state. New launch supplies
`OOMPA_CONTINUATION_CONTROL_DIR`; old running hosts require a supported restart
and cannot silently receive diagnostics. The Oompa-side gate is commit
`407ff09c9b9e9bdaced2cabe4061161e1956f75a` in its own repository.

The bounded existing process wrapper owns command execution, group drain and
post-execution source verification. Source drift is an unsuccessful exit (126),
with the reason in exit.json. Backend polling/adoption releases the matching
request only after its exact wrapper is gone; during an outage the worker stays
held until recovery or its original deadline. Parent stop/expiry also signals
nested diagnostics. Status exposes request/state, stdout/stderr and exit paths.
No canonical Task state is written by a diagnostic.

Working-source checks: six real MCP boundary tests passed, including the three
existing host tests, continuation scope/source/idle refusals, exactly-once replay,
reload, interrupted pre-spawn adoption, no-ack refusal, source mutation, deadline
and childtree stop. Server source/test TypeScript check and scoped Biome passed.
Committed-source verification is reported with the implementation handoff.
