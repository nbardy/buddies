# Desktop source setup: visible native recovery

Task: task_01a117b8-fee8-742d-a2a4-1eee266b3073. PM review: post_01a117d6-06ef-7318-ac5e-a7e95e8a8e49.

Implementation commits: c1726dd (persisted setup status and native menu/dialog controls), 92a5ea6 (macOS-visible instructions). Final inspected/tested revision: 92a5ea6, which also includes concurrent gitlink correction 961ec3f. Existing client formatting edits were excluded.

Native screenshot review caught Electrobun/macOS omitting the detail field entirely. Critical phase, interruption/retry and ready/reopen instructions now live in the message field. Regression assertions check these instructions in the native message projection. The status helper owns atomic progress writes; the shell reads them, identifies a dead helper as interrupted, and provides Retry, log-folder and Quit to reopen controls. Failed setup waits for explicit Retry; active selection remains intact.

## Verification at the combined revision

Isolated candidate: output/desktop-source-2026-10-08/candidate; tracked source matched 92a5ea6, only generated untracked .hutch directory. pnpm test:desktop passed 5 desktop/env/PATH tests plus 4 managed source/Git tests, no failures/cancellations. pnpm desktop:build --skip-build --stage-only passed staged catalog/client/Buddies write-read smoke. This reused earlier compiled server/client artifacts: these commits change native/helper code, not server/client compilation. Native dev build with BUDDIES_DESKTOP_SKIP_DMG=1 and electrobun 2.0.2 passed. Scoped Biome and git diff --check passed. HEAD grep confirmed status definition and native wiring committed.

Actual native app launched with BUDDIES_DESKTOP_HOME and HOME under output/desktop-source-2026-10-08/ui-preview; port32211, automatic setup disabled. Computer-use accessibility and screenshots verified:
- preparing menu/dialog includes Building the update and continuing to use Buddies;
- a dead-PID status fixture becomes interrupted with Retry;
- clicking Retry actually spawned helper PID38930. A controlled missing source.json in the disposable native preview made it fail code1; metadata was immediately restored. Bundled authenticated provider-catalog still returned HTTP200;
- ready fixture displays revision92a5ea6 and Quit/reopen/data-preservation instructions. Quit to reopen exited preview normally (code0).

Pictures posted for PM are WebP q95 from native screenshots; temporary PNGs were deleted. Preparing/ready states are status fixtures, not evidence of a real clean-Mac update or a verified runtime activated in this preview. The ready fixture was cleared after the test. No Buddy first reply was executed.

An earlier discarded preview selection auto-launched a second instance without test environment; its scoped preview processes were stopped before restarting with explicit isolation and waiting for backend readiness before selecting the app. This may have touched the default desktop app-data directory; no live SQLite was directly opened or edited. CEF uses its existing dev profile despite HOME override.

## Release limits

No new DMG was produced or published. Existing 9360fb4 DMG is unchanged, SHA256 bf61b6df0226c5b2eddf62fe6926983c1b9813772fe690e8c4bc943a5ab2e5e1. It does not contain the subsequent status/gitlink fixes. Separate54b9f1f release lane remains distinct. True clean Mac without Git/Rust/pnpm, installed A-to-B/reopen/data-preservation/first-reply journey and public exact source/submodule availability remain required. Owner A/B decision and launch hold remain; this note closes visible implementation evidence only, subject to PM review.
