# AGENTS.md — Agentic Coding Guide

Index for agents. Hard rules inline; read the linked doc BEFORE working in
that area.

## This codebase is yours

This codebase is yours: what it's for and how it's built are your call, and you'll keep building
on it. (Wording from Anthropic's "Prompting Claude Fable 5.2" guide, "Say who owns the code";
added 2026-11-10 at the owner's request.)

What that means here:

- **Improve the structure as you work.** Merge repeated code instead of adding beside it. Fix the
  nearby bug, the stale comment, the red lint or type error you find; do not only report it.
  Delete code that has no caller. Replace machinery; do not add a second copy of it.
- **These need no approval:** retrying a failed or busy command that is safe to repeat; fixing
  lint, format, type and test failures you come across; refactoring or deleting code in the area
  you are changing; adding the regression test and fix-guard a fix needs; updating the docs and
  this file to match the code; landing finished, verified work on `main`.
- **Say what you changed beyond the ask.** Name every unrequested change in your report, small
  ones included, and never change how an existing feature behaves without saying so. The owner
  reviews the diff, not only the summary.
- **The rules below are yours too.** Each one records an incident and its cost. They guard data,
  history and other sessions' unfinished work, which no amount of ownership makes safe to lose.
  If a rule's reason no longer holds, change the rule here, with the reason, in the same commit.
- **Another session's uncommitted files are work in flight, not yours to sweep up.** The tree
  often carries them. Do not stage, revert or reformat them; everything committed is yours.

## Code tree map

```
shared/src/index.ts                → shared exports + WS Zod schemas/types (protocol v3)
shared/src/conversation.ts         → list row / detail / message page / RowPatch (the wire model)
shared/src/conversation-config.ts   → canonical selection intent, patches, resolution
shared/src/provider-catalog.ts      → provider identities + catalog schemas
server/src/server.ts               → application composition and startup
server/src/conversations/runtime.ts → Conversation: record + queue + runner + kind policy
server/src/turns/*                 → TurnQueue, TurnRunner (event fold), TurnWatchdog, TurnPolicy
server/src/conversations/config-{service,records}.ts → durable configuration and revisions
                                     (records: Rust ConversationRecords store, own SQLite file)
server/src/transport/conversation-websocket.ts → WS command routing
server/src/observability/error-journal.ts → durable grouped server/client failures
server/src/ingest/*                → transcripts + list from the Rust ingest addon; runtimes
server/src/auth/*                  → shared-secret gate (policy/gate/express)
server/src/providers/*             → provider registry + catalog service (models from the generated catalog)
server/src/buddies/*               → Buddy server over the crate: grants, mcp (one HTTP
                                     endpoint, 13 tools), runner, channels, routes,
                                     briefing, memory-review, policy-port (T08 seam)
crates/unleashd-buddies/           → Buddies core (Rust, napi-rs addon): schema,
                                     authorize, posts/docs/tasks/runs
crates/unleashd-ingest/            → transcript ingest + conversation records (Rust addon)
vendor/agent-cli-tool/             → GIT SUBMODULE: canonical request → argv →
                                     process → unified event stream. Thin wrapper;
                                     harness differences live at its edges only.
client/src/atoms/*                 → jotai atoms, derived views, WS actions
client/src/components/{Sidebar,Chat,ConversationConfigPicker}.tsx → main desktop UI
client/src/mobile/*                → mobile view tree (second shell, same core)
client/src/atoms/ui.ts             → device-local UI prefs + NEW-badge seen indexes
server/src/expeditions/            → expeditions: one JSON record each, a serialized step per record,
                                     the `expedition` tool, /api/buddies/expeditions; design:
                                     docs/expeditions-lean-design.md
server/src/expedition-kernel/      → keyed expeditions (v1): log, reconcile, plan runner, gates;
                                     types in shared/src/expedition-keyed.ts (`keyed`)
server/src/expeditions-v1/         → its host: executor (commands, checks, agent calls as Buddy
                                     requests, asks), leader and owner ports, routes under
                                     /api/buddies/keyed-expeditions. Live only with the execution
                                     gate on AND UNLEASHD_EXPEDITIONS_V1=1, else read-only. State
                                     and open findings: docs/expeditions/keyed/v1/CONNECT_PLAN.md §10
client/src/components/buddies/Keyed*.tsx → its timeline view and rail rows
client/src/components/buddies/Expedition*.tsx → chat card, rail section (both shells) and modal.
{server,client}/src/swarm/          → QUARANTINED swarm/oompa viewer; outside code imports
                                     only swarm/index.ts (guard: swarm-quarantine.test.ts)
```

## Hard rules (each records an incident; break one only by changing it here, with the reason)

- Never `useAtomValue(rowsAtom)` in components — use `rowFamily(id)` (the row)
  and `listField(...)` (one field of the one-pass `listIndexAtom`). Bodies and
  detail live in `transcriptFamily(id)`, loaded on open (`useConversationBodies`).
  Streaming text goes to `streamFamily(id)`, never the transcript mid-stream.
  Socket/server state is `connectionAtom`; in-flight commands `commandsAtom`
  (`commandFor(id)`). The route owns the active conversation id.
- All hooks before any early `return`. New list views go in derived atoms, not
  component `useMemo`. Stable fallbacks are module constants.
- Read-only server data goes through `usePolledFetch(source, intervalMs)`,
  never a bare `fetch(...).then(setState)` inside `useEffect`. Results live in
  the keyed cache in `client/src/atoms/resources.ts`, NOT in component state,
  so a remount renders the cached value immediately and revalidates behind it —
  that is what stopped every mobile page visit from waiting on a round trip.
  The cache key is the identity of the DATA: a plain URL string, or
  `resource(key, load)` when one load fans out into several requests (thread
  `signal` into every inner `fetch`). A bare `(signal) => Promise<T>` fetcher is
  rejected by the type — with no key there is nothing to cache under, and it is
  the un-keyed form that made seven panels show the previous project's data
  after a fast switch until 2026-09-06 (SwarmDetail, SwarmAnalytics,
  UsagePanel). Keying supersedes the old abort-on-change guard: a late response
  lands on its own key, which whoever switched away is no longer reading, so
  never re-add a `data.id === currentId` check at a call site.
- `jotaiStore.set` only inside `client/src/atoms/`. The shells never import
  each other (mobile/ vs `components/*` outside `components/buddies/`);
  `views/` imports neither. Width `@media` lives only in shell CSS (G9); a
  view's device tweak is a colocated `[data-device="mobile"] .x` rule.
  Gates: `bash tools/check-client-invariants.sh`.
- One WS bridge (`App.tsx`), one `handleMessage` spine — never a second.
- Auth gate stays FIRST in the Express chain and the WS stays `noServer` +
  explicit `upgrade` handler. `new WebSocketServer({ server })` accepts every
  upgrade before app code runs and republishes the whole command channel.
  Same for the Vite dev server: Connect middleware never sees `upgrade`, so
  the HMR socket needs its own `prependListener('upgrade')` gate.
- Provider-bespoke values (effort levels etc.) pass through verbatim as
  `z.string()`; no shared enums, no value translation, server-side defaults.
- Submodule commits: commit + push INSIDE `vendor/agent-cli-tool` first, then
  bump the outer pointer.
- Keep local `main` and `origin/main` current and merge constantly (owner,
  2026-10-13). Start work from a freshly fetched `origin/main`. Land finished,
  verified work on main right away; do not leave it on a local branch waiting
  for a push. Rebase onto the latest `origin/main`, re-run the checks on the
  rebased commit, then push it fast-forward (`git push origin HEAD:main`). Then
  move local `main` up too (`git fetch origin main:main` when no worktree has it
  checked out). Never force-push main: a rejected push means fetch, rebase,
  re-verify, push. Why: finished fixes sat unpushed for days while the live
  checkout ran older code (Task pins 2026-09-30, delivery fixes 2026-10-12),
  and local `main` lagged `origin/main`.
- Verify the COMMIT, not the working tree. `git` cannot stage part of a file
  non-interactively, this repo forbids stashing, and the tree routinely carries
  150+ dirty files from concurrent sessions — so a multi-file change can land
  half-applied and still verify green, because the checks read the dirty tree
  where the missing piece still exists uncommitted. 48724f4 committed
  `conversation-routes.ts` importing two symbols while the file DEFINING them
  stayed unstaged: at HEAD they had four consumers and zero definitions, and it
  passed review anyway (repaired in afbcff3). Before calling anything verified,
  either confirm `git status --porcelain` is empty (tree == HEAD, so the checks
  you ran ARE checks of the commit) or check the commit directly with
  `git grep <symbol> HEAD`. Stage file-by-file so concurrent sessions' work is
  never swept in.
- Never `git reset --hard`, `filter-branch`, `filter-repo`, or `rebase -i` on a shared branch — they orphaned 5a6cf40/79a8381 on 2026-08-20. Use a throwaway branch instead (this repo does not stash: the tree carries other sessions' files), and ask before rewriting shared history. Guarded in `.claude/settings.local.json` (deny) + `~/.zshrc` wrapper.
- Prefer one integration test through a real boundary over mock-heavy units;
  never assert on TSX/CSS source text.
- Foreground Buddy deadlines must receive `TURN_MAX_RUNTIME_MS` explicitly;
  never inherit the background claim's 600-second default. Automatic expiry
  uses `max_runtime_timeout`, not `stop()` / `user_stop`. Preserve the packaged
  authority and runtime regression tests when changing timers or Buddy versions.
  History: `docs/incident-2026-09-10-buddy-chat-timeout.md` (distinct from the
  August bridge-heartbeat fix).
  A run's LEASE is not its deadline (`docs/patterns.md#lease-heartbeat`). The
  lease is a 5-minute heartbeat (`BUDDY_RUN_LEASE_MS`), renewed on the turn's
  bridge clock. The claim gate is the ONE place a dead holder's run ends, and
  nothing sweeps runs at boot. Never make the lease the deadline's length again:
  with a 24 h lease, dead holders' runs stayed `running` for up to 9.5 h
  (2026-09-30). Never derive a deadline from the lease, either: that was the
  09-10 incident. Guard: `server/test/run-lease.test.ts`.

- Structural patterns live in `docs/patterns.md` (one store + one index,
  sum types, capability grants, one write path, idempotency keys,
  wake-on-write, patches not snapshots, one type source, fix-guards, …).
  New code uses them, and each implementation carries a one-line tag at its
  definition: `// Pattern: <name> (docs/patterns.md#<name>)`. Before
  changing tagged code, read the pattern. Breaking one means updating the doc
  and the tag in the same commit, with the reason. Every fix leaves
  fix-guards: a 1–3 line reason comment (what broke, the measured cost, the
  guard's name), a regression test that fails on the bad pattern itself, and
  the event-loop stall monitor stays wired. Find implementations with
  `rg -n "Pattern: <name>"`.

## Read before touching

For any Buddy model, tool or execution change, start with
[the lean core design](product/buddies/CORE_DESIGN.md). Name the concrete workflow
gap before adding a concept or controller; reuse its canonical authority and
identify what existing code the change replaces. Historical proposals are not
requirements to rebuild omitted machinery.

| Area | Doc |
|---|---|
| Code patterns: the structural patterns, tagging rule, where each is implemented | `docs/patterns.md` |
| Writing a design spec: TS types, goals that name their mechanism, invariants that name their guard, ❌ gaps; Quint for the concurrent core | `docs/design-specs.md` |
| Expeditions v2 (design only): leader + revisable round graphs, user goal vs objective | `docs/expeditions-leader-design.md` |
| Buddies: core model, motivating cases, rationale and scope | `product/buddies/CORE_DESIGN.md` |
| Client state: subscriptions, mutations, perf, hook ordering | `docs/client-state.md` |
| Mobile view tree, grep gates, DeviceKind, UI-state partition | `docs/mobile-view-tree.md` |
| Mobile UI primitives, styling layers, extraction rules | `docs/mobile-ui.md` |
| Architecture: provider seam, submodule rules, lifecycle | `docs/architecture.md` |
| Auth: shared secret, bind policy, why plain-http LAN is the weak path | `docs/auth.md` |
| Per-conversation settings + pass-through pattern (7-step checklist) | `docs/pass-through-pattern.md` |
| WS contract: correlated creation/config commands, summaries, pending state | `docs/ws-contract-surprises.md` |
| Submodule commit dance + `git status` cheatsheet | `docs/git-submodule-dance.md` |
| Test strategy: useful vs overkill, lifecycle authority | `docs/test-strategy.md` |
| Error journal: capture policy, storage, inspection, acknowledgement | `docs/error-journal.md` |
| Buddy automations: ownership, budgets, capture, cancellation | `product/buddies/AUTOMATION_OWNERSHIP.md` |
| Buddy coordination: send/reply, bounded waiting, open purposes | `product/buddies/PLANNING_PRIMITIVES.md` |
| Buddy team setup and operation: readiness, preview/apply, work and returns | `product/buddies/TEAM_OPERATOR_GUIDE.md` |
| Direct reports: owner-granted staffing, relationships, retirement, threat model | `product/buddies/PLANNING_SUB_BUDDIES.md` |
| Buddy memory: soul, working and long-term docs, capture (notes are agent_notes files) | `product/buddies/PLANNING_MEMORY.md` |
| Channels: owner posts, @mention replies, threads, markdown media, Task chips | `product/buddies/CHANNEL_CONVERSATIONS_2026-09-23.md` |
| Memory reviewer benchmark: rerun, grade, extend, historical evidence (read before changing reviewer prompts/tools) | [Memory curation benchmark](server/test/fixtures/memory-curation/README.md) |
| New provider integration protocol | `docs/agent_client_spec.md` |

## Screenshot review (UI changes)

Prove a visible change with pictures, not source reading. A server must be
running (`pnpm dev`); both tools log in with the server's own token
(`UNLEASHD_AUTH_TOKEN` → `UNLEASHD_AUTH_TOKEN_FILE` → `~/.agent-viewer/auth-token`).
The session is READ-ONLY (the page refuses non-GET fetch/XHR/beacon and drops
WS sends; the manifest lists what it refused), so pointing it at the owner's
live dev server is safe. For a static baseline, prefer a throwaway server on a
spare port against a COPY of `~/.agent-viewer` + `~/.buddies` (`BUDDIES_HOME`
at the copy) with no agent CLIs on its PATH. Buddy execution (scheduler, recovery
follow-ups, worker spawns, memory reviewer, adoption of journaled executions) is
DISABLED on any backend whose `UNLEASHD_BUDDIES_DB`, `BUDDIES_HOME` or
`UNLEASHD_DATA_DIR` is set to a non-default path (log: `[buddies] Execution
disabled`), so a copy serves its data and launches nothing. Set
`UNLEASHD_BUDDY_EXECUTION=1` only for tests that need Buddies to run on temp
stores (`run-lease`, `ctrl-c-adoption`); never on a copy of the live stores. The
incident (2026-09-30: 5 real codex workers from a copied DB) and the gate:
`server/src/buddies/execution-gate.ts`, guard `server/test/copied-store-guard.test.ts`.

```bash
pnpm screenshots                              # every client screen × every size
pnpm screenshots --sizes phone,desktop        # phone | ipad-portrait | ipad-landscape | desktop
pnpm screenshots --only chat,thread,buddy-memory   # names: rows of the sheet / buildScreens()
pnpm screenshots --workspace project_… --open # pin a workspace; open the sheet when done
pnpm screenshots --workspace project_… --channel list_… --thread post_… --focus 'text'
                                              # pin one thread; `focus` scrolls to the post containing text
pnpm screenshot:mobile --out /tmp/shots       # the older phone-only gallery (chats, buddies, swarms…)
```

**No-regression loop** (every CSS/view consolidation step):

```bash
pnpm screenshots                                    # 1. before  → output/screenshots/<A>
# 2. make the change
pnpm screenshots --baseline output/screenshots/<A>  # 3. after: replays A's data ids, clock,
                                                    #    sizes and --only, then compares; exit 1 if over
pnpm screenshots --compare <A> <B> --threshold 0.5  # 4. re-diff any two runs (default threshold 0%)
```

Open `<B>/compare.html` (before | after | diff per row; changed pixels in
magenta). Run 1 and 3 back-to-back: live data drifts (sidebar badges,
"N running", new posts), and that drift is a real diff the masks cannot hide.

- Each run writes `output/screenshots/<timestamp>/` (gitignored):
  `<screen>@<size>.png`, `manifest.json` (shots, skips with reasons, data ids,
  clock, blocked writes) and `index.html` — a row per screen, a column per size.
- Stable pixels: the page's `Date` is frozen at the run's clock (the baseline's
  under `--baseline`), so every "3m ago" renders identically; animations and
  transitions jump to their end state; carets are transparent; device-local
  storage is cleared before every page (desktop `/` otherwise restores the
  last chat); each shot waits until no HTTP request has been open for 500ms
  (the idle-time chat-history prefetch excepted), and the manifest records
  anything still loading after 20s. A region that is live by nature gets `data-volatile` in the
  client, which the tool hides. Compare decodes PNGs in the same headless
  Chrome — zero dependencies; the diff math is `tools/lib/pixel-diff.mjs`
  (tested by `pnpm test:tools`).
- Screens use REAL data found through the API: the richest channel across
  every Buddy workspace, the longest settled chat (general, not running, idle
  ≥1h), the first Buddy, the first swarm project. A screen whose data is
  absent is skipped and recorded, never faked. Streaming is not a screen (a live
  turn always differs); the tail-regroup test covers it.
- iPad portrait (768px) renders the MOBILE tree; the switch is
  `matchMedia('(max-width: 768px)')`. A screen with no view on a tree
  (`settings-menu`, `usage` on mobile) is skipped there by design.
- Add a screen in `buildScreens()` in `tools/screenshots.mjs`: `views` maps a
  tree to `{ path, prepare }` (prepare = page JS run before the shot; return
  `'SKIP'` when its precondition is missing), `missing` is the skip reason when
  its data is absent. Set React-controlled inputs with the `typeInto` helper
  (native value setter + `input` event), or React never sees the value.
- No puppeteer/playwright: both tools drive Chrome over CDP through
  `tools/lib/headless-chrome.mjs` (zero dependencies). Always `await
  session.close()` in a `finally`; it waits for Chrome to exit before deleting
  the profile, because deleting early threw ENOTEMPTY and that error replaced
  the real failure.
- `pnpm screenshot:mobile` writes to the COMMITTED `docs/screenshots/mobile/`
  by default — pass `--out` for throwaway runs so the gallery does not churn.

## Misc

- Token cost: `pnpm token-audit` ranks sessions by EXCESS (context re-sent,
  identical tool output returned twice, warm-cache rewrites), never by volume;
  `--session <id>` drills in, `--tag buddy|channel|swarm|other` narrows.
  Run it (a) after any change to what a turn sends — briefing, thread/channel
  context, resume/fork, worker launch — comparing before/after, and (b) every
  few days of real use. A top entry is a lead to investigate, not a verdict.
  It found the briefing re-sent on every Buddy turn (5c081f5). Findings and
  next steps: `agent_notes/review_token_usage/FOLLOWUPS.md`.
- Every server start bootstraps the install's own checkout as the "unleashd"
  Buddy workspace with an #upstream channel, Product Dev and the Upstream
  Release Manager, and fetch-checks upstream `main` every 6 hours
  (`server/src/upstream/`). The checkout is the MAIN worktree
  (`git worktree list`), never `--show-toplevel`: servers run from agent
  worktrees against the live ~/.buddies, and each would otherwise register
  its own workspace and hire its own pair. The check only fetches; the merge
  is the Release Manager's turn, started by `POST /api/upstream/update`.
- A running turn survives any backend exit (reload, SIGTERM, crash): every provider runs
  from an on-disk journal under `~/.agent-viewer/executions/` and the next backend adopts it
  at boot, before the Buddy runner recovers anything (docs/turn-lifecycle.md#execution-adoption).
  Only an explicit Stop kills a turn, so never "fix" a stuck restart by stopping turns in
  `shutdown.ts`, and never delete a journal of a live process: its conversation and run are
  then orphaned. Guard: `server/test/execution-adoption.test.ts` (real backend SIGKILLed mid-turn).
- Every SQLite open sets `checkpoint_fullfsync = ON`: macOS `fsync()` skips the drive
  cache, and a hard power-off on 2026-09-30 tore a checkpoint in
  `~/.agent-viewer/observability/turn-attempts.sqlite` ("database disk image is
  malformed"), crash-looping startup. That journal is diagnostics, so its open runs
  `quick_check` and moves a corrupt file into `corrupt-<unix secs>/` beside it
  (log event `journal_quarantined`); salvage with `sqlite3 <file> .recover`. Guard:
  `corrupt_store_is_quarantined_and_replaced` in `crates/unleashd-ingest/src/attempts.rs`.
  Authoritative stores (records, buddies) are never auto-replaced.
- Client CSS G8 ratchet runs in `tools/check-client-invariants.sh` (CI).
- Performance: run `pnpm perf:audit` before hunting a regression. It summarizes `~/.agent-viewer/observability/perf/` (`boot.jsonl` phases per bootId from supervisor + backend, `stalls.jsonl`, and `profiles.jsonl` + `profiles/`: the continuous profiler's 30 s windows that held a busy stall >=500ms, with their top functions, `routes.jsonl` per-minute p50/p90/max) plus data growth and machine load, into `output/perf-audit/<ts>.md`. Check machine load and swap first: 2026-09-25 and 2026-10-23 were both mostly an oversubscribed machine. Capture a profile with `pnpm perf:profile` (gated `POST /api/debug/profile`) or `UNLEASHD_CPU_PROF=1 pnpm dev`. Never add boot work without a boot phase, never spawn synchronously (`execFileSync`/`spawnSync`) on the event loop (2026-10-23: a per-second `ps` per execution held 74% of the main thread; guard `vendor/agent-cli-tool/test/journal-no-sync-spawn.test.ts`), and never label-less timers (wrap with `labelled(name, fn)` from `server/src/observability/event-loop-stall.ts`; the label follows the work's async continuations, so a stall reads `timer x`, `timer x (async)` or `unlabelled`). The V8 profiler has one owner, `observability/cpu-profiler.ts`; never open a second inspector profile. Details: `docs/error-journal.md`.
- Inspect unresolved operational failures with `pnpm errors:list`; do not read or
  mutate the JSONL journal directly. Its configured location and capture policy
  are documented in `docs/error-journal.md`.
- Adding a provider: harness (submodule) + catalog.jsonc entry (`pnpm check:catalog`) +
  `ProviderSchema` in shared + a parser in `crates/unleashd-ingest` if persisted.
- Buddy sections are ROUTES, not tab state: `/buddies/:buddyId/:tab` with
  `/buddies/:buddyId` redirecting onto the default tab. Tab segments and labels
  live in `client/src/components/buddies/buddy-tabs.ts` (pure, mobile-safe).
  Tab strips are `<Link>`s so Back returns to the previous tab instead of
  leaving the buddy, and a tab survives reload.
- Any "open this conversation" affordance must be a `<Link to={/chat/:id}>`
  AND availability-checked against `listField('idSet')` (the one
  Set in the list index; never a per-component
  `new Set(ids)` memo). Deleting a
  conversation only terminalises its buddy link row, and an automation run
  keeps its `conversation_id` forever — navigating to a thread the client no
  longer holds hits `Chat.tsx`'s `navigate('/chats')` bounce, which reads to the
  user as "Open took me to the conversation list." Guarded by
  `client/test/buddy-conversation-links.test.tsx`. A button is still correct
  where the click CREATES the thread (`talk()`, the Buddy Builder, delegate /
  review, find-or-create on a project) — there is no id to put in an href yet.
- Client component tests are `.tsx` under `client/test/` and render through
  `react-dom/server` + `MemoryRouter` (no jsdom). They need
  `--tsconfig client/tsconfig.test.json` (it includes `src` AND `test`; tsx
  applies a tsconfig only to files it includes, so the app config left test
  files on the classic runtime) or JSX compiles classic and every component
  throws `ReferenceError: React is not defined`. `pnpm test:client` passes it.
  See `docs/test-strategy.md`.
  Tests are typechecked by `pnpm typecheck`: `client/tsconfig.test.json` and
  `server/tsconfig.test.json` (src + test, no emit). They sit outside
  `tsc -b` so a test-only type error fails typecheck, never `vite build`.
  Until 2026-09-25 no test was typechecked: a renamed `ConversationsTab` prop
  surfaced as `Cannot read properties of undefined (reading 'flatMap')` inside
  a jotai atom (2026-09-16), and fixtures drifted from real types (missing
  `done`, stale provider handles). `server/tsconfig.test.json` still has a
  TEMPORARY exclude list of runtime/Buddy tests left from the lean-rewrite
  tasks T08/T11. Fix a listed test's types and remove its entry whenever you
  are in that area; never add to the list.

- Typecheck the client with `tsc -b`, never `tsc --noEmit`. `client/tsconfig.json`
  is a solution file (`"files": []` + project references), so plain
  `tsc --noEmit` checks ZERO files and exits 0 on a broken tree — it reported
  success on three `ReferenceError`-grade unresolved identifiers on 2026-08-20.
  `vite build` does not catch them either (esbuild strips types, no scope
  analysis). `pnpm typecheck` checks the client's app and node configs with
  `-p` each (the projects `tsc -b` covers); never fall back to `--noEmit`.
- TypeScript is 7.0.2 (the native compiler), one exact pin in server, client,
  shared and the submodule. Per project it is 6-10x faster than 5.9 with ~30%
  less memory (server test config: 5.0-9.5 s / 700 MB -> 0.9-1.4 s / 490 MB,
  interleaved A/B at load 25-55, 2026-11-10). TS 7 removed
  `moduleResolution: "node"` (node10, error TS5108): CommonJS configs use
  `bundler`, which kept the emitted `server/dist` and `shared/dist` JS
  identical. It defaults `types` to `[]`, so a config that needs Node globals
  lists `"types": ["node"]`. It has NO JavaScript compiler API (`require
  ('typescript')` exports only the version) and no `bin/tsc` export subpath:
  find the launcher with `tscLauncher()` (`tools/lib/tsc.mjs`). The dev
  compilers are native `tsc --watch` children that emit into a stage and
  publish by rename, so a backend never loads a truncated module
  (`tools/dev-runtime.mjs`, guard `tools/dev-runtime.test.mjs`). Each runs
  through `tools/lib/bound-child.mjs`, which stops it when the supervisor's pipe
  closes: a SIGKILLed or crashed supervisor left all three `tsc --watch` running
  (2026-11-11; guard `tools/bound-child.test.mjs`).
- Editors: use TypeScript 7's language server, the workspace's
  `node_modules/typescript` (7.0.2; the native binary serves it with
  `tsc --lsp`). tsrs 0.23 also serves `--lsp` (stdio only), untried here.
  The old JS `tsserver.js` is gone in TS 7; nothing in the repo pins an
  editor to it (no `.vscode`, no `tsdk`).
- A second dev runtime runs beside the live one on other ports:
  `UNLEASHD_DEV_CLIENT_PORT` / `UNLEASHD_DEV_API_PORT` (default 7489/7499,
  `server/src/dev-ports.ts`). Prove a dev-runtime change with temp stores
  (`UNLEASHD_DATA_DIR`, `UNLEASHD_BUDDIES_DB`, `BUDDIES_HOME`, which also disable
  Buddy execution) and `UNLEASHD_CHECKOUT_ROOT` at a non-git temp dir, so the
  upstream check never fetches in the main checkout.
- While iterating, run `pnpm check [paths...]`: Biome (lint + format check) on
  your paths and the default typecheck on every project, AT ONCE under the
  typecheck lock (Biome prints live, the typecheck's output is held until Biome
  is done, so they never interleave), with one summary line per part. Biome is
  now most of its wall time. `pnpm lint` and `pnpm typecheck` still run alone.
- Fastest loop: `tools/typecheck.mjs` and `tools/check.mjs` are executable;
  run them directly (`./tools/typecheck.mjs`, `./tools/check.mjs src/x.ts`) to
  skip pnpm's own startup (~0.5 s per invocation, more than an unchanged-tree
  typecheck). Flags on both: `--fresh` (never reuse a recorded result) and
  `--timings` (one line: startup, fingerprint, shared build or skipped, each
  project, total). Measured 2026-11-11, median of 5, old runner vs new
  interleaved in one worktree at load 14-92 (absolute numbers are noisy, the
  ratios hold): direct entry unchanged tree 13.2 s -> 0.53 s, one changed
  `server/src` file 14.2 -> 2.9 s, one changed `shared/src` file 14.2 ->
  6.5 s; `pnpm typecheck` 5.2 -> 1.3 s, 8.1 -> 4.0 s, 9.0 -> 5.7 s;
  `pnpm check` 29 -> 9.3 s, 11.3 -> 4.8 s, 23.9 -> 14.3 s. At load ~5 the
  old direct run took 1.4 s in every case; the new one answers an unchanged
  tree in ~0.2 s (Node startup ~50 ms + fingerprint ~25-100 ms) and checks a
  changed tree in ~0.4-0.5 s.
- `pnpm typecheck` runs **tsrs** (npm `tsrs`, pinned 0.23.0-ts7.1.0-beta, a Rust
  port of TypeScript; EXPERIMENTAL) since 2026-11-11, at the owner's request:
  2.7-3.6 s and 257 MB peak against 4.9-6.6 s and 551-581 MB for the same
  projects on tsc 7.0.2 (back to back, load ~19). Its diagnostics matched tsc
  7.0.2 byte for byte on every project, clean and with four injected errors.
  `pnpm typecheck:reference` runs tsc 7 instead. A project tsrs cannot run
  (not installed, crashed, unknown option) is checked by tsc, with a
  `FALLBACK:` line giving the reason: never silent. CI runs
  `pnpm typecheck:cross-check`: both checkers on every project, failing if
  either fails or their diagnostics differ (order ignored). Never pass tsrs's own
  `--fast`. Re-run the cross-check after bumping tsrs or TypeScript. Guards:
  `tools/diagnostics.test.mjs` (the comparison), `tools/typecheck.test.mjs`
  (the fallback).
- `pnpm typecheck` is single-flight across every process on the machine
  (`tools/typecheck.mjs`): concurrent agents' typecheckers contended for the
  machine (2026-11-10). One lock file in the temp dir holds the holder's pid;
  a second run waits, then runs next or reuses a recorded result. A dead
  holder's lock (or one older than 10 min) is reclaimed. It takes no
  dev-runtime lock, so it is safe while a dev runtime runs. Every project is
  checked even after one fails. Guard: `tools/typecheck.test.mjs`.
- Where a typecheck's time goes (owner, 2026-11-11: "5-10s for a typecheck
  still feels pretty slow"; the compilers take 85-150 ms per project):
  - Result reuse: a finished run is recorded per mode in
    `node_modules/.cache/typecheck-result-<mode>.json` under a key of the tree
    (every tracked or unignored file, the submodule's too, by size and mtime,
    plus `node_modules/.modules.yaml`), the generated inputs the projects read
    (`shared/dist`, `vendor/agent-cli-tool/dist`: `GENERATED_INPUTS`), each
    compiler's version and binary, the runner's own source and the mode. Any
    run with the same key prints the recorded output, without the lock, and
    says `reused the result of PID n from Ns ago`. Not recorded: a run during
    which the tree changed, or one whose checker crashed or was killed.
    `--fresh` always runs. Guards: "every file a project reads is
    fingerprinted" (a project that starts reading another ignored file must
    add it to `GENERATED_INPUTS`), and the reuse tests.
  - The shared build (~0.7-2 s) runs only when the stamp
    `shared/dist/.build-stamp.json` no longer matches: a digest of shared's
    sources, configs, build script, `package.json`, TypeScript and each
    dependency (a workspace one by its types file), plus every published
    file's size and mtime (`tools/lib/shared-build-stamp.mjs`). A dev
    `tsc --watch` publish makes it stale. `pnpm --dir shared run build` always
    builds. Its two emits now run at once.
  - The six projects run at once, output buffered and printed in project
    order (the transcript is a sequential run's), and every child is stopped
    on an interrupt. Peak RSS of the process tree (2026-11-11, 10 cores /
    24 GB, load 4-17): default 380 -> 580 MB, reference 670 MB -> 1.6-1.75 GB,
    cross-check 670 MB -> 1.65-1.73 GB. Three at once saved ~0.45 GB but took
    1.5-3x as long, and the lock admits one typecheck at a time, so they are
    unbounded.
  - tsrs and tsc run as their native binaries (resolved by each package's own
    `lib/getExePath.js`; `TSRS_BINARY` is honoured), not via a Node launcher.
  - The floor for a changed tree is the slowest project (server, ~0.15 s
    alone, ~0.3-0.6 s beside the other five). tsrs takes tsc's options:
    `--watch` (a resident checker per project), `-b`/`--incremental`
    (tsbuildinfo) and `--lsp`, `--api`; none is wired in here. A sub-100 ms
    changed-tree check would need resident watchers whose latest verdict the
    runner reads.
- Recursive `rg` output is rewritten by rtk and is NOT safe to cite. The hook
  turns directory-target searches into `rtk rg`, which substitutes tokens
  silently (`compact_memory` reads back as `n_memory`, `compactProject` as
  `nProject`) and drops line numbers. Single-FILE searches pass through intact.
  Locate with a recursive search, then re-run against the one file before you
  quote, cite `file:line`, or conclude a symbol is absent. `rtk proxy` does not
  help. Same root cause as `git diff > x.patch` capturing a hunk-less summary —
  rtk output is for reading, never for capturing or citing. See
  `agent_notes/2026-08-22_memory-implementation-handoff_buddies-development-lead.md`.
- Never run `sqlite3` (or node:sqlite, DB Browser, `.backup`) against the live
  `~/.buddies` or `~/.agent-viewer` stores; read through the API or `pnpm errors:list`,
  and reproduce on temp stores (`UNLEASHD_DATA_DIR`, `UNLEASHD_BUDDIES_DB`,
  `BUDDIES_HOME` under a tmpdir). An outside opener is harmless only while the backend
  holds its POSIX locks, and on 2026-09-30 it did not: `sqlite3` runs 5.8 s and 0.6 s
  before two SIGBUS deaths of the backend. Inside the backend process, nothing but the
  owning addon may open a store file, not even to read bytes: see
  `docs/patterns.md#store-descriptor-isolation` (guard `server/test/sqlite-locks.test.ts`).
- Never run the Buddies package CLI (`bin/buddies.js`, from `~/git/buddies` or a
  package worktree) without `BUDDIES_HOME=<tmpdir>`. It ignores unknown flags —
  `buddies init --db /tmp/x.sqlite` opened the LIVE `~/.buddies/buddies.sqlite`
  on 2026-09-23 and ran an unvendored v33 migration in place. The running
  server kept its v32 code in memory, so every Buddy `post`/`new_list` write
  failed on the new NOT NULL column until the app was vendored and restarted,
  and a v32 build refuses to open a v33 database at all (`CURRENT_SCHEMA_VERSION`
  ceiling). Package tests are safe: they set `BUDDIES_HOME` themselves.
- The server's Buddies are the crate (`@unleashd/buddies-core`) over the NEW-schema
  DB: `UNLEASHD_BUDDIES_DB`, default `~/.buddies/buddies-v3.sqlite`. It is never the
  v33 `~/.buddies/buddies.sqlite`; a missing file while the v33 one exists fails every
  Buddy call with the import command, never an empty DB over it (`buddiesLocation` in
  `server/src/buddies/core.ts`). A first-time install (neither file) gets an empty DB. `pnpm addons`
  (also run by `pnpm run bootstrap`, `pnpm dev`, `pnpm build`, `test:server`) makes both
  addons match their sources from the shared build cache, running cargo only on
  a miss; `pnpm --dir crates/<c> run build` forces a build. Restart the backend
  after a Rust change. Deploy sequence: crate README "Deploy".
- Build cache: a lane that changes no Rust never runs rustc. The key is the
  crate's own inputs only (docs/patterns.md#build-cache), so one-time tools
  live in their own crates (the v33/records import CLIs did, until deleted after the 2026-09-27 swap);
  build them with `cargo build --release -p <crate>` and never move tool code
  back into an addon crate. Worktree setup is `pnpm run bootstrap`, never
  `pnpm setup`: that is a pnpm BUILTIN which edits `~/.zshrc` (it did, 2026-09-26).
- The Buddy MCP endpoint (`server/src/buddies/mcp.ts`) listens on its OWN loopback
  port. Never mount it on the gated Express app: a turn's bearer is not the owner
  secret, and the owner secret must never reach a turn. Each turn's grant is
  revoked at settle (the token is readable by the agent's shell).
- Workspace registration keeps folder history and Git-root history plus repo-relative folder
  identity. Startup and New workspace share `workspaceRegistration`; the crate reuses exactly one
  matching workspace only when all its folders are absent, preserving active clones separately.
  Ambiguous missing matches fail instead of merging teams. Existing workspaces acquire history on
  their next registration; folders already missing before that cannot be inferred. Turns use the
  newest registered folder that exists. There is no workspace move/fold route or MCP tool.
  Guards: `server/test/workspace-registration.test.ts`; failed-spawn handling stays in agent-cli.
- Add a dependency from the repo root with a filter (`pnpm add <pkg> --filter @unleashd/server`),
  then run `pnpm install --frozen-lockfile` and `pnpm typecheck`. On 2026-11-10 an install
  during a `pnpm --dir server add ...` session left `client/node_modules/vite` a dangling symlink,
  and `tsc -b` in the client failed with "Cannot find module 'vite'" eight hours later, after the
  commits were pushed. The prune did NOT reproduce under this repo's pnpm 9.15.0: `--dir server
  add`, `cd server && pnpm add` and root `add --filter` each ran a whole-workspace install and
  left every package's links intact (throwaway `is-number`, checked for dangling links in all
  five `node_modules`). So the root `--filter` form is the convention, not the proven fix: the
  frozen install and typecheck after it are what catch a broken tree.
  Chain the push after the checks with `&&`, never `;`.
- When source is broken, `server/dist/*.js` (and `shared/dist/`) is the oracle
  for what the code did before it broke — check it before git archaeology.
- The formatter is **biome** (`pnpm format`, `pnpm lint:fix`; config in
  `biome.json` — single quotes, width 100). There is no prettier config, so
  `npx prettier --write` fetches prettier with ITS defaults and reformats
  whole files (single → double quotes), burying a 20-line change in a
  700-line diff. Never reach for prettier here.
  Biome is 2.6.6 (2026-11-10, from 1.9.4). It honours `.gitignore`
  (`vcs.useIgnoreFile`): without it Biome 2 walked gitignored trees and one
  check ran past 120 s; with it 917 files take ~2 s. Kept as 1.9 had them:
  ASCII order for imported names (`identifierOrder: lexicographic`), no CSS
  formatting (2.x splits every comma list onto its own lines, 31 files, and
  breaks the G8 ratchet), no HTML/Markdown/YAML. The CSS rules
  `noDescendingSpecificity` (would reorder cascade-sensitive selectors) and
  `noImportantStyles`, and `noStaticElementInteractions` (the same call as
  `useKeyWithClickEvents`), are off. Generated JSON (`emoji-data.json`, the
  tool-contract snapshot) is not formatted. `pnpm lint` is green; keep it so.
  Two type-aware rules are errors: `noFloatingPromises` (57 findings, 4 real
  bugs; deliberate fire-and-forget is written `void call()`) and
  `useAwaitThenable`. They double lint time (~0.5 s -> ~1.1 s). Biome cannot
  resolve a plan folder's bare `expedition` import, so un-awaited plan calls
  are not caught statically, and tsc does not report a floating promise either.
  The authoring library catches it at run time instead: a plan that returns while
  a call or review it issued is unanswered ends as `threw`, naming the pending
  keys (`authoring/session.ts`; guard `expedition-kernel-runner.test.ts`). An
  un-awaited call already answered before the return is not caught.
  `noMisusedPromises` (presence-check noise, partial Express coverage) and
  `noUnnecessaryConditions` (mostly false) stay off.
  `biome.json` ignores `vendor` wholesale. It previously ignored only
  `vendor/agent-cli-tool/manual_tests/runs`, so a root `pnpm format` reformatted
  the SUBMODULE's source — the submodule carries no formatter config of its own,
  so it inherits width-100 biome and reflows every one-line `catalog.jsonc`
  model entry. That produced a 189-line, semantically-zero submodule diff on
  2026-09-06 which then demands a commit + push inside the submodule and an
  outer pointer bump, for no behaviour change. Never format across `vendor/`.
- CSS is global (plain `.css` imports, no modules), so one class defined in
  two files silently fights over the cascade — import order picks the winner.
  Prefix component classes with the component (`.chat-config-summary`, not
  `.config-summary` — that one is SwarmDetail's, with `flex-direction:
  column`). Genuinely shared primitives (`.empty-state`, `.provider-badge`)
  live once in `client/src/App.css`. Gate G6 in
  `tools/check-client-invariants.sh` fails on any cross-file duplicate.
  Routes are lazy chunks (App.tsx), and a component's CSS loads with its chunk,
  AFTER the entry stylesheets (`index.css`, `App.css`, `BuddyDetail.css`,
  `ui/controls.css`). A component rule of equal specificity therefore beats an
  entry rule, the reverse of the old single-bundle order. Chat.css lost dead
  `.ui-choice` duplicates for exactly this reason (2026-09-25). Never import a
  route module statically from `App.tsx` — one static import pulls the route
  back into the entry chunk.
  Sizes come from `ui/tokens.css` (`--fs-*`, `--sp-*`; gate G7 rejects a
  literal px font-size/padding/gap anywhere else, and any breakpoint but
  768px/340px). Repeated groups are classes in `ui/primitives.css`
  (`ui-row`, `ui-stack`, `ui-truncate`, …), loaded before every view sheet,
  so a view rule of equal specificity always overrides a primitive. When
  moving a declaration from a view rule into a primitive, check sibling
  classes on the same element: one that used to lose to the view rule by
  load order now beats the primitive. G8 caps total CSS lines (ratchet).
- Callbacks handed to a library are called with the library's arity, not
  yours. `handleFilesUpload` goes straight into react-dropzone's `onDrop`,
  which invokes it as `(acceptedFiles, fileRejections, event)` — a defaulted
  second parameter silently receives `fileRejections`, and `tsc` allows it
  because a 1-arg function fits a 3-arg slot. Keep such callbacks unary and
  put the extra state in a helper (`uploadFilesWithDrainRetry`).
- Sidebar recent-folder groups key on `folderGroupKey()`, never the raw
  `workingDirectory`. Oompa runs one worktree per iteration
  (`<repo>/.ws<swarm>-w3-i7`), so the raw key gave every iteration its own group
  header — 1,107 groups for one repo on 2026-09-06, all rendering as the same
  truncated `~/git/room-runners-aren…`. The fold is `getProjectRoot` in
  `utils/directories.ts` (core, not swarm code); it deliberately does NOT live in
  `normalizeFolderDirectory`, which answers "which directory did the user mean"
  and must not rewrite a worktree the user typed into its parent repo. Guard:
  `client/test/folder-grouping.test.ts`.
- A `~/.claude/projects` / `~/.cursor/projects` directory name is a LOSSY
  encoding — `/` became `-`, and Cursor also drops a leading `.`. Decoding it by
  replacing every `-` with `/` invents paths that have never existed
  (`~/git/room-runners-arena-lib/.wsf9…` came back as
  `~/git/room/runners/arena/lib/wsf9…`, 98 fabricated folders from one repo).
  Use `resolveEncodedProjectDirectory()`, which disambiguates against the
  filesystem and returns null rather than guessing. It only fires as a fallback:
  a modern Claude transcript carries an explicit `cwd`, which always wins.
- A new field on a server→client schema needs `.default(...)` on the wire.
  The client validates every WS message (`classifyServerFrame`), Vite
  serves new client code immediately, and the dev watcher defers backend
  reloads until running turns finish, so a required field rejects every
  `hello` and update from the not-yet-reloaded backend and the list goes empty.
  `Conversation.done` shipped required on 2026-09-24 and did exactly that
  (fixed in e54fe26). The parsed type stays required, so servers still set it.
  A protocol VERSION change is different: the client reads a v2 `init` as a
  typed skew (keeps its rows, shows "backend reloading", reconnects) — guard
  `client/test/protocol-skew.test.ts`. The other direction: the socket URL is
  `WS_PATH` (`/ws?protocol=N`), and the server closes a socket naming another
  protocol (or none: pre-v3 code) with `PROTOCOL_MISMATCH_CLOSE_CODE` 4426. A
  current tab then shows "The app was updated — reload"; a pre-v3 tab cannot
  reload itself and only shows "disconnected", so reload open tabs after a
  protocol swap. Guard: `server/test/websocket-lifecycle.test.ts`.
- Protocol v3 (T09): `hello`/`rows` carry list rows only (`ConversationRow`,
  ~200 B each); detail (config, queue, sub-agents, latest turn) is
  `GET /api/conversations/:id`; bodies page from
  `GET /api/conversations/:id/messages?afterSeq=&limit=` (one server function,
  `conversations/messages.ts`, which T13 re-points at the ingest crate).
  Changes go out as typed `patch` messages — never re-send a conversation. A
  conversation's kind is ONE stored value (`record.kind`: chat | buddy | builder
  | worker); never derive identity from transcript text. Guards:
  `server/test/wire-v3.test.ts`.
- The wire is compressed: WS permessage-deflate (the 2.4 MB `init` goes out
  as ~180 KB) and `compression` middleware after the auth gate for HTTP.
  A new streaming route (SSE, chunked `res.write`) must `res.flush()` after
  each write or compression buffers it. Hashed `client/dist/assets/*` are
  `immutable`; everything else served statically is `no-cache`. Guarded by
  `server/test/auth.test.ts` and `server/test/static-client-cache.test.ts`.
- Sidebar rows are ONE line. The row is the shared
  `views/conversation-row/ConversationRow` (`variant: 'sidebar' | 'card' |
  'list'` for Sidebar, Gallery and the mobile lists). Its Done button
  (`.conversation-row__done`) is an absolute overlay on the row's right edge,
  so anything else anchored right sits under it and stops receiving clicks.
  Two-line rows hid this; single-line rows do not. Buttons on a row are
  siblings of its `<Link>`, never inside it (`conversation-row-links.test.tsx`).

## Transient image dumps: WebP q95, then delete

Screenshots, frame grabs and debug renders you save to inspect (not ship) are
**WebP quality 95**, never PNG: `cwebp -q 95 in.png -o out.webp` (or CDP
`Page.captureScreenshot {format: 'webp', quality: 95}`; Playwright's
`page.screenshot` only does png/jpeg, so convert after capture and delete the
PNG). Exception: images a pixel-diff compares (`pnpm screenshots --baseline`)
stay lossless PNG, because lossy output would show up as diff noise. Write dumps
under one dated, gitignored directory and delete it when the task closes. Never
keep Playwright traces or browser profiles from passing runs (`trace:
'retain-on-failure'`, `screenshot: 'only-on-failure'`).
Why: on 2026-10-05 the disk hit 0 bytes with 10 GB in `wave_sim/output` (browser
profiles + traces 0.9 GB, 6k JPEGs, full-page PNGs up to 6.5 MB) and 3.5 GB of
`temp_paint_wt/*/shots`; agents never cleaned up after themselves.
