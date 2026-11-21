# Buddies v2 Handoff — Decoupled Standalone `expedition` CLI & File-Based Context Injection

**Date:** 2026-11-21  
**Origin:** Lessons from running a 25+ lane multi-wave Rust/ML sprint in `~/git/loft` (`wave15_2.sh` → `wave15_3.sh` → `wave16.sh` → `wave_fast.sh`), where we needed a resumable, live-rewritable parallel DAG runner and ended up hand-rolling bash scripts instead of reaching for Buddies Expeditions.

---

## 1. Diagnosis — Why We Reached for Bash Instead of Expeditions

Expeditions' **execution kernel is already strong** (proven in `LESSONS.md` Runs 1–5):
- Content-keyed `log.jsonl` memoization & instant replay across restarts and rewrites
- First-class live `rewrite` (re-evaluate plan, reuse settled keys, keep matching in-flight steps alive, drop obsolete pending steps, launch new ones)
- Proven final-message JSON extraction, isolated worktree commits, private temp dirs, and judged host checks

**Why nobody reached for it during a real 25-lane sprint:**
1. **Locked inside the Buddies server + UI ceremony.** Launching requires a Buddy proposing an `ExpeditionProposal`, an owner clicking Launch in the Channels rail, and the Buddies server owning the run lifecycle. From a terminal, Cursor session, or Codex loop, you cannot simply run `expedition run wave.ts`.
2. **Identity coupled into execution.** The kernel required a Buddies `leader` / `workspaceId` / DM channel thread in order to inject Buddy `SOUL.md` and memories — coupling long-term employee identity into what should be a pure, repo-agnostic DAG runner.
3. **Missing local-machine safety plumbing (macOS 24 GB / shared multi-agent reality):**
   - No native **Cambium** ephemeral worktree lifecycle (`git cambium add -ephemeral ...` / `git cambium remove --safe ...`)
   - No **`flock`-based resource locks** (kernel-released file locks for step slots, compile slot `agent-build`, and GPU slot `gpu_lock` — zero stale lockfiles, zero `ps`/`pgrep`/`lsof` process-table scans that trigger the macOS 15.5 `proc_find` freeze convoy)
   - No `memory_pressure` guard or `taskpolicy -b nice -n 15` background QoS
4. **Heavy authoring ceremony.** The 10 examples in `docs/expeditions/examples/` are 16–34 KB each. When you want to stand up a 10-step split-first parallel DAG in 60 seconds, a plan needs to read like a **40–80 line TypeScript file**.

---

## 2. Core Architectural Split for v2

Separate **Employee / Taste / Memory (Buddies)** from **Keyed DAG Execution (Expedition)**:

```text
┌─────────────────────────────────────────────────────────────────────────┐
│  Buddies (optional manager & UI layer)                                  │
│  - Owns SOUL.md, long-term memory, owner taste, Channels rail UI        │
│  - Dumps relevant context slice → plain `.expedition/<id>/context.md`   │
│  - Calls `expedition run` / `expedition rewrite` / `expedition answer`  │
│  - Renders `.expedition/<id>/log.jsonl` live in Channels rail           │
└───────────────────────────────────┬─────────────────────────────────────┘
                                    │ plain CLI + files (no daemon lock-in)
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  `expedition` standalone CLI (in PATH, zero server required)            │
│  - One run folder: `.expedition/<id>/{plan.ts, plans/vN.ts, log.jsonl}` │
│  - Keyed memoization + live rewrite + typed owner questions             │
│  - Native Cambium worktrees + `flock` slots (steps / build / gpu)       │
│  - Works identically from zsh, Cursor, Claude Code, Codex, OR Buddies   │
└─────────────────────────────────────────────────────────────────────────┘
```

### Context Injection: Plain Files, Not Server Coupling
Instead of wiring Buddies DB/memory lookups inside the expedition runner:
- Every plan and step accepts `contextFiles?: string[]` (plain markdown/text files, hashed into the step's memoization key — or explicitly marked `unkeyedContext` when minor wording tweaks shouldn't bust settled cache).
- When a **Buddy** launches or rewrites an expedition, the Buddy writes the relevant slice of its `SOUL.md` + domain memories + architectural constraints into `.expedition/<id>/context/<role>.md` and passes it via `contextFiles`.
- When a **human or Cursor/Codex agent** runs `expedition` directly from a repo, it passes `AGENTS.md` + `docs/spec/...` the exact same way.

---

## 3. Standalone CLI Contract (5 Commands, Zero Server, Live Rewrites First-Class)

