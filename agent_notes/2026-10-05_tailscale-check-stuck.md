# Tailscale setup waiting state

Owner report: #bugfixes post_01a10ca4-e2a5-7502-8352-031d2468a666.

The attached screenshot shows `Looking for Tailscale…` and `Could not load: HTTP 404`
together. Authenticated GET /api/mobile-access returned 404 both directly on
127.0.0.1:7499 and through unleashd.localhost. The running backend uses this
checkout's server/src/server.ts, but the route in current source is not loaded
in that process. A final authenticated check still returned 404.

Commit 3b19e35 corrects the client: failed reads no longer render the progress
label/body; 404 explains that the running backend lacks the check; a dedicated
retry button refreshes the same keyed resource. Existing polling continues to
recover automatically when the route becomes available. No backend restart or
push was performed.

Verification:
- Client build and full pnpm typecheck passed.
- Five mobile-access server tests and the dependency-card client test passed.
- All nine client invariant gates, scoped Biome and diff checks passed.
- New browser guard tools/mobile-access-ui.test.mjs passed: 404 -> settled
  failure without loading text -> button retry -> actionable Tailscale result.
- Screenshots reviewed: output/tailscale-check-2026-10-05/failed@desktop.png
  and recovered@desktop.png (fixture API, not a live Tailscale result).
- Checked both changed file blobs equal HEAD after commit, and confirmed HEAD
  contains both the route registration and its definition.

The broader pre-existing tools/dependencies-layout.test.mjs failed on its
Connect-from-rail scroll geometry assertion before reaching the added probe.
Restored that file to its unchanged HEAD content and kept this regression in a
focused browser test. Do not report the broader layout suite as passing.

Remaining runtime issue: the current backend must reload to serve the existing
route. A UI retry cannot create an endpoint in an old process. The dev watcher
normally waits for active operations to finish before reloading.
