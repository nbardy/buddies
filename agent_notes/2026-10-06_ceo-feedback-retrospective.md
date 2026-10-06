# CEO tooling feedback: use cases → decisions → results (retrospective, 2026-10-06 ~08:45Z)

Asked by the owner in #case-studies, thread post_01a10e04:

> "review the original feedback use cases and design decisions and describe system results and whether
> it's simpler, less bug prone and less token hungry as our core goal, and if there is follow up work
> needed, spec it out"

Author: Buddies Development Lead.

State measured at origin/main `fda9fa3`. The backend has reloaded: Buddies now see the `channel` tool, and `runs`
rows carry `purpose`/`taskTitle`, both checked live in this turn. Step 4 (Opus, run_01a11051-7039) is still running.
Decisions are in `2026-10-06_buddies-target-system-review.md` (owner-accepted A–P).

## 1. The seven use cases

| # | CEO pain | Decision | Shipped? | Result |
|---|---|---|---|---|
| 1 | runs/tasks/inbox outputs of 60–95k chars, parsed with ad-hoc Python | S1: views sized for a decision, evidence capped at write, no knobs | **Yes** (7A, 0f13025) | Seeded store: `tasks get` 153,599 → 29,325 chars; `inbox` 123,405 → 4,695. `runs list` keeps a 12 h window in every scope (3838b65), and rows grew slightly (+purpose/title). The cap applies to MCP and to HTTP writes |
| 2 | No run transcript | S2/L2: `runs get {tail}` for audit; progress goes in posts | **Half** | `tail` is live. The behavior half (workers post progress notes on the Task) is **not built**: F2 |
| 3 | A 2-member DM request started both | Owner: DMs are 1:1; groups go to public channels | **Yes** (d3e534f) | The double start can no longer happen. The multi-member `ask()` branch is deleted, not guarded. 0 existing group DMs on the live store |
| 4 | `channel_read {search}` broke after the restart | S4/N: additive-only tool inputs, legacy forms canonicalized, snapshot guard | **Yes** (3838b65, aada965) | The search instance is fixed, and the whole class now fails a test before it ships. The guard has already caught one budget overrun at merge |
| 5 | Restart killed runs; recovery was manual | G: an infrastructure death re-enters the same conversation once | **No**, step 4 (running) | Today: manual `runs retry` (fresh conversation). Turns survive backend restarts via adoption; a host reboot still kills them |
| 6 | No "what is it working on now" | Run rows carry `purpose` + `taskTitle` | **Yes** (7A) | Seen live this turn: `runs list {taskId}` shows "Step 4: one crate rebuild…" with its purpose |
| 7 | Schedules on one Task pile up | I: a schedule fire is a post in its thread; delivery coalesces | **No**, step 4 | Unchanged today |

The root cause was coordinator **polling**, and step 3 is what removes it: an answer now returns into the conversation that
asked, owner chats included, so a lead no longer re-reads runs/tasks/inbox to find results. It is live since the reload but
**not yet observed in production**: F1.

## 2. Against the core goal

### Simpler

**The model is simpler. The code is not yet:**
- **Concepts:**
  - DMs have one owed party.
  - Channel admin is one tool.
  - Return routing is always "the conversation that asked" (the foreground special case was deleted).
- **Lines:** Buddies server + crate went from 10,951 (3838b65) to **11,368 (+417)**:
  - Step 7A added `tool-views.ts`, net +253 in source.
  - Step 3 added the `owner_first` waiting reason, `ownerStop` and a 15-minute orphan bound.
- **The deletions are all ahead:**
  - Step 4: `Returns`, `thread_follow`, `follows.rs`, 4 run kinds.
  - Step 5: the pair machine and the follow-up gate.
  - The delivery design estimates −550 to −1,050. The parent Task's acceptance requires ending below 10,951.

**Two warts added today, each with a planned removal:**
- **The 15-minute `owner_first` bound.** This is a heuristic. It exists because queued chat runs are not durable yet. Step 6
  deletes it.
- **`tool-views.ts` joins `purpose`/`taskTitle` in TypeScript.** That costs N+1 `getPost`/`getTask` calls per row. Step 4
  should move the join into the crate's row SQL: F4.

### Less bug-prone

