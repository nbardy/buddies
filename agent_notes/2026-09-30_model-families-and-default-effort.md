# Model families + default effort (2026-09-30)

Trigger: owner in #case-studies (thread post_01a0eece-40e8-7292-abbb-b1fbb9f7d5a7), after the Wave
Simulation Lead's handoff on workers running gpt-6-sol: "6.1 sol should be med default, how did it
get low?", "call them sol vs astra, opus vs fable vs sonnet; always pick the latest version unless
overwritten, so upgrades come naturally", then: "the registry has `GPT-sol: {versions: [....]}` and it
always defaults to the latest in that list and requires overlays".

Claim boundary: code read at acd7410 plus `~/.codex/models_cache.json`, then step 0 landed. The live
server's loaded catalog was not checked.

Status
- Step 0 DONE: agent-cli `1b82d82` (pushed) + unleashd `70d2d99` (local, not pushed; origin/main..HEAD
  also holds c3065ab and 3217e26): 6.1 Sol defaults to medium; a rule test covers the whole served catalog.
- Steps 1-4: design only, waiting for the owner's go.

## 1. How 6.1 Sol got `low` (verified)

- Codex's own cache (`~/.codex/models_cache.json`, client 0.159.0, fetched 2026-09-29T20:19Z) reports
  `default_reasoning_level: low` for gpt-6.1-sol. It also reports `low` for gpt-5.6-sol, where our
  catalog says medium. So medium is our product policy, applied by hand; it is not what upstream ships.
- The 09-28 registry consolidation (agent_notes/2026-09-28_model-registry-inventory.md, row 6) deleted
  the server override that rewrote every model's default effort to medium and moved the policy into
  data. `catalog.jsonc` had 17 hand-typed `"defaultEffort": "medium"` strings and one `"low"`.
- agent-cli `4b15220` (2026-09-30 02:51 +08) added gpt-6.1-sol with the comment "Offered by codex-cli
  0.159.0 (models_cache.json 2026-09-29)": the cache's value, copied verbatim.
- agent-cli `87ea55a` (03:01:57) made it the Codex default. Outer `1444cdd` (03:02:16) bumped the pointer
  AND edited `server/test/conversation-config-domain.test.ts` from `gpt-6-sol`/`medium` to
  `gpt-6.1-sol`/`low`. The only test pinning "default = medium" asserted the literal one file away from
  the data, so it followed the data instead of catching it.
- Blast radius: `resolveConversationConfig` (shared/src/conversation-config.ts) takes default effort from
  `model.reasoning.defaultEffort`, so anything on default model + default reasoning resolved to `low`
  once a backend loaded the new catalog.

## 2. Where "latest" is hand-maintained today

| Site | What is wrong |
|---|---|
| `catalog.jsonc` `defaultModelId` and `aliases.sonnet` | two hand-bumped "latest" pointers |
| `client/src/views/config/config-options.ts:51` `latestCodexModelIds` | family list `astra\|sol\|luna` hard-coded; version parsed from the id by regex |
| `config-options.ts:154-158` | every non-default picker row stores the concrete id: picking Astra pins today's Astra |
| `client/src/components/buddies/BuddySettings.tsx:144` | Buddy profile model dropdown still filters Codex by `startsWith('gpt-6-')`, which hides gpt-6.1-sol. 1444cdd fixed only the picker's copy |
| `BuddySettings.tsx:116-124` | changing provider writes the concrete default model id and effort into the profile: the UI creates pins |
| `channel-text.ts:409` `configLabel`, `config-options.ts:74` `resolvedModelOf` | each re-derives "default -> defaultModelId" |
| catalog Claude entries | `fable` is a CLI alias id; opus/sonnet are pinned versioned ids. `config-service.ts:468-473` special-cases `claude-fable-5-1` -> `fable` |
| `server/src/buddies/worker-config.ts:15,49` | worker `model` is required and stored verbatim, so a literal id in prose is honored forever |
| records crate `crates/unleashd-ingest/src/records/types.rs:55` | `ModelSelection` is `Default \| Explicit` only |

## 3. Design: a family-keyed registry

Owner pattern: the registry is keyed by family, each family owns a `versions` list, a family always
resolves to the latest in its list, and staying off latest takes an explicit override. I read "overlays"
as that override (a pin). If a separate layer was meant (say, a per-workspace "sol -> 6" that applies to
everything using sol), it can sit on top of this later; nothing here blocks it.

**Catalog data** (agent-cli `catalog.jsonc`, the one data file)

```jsonc
"codex": {
  "defaultFamily": "sol",            // replaces the hand-typed defaultModelId
  "defaultEffort": "medium",         // product policy, one per provider
  "families": {
    "sol": { "displayName": "Sol", "listed": true, "versions": [   // newest first
      { "version": "6.1", "id": "gpt-6.1-sol", "displayName": "GPT-6.1 Sol", "levels": ["low", "medium", "high", "xhigh", "max", "ultra"] },
      { "version": "6",   "id": "gpt-6-sol",   "displayName": "GPT-6 Sol",   "levels": ["low", "medium", "high", "xhigh", "max", "ultra"] },
      { "version": "5.6", "id": "gpt-5.6-sol", "displayName": "GPT-5.6 Sol", "levels": ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"] }
    ] },
    "astra": { ... }, "luna": { ... }
  }
}
```

- Every model belongs to exactly one family; a lone model is a family of one. No "standalone" second shape.
- Latest = `versions[0]`. Position, not version parsing: no regex and no numeric compare at runtime. The
  generator asserts strictly newest-first by numeric compare, once, at build time, so the order cannot lie.