Installable in `PATH` (`~/.local/bin/expedition` or `pnpm` workspace bin) — **CLI first**; add a thin MCP wrapper only if a host lacks shell execution.

| Command | Behavior |
|---|---|
| `expedition run <plan.ts> [--id <id>] [--detach]` | Runs the keyed DAG in `<repo>/.expedition/<id>/` (or `$EXPEDITION_HOME`). Replays settled keys from `log.jsonl`; writes immutable `plans/v1.ts`. |
| `expedition status <id> [--json]` | Instant **file-only** status (zero `ps`/`pgrep`): settled / running (PID verified via `kill -0` only, log size, last-write age) / queued / waiting-question / failed, plus spend & plan version. |
| `expedition rewrite <id> <plan.vN.ts>` | **First-class live rewrite without a server.** Typechecks + dry-evaluates `<plan.vN.ts>`, snapshots `plans/vN.ts`, appends a `plan_rewritten` record to `log.jsonl`, and sends `SIGUSR1` (or bumps a watched version file) to the live runner: settled keys replay, matching in-flight keys keep running undisturbed, removed pending steps cancel cleanly, newly added/reordered steps launch immediately. |
| `expedition answer <id> <questionKey> <value>` | Appends an owner decision to `log.jsonl` and wakes the runner (Buddies UI calls the exact same command/writer). |
| `expedition stop <id> [--keep-worktrees]` | Gracefully stops active steps, releases `flock` locks, and safely retires ephemeral Cambium worktrees (`git cambium remove --safe`). |

### Why Live Rewrites Must Work Without a Server
During the Loft sprint we reshaped a running DAG **twice mid-flight**:
1. Flipped from 3 sequential refactor waves to **split-first → 8-wide parallel fan-out** while `iv15_2` was mid-merge.
2. Flipped all queued Rust workers into **zero-compile fast-coding mode** (deferring all compilation to one final integrator) while 3 workers were already running.

With bash we had to manually kill idle conductors and atomically swap scripts. With `expedition rewrite <id> plan.v2.ts`, that exact workflow becomes one atomic, typechecked, replay-safe command.

---

## 4. Machine-Native Execution Primitives (Must-Haves for Local Multi-Agent Runs)

Bake the lessons from Loft/Keel directly into the runner so no repo ever re-implements `run.sh`:

1. **Worktree strategy = `cambium` (default when installed, fallback `git worktree`):**
   - `git cambium add -b <branch> -name <id>-<key> -ephemeral ~/git/_wt/<id>-<key> <base>`
   - On settle/merge: preserve ignored artifacts if configured, then `git cambium remove --safe <name>`.
2. **Kernel `flock` locks (zero `ps` / `pgrep` / `lsof` anywhere in the runner):**
   - Step concurrency slots via `flock` (or atomic noclobber + `kill -0`) — crashed workers auto-release.
   - Named shared resource locks declared per step: `locks: ['build']` (uses `agent-build` / shared `flock` slot), `locks: ['gpu']` (uses `gpu_lock`), or `locks: []` for pure-Python / zero-compile coding steps (never stall a non-GPU worker on a GPU lock!).
3. **Host politeness built in:**
   - Check `memory_pressure` free % before spawning new slots (pause below 25%, cap `CARGO_BUILD_JOBS=1` below 35%).
   - Spawn workers under `taskpolicy -b nice -n 15` on macOS so foreground apps stay snappy.
   - Respect `~/Library/Logs/FreezeSampler/STALL` as a pause signal (no new spawns while a freeze stall is active).
4. **First-class step execution modes:**
   - `mode: 'code-only'` (injects strict zero-compile directive + `locks: []`, ideal for wide 6–10× parallel coding fan-outs with one integrator compiling at the end).
   - `mode: 'verify'` (runs build/tests/GPU checks with `locks: ['build', 'gpu']`).
   - Explicit `model`, `effort` (`low | medium | high | xhigh`), `harness` (`codex | claude`), `timeoutSec`, `retries`, and `contextFiles`.
