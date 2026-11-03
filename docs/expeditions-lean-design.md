# Expeditions, lean rewrite: design

Status: built on branch `feat/expeditions-lean` (base `origin/main` f27c7c5); §12 lists where the
build deviates. It replaces the old ledger-based `server/src/expeditions/*`, the client expedition
UI and `shared/src/expedition.ts`. Where this doc and older docs (`expeditions/design.md`,
`expeditions/mcp.md`) disagree, this doc wins; those two files are deleted.

An expedition is a crew that keeps running toward a fuzzy goal. Each **attempt** is one crew Buddy
turn in a fresh Cambium workspace. The turn is told the goal, the done definition and everything
earlier attempts learned. After the turn the host judges the attempt: it runs the checks, or the
owner gives a verdict. The loop stops on a pass, when the budget is spent, at the deadline, or when
the owner says stop.

## 0. Hard budgets

| Area | Budget | As built (after `biome format`) |
|---|---|---|
| `server/src/expeditions/*` (all .ts) | ≤ 600 | 1308 — over, see §12 |
| client expedition UI (.ts/.tsx) | ≤ 300 | 309 — over, see §12 |
| client `Expedition.css` | ≤ 120 | 118 |
| `shared/src/expedition.ts` | ≤ 120 | 229 — over, see §12 |
| edits in other server files | net-negative | −5 (`server.ts` meter block) |

Lines are counted after `biome format` at width 100. A file that goes over its budget is a design
bug. Do not split it into a new file to get under; shrink it instead.

## 1. Canonical types: `shared/src/expedition.ts` (complete, ≤ 120 lines)

The zod schemas live here and the TS types are inferred from them, so there is one source. The
server parses records with them once, at load. The client imports the types, `ALLOWED` and the
labels. `shared` already depends on zod (`buddy-api.ts`).

```ts
import { z } from 'zod';

// ---- Charter (the owner's WHAT; never edited by the loop) ----
/** One host-run check: execFile argv, no shell; exit 0 passes. */
export const Argv = z
  .array(z.string().min(1).refine((w) => !w.includes('\0'), 'no NUL bytes'))
  .min(1)
  .max(64);
export const Done = z.discriminatedUnion('t', [
  z.object({ t: z.literal('checks'), checks: z.array(Argv).min(1).max(10) }).strict(),
  z.object({ t: z.literal('owner') }).strict(),
]);
export type Done = z.infer<typeof Done>;
/** The crew's one seat. model/effort absent = the provider's default (absence is the meaning). */
export const Seat = z
  .object({
    provider: z.string().min(1),
    model: z.string().min(1).optional(),
    reasoningEffort: z.string().min(1).optional(),
  })
  .strict();
export type Seat = z.infer<typeof Seat>;
export const Charter = z
  .object({
    name: z.string().trim().min(1).max(60),
    goal: z.string().trim().min(1).max(8000), // markdown
    done: Done,
    maxAttempts: z.number().int().min(1).max(60),
    maxLive: z.number().int().min(1).max(4),
    hours: z.number().min(0.25).max(72),
    seat: Seat,
  })
  .strict();
export type Charter = z.infer<typeof Charter>;
/** What the Buddy tool may leave out, and the named defaults it then takes (listed in the reply). */
export const CHARTER_DEFAULTS = { maxLive: 1, hours: 8, seat: { provider: 'claude' } } as const;
export const CharterInput = Charter.partial({ maxLive: true, hours: true, seat: true });

// ---- Attempts ----
export const Lesson = z.discriminatedUnion('t', [
  z.object({ t: z.literal('lesson'), text: z.string() }),
  z.object({ t: z.literal('none') }),
]);
export const CheckOutcome = z.discriminatedUnion('t', [
  z.object({ t: z.literal('passed') }),
  z.object({ t: z.literal('failed'), exitCode: z.number(), tail: z.string() }),
  z.object({ t: z.literal('timed_out'), tail: z.string() }),
  z.object({ t: z.literal('error'), message: z.string() }),
]);
export const CheckRun = z.object({ argv: Argv, outcome: CheckOutcome });
export type CheckRun = z.infer<typeof CheckRun>;
export const Verdict = z.discriminatedUnion('t', [
  z.object({ t: z.literal('checks'), pass: z.boolean(), runs: z.array(CheckRun) }),
  z.object({ t: z.literal('owner'), pass: z.boolean() }),
  /** The expedition finished before this attempt was judged. */
  z.object({ t: z.literal('skipped') }),
]);
/** How the crew turn ended, read once when its request settles. */
export const TurnEnd = z.object({
  at: z.string(),
  turn: z.enum(['answered', 'failed', 'cancelled']),
  sha: z.string(), // tip of the attempt branch at turn end (= base if it never committed)
  lesson: Lesson,
});
export const AttemptPhase = z.discriminatedUnion('t', [
  z.object({ t: z.literal('starting') }), // recorded before `cambium add`
  z.object({ t: z.literal('running'), requestId: z.string() }),
  z.object({ t: z.literal('interrupted'), at: z.string() }), // restart; not counted
  z.object({ t: z.literal('judging'), end: TurnEnd }),
  z.object({ t: z.literal('judged'), end: TurnEnd, verdict: Verdict }),
]);
export const Tree = z.discriminatedUnion('t', [
  z.object({ t: z.literal('planned') }),
  z.object({ t: z.literal('live'), path: z.string() }),
  z.object({ t: z.literal('released'), salvageRef: z.string().nullable() }), // null: tree was clean
  z.object({ t: z.literal('absent') }), // never created (crash before `cambium add` finished)
  z.object({ t: z.literal('left'), reason: z.string() }), // cambium refused; retried at retire
]);
export const Attempt = z.object({
  n: z.number().int().min(1),
  workspace: z.string(), // exp-<id>-a<n>
  branch: z.string(), // expedition/<id>/a<n>
  startedAt: z.string(),
  tree: Tree,
  phase: AttemptPhase,
});
export type Attempt = z.infer<typeof Attempt>;

// ---- The record: <store>/expeditions/<id>.json ----
export const Origin = z.discriminatedUnion('t', [
  z.object({ t: z.literal('thread'), channelId: z.string(), rootId: z.string() }),
  z.object({ t: z.literal('direct') }),
]);
export const Launch = z.object({
  at: z.string(),
  deadline: z.string(),
  repoRoot: z.string(),
  baseSha: z.string(), // refs/heads/main at launch: every attempt's base AND the oracle source
  crewBuddyId: z.string(),
  chatChannelId: z.string(), // owner<->crew DM
  chatSeenOrd: z.string(), // '' = nothing read yet (every ord sorts after '')
});
export const FinishReason = z.discriminatedUnion('t', [
  z.object({ t: z.literal('passed'), n: z.number() }),
  z.object({ t: z.literal('budget') }),
  z.object({ t: z.literal('deadline') }),
  z.object({ t: z.literal('stopped'), by: z.string() }),
  z.object({ t: z.literal('setup_failed'), detail: z.string() }),
]);
export const State = z.discriminatedUnion('t', [
  z.object({ t: z.literal('draft'), issues: z.array(z.string()) }),
  z.object({ t: z.literal('running'), launch: Launch }),
  z.object({ t: z.literal('paused'), launch: Launch }),
  z.object({ t: z.literal('finished'), launch: Launch, at: z.string(), reason: FinishReason }),
]);
export type State = z.infer<typeof State>;
export const Expedition = z
  .object({
    v: z.literal(1),
    id: z.string(),
    workspaceId: z.string(),
    createdAt: z.string(),
    launcherId: z.string(),
    origin: Origin,
    charter: Charter,
    state: State,
    attempts: z.array(Attempt),
    notes: z.array(z.object({ at: z.string(), by: z.string(), text: z.string() })),
  })
  .strict();
export type Expedition = z.infer<typeof Expedition>;

/** GET /api/buddies/expeditions. An unreadable file is a row too: it shows in every rail. */
export type ExpeditionRow =
  | { t: 'ok'; id: string; name: string; workspaceId: string; state: State['t'];
      label: string; needsOwner: boolean; crewBuddyId: string | null }
  | { t: 'unreadable'; id: string; reason: string };

// ---- Owner/Buddy acts: one schema for HTTP, chat and tool ----
export const Act = z.discriminatedUnion('do', [
  z.object({ do: z.literal('launch') }).strict(),
  z.object({ do: z.literal('pause') }).strict(),
  z.object({ do: z.literal('resume') }).strict(),
  z.object({ do: z.literal('stop') }).strict(),
  z.object({ do: z.literal('extend'), hours: z.number().positive().max(72) }).strict(),
  z.object({ do: z.literal('verdict'), n: z.number().int(), pass: z.boolean() }).strict(),
  z.object({ do: z.literal('note'), text: z.string().trim().min(1).max(2000) }).strict(),
  z.object({ do: z.literal('retire') }).strict(),
]);
export type Act = z.infer<typeof Act>;
/** The one guard table: which states accept which act (server refuses; client shows buttons). */
export const ALLOWED: Record<Act['do'], readonly State['t'][]> = {
  launch: ['draft'], pause: ['running'], resume: ['paused'], stop: ['running', 'paused'],
  extend: ['running', 'paused'], verdict: ['running', 'paused'], note: ['running', 'paused'],
  retire: ['draft', 'finished'],
};
/** Attempts the budget counts (everything but interrupted). */
export const counted = (x: Expedition) => x.attempts.filter((a) => a.phase.t !== 'interrupted').length;
export function stateLabel(x: Expedition): string { /* δ on state.t / reason.t, one line each */ }
export function attemptResult(a: Attempt): string { /* δ on phase.t / verdict.t, one line each */ }
```

