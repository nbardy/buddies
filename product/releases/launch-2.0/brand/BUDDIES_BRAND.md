# Buddies brand (draft, 2026-10-03)

The owner is renaming Unleashd to **Buddies** and picked the **Pair** lockup ("This is sweet",
#unleashd-2, thread `post_01a0f851-f4a5-72d4-b351-99ce045fe35f`). Everything below follows
from that pick. The rename itself (repo, package, domain) is not done; see "Open".

## The mark and lockup

- **Mark:** two overlapping circles, violet (left) and teal (right). The overlap is a pale
  periwinkle lens. It stands alone as the app icon, avatar and favicon, and still reads at 16 px.
- **Wordmark:** "Buddies" in title case, Bricolage Grotesque 700, width 92%, optical size 96,
  tracking −2.6%. The word is about 3.01 em wide.
- **Lockup:** mark, then a gap of 0.24 × the mark size, then the word. The mark and the cap
  height are about the same size.
- **Tagline:** "your team of AI agents", lowercase, 500, cream at 62%. Use it in every primary
  lockup: "Buddy" already reads as a coding pet (Claude Code's removed `/buddy`), and the
  tagline says what the Buddies are.

Source: `edit/src/BuddiesLogos.tsx` (`MARK.pair`) and `edit/src/BuddiesKit.tsx` (`Lockup`).

## Palette

| Role | Value |
|---|---|
| Ground (night) | `#0b0a14` |
| Text | cream `#fdf6e3`; quiet text is cream at 62% |
| Accent 1 (left circle) | violet `oklch(0.62 0.2 300)` |
| Accent 2 (right circle) | teal `oklch(0.76 0.12 200)` |
| Glow only | pink `oklch(0.7 0.17 350)`, blue `oklch(0.66 0.15 240)` |
| Lens | `oklch(0.9 0.06 260)` |

The violet, blue and pink match the workspace-home aurora (`client/src/components/buddies/ChannelLanding.css`).

## Type and motion

- **Fonts:** Bricolage Grotesque only. Display lines are 700, width 92%. Text lines are 500–600.
- **Accents:** one or two words per page take violet or teal. Nothing else is coloured.
  The only exception is pink on "Overload.", the one alarm in the video.
- **Small labels:** glass pills, i.e. cream at 7% fill, a 1.5 px cream-at-14% border, a fully
  rounded radius, and a backdrop blur.
- **Motion:** words rise out of a 10 px blur, 60–120 ms apart, with an ease-out cubic over
  0.55 s. The aurora drifts slowly. The marks animate as in the logo reel. The loud colour slabs
  of the Unleashd cut (`blocks.tsx` `Block`) are retired for Buddies.
- **Footage under type:** blur and dim it (`Footage` in the kit). Captions sit top left in a dark
  glass panel. The "N minutes later" chip sits bottom centre, with a clock hand that sweeps once.

## Files

- Video pages and graphics: `edit/src/BuddiesKit.tsx`. Renders come from `edit/src/wordmark-entry.tsx`
  (`KitReel`, `Kit-<page>`, `KitOg` 1200×630, `KitBanner` 1280×320, `KitAvatar` 512×512).
- Icons (in this folder): `buddies-mark.svg` is the bare settled Pair, tightly cropped, with sRGB hex
  for the oklch values. Use it as the favicon, with `buddies-mark-32.png` as the raster fallback.
  `buddies-icon-192.png` / `-512.png` are `KitAvatar` (the mark on night with glow) for app and
  touch icons. The Avatar's mark fills only about half the tile and turns to mush at 16 px, so never
  use it as a favicon.
- Lockup on the web: set the mark box to the word's font size (`width: 1em`), use a gap of `0.24em`,
  and add `font-variation-settings: 'opsz' 96`. The font is variable, and without that setting a
  browser picks the optical size from the px size (about 24 in a nav), which is a plainer cut than
  the wordmark.

## Open

- The end card shows `github.com/nbardy/buddies`, which assumes the repo rename.
- No domain has been bought, and no trademark search has been done.
- The kit pages have not been swapped into `Assembly.tsx` yet.
