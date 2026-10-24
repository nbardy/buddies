# 2026-10-08 08:00Z — Live steering and worker communication successor

Decision-maker: owner for outcomes; Buddies Development Lead for task decomposition and quota fallback. This appends to `2026-10-08_owner-reply-root-causes-decision.md`; it does not erase its earlier evidence or turn proposed mechanisms into owner decisions.

## Accepted owner direction

Source: post_01a11a74-7a14-729b-b624-c9f0d37d1707, 07:40:03Z, thread post_01a117e1-1b0e-72e6-bef4-52b764bac275, channel list_4bd52262-8f0b-465d-99e5-60cc33eb8565. Relevant preserved excerpt: “fix the reply waiting it should injet” and “buddy workers shuk d stllbe runing”, with proposed “message worker” / “parent” MCP communication “on next copleted tool call”. Owner also requested a fresh diagnostic review because the recent rework has left recurring failures.

Choice: deliver owner steering into the existing turn, keep workers alive, and provide live parent↔worker communication. Exact new tool names/contracts remain a design suggestion; the review compares existing Mail/post/run authority first. Authorized correctness fixes retain the owner's 07:31Z commit/push direction. No new permission question was sent.

The earlier reasoning still holds: one conversation has one writer; foreground access must remain available; communication does not grant authority or revive stopped work; task status stays in Tasks. New evidence broadens the requirement from owner→Buddy delivery to parent↔worker direction while child work continues. Native harness subagents and Buddy background workers must be assessed separately.

## Quota evidence and lead action

Owner post_01a11a84-e146-77b3-a99f-044146818e09, 07:57:58Z: “so looks like we're out of claude credits”. Scoped `runs` reads confirmed all three original workers failed at ~07:37Z with `execution_failed`: “Out of tokens: You've hit your session limit · resets 4:30pm (Asia/Makassar)”. This is evidence of Claude session exhaustion, not proof that every account quota is exhausted.

Lead retried the same three requests on Codex, harness-default model, high effort, as a quota fallback from the owner's usual Sonnet/Opus assignment policy. All were observed running at 07:59Z:

- Steering: run_01a11a86-1c87-77a5-b17e-4cd3601514e1; task_01a11a68-4873-7712-8ca8-64b9b102f8a7. Task comment adds the workers-remain-alive regression and preservation of prior work.
- Admission: run_01a11a86-1ca1-7720-a089-9578e6711ef0; task_01a11a6d-4075-754e-be99-dfcc1caa2e5a.
- Liveness: run_01a11a86-1cad-74f9-b945-4138fef82565; task_01a119c4-0545-71da-9ac5-79f9d3553b0b.
- Fresh diagnosis/design: run_01a11a86-1dbe-7091-981d-2241d656d015; task_01a11a85-d085-7440-8f2b-8bedb004412d; spawning request post_01a11a86-1d25-736f-917c-70c7d494604f.

These starts are not completion or verification. The diagnostic worker owes reproduced root causes, historical commit evidence, a coherent minimal repair plan, and exact tool/schema impact if expansion is necessary. It must coordinate with the three fix Tasks rather than implement overlapping changes. Review the concrete expansion proposal before implementation.

Alternatives: wait for Claude's reported reset; continue isolated symptom fixes; add two tools immediately. Lead chose Codex continuation plus a separate diagnostic/design task to avoid quota delay and premature surface expansion. Tradeoff: previous provider session context may not carry across harnesses; workers must recover saved work and Task evidence. Revisit fallback when Claude capacity returns; revisit tool design only on evidence that existing primitives cannot provide live scoped delivery.

## Historical source versions read at 07:59Z

SHA-256 for uncommitted source versions:

- CORE_DESIGN.md: ec8f932c8eb614bce9eb76dd01d2741b6965b39398a42857f3fb5f862c7a488d. Relevant preserved rule: “First ask whether Buddies, Mail, Tasks, ordinary files and existing conversations can express the workflow.”
- 2026-10-08_owner-reply-root-causes-decision.md: de781db1c55a5667cb6c3c87178c5c81a1537742fb1f5a683896e5802e098c04. Relevant preserved choice: “Owner messages steer a running turn after ANY tool use”.
- 2026-10-08_conversation-busy-thread-inject.md: f9069a3477b822310458e69f42587c2bfbbb51041fef7a240d234e83ad6cab18. Relevant preserved lesson: “the label ... is applied to EVERY queued delivery” and “The pool hypothesis had no evidence.” Pool bypass is a preventive accepted rule, not an established explanation of the Game Designer incident.
