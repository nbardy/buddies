# SoL-Pi harness integration — route discovery

Owner request: general thread `post_01a13168-0ebc-71e1-8dca-cd1154eea513`.
Task: `task_01a1316e-3ff5-7246-9505-982b9bc3deff`.

## Outcome and missing input

Adding a SoL-Pi harness is feasible through the existing CLI subprocess boundary.
This is an investigation, not an implemented or deployed selector. The missing
input is the exact Muse Wonder model/API route and the intended Pi authentication
routes. Native Claude/Codex/Muse CLI availability does not prove Pi credentials or
access to the same models. Do not silently substitute Spark, Opus 5, or GPT-5.6.

## Evidence

- Main checkout observed at `a1cd28aafd2c4ff7d47d0bcc15e3448deb44763a`;
  harness submodule at `6d45ede10f6468b5991f41ef4d6fc5d7708cb2b4`.
  Both carry pre-existing dirty files; no existing source was edited.
- Installed the documented tested Pi release 0.85.1 under
  `/tmp/unleashd-sol-pi-investigation-2026-10-13` using npm with
  `--ignore-scripts`, without a global installation or writing owner settings.
- An isolated `PI_CODING_AGENT_DIR` and `--list-models` returned
  `No models available` / login guidance, exit 0. This was an unauthenticated
  isolated probe, not a test of the owner's account or production availability.
- Searched every shipped Pi provider data JSON for exact IDs
  `claude-opus-5-5` and `gpt-6.1-sol`: neither is in this package's baseline
  catalogs. Searched `muse-wonder` as a candidate only: no match. That spelling
  is not established as Wonder's real ID. Configured dynamic/custom routes
  may provide newer models; the baseline absence does not prove unavailability.
- Unleashd's current working catalog has `claude-opus-5-5`, `gpt-6.1-sol`,
  and Muse Spark models; it has no Muse Wonder entry.

## Integration shape

Reuse `executeCommand` and the existing journal/process lifecycle. A `sol-pi`
harness invokes unmodified Pi with SoL-Pi loaded as an extension; do not fork Pi,
wrap the native Claude/Codex CLIs under the SoL-Pi label, or create another Buddy
runner/controller/API. Existing grants, queues, watchdog deadlines and adoption
remain authoritative.

1. In `vendor/agent-cli-tool`, add the harness configuration and normalized JSON
   parser. Pi `--mode json` accepts piped prompt input and exits after a prompt;
   this matches our one-process-per-turn contract. Its initial session header
   carries `id`/`cwd`; subsequent `--session <id|path>` resumes the saved session.
   `--fork <id|path>` is available for existing merge-review forking.
2. Normalize `message_update.assistantMessageEvent.text_delta` exactly once;
   final `message_end` must not duplicate streamed prose. Map tool starts,
   results, errors and usage to existing unified events. An internal Pi
   `turn_end` can precede additional tools/model turns; completion must reflect
   the full agent settling, including SoL-Pi compaction continuations.
3. Target Pi 1.x's native MCP/codemode path if the SoL-Pi compatibility check
   passes. The earlier claim that Pi lacks built-in MCP applied to the tested
   0.85.1 release, not current Pi 1.0. Encode existing canonical `McpServerSpec`
   into Pi's configuration; use its native stdio/streamable-HTTP client and
   codemode tool discovery/calls. Do not build a second MCP client by default.
   Required servers must initialize AND list/register tools before the first
   provider request. Native MCP configuration alone does not establish this:
   current Pi docs describe background connections and skipped invalid entries.
   Prove fail-closed behavior with a real Pi process and a local MCP server
   before advertising `supportsRequiredMcp`. Preserve per-turn bearers and
   revocation; credentials belong in environment/private temporary files.
4. Add the native session-tree parser/discovery to `unleashd-ingest`, including
   the active branch, ordered prose/tool parts, identity markers, compaction
   and usage. Reuse the existing read driver and write/index path. No TS
   parallel transcript store or conversion into another provider's format.
5. Add the provider identity/catalog data and regenerate the shared catalog.
   Existing selector consumers read that catalog. Provider-prefixed Pi model
   IDs distinguish the model route from the harness. Effort is passed verbatim
   using Pi's supported values, with medium as product default.
6. Pin a compatible SoL-Pi revision/Pi release pair and verify upstream checks,
   package registration and effective configuration. All four mechanisms are
   disabled by default. The reducer uses a separately configured model route;
   choose it explicitly once usable credentials/model routes are known.

## Owner correction: Pi 1.0 codemode

