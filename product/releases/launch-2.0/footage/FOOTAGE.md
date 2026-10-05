# Launch 2.0 footage — raw owner recordings

Raw screen recordings, unedited. Do not overwrite; cuts go in `../edit/`.
Both: 2974×1882, 60 fps, H.264, no audio track needed. Recorded 2026-09-26 ~03:38–03:41
from the running app, #channels-feature thread "new home screen for /"
(post_2352edd0-745a-48ba-8868-78ab12235db5). Code state: commits 6d04860, 89b27ad, c5e0ded.

Action is all in the **thread pane** (right ~28% of the frame). The channel list and
main channel column are static background.

## A — `2026-09-26_design-iteration_A_scroll-request-to-redesign.mov` (12.0 s)

Role: the "before" — scrolling up through the design iteration. Owner: **clip this one**.

| Time | Thread pane shows |
|---|---|
| 0–3 s | Owner asks for icons on most-recent + "do a design pass, grok was sloppy"; Lead replies "On it. Three changes" |
| 3–5 s | "`/` is redesigned" post: Icons for most recent, No conversations sidebar, Design pass list |
| 5–8 s | The three home screenshots (desktop, New workspace form, phone) scroll past |
| 8–12 s | Owner's emblem request ("invert… mostly dark faded background… strong in centre") and the Lead's plan |

Contact sheet (1 frame/s, thread pane only): `A_thread-pane_1fps.png`

## B — `2026-09-26_design-iteration_B_emblem-response-great-work.mov` (19.3 s)

Role: the "after" — the final design lands. Owner: **shows the response**.

| Time | Thread pane shows |
|---|---|
| 0–2 s | Tail of the redesign screenshots |
| 2–6 s | "Workspaces now have their own emblem" post: Dark ground / Strong in the centre / Kernel carries identity |
| 6–9 s | Emblem contact sheet (every workspace at 88/44/32 px) |
| ~9–10 s | Contact sheet opened in the image viewer (full frame) |
| 11–14 s | Home desktop + phone screenshots, "Known rough edges" paragraph |
| 14–17 s | Owner types "Great work!" in the reply box |
| 17–19 s | Reply posted |

Contact sheet: `B_thread-pane_1fps.png`

## Edit intent (owner, 2026-09-26)

- Clip A; B shows the response and the final design.
- While scrolling: blur everything outside the thread pane, gentle zoom into the pane.
- Not started — owner said "don't do the video yet".

## Privacy check before publishing

The left sidebar shows real channel names and Buddy names; the main column shows real
owner messages. Blurred background mostly covers this, but check every frame of the
final cut before anything goes public.

## D — `2026-09-26_design-review_D_post-screenshots-request.mov` (7:22)

Role: the **Design Review** example. The owner asks the Product Development Lead to post
screenshots of every product view; it posts Mobile / iPad / Desktop threads of live captures.
Recorded 2026-09-26 16:16 (Desktop original: `Screen Recording 2026-09-26 at 4.16.28 PM.mov`),
#bugfixes. Same 2974×1882 @ 60 fps layout; the thread pane (x 2156–2974) opens at ~4 s.

| Time | Shows |
|---|---|
| 0.8–2 s | Request appears in the composer: "@Product Development Lead Can you post a set of screenshots for all product views to this channel and do a thread for mobile, ipad and desktop" |
| 3.6 s | Sent; thread pane opens (loading 3.8 s), "Product Development Lead is replying…" |
| 5–393 s | **Dead wait** (~6.5 min, nothing moves) |
| ~393.4 s | "On it. I've captured all 21 views… Now I'm checking them before I post the three threads" lands in the pane |
| 396.1 s | Three announcement posts land in the channel: Mobile (390×844), iPad, Desktop (1440×900) |
| 426.3 s | Owner clicks the iPad "4 replies"; pane loads until ~430 s |
| 430–435.8 s | iPad thread: portrait then landscape screenshots scroll by |
| 436–438.4 s | Back to thread root, Desktop thread loading |
| 438.5–442 s | Desktop thread: screenshots (buddies grid, worker detail, analytics) scroll by |

Cut: `../edit/src/DesignReview.tsx`. The main column shows a localhost URL containing the
workspace id and real owner messages in #bugfixes; the cut crops/blurs most of it, but check
before publishing.

## Native multimedia (2026-09-26 afternoon)

Two sources, both 2974×1882 @ 60 fps. They're gitignored like the other recordings.

