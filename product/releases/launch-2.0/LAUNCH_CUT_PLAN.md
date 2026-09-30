# Launch cut plan — 2026-09-28

Audit and proposed finishing brief, for owner review. This reconciles the kickoff
script with Assembly.tsx and the September 27 additions; it does not claim a new
render or an approved final cut. Audience: people juggling agent apps. Message:
Unleashd brings that work into channels, with a choice of harness and an open-source
app they can run and change. Primary destination: launch post and product page.

## Deliverables

1. Required: one complete 16:9 launch master, approximately 80–85 seconds, readable
   without audio, using the existing motion, footage and synthesized score.
2. Recommended after the master: one 20–30-second social cut derived from it;
   reframe as 9:16 where needed. Lead with a real request and its result, then the
   picker and CTA. This is a derivative, not another production or launch blocker.
3. Existing design-review, multimedia and picker clips remain reusable feature
   demos. No separate manifesto film or additional walkthrough is needed to launch.

## Story and the ethos line

Overload → one workspace → real work/results → harness choice → ownership → CTA.
The ethos replaces the older “Inspired by Vim / …for the future” close. It explains
why open source matters after the viewer has seen the product.

Exact closing copy, split into two readable cards:

> Vim is open source and it's still here decades later.
>
> Agent software should be too.

Allow roughly 7–8 seconds, then the Unleashd wordmark and existing CTA. The current
Vim slot is only 3.75 seconds; inserting the sentence without retiming would rush
it. Recover the extra time by removing the repeated Free / Open Source title
stack later in the film: the owner-requested post-intro benefits already say both.
Keep the privacy/local-running point with its real app proof. Retiming the music
is part of this change. This is an edit recommendation, not yet implemented.

## Timeline (script v2, as built 2026-09-30)

Owner approved `SCRIPT_V2_2026-09-30.md` ("Okay, impliment"). Every scene after the open is one
4-bar phrase of the EDM cue (`sound/edm.py` FULL_CUE, 59.5 s; `edm-build.wav` byte-identical), and
the intro's marimba hands its melody to the build (`PostIntroBenefits.tsx`, `BenefitsSound`).

| Time (s) | Bars | Scene | Source |
|---|---|---|---|
| 0–18.0 | — | Overload, "AI Overload! / We're all feeling it. / Don't worry, we've got you covered.", title | `Overload.tsx` |
| 18.0–25.5 | 1–4 build | The four benefits, one per bar, marimba handing off | `PostIntroBenefits.tsx` |
| 25.5–33.0 | 5–8 drop | Ask your agents: request → 6 minutes later → iPad result (3 shots) | `DesignReview.tsx` |
| 33.0–40.5 | 9–12 | They show their work: inline video → contact sheet → "Great work!" | `ShowWork.tsx` |
| 40.5–48.0 | 13–16 | Multi harness slide → picker, 2 beats per harness | `beat9.mp4`, `PickerRefresh.tsx` |
| 48.0–55.5 | 17–20 | Swarms / Memory / Mobile, one bar each; Bring your own subscriptions | `FeatureFlash.tsx`, `beat9.mp4` |
| 55.5–63.0 | 21–24 | GitHub + Fork (2 bars), Run it on your computer (2 bars) | `Close.tsx` |
| 63.0–70.5 | 25–28 coda | The Vim ethos, two cards, plain type surfacing word by word | `Close.tsx` |
| 70.5–76.5 | 29 final chord | End card, plain type, fades to black with the chord | `Close.tsx` |

Quiet close (owner, 2026-09-30, after the v2 render): the recap is cut, the beat never comes back
after the Vim line (`Coda` in `edm.py`: breakdown texture, then one soft D chord with no impact or
crash), and the Vim line and end card drop the colour-slab type, which stays for the demo scenes.

Not done from the v2 script: the groove does not thin before the coda (bar 24 is full groove).

## Remaining work, in order

1. Owner review of the v2 master (`edit/out/assembly.mp4`).
2. Before publishing: re-capture the GitHub still once the repo's About text is updated (it still
   says "swarm orchestrator") and CI on the latest commit is green.
3. Check the September 26 swarm, memory, chat and design shots against the shipping UI.
4. Privacy pass on every frame (unblurred openings of product clips, workspace names on the home
   shot and the localhost shot).
5. Export the approved master, thumbnail and optional 20–30 s social cut. Publishing requires
   separate owner approval.

## Sources

- `../UNLEASHD_2_0_LAUNCH_2026-09-26.md` — historical kickoff script.
- `edit/src/Assembly.tsx`, `Close.tsx`, `FeatureFlash.tsx` — current source timeline.
- `edit/POST_INTRO_2026-09-27.md` — latest inserts and capture provenance.
- `clips/CLIPS.md`, `footage/FOOTAGE.md` — clip bank and privacy notes.
- `brand/PROJECT_ETHOS.md` — exact owner-approved ethos.
- #unleashd-2 threads `post_b4c4e4bd-9c32-4306-84fe-c1b7b6987a24`,
  `post_8b3f5688-be29-41be-baf4-a5058775cc17`,
  `post_62a6fa1c-c73c-4873-8cdd-ad7b2a9ff004`.

## Update 2026-09-30 (late): 84 s, "They show their work" doubled

Owner: stay longer on "They show their work", the iPad Buddies grid at 0:32 was a bad screenshot,
and the bare emblem sheet at 0:37 was confusing. Now: "Ask your agents" ends on the three posts
(bars 5-8); "They show their work" is 8 bars (inline video, emblem post, labelled emblem sheet, "Great
work!"); the harness slide, picker, swarm, mobile flash, subscriptions, fork, run, Vim and end card
all move 4 bars later. `calm.py`/`edm.py` stretch the groove to bar 28, coda bars 29-32, end bar 33
(66 s cues). Score: half-time (owner pick), mastered to a -10 dBFS peak.
