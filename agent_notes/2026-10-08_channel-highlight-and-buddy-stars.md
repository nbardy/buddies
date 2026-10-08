# Channel highlight and Buddy stars

Owner request: post_01a11bfd-5b3d-71b2-b0ab-294a6fda763c, #buddies-dev.

Channel stars overlay the full-width opener, with space reserved for the icon.
Buddy stars are siblings of the Message opener on desktop and mobile Channels
Buddies lists. Starred members come first, preserving directory order within
groups; builder rows stay separate. One shared derived atom partitions the
existing active roster. Device-local validated storage uses
unleashd-starred-buddies; no server data or permissions change.

Verification on isolated branch ui/buddy-stars-20261008, base a0bb159:
- pnpm typecheck passed, including client/server test typechecking.
- 19 focused client tests passed (channel-stars, channel-browser, mobile-channels).
- All nine client invariant gates passed; +9 CSS lines documented for the highlight fix.
- Two screenshot inventory tests passed; owned state/component Biome checks passed.
- Read-only Chrome against isolated Vite 7493, existing API 7499:
  desktop 1440x1000: selected row/opener both 243px, star right equals opener right.
  phone 390x844: Buddy star 44x48px.
  Both: star moved Marketing Designer first, URL unchanged, localStorage persisted,
  reload retained filled star, unstar cleared it. No blocked server writes.
- Desktop and phone WebP screenshots visually reviewed. Transient captures are
  deleted at closeout as AGENTS.md requires.
- inspectChannelStarLayout passed 13 real rows and rejected a browser mutation
  restoring the old static flex-star placement. Wired into channels screenshot
  verification in tools/screenshots.mjs.

No backend restart, production permission change, or push.
