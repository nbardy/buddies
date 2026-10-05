# Setup dismissal survives startup

Owner request: #bugfixes post_01a10aaa-d9eb-7335-ab9e-8a259943e024.

Cause: DependenciesPrompt initialized a component-local dismissed flag to false
on each mount. Every page reload displayed Setup even after Continue or Close.

Change: one validated device-local Jotai storage atom and one exported action
in atoms/ui.ts. Continue, Close and Escape persist dismissal synchronously at
initial load, preventing a modal flash on reload. Settings → Setup clears the
flag and reopens the same shared prompt on desktop and mobile. Server startup
dependency probes and first-boot installer markers retain their existing behavior.
The preference belongs to a browser origin; another browser or cleared storage
starts with Setup visible.

Validation: client build (tsc -b + Vite), pnpm typecheck, all nine client gates,
targeted Biome check, real built-app browser regression passed. Browser test
restarts its HTTP fixture server on the same port, reloads without clearing
storage, checks no dialog, reopens via Settings, then verifies Continue and
Escape persistence. Prior layout/copy checks remain covered on phone/desktop.
Inspected output/dependencies-dismissal-2026-10-05/dismissed-after-restart@phone.png
and reopened-from-settings@phone.png. Missing-tool screenshots are fixtures,
not claims about the owner's tools. No live backend restart or agent probe needed.

RTK.md is absent in this checkout. Chronicle recordings were not accessed:
the skill's required Memories precondition is absent in this session.