`stateLabel` and `attemptResult` are plain exhaustive `switch` statements, one line per variant:
"Draft", "Running · 2/5", "Paused", "Passed (a3)", "Stopped · budget spent", "Stopped · deadline",
"Stopped by you", "Setup failed: …"; and "starting", "running", "interrupted", "checking" or
"needs your verdict", "pass", "fail (exit 1)", "skipped".

Notes on types:
- **No retired state in the live store.** Retire writes `.retired/<id>.json` as
  `{ v: 1, t: 'retired', at, record: Expedition }`, a TS-only shape. Nothing parses it, because
  the loader ignores `.retired/`.
- **`Launch` exists only on launched states.** A draft carries none, so no handler has to ask
  "is it launched?".
- **Only two optionals:** `Seat.model` and `Seat.reasoningEffort`. Leaving them out means "the
  provider's default". `salvageRef: null` and `crewBuddyId: null` also mean what they say.

## 2. State machines

### Expedition (`state.t`)

```
draft ──launch (preflight clean)──────────────▶ running ◀──resume── paused
  │                                              │  └────pause──────▶  │
  │                                              ├─ stop ───────────────┤──▶ finished{stopped}
  │                                              ├─ attempt verdict pass ─▶ finished{passed n}
  │                                              ├─ now ≥ deadline ───────▶ finished{deadline}   (paused too)
  │                                              ├─ counted ≥ max ∧ none starting/running/judging ─▶ finished{budget}
  │                                              └─ cambium add / request post fails ─▶ finished{setup_failed}
  └─retire─▶ moved to .retired/            finished ──retire (every archive ok)──▶ moved to .retired/
extend <h>: running|paused, deadline += h      note: running|paused, appended to notes
```

When the expedition enters `finished`, `finish()` does three things:
- it asks every `running` attempt's crew runs to stop (cancelRun);
- every `judging` attempt becomes `judged{skipped}`;
- it posts one status line.

A check job that finishes after this point finds its attempt no longer `judging`, so its result is
dropped. This is the same rule as for a stale verdict (`verdictInto`).

### Attempt (`phase.t`) and its tree (`tree.t`)

```
fill ─▶ starting{tree planned} ──cambium add ok──▶ tree live ──post request──▶ running{requestId}
           │ add/post fails: phase interrupted, expedition finished{setup_failed}
starting|running ──boot (interruptBootLive)──▶ interrupted          (not counted)
running ──request answered|failed|cancelled──▶ judging{end}          (state running|paused)
                                           └─▶ judged{end, skipped} (state finished)
judging + done.t=checks ──check job (host-wide queue)──▶ judged{checks, pass}
judging + done.t=owner  ──Act verdict{n,pass} / chat "pass"|"fail"──▶ judged{owner, pass}
tree planned|live, phase ∉ {starting, running} ──release()──▶ released{salvageRef} | absent | left{reason}
```

Release happens in the same step that settles the turn. The order is: read the sha of
`refs/heads/<branch>`, release the tree, then judge. Checks never run in the crew's tree. They run
in a fresh detached checkout of the sha.

## 3. Server file list and budgets (`server/src/expeditions/`, 600 lines total)

| File | Lines | Owns |
|---|---|---|
| `record.ts` | 70 | load all records at boot (κ), atomic save, file into `.retired`, ids |
| `cambium.ts` | 75 | `git` / `git-cambium` exec with a sanitized env; typed `add`, `release`, `archive`, `branches`, `tip` |
| `checks.ts` | 100 | launch preflight; fresh detached checkout; oracle restore; one check spawn (group kill, scratch HOME) |
| `brief.ts` | 55 | `CREW_ROLE`, `briefOf`, `lessonOf`, `chatAct`, status lines |
| `host.ts` | 190 | records map, serialized `step`, acts, boot interrupt, ticking, `turnDirectory`, crews |
| `retire.ts` | 45 | retire a draft or a finished expedition, refusing before any irreversible step |
| `tool.ts` | 35 | the `expedition` Buddy tool row |
| `routes.ts` | 30 | three HTTP routes |

There is no `index.ts` or `model.ts` re-export layer. Importers name the file they need.

### 3.1 `record.ts`

```ts
export type Loaded = { t: 'ok'; x: Expedition } | { t: 'unreadable'; id: string; reason: string };
/** Boot only (sync fs). Reads every regular file `<root>/*.json`. Skips directories (`.retired/`,
 * `trees/`, `checks/`, `crews/`, the old `drafts/`) and anything not ending `.json` (tmp files).
 * Each file: JSON.parse → Expedition.parse → x.id must equal the file stem. Any failure gives an
 * `unreadable` row with the reason (zod issues joined). It is never skipped, never rewritten. */
