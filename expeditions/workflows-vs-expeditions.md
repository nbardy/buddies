# Workflows vs. expeditions (and when to use which)

Status: historical comparison, superseded by the [keyed system](../docs/expeditions/keyed/v1/DESIGN.md); old host deleted 2026-11-11.

A Claude Code workflow is a **script written before it runs**. An expedition
is a **loop that works out its next steps as it learns**. They fit together:
a workflow makes a good implementation of one fixed-shape step inside an
expedition.

## Side by side

| | Claude Code workflow | Expedition |
|---|---|---|
| **Structure** | A JS script written up front: `agent()`, `parallel()`, `pipeline()`, phases. It can branch on results, but the branches were written in advance. | Discovered as it goes: Plan attempts create Questions; the Tick decides next steps from the Ledger |
| **Best for** | Work whose shape is known: review N files, verify each finding, fan out and merge | Vague, half-scoped goals where the shape is the unknown |
| **Lifetime** | Background of one session; resume only within that session | Days; state lives in the Ledger and survives any process or session ending |
| **Persistence** | Cached `agent()` results for resume | Append-only Ledger: every attempt, result, check and piece of feedback |
| **Models** | Claude models | Any harness (Claude, Codex, …) |
| **Long external jobs** | An agent has to sit and wait | First class: submit, end the attempt, wake when the job finishes |
| **Verification** | A verify stage you can write, as a pattern | Built in: nothing counts until a Check passes |
| **Human steering** | Launch, then stop if needed | Badge, inspector, `@` questions, typed feedback mid-run |
| **Learning** | None across runs | Lessons → playbook → better briefs next time |
| **Cost to start** | Exists today | Must be built |

## Where workflows sit inside an expedition

Fixed-shape steps a workflow captures well:
- a Check panel: three blind verifiers, then a vote;
- the failure re-run trio: same brief on another model, enriched brief, different approach;
- "review these 10 results, verify each".

The expedition decides *what* and *when*; a workflow carries out a fixed-shape
step reliably and in parallel.

## Prototype path

Workflows plus `/loop` in a Claude Code session approximate an expedition
today: the session is the Tick, the Ledger is a file, workflows run fan-outs
and Checks. Its limits (dies with the session, Claude-only, cannot cleanly wait
on external jobs, no badge or inspector) are exactly the reasons to build the
engine afterwards.

## Other neighbours

| Tool | What it is | Relation |
|---|---|---|
| **Buddies automation** | Cron + prompt that wakes a Buddy | Good trigger; persistence depends on the model choosing to continue. An expedition's Tick replaces "remember to continue" with a ledger read. |
| **oompa swarm** | N workers × iterations in worktrees, reviewer, task queue | A fixed task list with a merge gate. An expedition discovers its tasks and counts only verified claims; an oompa swarm could serve as a Work executor. |
| **A single worker / Agent call** | One bounded task | Use directly when the steps are known and one agent can finish. |

## Which one to use

Ladder, cheapest first:

1. **Answer in chat**: a question, a decision, a small edit.
2. **One worker**: a bounded task with a clear done state.
3. **Workflow**: the shape is known in advance (N items × the same steps, a fixed pipeline), it finishes within one session.
4. **Expedition**: all of these hold:
   - the shape is **unknown**: you cannot list the steps up front;
   - progress is **checkable**: there is a done check, or explicit owner judgment;
   - it needs **parallel attempts or more than a few hours**;
   - it is **worth the budget**: a goal that matters at a few dollars and up.

If progress is not checkable at all, it is research or a conversation, not an
expedition. If every step needs owner taste, it is a conversation.