**New guards, each tied to a named failure:**
- the tool-input snapshot and 3,000-char description budget (CEO #4);
- `an_orphaned_owner_message_stops_holding_returns`;
- the B1 extension (a return in an owner chat never holds the owner grant);
- `a_dm_is_one_to_one_and_a_legacy_group_dm_is_read_only`;
- the evidence cap on both write paths.

**One whole class removed:** recipient ambiguity (CEO #3) can no longer happen.

**Still open:**
- **The flaky test "a failed gate on an owner post is shown".** It times out under load. It goes away with the gate in
  step 5.
- **Restart and schedule pile-up:** these failure modes (#5, #7) remain until step 4.

### Less token-hungry

**Per turn:**
- **Worker tool descriptions:** 4,737 → ≤3,000 chars, about −37%, roughly 430 tokens saved on every Buddy turn. A test
  enforces the cap.
- **Reads:** −81% for `tasks get` and −96% for `inbox` on the seeded store.
- **Polling:** coordinators no longer need to poll for answers (step 3), and that was the CEO's ~30%.

**Fleet-wide (`pnpm token-audit --tag buddy`, run this turn):**
- 1,055 sessions, 4,126M input tokens, ~87M excess (2.1%).
- **77M of that excess (88%) is re-sent context.**
- **The top sessions** re-send the same block 13–35 times. There are two shapes:
  - the thread-turn envelope with thread history ("Nobody reads your text output…", ×13–20 in unleashd and
    temp_paint seats);
  - the Buddy briefing/memory text in wave_sim sessions (×17–35, up to 13.3M excess in one session).
- **This thread is an example.** After the backend reload, this turn's prompt re-sent the full root and many earlier
  replies, because the memory-only pair machine forgot the seat's read point.
- **Step 4's durable `through_ord` plus step 5's delta compose are the fix.** Neither has an acceptance number tied to the
  audit yet: F3.
- Separately, 45.7M is rewritten after idle gaps over 5 minutes. That is cache expiry and outside this work.

## 3. Follow-up work (specs)

- **F1. Live verification of steps 1–3 and 7A on the reloaded backend.**
  - **Why:** every result above was verified in tests on temp stores. None has been observed on the live install.
  - **Done when**, through the live API and real Buddies, on no copied store:
    - a Buddy request sent from an owner chat returns into that chat;
    - an owner message typed during the return's wait runs first;
    - Stop cancels a queued return;
    - `channel` and the legacy `channel_create` both work;
    - `runs list` shows purpose and title;
    - a 3-party DM is refused.
  - **Also:** record `tasks get` / `inbox` / `runs list` sizes on the live store.
  - **Evidence:** a short note with post ids. Sonnet.
- **F2. Workers report progress where people read (S2 behavior half).**
  - **Change:** the worker and request briefing says to post a one-line progress note on the Task at each milestone, and that
    the final answer carries evidence paths, not prose. This is a prompt change only.
  - **Size:** it must fit the existing briefing budget, so net characters are ≤0 (trim elsewhere).
  - **Done when:** a fake-provider test asserts the line is present, and `pnpm token-audit` shows no briefing growth.
  - **Needs the owner's OK:** it changes what every worker turn is told.
- **F3. Resumed turns send only the delta: a token acceptance for steps 4–5.**
  - **Change:** add to step 5's done criteria. A resumed seat or delivery turn sends only the posts after the conversation's
    `through_ord`, plus a stable envelope of ≤400 chars, including right after a backend restart.
  - **Guard:** a server test reloads the backend between two posts and asserts the second prompt carries one post, not the
    thread.
  - **Measure:** run `pnpm token-audit --tag buddy` before and after. A target, not a gate: re-sent context in unleashd seats
    falls by half within a week of use.
- **F4. Move the `purpose`/`taskTitle` join into the crate** (`list_run_rows` SQL) during step 4, and delete the TS N+1 in
  `tool-views.ts`. Added to step 4 as a Task comment.
- **F5. Delete the 15-minute `owner_first` bound in step 6,** once queued chat runs are durable and claimable after a
  restart. Its guard test then flips to "a queued owner message survives a restart and still goes first". Added to step 6.
- **F6. Ratchet the Buddies line count.**
  - **Change:** a test or gate fails if `server/src/buddies` + `crates/unleashd-buddies/src` exceed a committed ceiling. Same
    idea as client gate G8.
  - **Ceiling:** set to today's 11,368. Each step lowers it to its measured result. Steps 4–5 must take it below 10,951.
  - **Why:** "simple" stays measurable, and growth needs a deliberate bump. Sonnet, small.
- **F7. Owner look:** the wake indicator in the UI is now a static "woken" mark (7A side effect).

## Revisit if

- After steps 4–5, the line count is not below 10,951, or the token audit does not show re-sent context falling. Either one
  means the consolidation did not deliver the core goal, and the remaining cruft needs another pass.
