# Buddy memory: how it works today, where it fails, and the outside landscape

*Date: 2026-10-06 · Author: Buddies Development Lead · Kind: research + recommendation*
*Status: PROPOSED (assistant recommendation). No owner decision yet.*
*Question from: Owner, #memory-system thread post_01a10d87-69f0-74e1-b667-7f19806a823f*
*Code cited at main `db82ba6` (2026-10-06). Predecessors: `2026-08-21_memory-architecture-research_buddies-development-lead.md`,
`2026-08-22_memory-design-review.md` (accepted 2k/4k caps, pointers to notes), `2026-09-26_buddy-memory-unification-handoff.md`
(one soul / working / long-term per Buddy, plus a post-turn reviewer).*

## 0. The owner's target, restated

- **Long-term memory**: mostly *pointers* to docs worth remembering, not dense context.
- **Working memory**: evolves quickly and carries the important context *inline*: key learnings, current themes, recurring
  mistakes, key initiatives and *why*. Its job is to hold what matters across threads and projects.
- Memories should have **IDs** and be **promotable** from working to long-term.
- Deep context should sit in docs that are **expanded on demand**.

## 1. What it actually does (code at db82ba6)

| Aspect | Today |
|---|---|
| Unit | Three text blobs per Buddy: `soul`, `working`, `long_term` (plus `shared` docs that are never injected). Table `doc`, plus an append-only `doc_revision` with `reason`, `author`, `sha256`. Only the doc has an id; **entries inside a doc have no id, date or provenance**. `provenance` is never written (always `{}`). |
| Write | `doc_write` replaces the whole blob, with CAS on `base_revision`. The write cap is **40,000 chars for every kind**. No structure is enforced. |
| Who writes | The Buddy itself (rarely) and the **memory reviewer** after every successful turn: ladder codex gpt-6-luna → cursor grok-4.7-low → claude sonnet → muse contributor, low effort, 300 s per rung. It sees **only that one turn's transcript** (48 KB). The reviewer writes under the Buddy's own identity, so its writes can't be told apart except by the `reason` text. |
| Reviewer rule (prompt) | working (at most 2k) = in-flight state; long-term (at most 4k) = lasting owner preferences and confirmed lessons; resolved items are removed from working; "never promote for age or repetition alone"; task status belongs in Tasks; "preserve unrelated useful content". |
| Read | `composeBriefing` injects soul + working + long-term + 12 tasks **verbatim into every Buddy turn**. Each memory doc is **cut at 6,000 chars, keeping the head** (`briefing.ts:18-24`), and the briefing is re-sent whenever a memory revision changes. |
| Promotion / decay | **None as operations.** Promotion happens only when the reviewer rewrites both blobs. Nothing ages out or gets consolidated. |
| Deep docs | `agent_notes/*.md` are plain files with no index, no ids and no search tool. Nothing resolves a pointer written in memory. |
| Claude Code auto-memory | Turned off for Buddy turns (`server/src/buddies/harness-memory.ts`), so it can't fork a second memory. |

## 2. Where it fails against the target

Measured on my own docs today: working revision 71, long-term revision 5.

