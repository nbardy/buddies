# Launch video pipeline: how it's organized, where renders are slow, and what to change

Marketing Designer, 2026-10-04. Answers the owner's question in #unleashd-2 (handoff thread post_01a10710).

## How the cut is organized
- One Remotion project: `product/releases/launch-2.0/edit/`. The whole video is the `Assembly`
  composition. `SECTIONS` in `edit/src/Assembly.tsx` is a table of 14 rows (scene id, start bar, end bar,
  component), laid on the 128 BPM bar grid of the score. Reordering or dropping a scene means editing a row.
- Each scene is its own component file: `Overload` (open + `BuddiesIntro`), `HomeIntro`, `PostIntroBenefits`,
  `DesignReview`, `ShowWork`, `PickerRefresh`, `Swarm`, `FeatureFlash`, `Close` (Fork / Run / Vim / EndCard).
  Eight scenes also exist as standalone compositions. Finished ones are banked as `clips/NN_*.mp4`, indexed
  in `clips/CLIPS.md`.
- Sound is code: `sound/*.py` synthesizes WAVs (numpy), and cue tables in the scene files place them on frames.
- History is git only: 45 commits under `launch-2.0/`, 35 of them in `edit/src` since 2026-09-26.
  Past full renders `out/launch-v2…v8*.mp4` sit locally, gitignored. There is no ledger mapping
  version → commit → owner verdict, so that mapping lives only in threads.
- Weakness: the final is baked as one 5631-frame render. Any change, even audio-only work if done
  naively, re-renders all 93.85 s.

## Where renders are slow (measured 2026-10-04 22:18, load avg ~30)
`node render.mjs render src/index.ts Assembly … --frames=A-B --muted`, 120 frames each, ~18 s bundling included:

| Frames | Content | Wall time | ≈ fps after bundling |
|---|---|---|---|
| 300–419 | Overload pile-up (pure animation) | 27 s | ~13 |
| 2700–2819 | ShowWork (screen-recording footage) | 101 s | ~1.4 |

Footage frames cost about 9× more than animation frames. The raw recordings are 2974×1882 (or 2750×1882)
60 fps H.264, up to 324 MB (`design-review_D`). Every output frame decodes a near-3K frame, ships it into
headless Chrome, and gets scaled and composited there with software GL (swiftshader). The animation itself is cheap.

Contention made it worse: with ~6 renders running at once (load avg ~240 on 10 cores), the 21:15 full render
hit Remotion's frame-fetch timeout on `2026-09-30_feature_app.mp4` after 32 min. The chain's output filter
(`rg -v …`) hid the error, so it failed silently. `render.mjs` (d1cfd58) now caps renders at 2.

## What would help (ranked)
1. **Footage proxies.** ffmpeg-trim each recording to the range actually used, scaled to 1920 wide, with a short GOP.
   Expected several-× speedup on footage scenes and no fetch timeouts. Keep raw takes for re-cuts.
2. **Per-section render cache.** Render each `SECTIONS` row to `out/sections/<id>@<hash>.mp4`, keyed on the
   hash of its source + assets. Join with ffmpeg concat (`-c copy`, seconds), then mux the one score WAV.
   A one-scene tweak re-renders one scene, and old section renders double as rollback / A-B material.
3. **Loud renders.** No output filters; `set -e`; check that the output exists, is newer than the start, and
   has the expected frame count before muxing.
4. **VERSIONS.md ledger.** Version → commit → what changed → owner verdict → file. Backfill v2–v9 from threads.
5. **One editor per release dir at a time.** Today one session's uncommitted hit experiment sat in the
   tree another session was rendering from. Experiments go in a worktree or a `git archive` export.
