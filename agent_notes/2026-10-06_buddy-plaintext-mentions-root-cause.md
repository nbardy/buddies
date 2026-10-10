# 2026-10-06 — Buddy plain-text `@Name` mentions: not highlighted, wake nobody

Asked by: Owner, #case-studies thread post_01a10ff8-38f7-75ad-a587-135c46aab188.
Investigated by: Buddies Development Lead. Status: root cause confirmed; fix is a PROPOSAL awaiting owner pick.

## What happened (wave_sim #simulations, list_7eb2ffbd…)

| time (UTC) | post | author | how the Lead was addressed | effect |
|---|---|---|---|---|
| 06:42:29 | post_01a10ff3-0ead (Engine E root) | Wave_sim CEO (claude) | plain text `@Wave Simulation Lead`, `@Wave_sim CEO` | none: no chip, no wake |
| 06:42:34 | post_01a10ff3-215c (Engine A root) | Wave_sim CEO | same plain text | none |
| 06:42:44 | post_01a10ff3-48f0, **DM request** dm_080bd7d3… | Wave_sim CEO | `post {channel:{direct:[lead]}, kind:"request"}` | started run_01a10ff3-48f1 (Lead, codex). The Lead's "Engine A baseline checks are underway" reply came from this run, not from the thread tag |
| 06:46:34 | post_01a10ff6-cb45, DM request + `worker {codex, gpt-6.1-sol, high}` | Wave_sim CEO → Code Quality Engineer | DM request with a worker override | started run_01a10ff6-cb47; its thread post (06:47:21) came from that run |
| 06:46:40 | post_01a10ff6-e0fe (thread reply) | Wave_sim CEO | link form `[@Wave Simulation Lead](buddy:buddy_ed6b…)` | chip rendered; woke the Lead in its thread seat (conversation 763a464c…), reply at 06:47:38 |

Source: CEO transcript `~/.claude/projects/-Users-nicholasbardy-git-wave-sim/98696e43-….jsonl` (post tool inputs at 06:42:34 and 06:42:44) and `8f72d8c0-….jsonl` (06:46:34); Lead run transcript `~/.codex/sessions/2026/10/06/rollout-2026-10-06T14-42-46-01a10ff3-511f-….jsonl`, whose first input names "Request post_01a10ff3-48f0 … in direct channel".

So: DM requests (one plain DM, one with a background `worker` model), plus one correct link mention later. The thread-root plain tags did nothing.

## Root cause

A mention exists only in the link form. `server/src/buddies/channels.ts:67`:
`const MENTION = /\[@([^\]]+)\]\(buddy:([A-Za-z0-9_-]+)\)/g;` — wakes are derived from that regex, and the client chip
renders the same link. The owner's composer autocomplete inserts the link form, so owner posts always work.
A Buddy writes raw markdown through the `post` tool, and the only guidance is one clause in the tool description
("Use … [@Name](buddy:<id>) to mention"). `post` accepts `@Wave Simulation Lead` as ordinary text and returns success.
Nothing tells the author that the post mentioned nobody.

Contributing: the root posts themselves *instruct* readers to "Ping @Wave_sim CEO here", which teaches the broken form
to every Buddy that reads the thread. The same CEO used the link form correctly on 2026-10-05 (post_01a10ce3-0041),
so this is model inconsistency at write time. It is not a stale or changed tool.

## Proposal (assistant recommendation, not an owner decision)

Canonicalize at the write boundary (one κ, in `post`):
1. Resolve `@Exact Name` and `@"Two Words"` against the workspace roster and rewrite them to `[@Name](buddy:id)` before storing.
   Both the chip and the wake then come from the one link form.
2. The `post` result returns `mentioned: [{id,name}]`. It also returns `unresolved: ["@Foo"]` for an `@Token` that matches no
   Buddy or more than one, so the author learns whom it woke. A silent no-op becomes data.
3. Regression test: a Buddy post whose body has plain `@Wave Simulation Lead` wakes the Lead and stores the link form.

Alternative considered: reject the post when the text contains an unresolved `@Name`. This is stricter and stores
exactly what was written, but it costs a retry turn and fails on `@` in code or e-mail text. Revisit if rewriting ever
mis-resolves a name.

## Addendum (same day): why the link form worked before but failed here

Owner question: "why did they use it before but fail here? prompt better or bigger updates?"

Evidence, from counting the post tool calls in each transcript:
- CEO main chat `98696e43…` (claude-opus-5-5, 377 assistant turns, 4.3 MB) made about 40 posts over 10-05 and 10-06. All were DMs or task
  comments, and none had a link mention. Its first plain `@Name` posts were the 06:42 Engine roots and the 06:42:44 DM.
  This conversation has never written the link form.
- The 06:46:40 link mention came from a different conversation: the CEO's thread seat `8f72d8c0…` (claude-opus-5-5, 19 turns, fresh context).
- The 10-05 kickoff with links came from a codex session (gpt-6.1-sol), `rollout-2026-10-05T16-42-11-01a10b3a…`.

Reading: the syntax appears in exactly one place, a clause in the `post` tool description. The briefing block and the thread
prompt never mention it (the thread prompt teaches `[title](task:<id>)` but not mentions). A short, fresh conversation follows the tool
description. A very long coordination chat that had only ever sent DMs wrote a document-style post and typed `@Name` the way
a person would. The same Buddy succeeds or fails depending on which of its conversations writes the post.

Recommendation (assistant): do both. Add one prompt line to the briefing and the thread prompt, which is cheap and lowers the rate. Also make the
write path resolve plain names and report whom it woke, which removes the silent no-op. The second is a small change: one
function in the post path plus one test.

## Decision (owner, accepted 2026-10-06, #case-studies post after post_01a10fff-6514)

Owner: "Okay sounds good do the fixes". This accepts the recommendation in post_01a10fff-6514:
(1) `post` resolves plain `@Name` and `@"Name"` to the link form, which is the rewrite option. Reject was not chosen.
(2) The post result reports `mentioned` and `unresolved`.
(3) One guidance line goes at the point of use: the `post` body field description and the BUDDY TOOLS `post:` line. No context trimming
and no new prompt section.
Relation to the delivery plan: Step 5 (task_01a11013-b205) consumes this resolver as its mention input. This fix lands
first, at the write boundary, so the stored body is already canonical before any delivery code reads it, and Step 5 keeps it.
Revisit if a rewrite ever resolves a name to the wrong Buddy.

## Outcome (2026-10-06)

Landed on main as a939c1c (merge of fix/plaintext-mentions; feature commit 1ec6dc0) and pushed. The Sonnet worker implemented it.
New `server/src/buddies/mentions.ts` `resolveMentions`, called by the `post` handler in `mcp.ts`. The guidance line is in the `post` body description and
in the BUDDY TOOLS line in `briefing.ts`.
Lead verification: buddies-v2 + tool-contract 68/68 on a tree equal to HEAD. Live post post_01a1116a-227a on the running backend
stored a plain `@Buddies Development Lead` as a link and returned mentioned/unresolved; the code span was untouched.
Known limits: an unknown multi-word name is reported by its first word only (`@Nobody Here` becomes `@Nobody`). The tool-description budget
has about 2 chars of headroom. Step 4's branch touches `mcp.ts`, so the merge needs care.
