# 2026-10-08: Game Designer's background-Workflow turn "died ~7 min after a backend restart"

Task: task_01a11aa9. Read-only diagnosis (transcripts, backend-exits.jsonl, errors.jsonl,
macOS power log and DiagnosticReports; no sqlite on live stores). Times are UTC; the
machine's clock is +08:00.

## Verdict

**Not an unleashd defect.** The backend restart did not kill the turn. A second backend
adopted the turn and followed it for 6.5 minutes. Then the whole Mac was force-reset with
the power button: kernel panic `btn_rst` at about 07:04:25–07:04:53Z. No process survives
that. The post-reboot backend then correctly reported the journal as `lost`. Adoption is
built to survive a backend exit, not a machine reset, and it did what it was built to do.
No code change was made.

## Timeline

| UTC | Event | Source |
|---|---|---|
| 06:54:29 | Game Designer launches Workflow `wf_5baa8411-dbb` (6 Opus lens agents) in the background | parent transcript |
| 06:54:42 | The parent model ends its turn. The process stays alive for the Workflow | parent transcript (`stop_hook_summary`) |
| 06:57:26 | "Backend reload queued: keeping current backend available for 2 active operation(s)" | errors.jsonl, boot `945cf216` |
| 06:57:43 | Backend pid 18931 (boot `945cf216`) drains, code 0 | backend-exits.jsonl line 81 |
| 06:57:51 | **The next backend (boot `487a8614`) is up and serving.** It answers GETs for the running conversations (`209ff014…`, `298f67c6…`, codex `05fac68b…`, `dffb2208…`) until 07:04:23 | errors.jsonl (event-loop records carry `serverBootId`) |
| 06:56–07:04:25 | The Workflow's lens agents keep writing. The last records are mid-work (`attachment` entries), with no completion | `…/68ace89d…/subagents/workflows/wf_5baa8411-dbb/agent-*.jsonl` tails: 06:56:43, 06:58:05, 07:01:32, 07:02:21, 07:03:13, 07:04:25 |
| 07:04:23 / 07:04:25 | The adopting backend's last record and the Workflow's last write, 2 s apart: **everything stops at once** | errors.jsonl; agent-a0b404651e5af3710.jsonl |
| 07:04:53 | Kernel boot time | `sysctl kern.boottime` → `Thu Oct 8 15:04:53 2026`; `last reboot` → `Thu Oct 8 15:04` |
| 07:05:26 | powerd starts. "Total Sleep/Wakes since boot at 2026-10-08 15:05:26 +0800" | `pmset -g log` |
| 07:05:26 | Panic report `panic(cpu 5 …): btn_rst`. Reset counter: "Boot faults: timeout,dblclick_timeout target_off_restart" | `/Library/Logs/DiagnosticReports/forceReset-full-2026-10-08-150526.0002.diag` (sha256 95a412b5ccc568bbda285123848496b2fb41ed9fdb7496d77f30544bd3bf9a01), `ResetCounter-2026-10-08-150528.diag` (sha256 f24f90b9945feee3ee57148869a46d83ec919c8a9ec18b1369865c4cd0f904d2) |
| 07:07:23 | The post-reboot backend (boot `0f049d05`) starts | errors.jsonl |
| 07:08:04 | **Eight** executions are reported "execution was lost: its process group was killed without an exit record": 4 claude and 4 codex | errors.jsonl, component `conversation-runtime` |
| 07:08:06 | Game Designer gets its next turn with Claude's own notice: "Background workflow … didn't finish before the previous session ended". It relaunches on Sonnet at 07:09:40 | parent transcript |

## Why each candidate in the Task is ruled out

- **Process-group kill on drain**: ruled out. The Workflow agents wrote for 6.5 min
  after the 06:57:43 drain.
- **SIGPIPE when a pipe closed**: ruled out for the same reason. Journals write to files
  (docs/turn-lifecycle.md#execution-adoption), and the process outlived the drained
  backend.
- **Buddy MCP server or loopback port disappearing**: ruled out. A backend was serving
  from 06:57:51, and the lens agents were not making Buddy calls.
- **Claude's own background-task handling after the parent turn ended**: ruled out. The
  stop was simultaneous across processes: the backend (node) stopped at the same moment,
  and four codex executions died with it. A Claude-internal exit would not take down a
  node backend or codex processes.
- **A machine-wide stop**: confirmed. A `btn_rst` panic (power button held) and a reboot.
  The panic stackshot lists 8 Claude CLI processes (`2.1.292`/`2.1.293`) and 6 `codex`
  processes alive at the moment of the reset, so the turns were still running when the
  machine went down.

## The "orphaned" framing was wrong

`agent_notes/2026-10-08_game-designer-art-lead-trace-findings.md` (§Game Designer, last
bullet) says the next backend came up "about 07:07" and that the process was orphaned.
The 07:07 backend was the post-reboot one. An intermediate backend (`487a8614`) ran from
06:57:51 to 07:04:23 and was adopting the turn the whole time: the 07:08 `lost` came from a
journal that was still unsettled, which only happens if no backend settled it in between.
backend-exits.jsonl has no record for `487a8614`, because a hard reset leaves no exit to
record. That missing line is what made it look as if no backend had run in the gap.

## Open (not unleashd)

- Was the reset deliberate, or did the machine hang? The reset diag says
  `memoryPressure: false`, but 12,945 free pages (~200 MB) and a ~9.5 GB compressor on
  this machine, with 39 Chrome renderers, 16 node, 8 Claude and 6 codex processes. Earlier
  that day, at 04:10:59 local, WindowServer hit a userspace watchdog timeout
  (`WindowServer_2026-10-08-041059_…userspace_watchdog_timeout.spin`), and there was a
  reboot at 11:35 local. If the owner did not hold the power button on purpose, heavy
  memory load from parallel agent fan-out is the leading suspect. That would be a
  capacity question, not a lifecycle bug.
- Product follow-up, if wanted: after a reboot, a `lost` turn is only picked up by the
  Buddy's next wake. Here that was 4 min later, because owner posts were queued. Nothing
  resumes a background Workflow; Claude itself reports it as "stopped".

## How to diagnose the next "lost without an exit record"

1. Run `pmset -g log | grep -E 'Start|Sleep|Wake'` and `last reboot` around the gap. A
   boot inside the gap ends the investigation.
2. Look in `/Library/Logs/DiagnosticReports/` for `forceReset-*`, `panic-*` and
   `ResetCounter-*`.
3. Collect `serverBootId` from errors.jsonl across the gap. backend-exits.jsonl records
   only exits that ran their handler, so it misses backends killed by a hard reset.
