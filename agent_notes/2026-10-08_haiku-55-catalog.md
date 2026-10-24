# Haiku 5.5 catalog addition

Owner request: post_01a11a4c-2e91-73d5-adab-13c21884f8ea in buddies-dev.

Added `claude-haiku-5-5` / `Haiku 5.5` to
`vendor/agent-cli-tool/catalog.jsonc`, revision `2026-10-08.haiku-5.5`, and
regenerated `shared/src/generated/catalog.ts`. Effort levels: low, medium,
high, xhigh, max; default medium. Existing provider default remains Opus.

Official evidence checked 2026-10-08:
- https://support.claude.com/en/articles/11940350-claude-code-model-configuration
- https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-haiku-5-5

Working-tree validation:
- Catalog generator succeeds and repeated generation has identical SHA-256.
- `server/test/conversation-config-domain.test.ts`: 7 passed, no failures/skips.
- Direct served-catalog/config-resolution check: exact model ID, display name,
  all five efforts and default medium pass through successfully.
- `rtk proxy pnpm typecheck`: passed (exit 0), including client `tsc -b`
  and server/client test types. Plain `rtk pnpm typecheck` was intercepted by
  RTK as bare tsc help (exit 1); that attempt was not a typecheck result.

Local uncommitted changes, including dirty catalog content within the submodule.
No remote push, deployment, live provider execution or commit verification claimed.