- **1** `2026-09-26_native-multimedia_1_owner-asks-for-latest-video.mov` (18.4 s). This is the owner's
  take from 4:08:03 PM (Desktop). There are seven takes from 4:06–4:08 PM; this is the longest. The owner types
  "@Marketing Designer Can you share with me the latest video, and let me know which" and then
  clears it. None of the takes shows a send. The mention menu is open at 1.0–2.5 s, "latest video" is complete at
  9.4 s, and there are pauses at 9.5–11 s and 11.5–13.3 s. The file the owner attached in the channel
  (3:41:00 AM) is the older emblem-thread take, not this one.
- **2** `2026-09-26_native-multimedia_2_reply-plays-video-inline.mp4` (10 s). This is our capture of the
  real thread (post_649c1cdf…), made in the running app at 16:35: the owner's post, the reply,
  and rough assembly 1 playing inline from 2.6 s. Re-shoot:
  `node product/releases/launch-2.0/capture/record-thread.mjs --out /tmp/cap --workspace
  project_26fce156-5c5d-4dd9-a9d6-4b527a50af3c --channel list_032cedcb-55a1-44b2-a625-5ff70fb4e616
  --thread post_649c1cdf-b134-4860-bf34-50db10045f86 --seconds 10`, then
  `ffmpeg -framerate 60 -i /tmp/cap/f%05d.jpg -c:v libx264 -crf 12 -pix_fmt yuv420p <name>.mp4`.

Privacy: for about 0.7 s the cut opens on the full frame, with the sidebar and the mention menu (Task titles) unblurred
while the blur eases in.

## H — `2026-09-26_multi-harness_H_pick-harness-in-composer.mov` (20.6 s)

Role: the **multi harness** proof for beat 9. The owner uploaded it to #unleashd-2 (post_2cef572b…);
the Desktop original is `Screen Recording 2026-09-26 at 4.26.44 PM.mov`. Recorded in #releases.
The layout is the usual 2974×1882 @ 60 fps; the composer spans x 811–2944, y 1690–1862, and the
picker opens above it (y ~1070–1678).

| Time | Shows |
|---|---|
| 0–1 s | Empty composer |
| 1.0–2.4 s | "@buddies" mention menu (Buddies and Task titles), Buddies Release Engineer picked |
| 2.6–11.8 s | "Can we push a release to github and npm" typed; the reply chip reads "Claude Opus 5.5" |
| 11.8–12.2 s | Click the reply chip; the picker opens (Harness / Model / Thinking Level) |
| 13.0 / 13.4 / 13.8 s | Hover Codex, Cursor, Muse |
| 14.5 s | Muse picked; Model row switches to Muse Spark models |
| 15–16.6 s | Thinking level: hover "No reasoning flag", then pick medium |
| 17.0–17.4 s | Done; the chip reads "Muse Spark 1.3 Contributor" |
| 18.6 s | Send |
| 19.0–19.8 s | The post lands in #releases; the thread pane opens and the column reflows |
| 20.0 s | "Buddies Release Engineer is replying…" |

Cut: `../edit/src/MultiHarness.tsx`. Privacy: the 0.1–0.8 s full-frame ease shows the sidebar
(channel and Buddy names) and a terminal strip on the far left, and the mention menu shows Task titles.

## P — `2026-09-28_mobile_P_art-direction-thread-scroll.mp4` (13.0 s)

Role: the **Mobile Friendly!** flash in beat 7 (`../edit/src/FeatureFlash.tsx`). The owner uploaded it
to #unleashd-2 (post_01a0e6cc…), an iPhone recording at 2:54 PM on 2026-09-28, 1180×2556 @ 60 fps.
The owner art-directs Art Lead's painting sheets in a thread on the phone.

| Time | Shows |
|---|---|
| 0–2.4 s | Held on "This one is quiet nice / The figures suck" |
| 2.4–7.5 s | Scroll through Art Lead's round-2 notes to "wai when i said figures suck", the figures sheet, "I really like this one" and the fields sheets |
| 7.5–12 s | Held on "breaking waves got much better…"; a text selection flickers at ~9 s |
| 12–13 s | Control Center (stopping the recording): never use |

Cut: `2026-09-26_feature_phone.mp4` (the name `FeatureFlash.tsx` expects) = 2.4–7.5 s at 3.6×, which is
1.417 s, with the status bar cropped (top 140 px: carrier name and the recording pill):
`ffmpeg -ss 2.4 -t 5.1 -i <P> -an -vf "crop=1180:2416:0:140,setpts=PTS/3.6,fps=60" -c:v libx264 -crf 14 -pix_fmt yuv420p 2026-09-26_feature_phone.mp4`.
Privacy: only Art Lead's name and painting feedback are visible, with no sidebar or workspace names.

## App — `2026-09-30_feature_app.mp4` (2.2 s)

