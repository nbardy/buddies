# Scoped overnight Oompa controller delegation

## Outcome and ownership

The concrete gap was repeated owner authorization for each ordinary same-Buddy
scheduled continuation or host renewal. The existing Oompa owner execution
journal now holds the fixed delegation; no Buddy database mutation, task ledger,
renewed bearer, broader Buddy role or recursive delegation was added.

Implementation commits:
- `c2ccfada9603be350f67ca2e43e84cb857eb5055`: owner launch delegation, exact
  absolute grant horizon, ordinary same-Buddy continuation and saved-state renewal.
- `333fd20584096f7fee0cf7362b7c1cda49b0c993`: root revocation checked before
  adoption, independent of journal scan order.
- `6f3bcc4076434359b8f26cc69090e5fc7bb9399e`: asynchronous acknowledged-idle drain,
  preserving controller authorization for harness reload and renewal.

The canonical operating contract is
[automation ownership](../product/buddies/AUTOMATION_OWNERSHIP.md#owner-delegated-overnight-oompa-control--october-20-2026).

## API and limits

An owner-authored launch adds `automationSeconds` (positive, at most 43,200).
Its immutable journal scope records the launch Buddy/workspace, exact registered
source root, all approved task owners, exact configuration hash and expiry.
All parent hosts in this chain expire at that same controller horizon.
`originalExpiresAt` separately records the requested `maxSeconds` deadline.
Task configuration/deadlines are unchanged: a new desired task horizon must be
configured on a new owner launch.

Ordinary same-Buddy turns can continue pinned task diagnostics (at most 600
seconds), or renew a drained host with `launch.priorRunId` naming the latest
host. Use the same original config path/bytes and launch coordinates, with
`maxSeconds` no greater than remaining authorization. The host derives the exact
prior `resume_swarm_id`; Oompa retains attempts, native sessions, source workspaces,
held histories, acceptance counts and original task deadlines. One prior host
has at most one successor. Run-owned task children keep only their scoped
acceptance tools and never receive controller tools.

This is fixed task/config scope. Include the complete currently approved beta
set in the owner launch. New tasks, altered config, new validator pins or wider
policy require a fresh owner launch; this implementation does not claim authority
over arbitrary future descendants or complete all beta work by itself.

`{kind:'drain',runId}` returns immediately with `drain.phase='requested'`.
It persists intent and uses the existing worker continuation handshake to wait
for all workers to acknowledge idle and all validator/continuation children to
finish. Only then does the host end and revoke its own bearer. The original
automation remains valid for renewal. Reload reconstructs a missing control
projection from journaled intent. An explicit `stop` instead revokes the entire
chain before signaling, including after a crash between root revocation and a
successor phase write. The fixed deadline remains enforced independently.

## Verification receipts and boundary

Tests used real HTTP MCP transports, isolated fixture Git repositories and
execution journals, and a controlled stub executable. They did not launch a
paid provider or touch any live host. The integrator owns live activation.

- `c2ccfad`: **8/8** full `server/test/oompa-mcp.test.ts` tests passed from a
  temporary `git archive` of committed server sources (~90 s).
- `333fd20`: **2/2** overnight tests passed from committed archived sources
  (~28 s), including the revocation-before-successor-phase crash window.
- `6f3bcc4`: **3/3** combined overnight and checkpoint-drain tests passed from
  committed archived sources (~43 s):
  `tsx --test --test-name-pattern='overnight|checkpoint drain' server/test/oompa-mcp.test.ts`.
- Working-tree server/test typecheck and Biome checks passed. The owned source
  files were clean after their commits; foreign dirty files were not staged.

Archived runtime checks reused installed package/native dependencies. An isolated
whole-server static check exposed the existing installed dirty shared catalog's
`pi` provider versus committed harness/usage/subagent tables mismatch (five errors
outside this change). The working tree contains those foreign fixes. This is not
a claim that an entirely clean repository plus rebuilt dependencies was verified.
The first verification wrapper also used a nonexistent root `.bin/tsc` path after
its successful runtime pass; the corrected invocation exposed the mismatch above.

A stricter test initially caught a one-millisecond horizon drift from relative
TTL conversion; issuance now preserves the exact absolute owner deadline.
No test artifacts or verification source archives were retained.