- Ids are explicit, no `gpt-{version}-sol` templates: provider ids pass through verbatim and stay greppable.
- `levels` stay per version (5.6 Sol has minimal, 6.x does not, Luna has no ultra). `defaultEffort` is
  provider-level and asserted to be in every version's levels.
- `listed` moves the picker's curation (today the client regex `astra|sol|luna`) into data.
- Family names subsume `aliases.sonnet`; aliases stay only for retired ids (`composer-2` -> `composer-2.5`).
- The generator rejects: empty versions, unsorted versions, duplicate id or version, unknown
  `defaultFamily`, `defaultEffort` not in a version's levels, an alias to a missing id.
- The generator still EMITS the flat `models` (newest first within each family), `defaultModelId` and
  per-model `reasoning.defaultEffort`, all derived, so the wire and every existing reader are unchanged.
  A new `families` field rides along for the picker; on the wire it needs `.default(...)` (AGENTS.md:
  Vite serves the new client before the backend reloads).
- Adding a model = prepend a version. That is also the fleet rollout: everything on that family moves at
  the next backend load.

**Selection** `ModelSelection = Default | Family{family} | Explicit{modelId}`
- Default -> latest of `defaultFamily`; Family -> `versions[0]` of that family, or typed
  `model_unavailable` listing valid families; Explicit -> the id verbatim. Explicit is the pin ("overlay"):
  same stored shape as today, so no stored-data migration. The registry can show a pin as "pinned to 6,
  6.1 available".
- One shared `latestOf(provider, family)` plus one dispatcher `modelIdOf(provider, selection)`, called by
  the resolver, the picker, Buddy Settings and the chip label. The client regex and the
  `startsWith('gpt-6-')` filter are deleted.
- Rust records `ModelSelection` gets a `Family` variant (+ `validate.rs` text check); addon rebuild and
  backend restart. Additive, but an older addon cannot read a record holding it: ship the crate before
  anything writes a Family.

**κ (string -> selection), one place** `configFromProviderPreferences` (server/src/conversations/config-mapping.ts)
- absent -> Default; alias -> Explicit(target); exact catalog id -> Explicit; family name -> Family;
  anything else -> Explicit(raw), which the resolver rejects with the valid values (today's behavior).
  An exact id beats a family name. Profiles (the `model` column stays a string), workers and session
  evidence all use it.

**Workers**
- `worker.model` becomes optional: an id, a family name, or absent (provider default).
- `checkedRunConfig` resolves ONCE at post time and returns the resolved config (concrete id + resolved
  effort). That is what the run stores (`RunConfig` in the Buddies crate stays strings, no crate change)
  and what the post result echoes, so the record says what ran. "Swap the id, effort silently drops"
  cannot recur.
- The tool description says "id or family; omit for the provider default" (no ids in static text).

**Picker and Settings**
- One row per `listed` family: label + resolved version ("Sol . GPT-6.1"); choosing it stores Family. The
  row for the default family keeps folding to Default (one representation of "the default").
- Older versions stay reachable under a "Pin a version" group (Explicit). Buddy Settings lists the same
  rows and stops writing concrete ids on provider change (writes '' = server default).
- Answers 09-29: "latest" rows were removed because bare "Sonnet" did not say which model. The row always
  shows the resolved version, so the target is identified.

## 4. Order

0. DONE (see Status).
1. Registry reshape in agent-cli `catalog.jsonc` + generator + shared resolver + Rust variant + server
   resolution.
2. κ + worker schema + resolved-config echo.
3. Client picker + Buddy Settings + chip label; screenshot before/after (`pnpm screenshots`).
4. Docs: `// Pattern: one-definition` tag on `latestOf`; docs/pass-through-pattern.md (family selection is
   resolved server-side); catalog header says adding a version is the rollout.

Work in an isolated git worktree (`pnpm run bootstrap`), local commits only. On 2026-09-30 `shared/dist`
already showed the regenerated catalog before any build of mine ran, with `tools/dev-supervisor.mjs`
running against the main checkout, so a half-done registry change there would reach the owner's live dev
app. The agent-cli push and the outer
push are separate asks.

## 5. Guards (fix-guards)

- Real-resolver test on a tiny fixture catalog: prepending `sol 6.2` moves the provider default, Family
  selections and a family-valued profile, and does NOT move an explicit `gpt-6-sol` pin.
- Generator tests: unsorted versions, duplicate id, unknown `defaultFamily`, `defaultEffort` not in levels
  each fail generation.
- Worker post test through the real handler: `model: 'sol'` stores the resolved id + medium; omitted model
  stores the provider default; an explicit older id is honored.
- Buddy Settings render test with a catalog containing gpt-6.10-sol: the option is listed (guards the
  `startsWith` class of bug; the picker has the same test).
- Wire skew: an older client tab and an older addon must not crash on a Family config. Decide between a
  protocol bump (docs/ws-contract-surprises.md, `client/test/protocol-skew.test.ts`) and a tolerant parse.
- Keep the step-0 rule test (medium for every reasoning model) until `defaultEffort` is provider-level.

## 6. Risks and open items

- A Family conversation changes model mid-thread when the catalog moves. Default-mode conversations
  already do this (every default-mode chat moved to 6.1 when 87ea55a landed), so nothing new.
- Verify the Claude CLI accepts `claude-fable-5-1` before giving Fable a versioned id; otherwise keep
  `fable` as the id of its one version.
- Not covered: oompa configs (`codex:gpt-5.3-codex:medium`, `claude:opus`: strings passed through
  agent-cli; making those float means agent-cli resolves families from the same data), the superseded-id
  warning on explicit worker pins, the per-response model stamp, a read-only sweep of Buddy profiles and
  souls that carry literal ids (editing them needs owner approval), a runs transcript read.