Owner supplied https://lucumr.pocoo.org/2026/10/6/codemode/ after the initial
0.85.1 investigation. The article reports native MCP through codemode in Pi 1.0;
current upstream `packages/coding-agent/docs/mcp.md` confirms stdio and
streamable-HTTP support, environment-expanded bearer headers, and default
codemode exposure. Codemode lets the model discover tools and compose calls in
JavaScript, retaining/filtering intermediate results before returning output.

Implementation ownership: invocation, MCP encoding, live event parsing and
session resume are shared `agent-cli-tool` work. Saved history remains the
existing Rust ingest authority; selector identities/models remain catalog data.
No new Buddy API or runtime is needed for that split.

SoL-Pi's current compatibility doc still names 0.85.1 and 0.84.2 as tested;
its package pins 0.85.1 development dependencies. This is not proof Pi 1.x is
incompatible, but Pi 1.x compatibility needs a real check before combining
the new MCP implementation with all four SoL mechanisms. Model routing is
separate from that offline compatibility work.

## Pi 1.x candidate found and checked

Owner prefers the recent SoL-Pi work plus codemode. GitHub issue/PR inspection
found https://github.com/NVlabs/SoL-Pi/pull/105, opened October 10, 2026,
`xiaofuce/SoL-Pi:pi-1.1.0-compat`, exact head
`aed9f1362beb5ce3f4b87d79e7320329c6a39d75`. GitHub API confirms it is
open/unmerged; issue comments, review comments and reviews are empty.
The author's PR body reports Windows/live verification; that is the author's
evidence, not independent proof. Issue #94 documents the Pi-1.x bug this fixes:
failed fused validation commands could be labelled successful because Pi now
returns `isError` rather than throwing. The PR also adjusts the tool context
type and pins the four Pi development packages to 1.1.0.

Independent local check in `/tmp/unleashd-sol-pi-1x-2026-10-13`, with Node
24.3.0 / npm 11.4.2 and a clean exact-commit checkout:

- `npm ci --ignore-scripts --no-audit --no-fund`: pass.
- `npm run check`: pass (typecheck, 21 test files / **195 tests**, package
  dry-run inspection). This includes the all-mechanisms and real local
  AgentSession/compaction integration tests with the deterministic faux model.
- `node scripts/check-pi-compat.mjs`: pass.
- Installed package metadata: Pi coding agent **1.1.0**. Its shipped MCP docs
  confirm native HTTP/stdio and codemode support.
- `npm audit --audit-level=high`: **fail**, exit 1: two moderate findings in
  Vitest/@vitest/mocker, one high finding in source-map-js. No audit fix was
  applied; source and lockfile stay exactly at the candidate commit.
- `git status --porcelain`: empty after checks.

The source checks establish a useful Pi-1.x candidate, not a completed
installation. The failed audit is retained; the clone's `agents-install.md`
requires stopping on a failed validation command, so no further installation
or owner configuration changes were made. There is no native-MCP round-trip,
required-MCP failure test, Unleashd adapter, or live requested-model result yet.
Preferred integration candidate is now this Pi 1.1.0 branch with native
MCP/codemode; 0.85.1 is historical investigation evidence only. Resolve the
dependency audit gate in a reproducible candidate before a successful-install
claim. Model route clarification still applies to live checks.

## Acceptance checks

- Real process boundary: fresh turn, resumed turn, streaming/tool history with
  no duplication, provider error, explicit cancellation, backend exit/adoption.
- Required MCP initialize/list-tools failure: zero provider requests; success:
  real tool round trip through the existing turn grant, revoked on settle.
- Temp-store Rust ingest test: session branches, appended history, restart
  recovery, text/tool order, model/usage/context/identity preserved.
- Live answer and tool round trip for all three exact models. No success claim
  from argv construction, catalog inclusion, or synthetic model responses alone.
- Exact committed source typecheck/invariants and desktop/phone selector pictures.
- Token audit before/after a turn-context change; no savings claim from upstream
  benchmarks without a measured Unleashd workload.
- Submodule commit first; publish its branch before an outer pointer bump. Never
  push main or claim deployment without the owner's authorization.

## Primary sources checked

- https://github.com/NVlabs/SoL-Pi
- https://github.com/NVlabs/SoL-Pi/blob/main/agents-install.md
- https://github.com/NVlabs/SoL-Pi/blob/main/docs/compatibility.md
- https://github.com/NVlabs/SoL-Pi/pull/105
- https://github.com/NVlabs/SoL-Pi/issues/94
- https://lucumr.pocoo.org/2026/10/6/codemode/
- https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/mcp.md
- https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/README.md
- https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/docs/json.md
- https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/docs/providers.md
- https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/docs/models.md
- https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/docs/custom-provider.md

Pi's provider docs say Anthropic subscription use in third-party harnesses draws
from extra usage billed per token. Existing Claude Code plan usage must not be
presented as equivalent billing for this new harness.