export function loadAll(root: string): Map<string, Loaded>;
/** `<id>.json.<rand>.tmp` written with mode 0o600, then rename over `<id>.json`. */
export async function save(root: string, x: Expedition): Promise<void>;
/** Copies the retired wrapper to `.retired/<id>.json` with COPYFILE_EXCL, then unlinks `<id>.json`. */
export async function fileRetired(root: string, x: Expedition, at: string): Promise<void>;
export const retiredTaken = (root: string, id: string): boolean; // .retired/<id>.json exists
/** `<slug(name) ≤24>-<6 hex>`. */
export function newId(name: string): string;
export const paths = (root: string, id: string) => ({
  file, tree: (n) => `${root}/trees/exp-${id}-a${n}`, check: (n) => `${root}/checks/${id}-a${n}`,
  crewDir: `${root}/crews/${id}`,
});
```

### 3.2 `cambium.ts`

```ts
/** Sanitized env for every host git / git-cambium process (kept from the old git.ts, incident
 * audit 2026-11-01 #7): only PATH HOME USER LOGNAME LANG LC_ALL TZ TMPDIR and GIT_AUTHOR_* /
 * GIT_COMMITTER_*, plus GIT_CONFIG_COUNT=2 core.hooksPath=/dev/null core.fsmonitor=false and
 * GIT_TERMINAL_PROMPT=0. `archive` also gets SSH_AUTH_SOCK (it pushes). */
export const gitEnv = (withSsh: boolean): NodeJS.ProcessEnv;
type Exec = { code: number; stdout: string; stderr: string };
/** execFile with a timeout and 16 MB maxBuffer. It never throws; the exit code is data. */
async function exec(bin: 'git' | 'git-cambium', cwd: string, args: string[], o: { timeoutMs: number; ssh: boolean }): Promise<Exec>;
/** git that must succeed: throws Error(`git <args>: <stderr tail>`) otherwise. */
export async function git(cwd: string, args: string[], timeoutMs = 120_000): Promise<string>;
export type Added = { t: 'ok'; path: string } | { t: 'failed'; message: string };
/** git-cambium add --json -b <branch> -name <workspace> -ephemeral <path> <baseSha> (15 min timeout). */
export async function add(repo: string, a: { workspace: string; branch: string; path: string; baseSha: string }): Promise<Added>;
export type Released =
  | { t: 'removed'; salvageRef: string | null }
  | { t: 'absent' }                       // not in `git-cambium list --json`
  | { t: 'refused'; reason: string; detail: string } // exit 3
  | { t: 'failed'; message: string };     // any other exit
/** `list --json` lookup by name, then `remove --safe --json --salvage-ref <ref> <name>`.
 * Zod-parses the success/refusal JSON of the contract. */
export async function release(repo: string, workspace: string, salvageRef: string): Promise<Released>;
export type Archived = { t: 'archived'; sha: string } | { t: 'refused'; reason: string } | { t: 'failed'; message: string };
/** git-cambium archive --json --remote origin <branch> <tag>; `already: true` counts as archived. */
export async function archive(repo: string, branch: string, tag: string): Promise<Archived>;
/** Short names under refs/heads/expedition/<id>/ (for-each-ref --format=%(refname:short)). */
export async function branches(repo: string, id: string): Promise<string[]>;
/** rev-parse --verify refs/heads/<branch>^{commit}. */
export async function tip(repo: string, branch: string): Promise<string>;
```

`Released` maps onto `Tree` with one table in host.ts: `removed→released`, `absent→absent`,
`refused|failed→left{reason}`.

### 3.3 `checks.ts`

```ts
/** Every reason a launch would be refused (draft stores them; launch re-runs and refuses on any).
 * Gate disabled → its reason. Workspace missing. Root not a git repo, or refs/heads/main missing.
 * `git-cambium version` fails. Seat: checkedRunConfig(seat) throws → message; !installed(provider).
 * Each check's argv[0]: bare/absolute → an executable on PATH; relative with '/' → mode 100755 in
 * main's tree (`git ls-tree main -- <p>`). */
export async function preflight(p: { gate: ExecutionGate; workspace: Workspace | undefined;
  charter: Charter; installed: (provider: Provider) => boolean }): Promise<{ issues: string[]; repoRoot: string; baseSha: string }>;
/** Runs the charter's checks on `sha` in order, stopping at the first that does not pass.
 *  1. dir = paths.check(n): fs.rm(dir, recursive, force); `git worktree prune`;
 *     `git worktree add --detach <dir> <sha>`.
 *  2. Oracle restore: collect every argv element of every check (deduped) that does not start
 *     with '-', is not absolute and has no '..' segment, and that `git ls-tree --name-only <base> -- <e>`
 *     lists. Then `git checkout <base> -- <those paths>` in dir. A named directory is restored
 *     whole. Files the attempt ADDED inside it remain (documented limit).
 *  3. Each check: runOne.
 *  4. finally: `git worktree remove --force <dir>`. A tree-setup error becomes one run with
 *     outcome {t:'error', message}. */
export async function runChecks(repo: string, j: { dir: string; sha: string; base: string; checks: string[][] }): Promise<CheckRun[]>;
/** spawn(argv[0], rest, {cwd, detached: true, env: PATH USER LOGNAME SHELL LANG LC_ALL TZ +
 *  HOME/TMPDIR = fresh `<dir>.scratch/{home,tmp}`}). Keeps a 4000-char stdout+stderr tail.
 *  CHECK_TIMEOUT_MS = 2 h → kill(-pid). After exit, kill(-pid) once more. Closes the pipes after
 *  2 s (for setsid stragglers). Removes the scratch dir. Kept from command.ts, audit #3. */
async function runOne(argv: string[], cwd: string, scratch: string): Promise<CheckOutcome>;
```

### 3.4 `brief.ts`

```ts
export const CREW_ROLE: string; // ≤ 6 lines: one request = one attempt; work only in the named
// workspace, commit on its branch, never push, never start Buddies/workers; answer the request;
// last line "Lesson: <one sentence>"; owner messages in your chat are steering: acknowledge briefly.
/** The request body, rebuilt from the record:
 *  `# <name>` + goal markdown; DONE WHEN (each argv joined with spaces, plus "files these name are
 *  restored from the base before checking: editing them changes nothing"), or "the owner judges";
 *  YOUR WORKSPACE <path>, BRANCH <branch>, BASE <baseSha>; PRIOR ATTEMPTS: one line each
 *  `a<n> <attemptResult> · lesson · branch <b> @ <sha8>` (interrupted ones: "work kept at
 *  refs/salvage/expeditions/<id>/a<n>"); a failing check's tail is clipped to 600 chars;
 *  OWNER NOTES: every note, oldest first. "You may merge or cherry-pick earlier attempt branches." */
export function briefOf(x: Expedition, launch: Launch, a: Attempt, path: string): string;
/** The last non-empty line, if it matches /^lesson:\s*(\S.*)$/i; else {t:'none'}. */
export function lessonOf(body: string): Lesson;
/** κ for an owner chat message (trimmed, lowercased, trailing .! dropped):
 *  pause|resume|stop → act; /^extend:?\s*(\d+(\.\d+)?)\s*(h|m)$/ → extend{hours}
 *  (m divided by 60, >72 h is a note); pass|fail → verdict{n: oldest judging attempt}, or a note
 *  when none is judging under done.t=owner; anything else → note{text} (original case, ≤2000). */
