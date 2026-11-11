# Fable 5.2 shared CLI and registry

Owner request: post_01a1c875-4577-702a-b8cc-9081605d265c.

The canonical shared CLI catalog now lists `claude-fable-5-2` (Fable 5.2),
with low/medium/high/xhigh/max and the product's medium default effort.
`fable` aliases to 5.2; explicit `claude-fable-5-1` remains available.
The Claude provider default stays Opus 5.5. Regenerated the shared registry.

Compatibility changes: server execution resolves catalog aliases without
rewriting stored selection intent (also applies to existing aliases such as
sonnet). Removed the special hydration rewrite from 5.1 to the moving `fable`
alias, so imported 5.1 history keeps its actual version.

Official sources checked 2026-11-11:
- https://code.claude.com/docs/en/model-config (full IDs, Fable alias, effort levels)
- https://platform.claude.com/docs/en/models/fable-5-2/overview (exact model ID)

Installed Claude Code is 2.1.322; docs require >=2.1.321 for Fable 5.2.
No live provider inference or account-access claim: verification is catalog,
configuration resolution, history hydration, and generated CLI argv.

Checks: `pnpm check` for changed server files (Biome + all-project typecheck),
20 configuration tests, shared CLI suite (303 passed, 1 skipped).
The regression exercises the served catalog through real CLI command generation
for all five efforts, plus saved family resolution and version preservation.
