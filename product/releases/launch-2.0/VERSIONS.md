# Launch video versions

One row per posted cut: what changed, its source commit, how it was made, and the file. Renders are
gitignored. The files a cut is built from are kept read-only in `renders/<cut>-chain/` (APFS clones of
`edit/out/`), with a `SHA256SUMS` you can check with `shasum -a 256 -c SHA256SUMS`. Earlier cuts
(v2–v9, 2026-09-26 to 10-04) are in the #unleashd-2 threads and `LAUNCH_CUT_PLAN.md`.

| Cut | Posted | Source | What changed | How it was made | File (sha256) |
|---|---|---|---|---|---|
| v10 | 2026-10-05 13:39 | picture `4d7f290`, sound `4af67b0` | Slam "AI Overload" blended with the robot reveal, the Drop launch song, the benefits marimba removed | full render (`render.mjs`, muted video + WAV), mux with `volume=-3.7dB`; details in `agent_notes/2026-10-05_launch-v10-render-provenance.md` | `launch-v10_4af67b0.mp4` (`06cfb007…`) |
| v11 | not posted (step to v12) | `82af5d4` | logo holds 2 bars; swarm right after the home, 4 bars; benefits moved before the Vim line | `edit/stitch-v11.sh`: renders the open+home+swarm, features+subs and benefits; cuts every other section from the v10 picture | `launch-v11.mp4` (`1118a00a…`) |
| v12 | 2026-10-05 14:17 | `9079273` | "Mobile Friendly!" first after the swarm, 2 bars, on footage P | `edit/stitch-v12.sh`: renders the mobile scene and the sound; cuts every other section from v11 | `launch-v12.mp4` (`92804ffb…`) |
| v13 | 2026-10-05 14:50 | `432e886` | "Open Source" shimmers on the Vim card (owner pick); end card says github.com/nbardy/buddies | `edit/stitch-v13.sh`: renders vim+end; cuts frames 0–4965 from v12; v12's sound | `launch-v13.mp4` (`e98e9a83…`) |
| v14 | 2026-10-05 19:30 | `235fc41` | the emblem shots cut from "They show their work" (8 bars → 2); everything after moves up 6 bars; 85.0 s | `edit/stitch-v14.sh`: no picture render; v13 frames 0–2828 + 3504–5775, the song re-timed | `launch-v14.mp4` (`2817b046…`) |

## Reproducing v14

`renders/v14-chain/` holds `launch-v13.mp4` (its source picture), `v14.wav` and `launch-v14.mp4`
(`SHA256SUMS`). To re-make it: put `launch-v13.mp4` at `renders/v13-chain/`, check out `235fc41` and run
`stitch-v14.sh`. Its one join (v14 frame 2829 = v13 frame 3504) was checked against the source frames:
the exact frame wins (74 dB, against 18 dB for its neighbour).

**X/Twitter upload:** `launch-v14-x.mp4` (`2304347a…`, also in the chain) is v14 with the settled Vim
"Open Source" card (v14 frame 4455, the site poster's image) as its first 2 frames, so X's preview is
that card, not the dark opening; the sound is delayed 2 frames to keep sync. Made by
`edit/x-cover.sh out/launch-v14.mp4 4455 out/launch-v14-x.mp4`.

## Reproducing v13

`renders/v13-chain/` holds the v12 chain plus `v13-vimend.video.mp4` (`eb22ac9e…`) and
`launch-v13.mp4`. To re-make it: copy the chain into `edit/out/`, check out `432e886` and run
`stitch-v13.sh`. Its join (v12 frame 4964 | new frame 4966) was checked by eye: the benefits frame
is unchanged and the Vim card starts on black. The site poster is `brand/site-poster-v13.jpg`,
frame 5130 (85.5 s).

## Reproducing v12

v12 is a stitch of a stitch, so it depends on files that are not in git: v11, which in turn depends on
the v10 picture. All of them are in `renders/v12-chain/` (11 files, `SHA256SUMS`):

| File | Made by | Used by |
|---|---|---|
| `launch-v10.video.mp4` (`7234dad9…`) | v10 full picture render | `stitch-v11.sh` |
| `v11-a/b/c.video.mp4`, `v11.wav` | `stitch-v11.sh` at `82af5d4` | `stitch-v11.sh` mux |
| `launch-v11.mp4` (`1118a00a…`) | `stitch-v11.sh` | `stitch-v12.sh` |
| `v12-mobile.video.mp4`, `v12.wav` | `stitch-v12.sh` at `9079273` | `stitch-v12.sh` mux |
| `launch-v12.mp4` (`92804ffb…`) | `stitch-v12.sh` | the posted cut |

The exact cut is the kept `launch-v12.mp4`. To re-make it: copy the chain's inputs back into `edit/out/`,
check out `9079273` and run `stitch-v12.sh`, which re-renders only the mobile scene and the sound.
To rebuild without the chain: a full render at `9079273` (`node render.mjs render src/index.ts Assembly`,
as for v10) should give the same picture in a different encode (a 30-minute render). That has not been
checked end to end; spot checks of reused sections against fresh stills matched at 37–50 dB.
The stitch joins were checked against their source frames: each join's exact frame wins over its
neighbours (52–88 dB against 9–18 dB).
