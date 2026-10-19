# Oompa run-owned Buddy connection

Owner-authorized workflow gap: a detached Oompa execution cannot reuse a turn
bearer after its parent settles. The target is one supported owner-only launch
operation with a fresh task-scoped capability, fixed execution deadline, explicit
stop, and host-executed independent acceptance. Existing turn tokens and task
authority remain with their canonical owners.

The launch pins workspace, task IDs, accountable Buddy, configuration and oracle
commands. Its delegated principal comes only from the owner-authored launch;
every call is restricted to those task IDs and progress fields. The execution
journal and existing phase transitions own lifetime; a separate Oompa host
process enforces the same deadline during a backend outage. Grants are restored
only for a live running execution, and revoked before stop/expiry signals.

Cheapest check: temp-store MCP integration with a real bounded child, parent
settle, foreign task probes, cancellation, expiry and a pinned executable oracle.
Pass means the child grant survives only its own execution and cannot perform
owner/team/doc operations or mark done through task_write. Host acceptance must
run the pinned oracle and preserve the exact clean candidate commit. Stop on a
scope leak, an untracked child, or inability to bind runtime activation safely.
This is an execution connection, not evidence that wave_sim beta is accepted.

The owner-only MCP operation is `oompa` with
`{action:{kind:'launch',workspaceId,buddyId,workspacePath,configPath,maxSeconds},key}`;
`maxSeconds` is positive and at most 43200. The host uses its configured
`UNLEASHD_OOMPA_EXECUTABLE` (default `~/git/oompa_loompas/swarm.bb`). Status and
stop take `{action:{kind:'status'|'stop',runId},key}`. The result contains the run
ID, phase, deadline and log directory, never a bearer. Launch accepts a registered
linked Git worktree of the canonical Buddy workspace repository.

The selected IDs and expected owners come from `task_backend`; oracle commands,
timeouts and tracked file SHA-256 pins come only from `task_execution.validators`.
Both are snapshotted at owner launch. The task-scoped bearer can read selected
tasks, CAS progress, comment without spawning work, and request `oompa accept`.
It cannot create tasks, change criteria/owners, access docs/team/runs, or submit
`task_write status:done`. The scoped principal preserves the explicit owner's
delegation; it is not a general owner worker grant. The independent validator
receives no Buddy or owner bearer.

Acceptance requests are
`{action:{kind:'accept',taskId,baseRevision,sourceCommit,workspacePath}}`.
The same request starts or polls one bounded oracle process. The host checks
registered worktree identity, clean exact HEAD and source pins before and after
the oracle, and requires zero exit plus the strict
`oompa.task-validation/v1` task/commit-bound accepted JSON verdict. Only then does
it fast-forward the clean launch branch and CAS the unchanged task to done.
An unchanged request never runs the oracle twice; failures preserve the candidate
and canonical unfinished task. A new candidate commit is a new validation attempt.

Runtime inspection found the existing source dev supervisor, not a packaged app.
Its normal source reload adopts running provider executions and their original
grants; running turns do not block reload or get killed. The backend PID changed
during implementation while current turns continued. A schedule-origin Buddy
turn does not gain owner launch authority; the current adopted owner turn must
perform the launch.

Follow-up blocker: the scheduled launch Buddy had no MCP status/stop operation
after the owner launch turn settled. Ordinary Buddy workers now see `oompa`,
but the host admits only status/stop for the exact launch Buddy and workspace.
Peers, foreign workspace grants and run-owned children are denied; launch still
requires an owner-authored principal. Cheapest check is a real MCP call under a
fresh ordinary worker grant after parent revoke, plus peer/foreign/launch denials.
The live run retains its original journaled token and deadline across the source
reload; this change does not mint or promote a grant for it.