export function chatAct(x: Expedition, body: string): Act;
/** Crew-authored status lines (purpose 'expedition_status') for the owner<->crew DM. */
export function judgedLine(x: Expedition, a: Attempt): string;   // "a2 failed: exit 1 · Lesson: …"
export function askVerdictLine(a: Attempt): string;              // "a2 ended @sha8. Reply pass or fail."
export function finishedLine(x: Expedition): string;             // stateLabel + branch of the pass
```

### 3.5 `host.ts`

```ts
export interface ExpeditionHostOptions {
  core: BuddiesCore; events: BuddyEvents; root: string; // <APP_DATA_DIR>/expeditions
  gate: ExecutionGate; installed: (provider: Provider) => boolean;
  onBuddyArchived: (buddyId: string) => void; onChannelArchived: (channelId: string) => void;
  now?: () => Date;
}
export type Acted = { t: 'ok'; x: Expedition } | { t: 'refused'; reasons: string[] } | { t: 'missing' };
export type DraftInput = { charter: Charter; origin: Origin; launcherId: string; workspaceId: string };
export type ExpeditionHost = ReturnType<typeof createExpeditionHost>;
export function createExpeditionHost(o: ExpeditionHostOptions): {
  draft(input: DraftInput): Promise<Expedition>; // preflight → save → card post (key exp:<id>:card)
  act(id: string, act: Act, by: string): Promise<Acted>;
  get(id: string): Loaded | { t: 'missing' };
  rows(): ExpeditionRow[];                // ok rows newest createdAt first, unreadable rows first
  crewOf(buddyId: string): string | undefined; // expedition id a crew Buddy belongs to (tool guard)
  crewBuddyIds(): ReadonlySet<string>;    // CrewRegistry (policy-port.ts), unchanged contract
  turnDirectory(context: BuddyContext): Promise<TurnDirectory>;
  interruptBootLive(): Promise<void>;
  start(): void; close(): void;
  step(id: string): Promise<void>;        // tests
  drain(): Promise<void>;                 // tests: await check queue + chains
};
```

Internals. Every function is closed over `o` and the map `records: Map<string, Loaded>`.

```ts
/** Per-id promise chain; every write goes through it. */
function serialized<T>(id: string, work: () => Promise<T>): Promise<T>;
/** save(), then records.set, then events.emit({kind:'changed'}). The one write path. */
async function commit(x: Expedition): Promise<Expedition>;
/** One step of a loaded, ok record:
 *  readChat → settle each running attempt → queue checks for judging attempts →
 *  finishIfDue → fill → releasePending. It commits after each sub-step that changed the record.
 *  STEP: Record<State['t'], (x) => Promise<Expedition>> = { draft: id, running: live, paused: live,
 *  finished: settleOnly }. */
async function step(id: string): Promise<void>;
/** Owner posts in launch.chatChannelId with ord > chatSeenOrd, oldest first: the channel feed
 *  AND every thread's replies (as built, §12). Each goes through chatAct, then applyAct; its ord
 *  commits with its act. An act the state refuses is answered with a status line in the chat. */
async function readChat(x: Launched): Promise<Expedition>;
/** request = core.getPost(OWNER, requestId).request.state:
 *  awaiting|none → unchanged; answered → TurnEnd{answered, lessonOf(answer.body)};
 *  failed|cancelled → TurnEnd{<state>, {t:'none'}}. sha = tip(branch).
 *  SETTLE_INTO: Record<State['t'], ...>: running|paused → judging, then JUDGE[done.t];
 *  finished → judged{skipped}. */
async function settle(x: Launched, a: Attempt): Promise<Expedition>;
/** JUDGE: Record<Done['t'], (x, a) => Promise<void>>:
 *  checks → enqueue (once per `${id}/a${n}`) on the ONE host-wide check queue: runChecks, then
 *          serialized(id, verdictInto(n, {t:'checks', pass: every passed, runs})), then step(id);
 *  owner  → post askVerdictLine (key exp:<id>:a<n>:ask). */
const JUDGE: Record<Done['t'], (x: Launched, a: Attempt) => Promise<void>>;
/** Applies a verdict only to an attempt still `judging`; a stale one is dropped (returns x).
 *  Posts judgedLine (key exp:<id>:a<n>:judged). */
function verdictInto(x: Expedition, n: number, v: Verdict): Promise<Expedition>;
/** For running|paused only. Checks in this order: any judged pass → passed{n}; now ≥ deadline →
 *  deadline; counted ≥ maxAttempts with none starting/running/judging → budget. */
function finishIfDue(x: Launched): Promise<Expedition>;
/** cancelRuns(running attempts); judging → judged{skipped}; state finished; post finishedLine
 *  (key exp:<id>:finished). */
async function finish(x: Launched, reason: FinishReason): Promise<Expedition>;
/** For running only: while live (starting+running) < maxLive and counted < maxAttempts and
 *  now < deadline, call startAttempt. */
async function fill(x: Launched): Promise<Expedition>;
/** n = attempts.length + 1 (numbers are never reused). commit {starting, tree planned} → add →
 *  commit tree live → core.post(crew, {kind:'direct', members:[crew]}, {kind:'request',
 *  body: briefOf(...), purpose:'expedition_attempt', evidence:[`expedition-attempt:${id}/${n}`],
 *  runConfig: checkedRunConfig(seat), mentions:[], broadcast:false, key:`exp:${id}:a${n}`}) →
 *  commit running{requestId}. If add or post fails: phase interrupted, then
 *  finish(setup_failed{detail}). */
async function startAttempt(x: Launched): Promise<Expedition>;
/** Attempts with phase ∉ {starting, running} and tree ∈ {planned, live}:
 *  release(repo, workspace, `refs/salvage/expeditions/${id}/a${n}`) → TREE_OF[released.t]. */
async function releasePending(x: Launched): Promise<Expedition>;
/** core.listRuns({kind:'buddy', buddyId: crew}, 2000), filtered to input.kind 'post' with postId
 *  among the attempts' requestIds and status ∉ {complete, failed, cancelled}; for each:
 *  core.cancelRun(OWNER, id) + events.emit({kind:'cancelled', run}). */
async function cancelRuns(x: Launched, attempts: Attempt[]): Promise<void>;
/** Crew-authored inform in launch.chatChannelId, purpose 'expedition_status', evidence
 *  [`expedition:${id}`], idempotency key given. */
async function postStatus(x: Launched, key: string, body: string): Promise<void>;
/** Thin dispatcher. Missing → missing. Gate disabled → refused. ALLOWED[act.do] lacks
 *  state.t → refused [`cannot ${do} a ${state} expedition`]. Otherwise ACTS[act.do] runs, via
 *  serialized(id), and is followed by step(id). */
async function act(id: string, a: Act, by: string): Promise<Acted>;
const ACTS: { [K in Act['do']]: (x: Expedition, a: Extract<Act, { do: K }>, by: string) => Promise<Acted> };
//  launch : preflight; any issue → commit draft{issues} + refused. Else createBuddy (slug exp-<id>,
//           name `⛺ <name>`, role CREW_ROLE + id, manager {kind:'buddy', id: launcherId}, seat,
//           key exp:<id>:crew) + openChannel(OWNER, direct [OWNER, crew]) → running{Launch}.
//  pause / resume : state swap.        stop : finish(stopped{by}).
//  extend : deadline += hours.         note : notes.push({at, by, text}).
//  verdict: attempt n must be judging under done.t=owner, else refused; verdictInto.
//  retire : RETIRE[state.t] from retire.ts; on ok: records.delete(id) + emit changed.
/** Boot, before adoption (server.ts, unchanged order). Gate disabled → no-op. For each ok record
 *  with starting|running attempts: cancelRuns (all unsettled crew runs) and set those attempts
 *  to interrupted{at}; commit. Trees are released by the first step after start(). */
async function interruptBootLive(): Promise<void>;
/** Crew Buddy? No → WORKSPACE_DIRECTORY. coordinationRunId → getRun → post → evidence
 *  `expedition-attempt:<id>/<n>`, and attempt n has tree live → {t:'attempt', runId, path}.
 *  Any other crew turn → {t:'crew', path: paths.crewDir} (mkdir -p). */
