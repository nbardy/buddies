# Buddies public rename: completion pass (Release Engineer, 2026-10-05)

Answers Delivery PM review `agent_notes/2026-10-05_buddies-public-rename-review.md`.

## Shipped
- `78baa89` (pushed to origin/main; range 54f8c9a..78baa89 also carried 0259383 Setup
  dismissal and 9079273 launch video v12 source). Live site now serves 79b4ba4, a concurrent
  session's commit on top (drops the Oompa button, adds `html { overflow-x: hidden }` on phones).
- client/index.html title + boot diagnostics, PWA manifest name/short_name/description → Buddies.
- README: remaining prose renamed; "Names: Buddies and unleashd" section records the decision:
  npm package stays `unleashd` (bins `buddies` + `unleashd`); `@unleashd/*`, `UNLEASHD_*`,
  `~/.agent-viewer`, `unleashd.localhost`, `crates/unleashd-*` kept on purpose.
- OpenCode qualified read-only in README pitch, site subtitle, card, og/twitter descriptions.
- Phone overflow root cause: `.title-glow` (absolute copy of the h1) kept `clamp(5rem,…)` = 80px
  on phones because the 768px rule shrank only `h1`. Bisected by hiding elements: hiding
  `.title-glow` alone took scrollWidth 400 → 390. Fix: one `--title-size` on `.title-container`.

## Verification
- Clean clone of 78baa89 under a temp HOME (real pnpm store/cargo/addon cache only):
  `pnpm install && pnpm build` OK; `PORT=7591 pnpm start` → "Initial load complete", `/` title
  Buddies, manifest Buddies. `pnpm link --global` (temp PNPM_HOME) created `buddies` and
  `unleashd`; `buddies` from /tmp started the server on 7592 and served the Buddies title.
- Clean clone: `pnpm typecheck` pass; `pnpm test:client` 221/223. Both failures pre-exist at
  54f8c9a: channel-restored "the Task filter shows one Task…", channel-dm "only a harness
  failure offers a retry…".
- Live https://nbardy.github.io/buddies/ (Last-Modified 06:19:19 GMT): phone 390 →
  scrollWidth 390, h1 = glow = 40px; desktop 1440 → 1440, 128px; no Oompa link.
- Screenshots: output/screenshots/release-rename-20261005/.
- Fresh isolated app showed Claude "Login required" only because the temp HOME has no
  credentials; first-agent-reply is NOT verified. The install workspace is still named "unleashd".

## Open / owners
- npm publish: workflow 37269558549 blocked by GitHub billing lock. Owner fixes billing → rerun.
- Video + hero: Designer (v12 in progress). Handoff DM sent; site still serves the 84 s cut.
- Install workspace name/copy in server/src/upstream/unleashd-home.ts + fresh-workspace channel:
  Product Lead task buddy_project_85f41c44 (comment posted), first-run todo_4784a23d.
- Brand: site still uses Slate/grid/rainbow tagline/blue+orange accents and has no Pair mark;
  BUDDIES_BRAND.md specifies #0b0a14 night, cream text, violet+teal on 1–2 words, glass pills.
  Restyle proposed, not done; needs Designer sign-off on the mark asset.

## Brand restyle (da224ee, verified 2026-10-05 06:3x)
- da224ee (owner chat de25aaa1 under this Buddy identity) restyles docs/ to BUDDIES_BRAND.md: night
  #0b0a14, cream text, Pair mark as inline SVG (settled cx 37/63 r 28 + lens clip), glass pills,
  teal "too." / violet "team." as the only accents, OG = kit-Og.png copy. Local only; not pushed.
- Verified from `git archive da224ee docs` (not the working tree) via tools/lib/headless-chrome.mjs
  (/tmp/site-shots.mjs): phone 390@2x scrollWidth 390, desktop 1440 → 1440, body bg rgb(11,10,20),
  color rgb(253,246,227), Bricolage loaded, 5 Pair marks, no element past the viewport.
  Shots: output/screenshots/site-restyle-da224ee/{phone,desktop}-{fold,full}.png.
- Gaps: favicon docs/icon-192.png is the old "Save prompt" brain, not the Pair; video still the
  84 s unleashd-2.mp4 and hero.png is wave_sim (Designer's swap). Designer asked to confirm assets.
