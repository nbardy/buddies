# Phone development startup investigation

The owner reported the Tailscale URL stalled at the inline “Buddies is loading slowly” message.
The initial workaround pointed HTTPS at port 7499's built client. That did not diagnose the dev path;
the owner requested investigation and restoration of development behavior.

## Evidence

- A temporary loopback timing proxy forwarded the same HTTPS URL to Vite on 7489.
  Phone requests reached Vite; initial script responses were ready in 1–8 ms. The phone
  requested the app entry about 30 seconds after the initial development scripts.
  At this boundary `finish` means handed to Tailscale, not received by Safari.
- Vite's JavaScript responses had no Content-Encoding despite Accept-Encoding: gzip.
  A normal phone-width load fetched roughly 4 MB across 138 requests.
- A real-Vite integration test failed before the fix: Content-Encoding was absent.
- Added compression after the development auth gate. API routes are excluded using
  originalUrl, since mounted Connect middleware can shorten url; backend API streaming
  retains its existing compression authority.
- The live Vite client script decreased from 180,258 bytes to 37,332 bytes on the wire.
- A cold-browser comparison at 550 ms latency and 250,000 bytes/s showed the app rendered
  by the 21-second sample before and the 16-second sample after. Bytes received by those
  samples fell from 3,526,579 to 1,100,873. These are sampled first-render measurements,
  not precise LCP measurements or the total bytes of a fully settled page.
- No JavaScript exceptions occurred in either throttled load. The actual phone retry of
  the final compression change is still unconfirmed.

## Validation and runtime state

- All 17 tests in pnpm test:dev-supervisor passed, including the new real-Vite boundary
  covering gzip round-trip equality, auth before compression, unbuffered API events,
  and HMR WebSocket connection.
- Client tsc -b and scoped Biome passed.
- pnpm typecheck stopped at the pre-existing Buddy line ratchet: 14,363 > 12,487;
  it did not proceed to TypeScript. No ratchet was changed for this fix.
- The current HTTPS host is restored directly to http://127.0.0.1:7489. The diagnostic
  proxy was stopped. No backend or Buddy processes were restarted for this change.
- Timing captures: output/phone-dev-load-2026-10-21/{before,after}.json (gitignored).
- Changes are local working-tree changes, not a verified commit. Other sessions' dirty
  files were preserved.

Tailscale's DNS warning while Mullvad was active remains a separate observation; this
investigation did not establish Mullvad as the cause or change its settings. Switching
between built and dev clients on the same origin also produced transient missing-chunk
and MIME errors in an already-open tab; those are distinct from the original startup delay.

## Owner's final preference: built mobile client

The owner subsequently chose the compressed production build for mobile, with Vite
remaining the desktop development surface. The current Tailscale HTTPS handler now
proxies directly to 7499. Mobile-access discovery recommends the backend's own port,
and pnpm dev now builds client/dist after the shared compilers finish and before
starting HTTP. Standalone dev-server also builds the client (the existing tests-only
UNLEASHD_DEV_PREBUILT path remains prebuilt). Rebuild manually with pnpm --dir client
build to publish frontend edits without restarting the backend.

The reported ~19.2k-line/531-file change list included pre-existing notes and audit
artifacts. Added ignore rules for raw agent_notes JSON, PNG, WebP, TXT and SHA256 output;
bytes stay in place and Markdown findings/reproduction scripts stay visible. No prior
source edits were discarded. This removes 380 raw files from review.

Final working-tree validation: all 18 dev-runtime tests, all 8 mobile-access/static-client
tests, client tsc -b, server typecheck, scoped Biome and diff whitespace checks passed.
Backend mobile-access now reports ready with the 7499 Serve target; the built assets
are gzip-encoded and the phone-width browser renders without a boot diagnostic. The
repository-wide line ratchet remains a separate pre-existing failure.
