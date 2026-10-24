# DM open (clicking a Buddy name) is slow; channels are not (2026-10-05)

Owner report: post_01a10bee in #buddies-dev. DM probed: d7b0a9ec-ed58-58d3-8026-326d6060afed
(buddy_ed6ba302, workspace project_88cdc98e). Probe: `agent_notes/2026-10-05_dm-open-probe.mjs`
(headless Chrome via tools/lib/headless-chrome.mjs, pushState to `?dm=`, measures time to rows,
long tasks and per-request queue/server/body timings).

## Measurements (7 cold opens)
- DM open ranged from 0.1s to 20.9s for the same DM. A warm reopen took 0.35s.
- Every open does the following:
  wave 1: detail + messages(all) + provider-catalog + direct/chain
  wave 2 (after chain returns): detail + messages(all) for EACH earlier generation
  This DM has 3 generations, so it loads 331 rows, ~245 KB of JSON and ~3,300 DOM nodes.
- Client long tasks total 0.7–1.2s on every open, from rendering the whole history of all 3 generations.
- Backend server time for trivial endpoints jumps from ~10ms to 600–950ms
  (provider-catalog, 300 B: 770ms). The stall journal shows 100–400ms event-loop stalls
  attributed to many routes. This amplifies each of the two serial waves.
- Dev only: lazy deps (rehype-highlight 1.4 MB, katex) load on first DM. Runs of 8–21s
  coincided with Vite HMR re-imports (`?t=` modules) while other sessions edited client
  files. This is noise from dev mode, not the product path.

## Root cause
1. A DM loads and renders the ENTIRE history of EVERY live generation on every open
   (ChannelDm `shown = generations` when on latest; `readMessagesAfter(id, -1)` pages until total).
   Channels only read the newest page of posts. So DM cost grows with history, which is why
   it was fast at first.
2. The open is serial: the rail click POSTs /direct first, then chain, then the earlier
   generations, so 3 round trips stack.
3. Backend event-loop stalls (open task task_01a10b47-33ed…) turn each round trip from
   ~10ms into up to ~1s.

## Fix proposal
- Render the latest generation only. Earlier generations become a collapsed
  "Earlier conversations (N)" divider that loads on expand.
- Tail-page the transcript: load the last ~50 messages and page older ones on scroll-up
  (server already supports afterSeq/limit).
- Optional: skip the POST /direct when the rail already holds the DM id.

## Shipped (2026-10-06): 551feb9 on origin/main
Owner said "fix and merge and commit and push". Fixes 1 and 2 shipped. Fix 3 was dropped:
the POST /direct is one ~10-90 ms hop, and skipping it needs a client-side index of DM generations.
- The open chat draws its newest 40 rows (`tailRows`). ChannelHistory reveals more on scroll-up
  and `hold()` keeps the reader's place.
- Earlier generations mount and load only on "Show N earlier chats".
- The divider reads the previous generation's config from its ~1 KB detail (`usePolledFetch`).
Before/after (dev mode, same backend, alternating cold opens of d7b0a9ec):
- Settle time: 850-1,340 ms before, 420-540 ms after.
- API calls: 10-15 before, 6 after.
- Histories fetched: 3 before, 1 after.
The open chat has only ~41 rows, so most of the win comes from not loading the 2 earlier chats.
In the browser, scroll-up revealed the rest with the position held, then "Show 2 earlier chats"
appeared; clicking it loaded both, with their harness-change dividers.
Headless gotcha: IntersectionObserver only fires while frames run. Drive frames with a rAF loop
inside evaluate, or a programmatic scroll never reaches the sentinel.
Client tests: 228 pass. 2 failures also fail on base 6990beb ("only a harness failure offers a
retry", "the Task filter shows one Task across channels"); both are pre-existing and unrelated.
Not done: the local main checkout (which the live dev server serves) is behind origin and dirty
with other sessions' work. It was left alone, so the live app needs `git pull` there to show this.
