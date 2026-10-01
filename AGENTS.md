# AGENTS.md — Agentic Coding Guide

Index for agents. Hard rules inline; read the linked doc BEFORE working in
that area.

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
                                     endpoint, 12 tools), runner, channels, routes,
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
{server,client}/src/swarm/          → QUARANTINED swarm/oompa viewer; outside code imports
                                     only swarm/index.ts (guard: swarm-quarantine.test.ts)
```

## Hard rules (violations = rejected PR)

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
  bump the outer pointer. Never push main unless the user asks.
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
- Never `git reset --hard`, `filter-branch`, `filter-repo`, or `rebase -i` on a shared branch — they orphaned 5a6cf40/79a8381 on 2026-08-20. Use `git stash` or a throwaway branch and ask. Guarded in `.claude/settings.local.json` (deny) + `~/.zshrc` wrapper.
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
at the copy) with no agent CLIs on its PATH: the Buddy scheduler still runs
there and would otherwise launch real agents.

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
  TEMPORARY exclude list of runtime/Buddy tests owned by the lean-rewrite
  tasks T08/T11 — shrink it, never grow it.

- Typecheck the client with `tsc -b`, never `tsc --noEmit`. `client/tsconfig.json`
  is a solution file (`"files": []` + project references), so plain
  `tsc --noEmit` checks ZERO files and exits 0 on a broken tree — it reported
  success on three `ReferenceError`-grade unresolved identifiers on 2026-08-20.
  `vite build` does not catch them either (esbuild strips types, no scope
  analysis). `pnpm typecheck` runs `tsc -b` and takes no lock, so it is safe
  while a dev runtime runs; never fall back to `--noEmit`.
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
- When source is broken, `server/dist/*.js` (and `shared/dist/`) is the oracle
  for the author's prior intent — check it before git archaeology.
- The formatter is **biome** (`pnpm format`, `pnpm lint:fix`; config in
  `biome.json` — single quotes, width 100). There is no prettier config, so
  `npx prettier --write` fetches prettier with ITS defaults and reformats
  whole files (single → double quotes), burying a 20-line change in a
  700-line diff. Never reach for prettier here.
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