async function turnDirectory(context: BuddyContext): Promise<TurnDirectory>;
/** Gate enabled: events.on(changed|posted) → 1.5 s debounce → step every active id. A 60 s
 *  backstop interval does the same (deadlines). Active = state running|paused, or any attempt
 *  starting/running/judging, or any tree planned|live. Timers use `labelled(...)` and `.unref()`.
 *  Gate disabled: start() starts nothing. */
function start(): void;
```

`Launched` is `Expedition & { state: Extract<State, { launch: unknown }> }`. The STEP and ACTS
dispatchers narrow to it, so handlers never test `state.t` again.

A step that throws (a crate read, git) is logged as
`[expeditions] <id> step failed: <reason>`. It is retried on the next debounced event or the
backstop, so it runs at most once per 1.5 s. Every failure that reflects real state is data
instead: `setup_failed`, `left`, and check `error` outcomes.

### 3.6 `retire.ts`

```ts
export interface RetireDeps { core: BuddiesCore; root: string; now: () => string;
  release: (x: Launched, a: Attempt) => Promise<Tree>;
  onBuddyArchived: (id: string) => void; onChannelArchived: (id: string) => void }
export type Retired = { t: 'retired' } | { t: 'refused'; reasons: string[] };
export const RETIRE: Record<'draft' | 'finished', (d: RetireDeps, x: Expedition) => Promise<Retired>>;
```

Retiring a **draft**: refuse if `retiredTaken`. Otherwise `fileRetired`. Its chat card then reads
"no longer listed".

Retiring a **finished** expedition runs these steps in order. Any refusal returns
`{t:'refused', reasons}` and leaves the record in place:

1. Refuse if `retiredTaken(id)`, or if any attempt is still starting, running or judging.
2. Release again every tree that is `planned`, `live` or `left`. Refuse with every reason if any
   is still `left`.
3. For each branch from `branches(repo, id)`, `archive(repo, b, 'archive/expeditions/<id>/<tail>')`,
   where tail = `a<n>`. Collect every refusal or failure, and refuse if there is any. Archive is
   idempotent, so a re-retire continues where it stopped. **This is the only partial step**: some
   branches may already be archived when a later one refuses.
4. Run `setChannelArchived(OWNER, …, true, key)` on the crew chat and on the crew's self-DM.
   Open the self-DM as the crew first, while the crew is still active.
5. `updateBuddy(OWNER, {status:'archived'})` and `onBuddyArchived`.
6. `fs.rm(crewDir)`, then `fileRetired`.

Salvage refs `refs/salvage/expeditions/<id>/a<n>` are **kept as local refs**. They are not
branches, and `cambium archive` takes only a branch. This is a documented limit. If they should be
archived too, the one-line change is to pass `--salvage-ref refs/heads/expedition/<id>/a<n>-salvage`
instead, and step 3 then archives them. That deviates from the fixed decision, so the orchestrator
has to approve it first.

### 3.7 `tool.ts` (the `expedition` Buddy tool)

```ts
/** The acts a Buddy may relay (launch, verdict, retire are the owner's). */
const BuddyAct = z.discriminatedUnion('do', [
  // as built: BuddyAct in shared, chosen by name: pause resume stop extend note
]);
const Action = z.discriminatedUnion('do', [
  z.object({ do: z.literal('draft'), charter: CharterInput }).strict(),
  z.object({ do: z.literal('status'), id: z.string().min(1) }).strict(),
  z.object({ do: z.literal('list') }).strict(),
  z.object({ do: z.literal('act'), id: z.string().min(1), act: BuddyAct }).strict(),
]);
export const EXPEDITION_TOOL = { description, writes: true, schema: z.object({ action: Action }).strict(),
  handler(deps: ToolDeps, grant: BuddyGrant, { action }) };
async function originOf(core: BuddiesCore, grant: BuddyGrant): Promise<Origin>; // as today
```

- **description** (≤ 100 chars): `Draft a self-running expedition (posts a card the owner launches); status, list, act.`
- **draft**: refused for a crew (`crewOf(grant.buddyId)`). It applies `CHARTER_DEFAULTS` to the
  omitted keys, calls `host.draft`, and replies
  `{ id, issues, defaulted: string[], next: 'The host posted a card in this chat; the owner launches it. Reply in one line; post no link.' }`.
- **status**: `{ state: stateLabel, attempts: [{ n, result, lesson, branch }] }`. Allowed for crews.
- **list**: this workspace's ok rows.
- **act**: refused for crews. Relays the owner's steering.
- **Scope:** status and act on an id from another workspace throw `no expedition <id> here`.

**launch, verdict and retire are owner-only** (HTTP). A Buddy can no longer launch.

### 3.8 `routes.ts`

Registered where it is today (after the auth gate, before the Buddy routes).

| Method / path | Answer |
|---|---|
| `GET /api/buddies/expeditions` | `200 ExpeditionRow[]` |
| `GET /api/buddies/expeditions/:id` | `200 Expedition` · `404` missing · `409 {error: 'unreadable: <reason>'}` |
| `POST /api/buddies/expeditions/:id/act` (`buddyMutations['expedition.act']`, body `Act`) | `200 Expedition` · `400` bad body · `404` · `409 {error: reasons.join('; ')}` |

Retire runs synchronously inside the request. Its pushes are a handful of `git push` calls, and the
client shows "pending" meanwhile.

## 4. Record example (`<store>/expeditions/widget-fix-3fa9c1.json`)

```json
{"v":1,"id":"widget-fix-3fa9c1","workspaceId":"ws1","createdAt":"…","launcherId":"b-lead",
 "origin":{"t":"direct"},
 "charter":{"name":"Widget fix","goal":"Make **widget** pass.","done":{"t":"checks","checks":[["sh","check.sh"]]},
            "maxAttempts":5,"maxLive":1,"hours":8,"seat":{"provider":"claude"}},
 "state":{"t":"running","launch":{"at":"…","deadline":"…","repoRoot":"/r","baseSha":"ab…",
          "crewBuddyId":"b-crew","chatChannelId":"c-dm","chatSeenOrd":""}},
 "attempts":[{"n":1,"workspace":"exp-widget-fix-3fa9c1-a1","branch":"expedition/widget-fix-3fa9c1/a1",
   "startedAt":"…","tree":{"t":"released","salvageRef":null},
   "phase":{"t":"judged","end":{"at":"…","turn":"answered","sha":"cd…","lesson":{"t":"lesson","text":"…"}},
            "verdict":{"t":"checks","pass":false,"runs":[{"argv":["sh","check.sh"],"outcome":{"t":"failed","exitCode":1,"tail":"…"}}]}}}],
 "notes":[]}
