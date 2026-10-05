# 2026-10-05 — Which agent an unpinned Buddy runs on a fresh install

Author: worker for Buddies Development Lead (Opus), request post_01a10acd-2cba-7423-bbc0-0c370eb92600.
Status: proposed by the worker and implemented on `fix/installed-provider-default`. This is not an
owner decision. It changes neither the owner's model-selection rule nor the Buddy data model, so the
brief allowed implementing it without stopping.
Todo: todo_57268f4b-dadf-4812-bb5f-68d124f170ab. Context: `2026-10-05_fresh-install-launch-blockers-decision.md`.

## Base

The brief asked for a branch from `fix/unified-thread-model` @ 27027d6, which owns model
resolution. That base predates e97acf0 ("Install missing tools on first boot"), and the install
race this note is about only exists with e97acf0. The branch therefore starts with a clean merge
of main 654032b into 27027d6 (`git merge-tree` reported no conflicts). It still merges cleanly
into either parent.

## What the code does today

The bootstrap (`server/src/upstream/unleashd-home.ts`) hires Product Dev and the Upstream Release
Manager with **no** provider. The hardcoded Codex is the fallback in the one shared mapping,
`buddyExecutionPreferences` (`shared/src/config-mapping.ts`): an unset provider becomes `'codex'`
unless the model alone names a harness. That mapping feeds every place a Buddy's default is
read:

- `server/src/buddies/briefing.ts` → `buddy-creation-service.resolveConfig`. This covers the direct
  chat (`POST /api/buddies/:id/direct`), background runs and WS-created Buddy conversations.
- `server/src/buddies/channels.ts profileConfig`. This covers channel/DM thread seats and the reply gate.
- `client/src/components/buddies/channel-data.ts profileExecution`. This covers the @mention chip
  and the composer picker.

Once a conversation exists, its config is persisted and wins (owner rule step 1). So the fallback
only matters when a conversation is **created** for a Buddy whose profile has no provider.

## Options

### (a) Pick at seat creation, re-pick when readiness changes

The bootstrap writes `provider: <installed>` onto the Buddy row.
- *Install race:* the bootstrap runs on every start, before or during the async first-boot install.
  With nothing installed yet, there is nothing to write. A later re-pick needs a trigger, which
  means a readiness watcher that edits Buddy rows.
- *Second CLI installed later:* the re-pick must decide whether to change a stored provider.
- *Owner-set default:* a stored `provider: claude` reads the same whether the owner chose it or
  the bootstrap guessed it. A re-pick would need provenance on the profile (a data-model change)
  or it would risk overwriting an owner choice. That violates the hard constraint.
- It also writes a guess into the authoritative store. Every client then reads a guess as an owner
  choice, including the Buddy editor and `configure_team`.

### (b) Store nothing; resolve the default at run time from what is installed

The Buddy row keeps `provider` unset. Unset already means "the owner has not chosen", so this adds
no new state. The shared mapping takes one extra input, the install's agent, and returns a sum
type: run on a provider, or `no-agent`.
- *Install race:* resolution happens when a conversation is created. Before an agent exists, the
  result is `no-agent`: nothing spawns, and the user sees why. As soon as the binary lands on
  PATH, the next open resolves to it. The bootstrap never needs to rerun.
- *Second CLI installed later:* existing conversations keep their persisted model (rule step 1).
  New conversations of unpinned Buddies follow a fixed preference order (below). The picker reads
  the same value, so it shows what will run.
- *Owner-set default:* an explicit provider, or a model that names exactly one harness, is returned
  unchanged before the install is consulted. Owner choices are never read, compared or rewritten.

### (c) (b) plus a sticky install-level default

Store the first agent that became available and keep it until it disappears. This is stable
across a later second install, but it adds a new persisted setting with its own lifecycle and
repair cases. That buys little over (b), whose only movement on a second install is confined to
*new* conversations and is visible in the picker.

## Recommendation: (b)

Data stays canonical: no guessed values are written, and absence keeps its one meaning. The
choice is recomputed from the ground truth, so the race disappears instead of being managed.

### Which agent is "installed"

`installedAgent(env)` (`server/src/providers/installed-agent.ts`) walks `env.PATH` for the
**same binaries the runner spawns**. It uses a plain `stat` per PATH entry, with no subprocess and
no cache. This is the process env that `createDependencyChecks` already extended with
`~/.local/bin` and `~/.cargo/bin`, so "found" means "spawn will not ENOENT". That is exactly the
failure in the trial.

- **Order: codex, then claude.** Only these two harnesses are offered by Setup and probed. Codex
  comes first because it is today's fallback. An install that has both keeps today's behavior, so
  the owner's live install sees no change. On a single-CLI install the order does not matter.
- **Readiness probes are deliberately not used.** A probe can be `checking` for 45 s after every
  start, and `failed` can be transient (network, quota). Choosing on probe health would make the
  default flap between boots. An installed but logged-out agent is still chosen. Its failure is a
  provider error the user can see and retry, which is truthful. "No agent" would be wrong there.
- Other harnesses (cursor, opencode, gemini, muse) are never auto-picked. A Buddy runs them only
  when the owner pins them.

### The no-agent state

- Server: when a conversation must be created and the profile resolves to `no-agent`,
  `buddy-creation-service` throws `No agent is installed…`. The direct chat surfaces it as the
  DM's failed action. Channel/DM thread replies turn it into the existing visible `reply_failed`
  notice (`runReply`), so no spawn happens and the failure is not silent.
- Wire: `GET /api/dependencies` gains `agent: {kind:'agent', provider} | {kind:'none'}`. Its
  `.default` is `{agent: codex}`, which is exactly what a pre-change backend does during a version
  skew.
- Client: the mention/composer picker resolves through the same shared mapping with the
  same `agent`. A `no-agent` profile renders "Needs an agent" (disabled). The direct chat's model
  button reads the persisted conversation config, which is already exact.

## Scope left out

- The Buddy Builder (`createBuddyBuilderConversation`) and the memory reviewer pin
  `codex`. They are owner-level tools, not bootstrap Buddies, and the same defect class applies to
  them. Follow-up recommended, not done here.
- A failed spawn of an *installed* agent is task_01a10acc-99d8 (in flight on
  `fix/missing-cli-visible-error`).

## Revisit when

The owner wants a second install to keep new conversations on the first agent (adopt (c)). Also
revisit if Setup starts offering a third agent, which must then be placed in the order, or if
Buddy profiles gain explicit provenance for other reasons.
