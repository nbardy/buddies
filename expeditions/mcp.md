# Expedition MCP surface and Buddy behaviour

Status: built as ONE tool, `expedition` (2026-11-01, `server/src/expeditions/tool.ts`); the
original multi-tool design is kept below where it still differs. Primitives:
[design.md](./design.md). How the owner starts one: [README.md](./README.md#how-to-start-one).

## The tool as built

One tool keeps the per-turn description cost to one line (tool-contract.test.ts budget); usage
lives in the Buddy briefing (`BUDDY_TOOL_GUIDE`, server/src/buddies/briefing.ts) and here.

```
expedition({ action })
  { do:'draft',  charter: CharterRequest }  → { draftId, ready, issues[], advice[], defaulted[], resolved[], drafted, next }   // posts a card; launches nothing
  { do:'launch', charter: CharterRequest }  → { id, page, launched, defaulted[], resolved[], next }
                                            | { id, page, alreadyRunning, running }   // same name from this conversation, still open
                                            | error listing every refusal
  { do:'status', id }                       → status text (badge, charter, questions, stages, attempts, validations, integration, cost)
  { do:'list' }                             → [{ id, badge }]
  { do:'steer', id, feedback }              // feedback: {t:'lesson'|'note', text} | {t:'pause'|'resume'|'stop'} | {t:'extend', hours}
  { do:'retire', id }                       // finished expeditions only (stop first): archive branches as origin tags, release trees, archive the crew and its chats, freeze a snapshot
```

`CharterRequest` requires only the WHAT: `name`, `goal`, `done`, `maxAttempts`. The rest take
named defaults when left out, and `defaulted` lists each one applied (never a silent fill):
`inScope`/`outOfScope` none stated, `maxLive` 2, `hours` 8, `exploreShare` 0.2, `crew` the
default crew (manager claude; work claude, codex; check codex, claude; provider default models).
The ledger always stores the full charter. Seat models may be the owner's words: a name that is
not a catalog id resolves once, at ingestion, when its words pick exactly one of that provider's
catalog models by id or display name (`haiku` or `claude haiku` → `claude-haiku-5-5`, `sonnet` →
`claude-sonnet-5-5`, `fable`), and `resolved` lists each one; a name that picks none or several
(`codex sol`) is left as written and refused with the valid ids. Never an invented id. A seat's
model is stored tagged: `{t:'default'}` (the provider picks it at run time) or
`{t:'named', id}`; the tool input stays the plain optional `model` word.

`page` is the expedition page's path as plain data, not a link to post: the host has already
posted the clickable badge in the launch chat, and `next` tells the Buddy so. (2026-11-01 smoke:
the old `link` was markdown with a relative path; a Buddy posted it and the post tool refused it
as a missing media attachment.)

### Draft (design.md R10)

`draft` validates the charter like `launch` and launches nothing. It persists the canonical
charter with its issues, advice, defaulted fields (stored as field names, `inScope`…`crew`; the
card marks each value `default`, while the tool result's `defaulted` keeps one line per field),
resolved model words, origin (the same thread-or-DM rule
as launch), launcher and workspace at `<appData>/expeditions/drafts/<draftId>.json` (one atomic
write), and the host posts ONE draft card where the launch badge would go: purpose
`expedition_draft`, evidence `expedition-draft:<draftId>`, idempotency key `exp-draft:<draftId>`,
plain fallback text `⛺ Draft expedition: <name>`. Re-drafting a name in the same conversation
supersedes the older open draft. A crew Buddy cannot draft. The result carries no charter to
paste: `drafted` is a one-line summary and `next` tells the Buddy the card is in the chat, to
reply in one line with the post tool, and not to ask the owner to type "launch it". When it is
not `ready`, `next` also says Launch stays disabled until the issues are fixed and a new draft
replaces the card.

The owner launches from the card over HTTP (server/src/expeditions/routes.ts, behind the owner
auth gate like every `/api` route): `GET /api/buddies/expeditions/drafts/:draftId?workspaceId=`
returns `ExpeditionDraftView` (an open draft's issues re-checked on read), and `POST
/api/buddies/expeditions/drafts/:draftId/launch {workspaceId}` runs the host's own launch with its
refusal list: 200 `{expeditionId}` (again on a second click), 409 for a superseded draft (naming
the newer one) or a same-name expedition still open, 422 with every refusal, 404 for another
workspace's draft. A tool `launch` of the same name from the same conversation also marks that
open draft launched.

`issues` (draft) and launch refusals are the same list, built in one place (launch.ts
`preflightOf`): the server may run expeditions (its execution gate is enabled, so never a copied
store), the workspace is a git repository with a base commit, `git cambium` is available, every
command check's `argv[0]` resolves (a relative path with a slash must be an executable file
committed at HEAD: checks run in a checkout of a commit), every crew
seat is a known provider/model/effort that guarantees the Buddy tools, and every work seat has a
check seat on another model (claims are never checked by their author's model). `advice` is
non-blocking: no command check, no out-of-scope fence.

Launch is idempotent per (conversation, name) while that expedition is open: a retry returns it
as `alreadyRunning` (nothing new launched); once it finished, the same name launches a new one.

Results go to the chat the launch came from (the badge) and to the expedition chat (the
owner↔crew DM). The owner steers by writing in that chat: the host records each owner message as
`feedback` (`pause`, `resume`, `stop`, `extend 3h`, `lesson: …`, else a note), no tool call
needed. `resume` re-plans: the next manager decision runs under the host's current rules, which
is how a run left at "needs you" continues after a host upgrade (nothing resumes by itself).
`stop` (and the deadline) also cancels the live attempts' runs, as the owner's Stop does; a run
still going 5 minutes later is ended `abandoned` and its tree released (unintegrated commits are
pinned at `refs/salvage/expeditions/<id>/<tree>` first). A crew
Buddy cannot launch or steer expeditions (status only), and a Buddy sees and steers only its own
workspace's expeditions. Not built: `ask`, `ledger`, the budget
envelope and the AmendGoal/RaiseBudget proposals below.

## Original design (multi-tool)

```
expedition_draft(request, context?)
    → { charter, issues[] }            // a Goal draft + what is missing or weak; launches nothing
expedition_launch(charter)
    → { id, badge } | Rejected(issues)  // rejects: no done check (unless OwnerJudgment), no budget, budget over envelope
expedition_list(filter?)               → [{ id, badge }]
expedition_status(id)                  → overview: questions, live attempts, results, spend, needs-you
expedition_ledger(id, since?, kinds?)  → raw entries, for the inspector or detailed questions
expedition_ask(id, question)           → answer citing runs and results (a read-only Answer attempt)
expedition_steer(id, feedback)         // Feedback from design.md: Approve | Redirect | Fund | Kill | Lesson | Pause | Resume | Stop | AmendGoal | RaiseBudget
```

Event stream: each expedition pushes badge updates and "needs you" items to the
chat that launched it.

### Permissions

| Action | Buddy | Owner |
|---|---|---|
| draft, list, status, ledger, ask | yes | yes |
| retire (finished expeditions only; a crew cannot retire) | yes | yes |
| launch | only within the owner's pre-approved budget envelope | yes |
| steer: Approve, Redirect, Fund (within explore share), Kill, Lesson, Pause, Resume, Stop | yes | yes |
| steer: AmendGoal, RaiseBudget | proposes; owner confirms with one click | yes |

So "only the owner changes the WHAT" holds even when a Buddy drives.

## How a Buddy crafts one

The Buddy does not need to be good at writing charters. Crafting is an intake
with typed checks, not a prose skill:

1. **Draft.** The Buddy fills a charter from the owner's request and context and,
   when unsure, calls `{do:'draft'}`. As built it posts the draft card (Info, Launch)
   in the chat and returns `issues[]` (what a launch would refuse), `advice[]` (no
   command check, no scope fence) and the defaults it applied; a missing `done` or
   `maxAttempts` is a schema error naming the field.
2. **Fill gaps.** The Buddy fills what it can from context and asks the owner
   only for what it cannot infer, usually the budget and the done check, in one
   message.
3. **Launch.** `{do:'launch'}` refuses a charter with blocking issues, listing all
   of them. No silent defaults: a missing done check is either supplied or
   explicitly declared `{ownerJudgment:true}`; optional limits take named defaults
   the result lists.

Built shape (2026-11-01, design.md R2): `done` is `{ checks: DoneCheck[] }` or
`{ ownerJudgment: true }` (the ledger stores it tagged, `{t:'checks', checks}` or `{t:'owner'}`), with
`DoneCheck = { kind: 'command', argv: string[], timeoutSeconds } | { kind: 'judged', text }`.
Prefer a `command` check whenever completion can be tested (`["pnpm","test","widget"]`): the
host runs it on the expedition branch head at done, and no agent can report it passed. `judged`
items are verified by a blind goal-check panel. An argv element may not contain a NUL byte, and
`argv[0]` may not carry surrounding whitespace (refused at ingestion).

Per-question acceptance (design.md R11): the done checks are the GOAL's. Each question the
manager adds names its own acceptance, `{t:'command', argv, timeoutSeconds}` (host-run on the
claim's immutable candidate commit, exactly like a done command) or `{t:'panel'}` (an independent
check panel on another model). The done commands never run on a candidate unless the manager names
one as a question's acceptance, so a fail-closed final verifier does not block the preparation
steps that build toward it (2026-11-01 incident `own-engine-geometry-opti-1b837b`). The manager may change any open
question's acceptance with `set_acceptance`, which re-validates the question's unmerged claims
(only the current acceptance decides). A command acceptance trusts its validator files at the
expedition head when it was declared; a candidate that changes them is refused.

Answers (R11): an attempt's answer ends with a fenced json block, or a bare JSON object that ends
the answer. One that cannot be read gets one repair request on the same seat before it is final
(not after the expedition finished); a work attempt that ends with anything but a code claim (an
unreadable answer, a finding, blocked, failed) while its branch holds commits ends as
`unreported_commits {shas}`, and the manager's `claim` action names one of them as its claim.

The tool guide in the Buddy briefing carries a short how-to: when to suggest an
expedition (below), the intake steps, and the permission rules.

## Can a poorly crafted expedition improve itself?

Yes, within the guardrail.

- **What it can fix itself:** Questions, briefs, allocation, routing. A vague
  goal produces a rough first Plan; Reflect and Zoom-out refine the Questions as
  results arrive.
- **What it can only propose:** Goal, scope fence, done checks, budget. When
  results show the charter is weak (a done check that cannot fail, a scope that
  excludes the real problem, an unreachable target), Zoom-out files an
  `AmendGoal` proposal with evidence. It shows as "needs you" on the badge; one
  click applies it.

The first Plan's output is the main moment for this: the expedition returns
its Questions and any charter amendments it already sees. Reviewing that is
optional, but it is the highest-leverage point to steer.

## When a Buddy suggests an expedition

It suggests; it never launches unprompted (cost). One line at the end of its
reply, e.g. "This looks like an expedition: the steps aren't known and it needs
parallel attempts. Want me to draft one with a 20-attempt budget?"

It suggests only when all four hold (same ladder as
[workflows-vs-expeditions.md](./workflows-vs-expeditions.md#which-one-to-use)):

| Test | Means |
|---|---|
| Unknown shape | The Buddy cannot list the steps with confidence |
| Checkable | A done check exists or can be written, or the owner accepts OwnerJudgment |
| Big enough | Needs parallel attempts, or more than a few hours of work |
| Worth it | The goal matters at a budget of a few dollars and up |

It does not suggest one for: questions, single bounded tasks, known-shape
batch work (a workflow fits), or work that needs owner taste at every step.

Signals in the owner's phrasing that often pass the tests: "figure out why…",
"get X passing", "make many parallel attempts", "keep going until…", "half of
this is unscoped".