5. **Zero-ceremony authoring (40-line plan target):**
   ```ts
   import { expedition, parallel, step } from 'expedition';

   export default expedition({
     goal: 'Loft v1.5 split-first lean core + train-ready seeds',
     base: 'origin/main',
     maxParallel: 8,
     contextFiles: ['AGENTS.md', '.expedition/context/loft-core.md'],
     async run(e) {
       const [builtins, mood] = await parallel(
         e.step('w16_builtins', { model: 'gpt-6.2-sol', effort: 'low', mode: 'code-only', brief: 'briefs/w16_builtins.md' }),
         e.step('v15_motion_mood', { model: 'gpt-6.2-sol', effort: 'low', mode: 'code-only', brief: 'briefs/v15_motion_mood.md' }),
       );
       const [ctx, split] = await parallel(
         e.step('v15_context', { model: 'gpt-6.2-sol', effort: 'medium', mode: 'code-only', brief: 'briefs/v15_context.md' }),
         e.step('w16_splitter', { model: 'gpt-6.2-sol', effort: 'medium', mode: 'code-only', brief: 'briefs/w16_splitter.md' }),
       );
       const base = await e.step('iv_split', {
         model: 'gpt-6.2-astra', effort: 'high', mode: 'verify', locks: ['build'],
         after: [builtins, mood, ctx, split], brief: 'briefs/iv_split.md',
       });
       const fanout = await parallel(
         ...['v15_crab_seeds', 'v15_meta_seeds', 'w16_verify', 'w16_emit_wgsl',
             'w16_check_builtins', 'w16_eval_builtins', 'w16_compile_stages', 'w16_runner_trim']
           .map(k => e.step(k, { base: base.commit, model: 'gpt-6.2-sol', effort: 'low', mode: 'code-only', brief: `briefs/${k}.md` }))
       );
       return e.step('iv_final', {
         model: 'gpt-6.2-astra', effort: 'high', mode: 'verify', locks: ['build', 'gpu'],
         after: fanout, brief: 'briefs/iv_final.md',
       });
     },
   });
   ```

---

## 5. Buddies v2 Integration (Thin Shell Over the CLI)

Once the standalone `expedition` package + CLI exists:
1. **Buddies server no longer owns the DAG runtime.** It invokes the `expedition` library/CLI, pointing at `<APP_DATA_DIR>/expedition-runs/<id>/`.
2. **Buddies adds what Buddies is uniquely good at:**
   - Authoring `context.md` from `BUDDY_SOUL.md` + scoped employee memories before `expedition run` / `expedition rewrite`
   - Channels-rail live view reading `log.jsonl` (rendering `ExpeditionView`)
   - Owner approval cards / DM thread for `expedition answer` and `expedition rewrite` confirmation when spend exceeds allowance
   - Manager wake-ups on failure/blockers so the Buddy can inspect diffs and issue `expedition rewrite`
3. **Zero duplication:** `shared/src/expedition.ts` types (`ExpeditionView`, `ExpeditionStep`, `ExpeditionResult`, `ExpeditionQuestion`) map 1:1 onto the CLI's `log.jsonl` schema.

---

## 6. Recommended Build Order (Smallest Slice First)

1. **Slice 1 — Extract `packages/expedition` (pure Node 24 TS package + `expedition` bin in `PATH`):**
   - Keyed `log.jsonl` engine, `run` / `status` / `rewrite` / `answer` / `stop`, `contextFiles`, Cambium worktrees, `flock` locks (`build`, `gpu`, step slots), `memory_pressure` + `taskpolicy -b nice -n 15`, zero `ps`/`pgrep` scans.
   - **Acceptance test:** Run a real 4-step fan-out + mid-flight `expedition rewrite` (changing a pending step + adding a new step while keeping an in-flight step alive and replaying 2 settled keys) from a plain zsh shell with **zero Buddies server running**.
2. **Slice 2 — Reconnect Buddies UI & Buddy managers onto `packages/expedition`:**
   - Replace server-embedded execution host with calls into `packages/expedition` + Buddy `context.md` export.
   - Keep `ExpeditionProposal`, Channels-rail live view, DM thread, and owner question routing intact.
3. **Slice 3 — Optional thin MCP shim (only if needed):**
   - Expose `expedition_status` / `expedition_rewrite` / `expedition_answer` for hosts without shell access; CLI remains the primary interface.

---

## 7. Explicit Non-Goals (Keep It Lean)
- **No daemon required** to run or rewrite a plan (the `run` process itself handles `SIGUSR1` / watched `plans/vN.ts` and `log.jsonl` appends).
- **No process-table scraping** (`ps`, `pgrep`, `lsof`) anywhere in status, locking, or cleanup.
- **No mandatory approval ceremony** for local CLI runs (owner budget/approval gating is opt-in via contract config or Buddies UI).
- **No server/DB lookups inside worker steps** — pass everything through plain `contextFiles` so every step is inspectable and reproducible.