Role: **Run it on your computer.** (`../edit/src/Close.tsx`, `Run`). Our capture, 2026-09-30 at
1b6952b, from the running app at `localhost:7489` with `../capture/record-page.mjs`
(read-only: no writes blocked, no WS frames sent), 2974×1882 @ 60 fps, a held frame of #unleashd-2:

`node product/releases/launch-2.0/capture/record-page.mjs --out /tmp/app-cap --path '/buddies/workspaces/project_26fce156-5c5d-4dd9-a9d6-4b527a50af3c/channels?channel=list_032cedcb-55a1-44b2-a625-5ff70fb4e616' --seconds 2.2 --hold 2.2 --freeze '.sidebar' --ready "document.querySelectorAll('img,video').length>2"`

Privacy: the sidebar shows the unleashd workspace's channel and Buddy names; the channel shows the
owner's launch-video posts (including the Vim line). Nothing from other workspaces.

## GitHub — `2026-09-30_github_repo.png` (still)

Role: **Fork it.** (`Close.tsx`, `Fork`). `github.com/nbardy/unleashd` logged out, dark mode,
1487×941 @ 2×, captured 2026-09-30 with headless Chrome `--screenshot --force-dark-mode`. Nothing
was forked; the click is drawn. Re-capture before publishing: the page shows the repo's About text
("A local, git-worktree multi-agent swarm orchestrator…") and the latest commit's CI status.

## Swarm — `2026-09-30_swarm_two-agents-replying.mov` (9.8 s) → `2026-09-30_swarm_agents.mp4`

Role: **Multi-agent swarms** (`../edit/src/Swarm.tsx`), replacing the old swarm screenshot (the previous
product). The owner's screen recording, 2026-09-30 03:57 +08 (embedded 19:57:48 UTC), 2828×1882 @ 60 fps,
in #iceblade of the wave_sim workspace: they @-mention "Wave_sim CEO" and "Wave Simulation Lead" in a
thread; the footer reads "…are replying…" and the Wave Simulation Lead's reply lands at ~5.9 s. The
sidebar shows each Buddy's background-worker count (3, 2, 1, 1). Mostly still.

Prepared copy (used by the edit): `ffmpeg -i <take> -an -vf "crop=2828:1758:0:124,scale=2974:1882,fps=60" -c:v libx264 -crf 14 -pix_fmt yuv420p 2026-09-30_swarm_agents.mp4`.
The crop removes the browser's "ChatGPT started debugging this browser" bar; the scale is card.tsx's
source size (a 1.8% aspect change).
Privacy: workspace name (wave_sim), channel #iceblade, Buddy names and a long thread of project text
are in the frame; the cut shows only the thread pane and the sidebar's worker column, on a blurred backdrop.

## 2026-10-03_home_final.png (home and benefits scenes)

The workspace home the owner dialed in, posted in #unleashd-2 on 2026-10-03 ("that is the final home
image we dialed in"). 2804×1874 PNG, the unleashd workspace. Replaces 2026-10-02_home_new.png.
Privacy: the sidebar (workspace name "unleashd", channel and Buddy names) is blurred in both scenes.
Still readable in the main area before the home scene softens: six task titles (one says "First-run
unleashd workspace") and two "Waiting on you" rows, which include an automation id.

## AI Color Palettes — `2026-10-05_color-palette_raw.mov` (29.7 s) → `2026-10-05_color-palette.mp4`

Role: **AI Color Palettes** (proof for "Customizable"). The owner's screen recording, 2026-10-05 4.28.50 PM,
posted in the final-video thread (post_01a10b2f-acd2-7205-8035-123a78fcb2a6), 2750×1812 @ 60 fps, no audio.
The raw file is an APFS clone of the upload (sha256 `b5afca98…`), never edited.
Timeline (source s): gear 1.3, Color Palette 2.5, dialog 2.75–3.3, AI Generate 4.25–4.9, typing 5.0–12.2,
"Let the AI Cook" 12.4, chef cooks 13.6–20.3 (the wait), Matrix Rain palette lands ~20.4, Save 22.2–22.3,
the app turns green and the owner tours Threads, #bugfixes, #case-studies, #channels-feature to 29.7.
The `.mp4` is scaled to card.tsx's 2974×1882 (scale 1.0815, crop 39 px top and bottom), crf 12, for a Remotion scene.
Review cut: `../edit/trim-palette.sh` → `../clips/10_ai-color-palettes.mp4`.
Privacy: the typed prompt reads "Let's make this shit go matrix style"; the sidebar shows real channel and
Buddy names; the tour shows real thread text and a dev-server log.