1. **The caps were lost in the lean rewrite** (c3ff355 / 0fef9d4, 2026-09-25). The 2k/4k limits survive only as prompt text. My
   working memory is about 5–6k chars, roughly 3× the target and a few hundred chars from the 6k briefing cut. **That cut keeps the
   head, and the reviewer appends to the tail, so the newest context is the first thing to fall off, silently.** (Inference from
   `briefing.ts:24`; it hasn't happened to me yet.)
2. **Working memory has become a turn log, not themes.** Six of its seven entries read "2026-10-06 <thing>: transcript reports
   commit X, tests N/M, not independently verified". That is Task status, which the reviewer's own prompt forbids. None of them
   says *why* we are doing something, what keeps going wrong, or what the current initiatives are. **Structural cause:** the
   reviewer sees one turn, so the natural thing for it to write is "summary of this turn". It never has a cross-turn view from which
   to synthesise a theme or spot a recurring mistake.
3. **Nothing is ever evicted.** "Resolved → remove" needs the reviewer to know an item is resolved, and it only sees the current
   turn. The older prompt's "consolidate duplicates, remove expired detail" was dropped. Benchmark case A.r2 already showed the
   reviewer leaving duplicates in place and answering NONE (`docs/benchmarks/memory-curation/2026-09-27/README.md`).
4. **No entry identity, so no promote, retire, cite or diff of a single entry.** Every update is a full rewrite, which is the
   "context collapse / brevity bias" failure that ACE measured (arXiv 2510.04618).
5. **Long-term holds dense context instead of pointers, plus stale and duplicated facts.**
   - The "Direction 1" paragraph inlines a list of five defects.
   - Two entries name "gpt-5.6-luna" as the reviewer; code runs gpt-6-luna plus a ladder.
   - The worker-model policy appears in both the soul and long-term.
6. **Pointers are unchecked plain text** and often name mutable files, against my own soul rule. GitHub Copilot, by contrast,
   validates each memory's citations against the current branch before using it.
7. **Each reviewer write re-sends the full briefing** into a resumed session on the next turn: one copy per revision. This is the
   same shape as the earlier 44-copy / ~835k-char incident (`agent_notes/review_token_usage/FOLLOWUPS.md`).
8. **The reviewer's quality is ungraded.** The current prompt (M3, 2026-09-26) has never been benchmarked or manually graded. The
   ladder ends on the muse *contributor* model, which PLANNING_MEMORY said never to use.
9. **Shared docs are invisible.** "Workspace" shared docs are never injected and aren't readable by other Buddies, despite the tool
   text saying otherwise (`mcp.ts:226` vs `docs.rs:57`).

## 3. Does the target design make sense?

Yes. It is the layout the field converged on in 2025–26:

- a small, capped, always-loaded layer, plus
- one-line index entries that point at detail loaded on demand, plus
- a separate fast-changing "active context".

Claude Code (`MEMORY.md` index + topic files), Letta Code (`system/` pinned + on-demand subdirectories), Gemini CLI (copied
Claude Code's layout in Oct 2026), skills, Cursor "Apply Intelligently" and Windsurf `model_decision` all do this. Cline's
"active context vs stable brief" split is the same idea for working memory.

Three refinements:

1. **"Pure pointer" long-term entries fail in one specific way:** a pointer that doesn't say *when* it matters never gets opened.
   Skills solve this with a description that gets read; Claude Code with a one-line hook per index line. Owner preferences and
   behavioural rules also have to be obeyed without opening anything. So each long-term entry should be **one line of gist or rule,
   a when-relevant hook, and a pointer pinned to a commit**. The dense context lives behind the pointer.
2. **Working memory needs a cross-turn writer.** Themes and recurring mistakes cannot be seen from a single turn. A periodic
   consolidation pass ("dreaming") is what Letta (reflection + defrag subagents), ChatGPT ("Dreaming", June 2026), Codex (phase-2
   consolidation) and Claude Code ("Auto Dream", unofficial) all added on top of per-event capture.
3. **Promotion should be an explicit operation on an entry with an ID,** with criteria:
   - the owner confirmed it, OR
   - a mistake recurred and has a fix, OR
   - it stayed relevant across N consolidations.

   Repeated *mistakes* are exactly the signal the current "never promote for repetition alone" rule throws away.

## 4. What ours does better

- **An independent reviewer writes memory, not the acting agent's own diligence.** Cline's memory bank and the API memory tool
  depend on the agent remembering to update; we don't. Same direction as sleep-time agents, Dreaming and Codex consolidation.
- **Revisioned history with CAS and a reason on every write.** OpenClaw and Hermes record no "why"; CLAUDE.md is overwritten in
  place. Only Letta (git) and Zep (bi-temporal invalidation) keep comparable history.
- **The soul is protected.** The reviewer can't edit it and transcripts are treated as evidence, never instructions. The research
  shows memory poisoning is real: MINJA succeeds over 95% of the time, and planted sleeper memories triggered actions in 60–89% of
  trials (arXiv 2601.05504). OpenClaw's agent-writable `SOUL.md` is the counterexample.
- **Task state lives in Tasks, not memory.** This matches Claude Code's "don't store what you can derive" (when the reviewer obeys it).
- **One memory per Buddy across all harnesses** (codex, claude, cursor), and across chat, channel, worker and schedule turns.
  Claude Code's memory is per repo and per machine and tied to one harness.

## 5. Landscape (condensed; full agent reports are summarised here, with sources in §8)

**Claude Code default memory:**

1. **CLAUDE.md** is written by the human. Scopes: managed → user → project → local; nested directories load lazily; `@imports` up
   to four hops; `.claude/rules/*.md` with `paths:` globs. It is injected as a user message after the system prompt, with a target
   under 200 lines. The `#` quick-add shortcut has been removed; editing is through `/memory`.
2. **Auto memory** is written by Claude in `~/.claude/projects/<repo>/memory/`. `MEMORY.md` is an index with one line per memory.
   **Only its first 200 lines or 25 KB load each session.** Topic files carry frontmatter `type` (user / feedback / project /
   reference) plus a `modified` timestamp and are **read on demand** with file tools. The harness nags as the index nears the cap
   and returns an error once it is over. Claude skips anything derivable from code, git or CLAUDE.md. There are no IDs; the filename
   is the identity.
3. **Skills** use three levels of disclosure: description always loaded, body on use, supporting files when referenced.
4. **`/compact`** re-injects CLAUDE.md and auto memory after summarising the conversation.

**Other products and systems:**

| System | Unit / IDs | Writer | Loading | Consolidation / decay |
|---|---|---|---|---|
| Anthropic memory tool | files under `/memories` | Claude via tool | pull: "view your memory dir first" | app-defined |
| claude.ai | topics + per-project summary | in-chat + background | injected + `conversation_search` | 24 h synthesis (legacy) |
| ChatGPT | dated facts → one synthesized summary | `bio` tool → background "Dreaming" | always injected | Dreaming rewrites, fixes time-sensitive facts |
| Codex CLI memories | summary + raw entries + skills | 2-phase background | injected summary (after AGENTS.md) | ranks by use and recency, drops after `max_unused_days` |
| Gemini CLI | MEMORY.md index + topic files | agent; background patches need approval | index always, topics on demand | `/memory inbox` review |
| Copilot Memory | **fact + citations + reason** | agent `store_memory` | recent ones, **citations validated vs branch** | expires after 28 days unused; use renews |
| Cursor | rules (Memories feature **removed**) | human | 4 rule modes | — |
| Windsurf | memories + rules | auto / human | memories retrieved | none; docs say "use rules for reliability" |
| Cline Memory Bank | 6 md files (brief…activeContext, progress) | agent per instructions | **reads ALL every task** | manual |
| Devin Knowledge | name + trigger + body | suggested, user approves | trigger or pinned | **deprecated → Skills** |
| MemGPT/Letta (classic) | labelled, capped core blocks + archival vectors | agent self-edit + sleep-time agent | blocks pinned | sleep-time rethink |
| Letta Code MemFS (2026-02) | **git repo of md files** | agent + reflection/defrag subagents | `system/` pinned, rest on demand | defrag into 15–25 files |
| Mem0 | atomic facts with ids | LLM extraction; **v3 dropped UPDATE/DELETE → ADD-only** | retrieval (semantic + BM25 + entity, recency) | recency/decay at read time |
| Zep / Graphiti | temporal KG edges | LLM extraction | hybrid retrieval | **invalidate, never delete** (bi-temporal) |
| Generative Agents | timestamped stream | every observation | recency + importance + relevance | reflections that cite their sources |
| A-MEM | Zettelkasten notes with links | LLM | retrieval | new notes rewrite linked ones |
| ACE (ICLR '26) | **bulleted playbook items with ids + helpful/harmful counters** | reflector → curator | in context | **delta updates, not rewrites** |
| OpenClaw / Hermes (Aug note) | MEMORY.md + daily files / FTS5 sessions | agent | loaded / FTS search | Hermes replaced LLM retrieval with FTS5 (4,500× faster) |

**Evidence that matters for work agents (not chat personalisation):**

- **VibeMemBench** (arXiv 2609.23570, 2026-09-20; abstract verified).
  - Hand-injected relevant experience raises coding resolution by 1.1–4.5 points.
  - But when four existing memory systems had to build and retrieve that experience themselves, **11 of 12 pairings failed to beat
    memory-off**.
- **What does help:**
  - procedural / strategy memory distilled from *verified* outcomes (Reflexion, Voyager, ReasoningBank +4.6 on SWE-bench Verified,
    ACE +10.6 on AppWorld);
  - pointer + grep over files, which matched vector stores (Letta 74.0% vs Mem0 68.5% on LoCoMo).
- **What doesn't:** LoCoMo is saturated and about 6.4% of its answer key is wrong. Vendor memory scores aren't comparable.

**Recurring failure modes everywhere:** bloat, staleness, contradiction, collapse under repeated rewrites, poisoning, sycophantic
or over-personalised memory (Codex warns about this), over-recall into unrelated work (Willison's "dossier"), and loss of what the
assistant itself decided (Zep −17.7% on single-session-assistant questions).

## 6. Recommendation (PROPOSED: needs an owner decision)

Keep the substrate: three docs, CAS revisions, an independent reviewer, notes as files. Change the *shape* and add *one*
cross-turn pass. Don't add vectors, graphs or Mem0: the work-agent evidence doesn't support them, and Hermes deleted its own smart
retrieval layer.

**R1 — Enforce caps at write time (cheap; restores an accepted 2026-08-22 decision).**
- The crate rejects working over 2k and long-term over 4k with an error that tells the writer to compress, the same way Claude
  Code's harness errors on an oversized index.
- Truncation in the briefing becomes unreachable.

**R2 — An entry format with IDs, inside the same markdown docs.**
- One entry per line: `- [w7f3a] 2026-10-06 · <type> · <text> → <ref>`.
  - Types for working: `initiative | theme | mistake | open-question | fragile`.
  - Types for long-term: `preference | rule | lesson | pointer`.
  - `<ref>` must be `path@commit`, `task:<id>` or `post:<id>`.
- The crate parses and validates entries, so the ops become single-entry edits rather than full-blob rewrites (ACE's fix for
  context collapse):
  - `add`
  - `edit`
  - `retire(reason)`
  - `promote(id)`: moves the entry into long-term **keeping its id**
- `provenance` is filled with the turn id and reviewer model. The reviewer gets its own author key.

**R3 — Reshape the reviewer prompt to match the target.**
- Working = initiatives and *why*, current themes, recurring mistakes, open owner questions.
  - **Banned:** commit hashes, test counts, "transcript reports" logs. Those go to a Task comment or a note.
- Long-term = one-line rule or gist, a when-relevant hook, and a pointer.
- Promotion criteria: the owner confirmed it, OR a recurring mistake has a fix, OR it survived N consolidations.

**R4 — Daily consolidation ("dream") per Buddy: the one new mechanism.**
- Inputs: working + long-term + the last N reviewer receipts and turn summaries + open Tasks.
- It synthesises themes and recurring mistakes, retires resolved and stale entries, proposes promotions, and checks every `ref`
  still resolves (Copilot's validation step).
- It runs through the existing schedule and run machinery, scales to zero, and writes through the same entry ops.

**R5 — Measure what matters.**
- Extend the memory-curation benchmark with cross-thread cases: a fact learned in thread A must change an action in thread B (the
  MemoryArena / VibeMemBench lesson).
- Grade the current prompt before and after R3.
- Drop the muse contributor rung.

**Reconsider vectors or retrieval only if** both of these hold: entry counts outgrow what a 2k/4k index can point at, and grep over
`agent_notes` measurably misses (for example, in the cross-thread benchmark cases).

**Open questions for the owner:**
1. Approve R1–R5, or a subset? R1 + R3 is about a day's work. R2 + R4 is a design-then-build Task: Opus for the entry format
   and dream design, then Sonnet to build.
2. Should the reviewer keep writing per turn once dreaming exists? Or should per-turn capture become append-only "candidates" that
   only the dream pass curates? I recommend candidates; that is Mem0 v3's lesson: ADD at write time, resolve later.
3. Should a promotion to long-term need owner approval (Gemini CLI inbox / Devin model)? Or only owner *visibility* (a weekly
   digest post)?

## 7. What would change this recommendation

- If the cross-thread benchmark shows the current blobs already carry themes across threads, R2/R4 aren't worth their cost.
- If dreaming costs more than per-turn reviews save (measure with `pnpm token-audit`), make it weekly or on demand.

## 8. Sources

**Internal:**
- `server/src/buddies/briefing.ts:18-24,70-134`
- `server/src/buddies/memory-review.ts:36-94`
- `server/src/buddies/mcp.ts:226,238,556-569,734-744`
- `crates/unleashd-buddies/src/{schema.rs:129-139,docs.rs:34-137}`
- `server/src/turns/runner.ts:806-808`
- `product/buddies/PLANNING_MEMORY.md`
- `agent_notes/buddy-notes/*/memory-archive.md` (historical sizes: avg 1,667 / max 2,069 working; avg 2,296 / max 3,985
  long-term while caps were enforced)

**External:**
- Claude Code memory https://code.claude.com/docs/en/memory · skills https://code.claude.com/docs/en/skills
- Memory tool https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool · context editing https://platform.claude.com/docs/en/build-with-claude/context-editing
- Anthropic context engineering https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents · Skills https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills
- Auto Dream (unofficial) https://tessl.io/blog/anthropic-tests-auto-dream-to-clean-up-claudes-memory/
- ChatGPT Dreaming https://openai.com/index/chatgpt-memory-dreaming/ · reverse-engineering https://llmrefs.com/blog/reverse-engineering-chatgpt-memory · Willison https://simonwillison.net/2025/May/21/chatgpt-new-memory/
- Codex memories https://learn.chatgpt.com/docs/customization/memories · https://codex.danielvaughan.com/2026/04/18/codex-built-in-memory-system-deep-dive/
- Gemini CLI https://geminicli.com/docs/cli/gemini-md · https://github.com/google-gemini/gemini-cli
- Copilot Memory https://docs.github.com/en/copilot/concepts/agents/copilot-memory · https://github.blog/ai-and-ml/github-copilot/building-an-agentic-memory-system-for-github-copilot/
- Cursor rules https://cursor.com/docs/context/rules · Windsurf https://docs.devin.ai/desktop/cascade/memories · Cline https://docs.cline.bot/features/memory-bank · Devin https://docs.devin.ai/product-guides/knowledge.md
- MemGPT https://arxiv.org/abs/2310.08560 · sleep-time https://arxiv.org/abs/2504.13171v1 · Letta context repositories https://www.letta.com/blog/context-repositories · Letta FS benchmark https://www.letta.com/blog/benchmarking-ai-agent-memory · Letta skill learning https://letta.com/blog/skill-learning
- Mem0 https://arxiv.org/abs/2504.19413 · v3 https://docs.mem0.ai/migration/oss-v2-to-v3 · Zep rebuttal https://www.getzep.com/blog/lies-damn-lies-statistics-is-mem0-really-sota-in-agent-memory/
- Zep/Graphiti https://arxiv.org/html/2501.13956v1 · LangMem https://www.langchain.com/blog/langmem-sdk-launch
- Generative Agents https://arxiv.org/abs/2304.03442 · A-MEM https://arxiv.org/abs/2502.12110 · MemoryOS https://arxiv.org/abs/2506.06326v1 · MIRIX https://arxiv.org/abs/2507.07957
- Reflexion https://arxiv.org/abs/2303.11366 · Voyager https://arxiv.org/abs/2305.16291 · ExpeL https://arxiv.org/abs/2308.10144 · ACE https://arxiv.org/abs/2510.04618 · ReasoningBank https://research.google/blog/reasoningbank-enabling-agents-to-learn-from-experience/
- VibeMemBench https://arxiv.org/abs/2609.23570 (abstract fetched 2026-10-06) · MemoryArena https://arxiv.org/abs/2602.16313 · LoCoMo audit https://dev.to/penfieldlabs/we-audited-locomo-64-of-the-answer-key-is-wrong-and-the-judge-accepts-up-to-63-of-intentionally-33lg
- Memory poisoning https://arxiv.org/html/2601.05504v1 · Manus https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus

Caveats on sourcing:
- ChatGPT internals come from reverse-engineering (openai.com returned 403).
- The Codex file layout and Claude Code "Session Memory" / "Auto Dream" come from third parties.
- Vendor benchmark numbers are self-reported.

---

## Successor 1 (2026-10-06): owner asks "maybe we scrap working memory?" — PROPOSED, no decision yet

Owner (thread post_01a10d87…): the working-memory-as-turn-log duplicates the chat log and context we already have;
maybe scrap working memory.

New evidence since §2:
- **Prompt fixes alone won't hold.** Right after this research, the reviewer appended another turn-log entry (working rev 76,
  "Wave_sim CEO tooling feedback … transcript reports …") and kept the stale "gpt-5.6-luna" line. A writer that sees one turn
  writes turn summaries.
- **Churn:** working went from rev 71 to rev 76 in a few hours, while long-term is at rev 5. Almost every briefing re-send
  (§2.7) comes from working-memory churn.

Assistant recommendation: **scrap working memory as a separate, per-turn-written doc. Keep the one thing it was for.**
- What working memory duplicates:
  - chat history: per-thread, and already in context;
  - Tasks: status, initiatives, next actions; 12 are injected;
  - notes: detail.
- What none of those carry is the **cross-thread gist**: current focus and why, recurring mistakes, and open owner questions.
  That is small: a few lines.
- Proposal:
  1. One memory doc: the existing long-term doc (§6 R2 index format) plus a short `## Now` section (≤ ~800 chars, dated).
  2. **Only a daily consolidation pass rewrites `## Now`**, because it reads across threads and Tasks.
  3. The per-turn reviewer either goes away or only adds durable preferences/lessons, which are rare. Lean towards removing it
     once the daily pass exists.
  4. Delete the `working` kind (migrate the current content into a note, then drop it).
- **Alternative considered: scrap it with no replacement.**
  - Simplest option.
  - Loses the cross-thread themes and recurring-mistakes context the owner asked for in the root post.
  - Recurring mistakes would then survive only if promoted to long-term lessons.
  - Acceptable fallback if the daily pass is judged not worth its cost.
- **Revisit if:** the cross-thread benchmark cases (R5) show Buddies carry focus between threads just as well with no `## Now`
  section. Then drop it too.