```

## 5. Crash and restart

- **Before boot.** Phase A's machinery stays as it is: `policy-port.ts` `CrewRegistry` and
  `sessionScope`, `adopt-executions.ts` `restartOf`/`crewExecutions`, `shutdown.ts`
  `discardCrewTurns`, and `turns/executions.ts`. Crew turns are discarded at shutdown and are never
  adopted, and crew sessions last one boot. None of these files change; they read
  `host.crewBuddyIds()` as today. This was reviewed for shrinkage: the crew-specific part is
  already about 25 lines across them, and the generic adoption code is not expedition code.
- **Boot.** `interruptBootLive()` (same slot in `server.ts`) turns every `starting` or `running`
  attempt into `interrupted` and cancels the crew's unsettled runs.
- **After `start()`.** The first step releases those trees with
  `release(..., refs/salvage/expeditions/<id>/a<n>)`. If the add never completed the result is
  `absent`; dirty work is snapshotted at the salvage ref. The step then fills the next attempt
  (n+1). Interrupted attempts are not counted.
- **Judging attempts** under `checks` are simply re-queued, because the sha is immutable. A check
  orphaned by a crash runs in a dir that `runChecks` deletes and prunes first, so it fails fast.
  That is a documented limit and needs no pidfile.
- **Torn writes** cannot happen (tmp + rename). A leftover `*.tmp` is ignored.

## 6. Integration points in other files

| File | Change |
|---|---|
| `server/src/server.ts` | Delete `import { boundSessions } from './expeditions/meter'` and the `meter: {…}` option block (−5 lines). The `createExpeditionHost` call keeps `core, events, root, gate, installed, onBuddyArchived, onChannelArchived`. `crewRegistry`, `interruptBootLive`, `start`, `close`, `turnDirectory` wiring and `registerExpeditionRoutes(app, () => expeditionHost)` are unchanged. |
| `server/src/buddies/mcp.ts` | None (still `import { EXPEDITION_TOOL } from '../expeditions/tool'` and `ExpeditionHost` from `host`). |
| `server/src/buddies/briefing.ts` | Replace the `expedition:` guide line with: `'expedition: for a big, fuzzy goal with a checkable done. Asked, draft one (name, goal markdown, done {t:"checks",checks:[argv…]} or {t:"owner"}, maxAttempts); the host posts a card the owner launches; post no link. act relays pause/resume/stop/extend/note.'` (shorter than today). |
| `server/src/buddies/policy-port.ts`, `turn-policy.ts`, `lifecycle/shutdown.ts`, `lifecycle/adopt-executions.ts`, `turns/executions.ts` | None. |
| `shared/src/buddy-api.ts` | Delete the `expedition.launch` and `expedition.retire` mutations. Add `'expedition.act': { method: 'POST', path: '/api/buddies/expeditions/:id/act', status: 200, body: Act }` (import `Act` from `./expedition.js`). Result type `Expedition`. The `BuddyRouteMutation` exclude becomes `'upstream.update' \| 'expedition.act'`. |
| `shared/src/index.ts` | Unchanged (`export * from './expedition.js'`). `ExpeditionView`, `ExpeditionDraftView`, `ExpeditionSummary`, `ExpeditionRetiredView`, `ExpeditionCrews` and `expeditionRunLabel` are gone; fix their importers below. |
| `tools/test-server.mjs` | Delete the `expeditions: { shards: 12, live: 6 }` entry (the new file is small). |
| `tools/screenshots.mjs` | Delete the `expeditions` (`?view=expeditions`) shot. |
| `server/test/fixtures/tool-contracts/input-schemas.json` | Regenerate the `expedition` entries. In `tool-contract.test.ts`, lower the description budget comment and number to match. |
| repo `expeditions/` docs | Delete `design.md` and `mcp.md`. Rewrite `README.md` to 5 lines pointing here. Keep `workflows-vs-expeditions.md`. |

Client integration edits (outside the 300-line budget, each a deletion or a one-liner):

| File | Change |
|---|---|
| `client/src/App.tsx` | Delete the lazy `ExpeditionModal`, `EXPEDITIONS_SCREEN`, `EXPEDITIONS_INDEX`, `ExpeditionRoute`, the overlay base logic and the `/expeditions` and `/expeditions/:id` routes. The modal is local state of the card and the rail; no URL. |
| `client/src/components/buddies/channels-view.ts` | Remove the `{ kind: 'expeditions' }` variant and its `view=expeditions` parse case. |
| `client/src/mobile/channels/ChannelsIndex.tsx`, `channel-route.ts`, `ShellMobile.tsx`, `workspace-order.ts` | Remove the `expeditions` screen/kind and the comments naming it. |
| `client/src/components/buddies/ChannelBrowser.tsx` | `<RailExpeditions workspaceId classes={DESKTOP_ROW} />` replaces the old one. Delete `ExpeditionsPane` and `panes.expeditions`. |
| `client/src/components/buddies/ChannelLanding.tsx` | Delete `<HomeExpeditions>`. |
| `client/src/mobile/channels/ChannelsMobile.tsx` | Delete the `expeditions` page case and `ExpeditionSection`. Render `<RailExpeditions workspaceId classes={MOBILE_ROW} />` in its place. |
| `client/src/components/buddies/channel-data.ts` | `ExpeditionCard = { t: 'none' } \| { t: 'card'; id }` on purpose `'expedition'` + evidence `expedition:`. UNLABELLED adds `'expedition'` and keeps `'expedition_status'`; the old `'expedition_badge'`/`'expedition_draft'` names stay in the set only so old posts render without a tag (their body text is the fallback). |
| `client/src/components/buddies/ChannelPostContent.tsx` | One case: `card → <ExpeditionCard id={card.id} />`. |
| `client/src/atoms/channel-rail.ts` | Delete `expeditionRailFamily` and `NO_EXPEDITIONS`. |
| `client/src/atoms/buddy-visibility.ts`, `client/src/hooks/useBuddyData.ts` | Crew ids come from the cached `EXPEDITIONS_URL` rows (`crewBuddyId`). `useExpeditionCrews` polls `EXPEDITIONS_URL`. The `/crews` URL is gone. |

## 7. Buddy tool surface and HTTP

- **Tool** `expedition`, one argument `action`:
  - `draft { charter: CharterInput }`
  - `status { id }`
  - `list {}`
  - `act { id, act: pause | resume | stop | extend{hours} | note{text} }`
- **HTTP:** the three routes of §3.8. Deleted routes: `/crews`, `/drafts/:draftId`,
  `/drafts/:draftId/launch`, `/:id/retire`.
- **Chat grammar** (owner, in the owner↔crew DM): `pause`, `resume`, `stop`, `extend <n>h|<n>m`,
  `pass`, `fail`. Anything else is a note forwarded into every later brief.
- **Posts the host makes:**
  - The card, posted by the launcher Buddy at draft time with purpose `expedition`, evidence
    `expedition:<id>`, key `exp:<id>:card`. It is placed in the origin thread, or in the
    owner↔launcher DM for a direct origin; `placementOf` logic moves into host.ts as 6 lines.
  - Attempt requests: purpose `expedition_attempt`, in the crew's self-DM.
  - Status lines: purpose `expedition_status`, in the crew chat.

## 8. Client components (≤ 300 lines, CSS ≤ 120)

| File | Lines | What |
|---|---|---|
| `components/buddies/expedition-api.ts` | 40 | `EXPEDITIONS_URL`, `expeditionUrl(id)`; `useExpeditionRows(workspaceId)` (`usePolledFetch<ExpeditionRow[]>` 10 s; filters ok rows to the workspace, keeps every unreadable row; sort: needsOwner, running/paused/draft, finished); `useExpedition(id, pollMs)`; `useAct(id)` → `{ state: idle\|pending\|failed{error}, run(act) }` via `buddyWrite('expedition.act', {id}, act)` + `invalidateBuddyResources()` |
| `components/buddies/ExpeditionCard.tsx` | 50 | Chat card: ⛺ name, `stateLabel` pill, `counted/maxAttempts`, issue count for a draft. **Info** opens `<ExpeditionModal id>` (lazy, local state). **Launch** appears when `ALLOWED.launch` includes the state. 404 shows "Expedition no longer listed". |
| `components/buddies/ExpeditionModal.tsx` | 150 | `ModalDialog` holding: header (name, state label, deadline); goal through `ChannelMarkdown` (body `{t:'text', text}`, `useWorkspaceDirectory`); done line (argv list, or "you judge"); draft issues; the attempts table (n, state, result, lesson, branch); per-row **Pass**/**Fail** buttons while `judging` under owner; controls rendered from `ALLOWED`: Launch, Pause, Resume, Stop, Extend (number input, hours), Retire (two-step confirm); act error text inline. An unreadable row shows its reason only. |
| `components/buddies/ExpeditionRail.tsx` | 55 | `RailExpeditions({ workspaceId, classes })`: section header "Expeditions" and one row per expedition (dot from state, name, "needs you" flag); a click opens the modal (local state). Used by both shells. |
| `components/buddies/Expedition.css` | ≤120 | card, pill tones, modal layout, table, phone-width sheet |

Deleted client files: `expedition-view.ts`, `expedition-overlay.ts`, `expedition-action.ts`,
`ExpeditionBadge.tsx`, `ExpeditionDraftCard.tsx`, `ExpeditionDraftLaunch.tsx`,
`ExpeditionList.tsx`, the old `ExpeditionModal.tsx` (rewritten), and the old `Expedition.css`
(rewritten).

## 9. Test plan

All tests live in **one** file, `server/test/expeditions.test.ts`, with 4 integration tests. They
run on a real temp git repo, a temp store, real sqlite `BuddiesCore`, the real `git-cambium`
(which must support `remove --safe` and `archive`) and the real MCP endpoint. A rewritten
`server/test/fixtures/expedition-fixture.ts` (≤ 150 lines) supplies them. It reuses from today's
fixture `rpc`, `git`, `tempRepo` (extended with `check.sh`, which greps `widget/widget.ts` for
`broken = false`), `fixture()`'s core/workspace/lead/endpoint setup, `executeRequestRun` and
`BUDGETS`.

It adds two helpers:
- `crewAnswer(id, n, body)`: answers attempt n's request as the crew, then `host.step`.
- `ownerSays(id, text)`: an owner post in the crew chat, then `host.step`.

The fixture asserts on startup that `git-cambium remove --help` lists `--safe`, and fails loudly
otherwise; it never skips. `oompa-stub.cjs` is unrelated (Oompa MCP) and is not used.

1. **Loop to a pass; the oracle cannot be edited.**
   - Draft via the tool. Assert the card post exists (purpose `expedition`) and the record is
     `draft`. Launch via `POST …/act {do:'launch'}`.
   - a1: commit a wrong change, answer `…\nLesson: grep is literal`. Checks fail. a2's brief
     contains a1's lesson, plus the text of an owner note posted in the crew chat.
   - a2: rewrite `check.sh` to `exit 0` without fixing the widget. The oracle is restored, so it
     still fails.
   - a3: make the real fix. The expedition finishes `passed{3}`.
   - Afterwards: the Cambium list has no `exp-*` workspace, branches `expedition/<id>/a1..a3`
     exist, and the JSON file on disk re-parses through `Expedition`.
   - Catches: pins regression, lesson/notes plumbing, tree release, budget count.
2. **Restart: interrupt, salvage, not counted, typed load errors.**
   - Charter with `maxAttempts: 1`. a1's run is executing (`executeRequestRun`) and the crew leaves
     an uncommitted file in the tree.
   - Write `junk.json` (`{}`) and `.retired/old.json` + `.retired/old/ledger.jsonl` sentinels into
     the store.
   - `reboot()` → `interruptBootLive()`: a1 is `interrupted` and the crew run is `cancelled`.
   - `start()`, then step: the tree is released and `refs/salvage/expeditions/<id>/a1` contains the
     file. a2 is started even though `maxAttempts` is 1. `rows()` holds `{t:'unreadable', id:'junk'}`,
     and the `.retired` bytes are unchanged.
3. **Owner-judged, chat grammar, finish conditions.**
   - `done: {t:'owner'}`. a1 answers, so the ask-verdict status post appears.
   - Owner chat: `extend 2h` moves the deadline by 7,200,000 ms. `pause`: after `fail`, no a2
     starts. `resume`: a2 starts. `pass` → `finished{passed:2}`.
   - A separate expedition: `stop` while a1 runs → the run is cancelled, then a1 is
     `judged{skipped}` and the state is `finished{stopped}`.
   - Moving the clock past the deadline on a third → `finished{deadline}`.
4. **Retire archives or refuses whole.**
   - A file:// bare `origin`. A finished expedition with branches a1 and a2.
   - `act retire`: tags `archive/expeditions/<id>/a1|a2` resolve on origin to the old tips, the
     local branches are gone, the crew Buddy and both crew chats are archived, and `<id>.json` has
     moved to `.retired/<id>.json`.
   - A second expedition whose a1 branch is checked out in a manual `git worktree`: retire returns
     409 with `checked-out`, the record stays, the crew is not archived, and nothing moved.

Kept unchanged: `server/test/crew-restart.test.ts` (lifecycle; it covers the Phase A machinery)
and `buddies-v2.test.ts` (`names.includes('expedition')`). `tool-contract.test.ts` is updated only
for the new schema and description size.

Client: one smoke test, `client/test/expedition.test.tsx` (rewritten, ≤ 60 lines). It renders the
modal for a fixture record in each state plus an unreadable row, asserts no throw, and checks that
retire needs two clicks. That second check guards the one owner action that cannot be undone.

**Deleted test files:**
- `server/test/expedition-restart.test.ts`
- `server/test/expedition-retire.test.ts`
- `server/test/expedition-git-retire.test.ts`
- the old `server/test/expeditions.test.ts` (replaced)
- `server/test/fixtures/expeditions-live/` (4 old ledgers + README)
- `client/test/expedition-overlay.test.ts`

There is no `expedition-decide.test.ts` on f27c7c5, so there is nothing to delete for it.

## 10. Deletion list

`server/src/expeditions/`: `briefs.ts`, `charter.ts`, `command.ts`, `decide.ts`, `drafts.ts`,
`effects.ts`, `git.ts`, `host.ts` (rewritten), `ledger.ts`, `meter.ts`, `model.ts`, `news.ts`,
`pins.ts`, `queries.ts`, `release.ts`, `retired.ts`, `routes.ts` (rewritten), `store.ts`, `tool.ts`
(rewritten), `view.ts`.

That drops these concepts entirely:
- the event ledger and replay, quarantine, tick failure streaks and backoff;
- idempotent effect adoption and `cambium recover` handling;
- managers, questions, custody, panels, integration branch and merge;
- the manager tree, drafts store, supersede and launch-key dedupe;
- cost metering, pins, harvest, release guard ladders, `archiveBranch`, the pidfile kill;
- the repair round, the JSON answer schemas, the markdown status report, view/queries projections;
- retired snapshots, and seat-catalog model-name resolution (`seatOf`). The seat is now validated
  by `checkedRunConfig` + `installed` only.

Shared, deleted from `expedition.ts`: `ExpeditionRun`, `ExpeditionRetirement`,
`ExpeditionStage`, `ExpeditionQuestion`, `ExpeditionWorktree`, `ExpeditionAttemptCost`,
`ExpeditionAttemptPhase`, `ExpeditionAttempt`, `ExpeditionDoneCheck`, `ExpeditionValidation`,
`ExpeditionIntegration`, `ExpeditionCharterView`, `ExpeditionView`, `ExpeditionDraftState`,
`ExpeditionDefault`, `ExpeditionDraftView`, `ExpeditionCrews`, `ExpeditionSummary`,
`ExpeditionRetiredView`, `expeditionRunLabel`.

Client: §8 deleted files plus the §6 client edits.

**Old data:**
- All four old expeditions are already in `<store>/expeditions/.retired/`. The loader ignores that
  directory and nothing writes to it except `fileRetired` of new records (COPYFILE_EXCL, so it
  never overwrites).
- `<store>/expeditions/drafts/` (old drafts) is ignored as a directory. The owner may `rm -r` it;
  the code never touches it.
- Old chat posts with purposes `expedition_badge`/`expedition_draft` render as their plain body
  text.
- No migration, no old readers.

## 11. Known limits (deliberate)

- **Oracle restore** brings back only files named by argv elements (directories are restored
  whole). A check that reads an unnamed file through a named script reads the attempt's version
  of that file. Name the test files in argv, or check through a named directory.
- **There is no sandbox for checks**: only the env scrub, scratch HOME/TMPDIR, the 2 h timeout and
  the group kill. The same holds today.
- **Repo config filters** (`filter.<x>.smudge`) can still run code during host git checkouts. The
  same holds today; hooks and fsmonitor are off.
- **Salvage refs stay local** at retire (§3.6).
- **Interrupted attempts**: when an attempt is interrupted before its `cambium add` finished, a
  half-made workspace may need `git cambium recover` by hand. `release` reports `absent` when the
  registry has no entry, and `left` when Cambium refuses.
- **Checks run one at a time host-wide**, by design for the shared machine. Finishing an
  expedition aborts its own queued and running checks.
- **Retire needs an `origin` remote**: `git cambium archive` refuses `push-unverified` without
  one, so a finished expedition in a repo with no origin cannot retire (the refusal is shown).
- **Archived crew run**: a crew run cancelled at boot stays `cancel_requested` until its lease
  ends (about 5 min); a retire in that window shows the archived crew as working until then.

## 12. As built: deviations

- **Line budgets.** The §0/§3/§8 plans counted signatures, not `biome format` output (objects and
  call arguments past 100 columns break one per line). As built, per file: `host.ts` 594 (plan 190),
  `checks.ts` 177 (100), `tool.ts` 119 (35), `cambium.ts` 103 (75), `brief.ts` 101 (55),
  `record.ts` 86 (70), `retire.ts` 71 (45), `routes.ts` 57 (30); client `ExpeditionModal.tsx` 140,
  `ExpeditionCard.tsx` 65, `ExpeditionRail.tsx` 61, `expedition-api.ts` 43; `shared/src/expedition.ts`
  229 (it also holds `stateLabel`/`attemptResult`, about 45 lines). No file was split and nothing
  was packed onto one line to get under.
- **A judging attempt holds a live slot** (`fill`, host.ts). §3.5 counted only starting+running,
  which started a4 while a3's passing checks ran, and started a2 before the owner's verdict on a1
  (the §9 test 3 "after `fail`, no a2 starts" could not hold).
- **A request whose every run settled is a cancelled turn** (`turnOf`, host.ts). Cancelling a QUEUED
  run closes no request (runs.rs `cancel_queued`), so after `stop`/`finish` the attempt stayed
  `running` and its tree was never released.
- **`attemptResult(a, done)`** takes the charter's `done`, to say "checking" or "needs your verdict".
- **Preflight returns a union** `{t:'ready', repoRoot, baseSha} | {t:'refused', issues}`.
- **Retire re-release** of planned/live/left trees runs inside `retire.ts` (`RetireDeps.release` and
  `commit`), so a refusal leaves the record with its updated trees.
- **Rail rows** carry `section`, `heading` and `list` class names too, so both shells render the one
  section header; the phone has no separate `MobileSection` wrapper.
- **Review fixes (2026-11-03).**
  - The oracle restore passes only literal, tracked, non-root paths (`--literal-pathspecs`, no
    `.`); an argv with no such element restores nothing instead of the whole tree.
  - Only an `answered` turn is judged; `failed`, `cancelled` and `lost` turns end `skipped`, and
    the label names the turn. A crew that renamed or deleted its branch gets it back at its tree's
    HEAD; with the tree gone too, the turn is `lost` (sha = base).
  - The chat is read from the channel feed and every thread; each command's ord commits with it,
    so a later failure never replays it; a refused act is answered in the chat, never a note.
  - Trees are released before the next brief is written, and a prior line names the attempt
    branch plus the salvage ref only when one exists. A restart posts an interrupted line.
  - The owner act route answers 500 when an act throws; acts are refused until `start()`.
  - Retire files through tmp + `link` (exclusive), resumes past an already archived crew, and
    archives a crew left behind by a failed launch when a draft is retired.
  - The modal links to the crew chat and posts notes and commands into it; the Buddy tool's acts
    are chosen by name (`BuddyAct` in shared).
- **Expedition view and manager (owner 2026-11-03: the modal was "ugly bad no white space
  balance", with "No chat log to discuss with the running manager").**
  - The modal is gone. `?expedition=<id>` (and `?retired=<id>`) is a Channels view kind
    (`channels-view.ts`): desktop shows the overview where a channel sits (header strip with
    pill, attempts used, time left and controls from `ALLOWED`; goal markdown clamped with Show
    more; Done-when argv chips; attempts list) and the manager chat where a thread sits. The phone
    shows Overview | Chat tabs. The rail and the chat card navigate there, so the URL, Back and
    the rail highlight work like a channel's.
  - The manager is the crew Buddy's chat seat. The chat is one thread in the owner<->crew DM
    (root: crew post, purpose `expedition_chat`, key `exp:<id>:chat`; status lines are its
    replies), so every owner message reaches one seat conversation that remembers the talk. It is
    a separate conversation from the attempt turns and owner posts skip the run cap, so it answers
    while an attempt runs. `host.seatOf` tells attempt turns from manager turns; the tool's `act`
    is refused in an attempt turn and allowed in the manager seat for its own expedition.
  - Chat grammar: bare `pause|resume|stop|extend Nh|pass|fail` and `note: <text>` are applied by
    the host; anything else is talk for the manager (no longer filed as a note).
  - Act `relaunch` (finished, or a retired record): a new draft with the same charter, fresh id;
    the view opens it. `GET /api/buddies/expeditions/retired` lists lean retired records only;
    the four pre-lean `.retired` files stay unread.
- **Review 2026-11-03 of the view and manager (authority and chat).**
  - Seats: a crew turn is the manager only when the owner started it (a chat run, or a post or
    request authored by the owner); a crew turn another Buddy started is seat `crew` and cannot
    act. A Buddy outside a crew may relay pause/resume/stop/extend/note but never `verdict` or
    `relaunch` (the owner's words). Before, any Buddy could pass an owner-judged attempt and it
    was recorded as the owner's verdict, and "@crew stop" from a Buddy was obeyed.
  - A bare chat command is the host's alone: `publishOwnerPost` asks `HostCommands.consumes`
    (host.ts) and posts it with no wake, so no manager turn answers it with a stale status or
    applies it a second time (extend twice = 4 h). The host answers each applied command in the
    chat (`brief.ackOf`: "Extended 2 h · new deadline …", "Paused …"; stop and verdict already
    post their own line).
  - `GET /api/buddies/expeditions/:id/chat` names the chat thread (`ExpeditionChat`): made on
    first open for a launched record, found (never made) for a retired one, else a typed reason.
    The view no longer searches the DM's first feed page, which spun forever when the root was
    missing or more than 50 posts old. Boot makes roots only for live records, quietly (no
    announcement per finished expedition).
  - Relaunch is idempotent: an unlaunched draft with the same charter in the workspace is the
    answer. Relaunch of a retired record passes the gate and started checks like every act.
