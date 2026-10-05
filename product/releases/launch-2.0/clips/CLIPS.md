# Launch 2.0 clips bank

Finished, cut clips ready to drop into the assembly: one `.mp4` per clip, plus a `.jpg`
poster frame. The renders are regenerable and gitignored; this index is the committed record.
Refill the bank with `edit/bank.sh`, after re-rendering whatever changed with
`pnpm run render:<clip>` in `edit/`.

The number prefix is the clip's place in the launch script
(`product/releases/UNLEASHD_2_0_LAUNCH_2026-09-26.md`), so a sorted folder reads in running order.

## In the bank

| Clip | Length | Beat | Shows | Built from | Status |
|---|---|---|---|---|---|
| `01_overload-open` | 18.0 s | 1–5 | Chat windows pile up, hard cut to "AI Overload!", then the calm "Introducing… 2.0", with sound | motion graphic, `edit/src/Overload.tsx` | Draft 2 + sound, marimba locked |
| `02_design-iteration` | 15.35 s | 6 | Workspace-home redesign, then emblems, then the owner types "Great work!" | footage A + B, `edit/src/DesignIteration.tsx` | Rough cut 1, silent |
| `03_design-review` | 11.2 s | 6–7 | The owner asks for screenshots of every view; ~6 min later the Lead posts Mobile, iPad and Desktop threads; hold on the iPad Buddies grid, one quick scroll to an iPad channel, cut | footage D, `edit/src/DesignReview.tsx` | Rough cut 4 (ends on the scroll; owner OK with the rest), silent |
| `04_native-multimedia` | 9.375 s | 6–7 | "Native multimedia" over the owner typing "@Marketing Designer Can you share with me the latest video", cut on the beat to the reply playing the launch video inline, drop on "Code + / Design + / Marketing!" | footage 1 + 2, `edit/src/NativeMultimedia.tsx`, `sound/edm.py` | Rough cut 2, EDM build + drop |
| `09_beat9-harness-and-close` | 7.0 s | 9 | "Multi harness", logos, "Bring your own subscriptions" slides | `beat9/beat9.html` | Motion v2 |
| `09b_multi-harness-picker` | 9.05 s | 9 | The proof after the "Multi harness" slide: @mention the Release Engineer, type the request (6×), open its reply picker, hover Claude → Codex → Cursor → Muse, pick Muse and a thinking level, send; "is replying…" | footage H, `edit/src/MultiHarness.tsx` | Rough cut 1, silent |
| `10_ai-color-palettes` | 12.37 s | benefits (Customizable) | Settings → Color Palette → AI Generate, the prompt typed at 3×, "Let the AI Cook" and the chef at 1×, the wait cut, the Matrix Rain palette lands, Save, the app goes green (Threads → #bugfixes at 2×) | footage `2026-10-05_color-palette_raw.mov`, `edit/trim-palette.sh` (ffmpeg, kept ranges in the script) | Review trim 1, silent |
| `10_ai-color-palettes-4bar` | 7.5 s (450 frames) | benefits → palette, v16 | The same take at exactly 4 bars: navigation 3×, typing 6×, "Let the AI Cook" + chef 1×, Matrix Rain lands + Save 1.4×, green Threads 2× (ends at source 23.5 s, before the thread list scrolls to a message with "fuck" in it); the prompt's "shit" blurred; scaled to the 1458×960 card | `edit/trim-palette-4bar.sh` (its scene, `Palette.tsx`, is deleted; git has it at `4917ae9`) | Was in v16, rolled back 2026-10-06 (owner: "too much") |
| `11_ai-color-themes-short` | 15.0 s (900 frames, 2750×1812) | the AI color themes short | The same take at 8 bars for its own product video: navigation 1.25×, typing 2×, Cook + chef 1×, the wait at 3×, Matrix Rain lands + Save 1×, green Threads 1× (ends at source 23.8 s); "shit" blurred from the moment it is typed until the palette replaces the prompt; full resolution so the camera can zoom on the prompt | `edit/trim-palette-short.sh`, placed by `edit/src/PaletteShort.tsx` | In the short, silent |

## Raw takes, 2026-09-26 (owner's Desktop unless noted)

Renamed copies of the used takes live in `../footage/`, with their timecodes in `../footage/FOOTAGE.md`.

| Take | Length | What it is | Used as |
|---|---|---|---|
| 3.38.07 AM | 12.0 s | #channels-feature: scrolls the redesign request to the emblem request | footage **A**, clip 02 |
| 3.41.00 AM | 21.1 s | #channels-feature: emblem thread, contact sheet, image viewer (a longer take of B) | spare for clip 02 |
| 3.41.29 AM | 19.3 s | Emblem response, then "Great work!" | footage **B**, clip 02 |
| 4.06.39–4.08.52 PM (7 takes) | 4.5–18.4 s | "@Marketing Designer can you share the latest video…", typed; none shows the send | native multimedia, footage 1 (4.08.03) |
| 4.14.27 PM | 19.4 s | Request typing that opens the **per-mention harness / model / thinking picker** (Claude, Codex, Cursor…) around 7–12 s | spare for clip 09b (H is the cleaner take) |
| 4.15.21 PM | 6.7 s | Mention autocomplete (Task list), then a false start | unused |
| 4.15.32 PM | 12.0 s | False start ("Can you post a full s…"), cleared | unused |
| 4.15.51 PM | 27.9 s | The full screenshots request typed, not sent (rehearsal for D) | spare for clip 03 |
| 4.16.28 PM | 7:22 | Screenshots request, sent; ~6.5 min wait; Mobile, iPad and Desktop threads land and are opened | footage **D**, clip 03 |
| 4.26.44 PM (channel upload) | 20.6 s | @mention, typed request, harness / model / thinking picker, send | footage **H**, clip 09b |

## Privacy before publishing

Real channel names, Buddy names, owner messages and a localhost URL containing the workspace
id appear in the raw frames. The cuts blur most of this, but check every frame of a clip
before it goes public.
