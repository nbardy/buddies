# Retry model picker and Home mentions

Owner request: #buddies-dev thread `post_01a11aa2-a934-7547-84e4-9266f5c0ef17`.
Three sub-agents handled retry picker/button accessibility, Home popup placement,
and removal of Tasks from @ suggestions.

Local commits: `1cf9127`, `f5164c7`, and screenshot-only `fd716b9`. No push or deployment.

- Retry and mention model settings share `ChannelModelPicker` and its thinking slider.
  The options scroll independently; confirmation stays visible. Retry is centered
  on desktop and uses the existing bottom-sheet layout on mobile.
- Home explicitly requests below placement; bottom channel composers retain above
  placement. @ suggestions contain active Buddies only. Existing Task chips still render.
- Browser guard `tools/check-mention-placement.mjs` reproduced the old phone popup
  at top=-47.78px and passes phone/desktop Home, desktop channel, hit testing, and
  ArrowDown/Enter selection after the fix.
- Actual failed-reply Retry was opened read-only at desktop 1440x900,
  short desktop 1024x340 and phone 375x600. `inspectChannelModelPicker` passed
  footer geometry/hit testing at all sizes. Short desktop actually overflowed
  the options while confirmation remained visible.

Verification: committed client source exported into `/tmp/unleashd-ui-1cf9127-check`
(updated with the three files from f5164c7), with existing dependency directories
linked. Client tests 259/259; `tsc -b client`; all nine client invariant gates;
screenshot-tool tests 2/2. CSS remains 14587/14587 lines. Full working-tree
`pnpm typecheck` also passed. Unrelated dirty source/catalog/submodule work was
excluded from both commits. Initial committed-tree gate caught a duplicate Home
CSS owner masked by dirty CSS; f5164c7 fixed it through composer placement.

Screenshots copied into the owner thread by post `post_01a11aaa-692a-73f6-afc0-df0994a1446f`:
Home phone and actual Retry phone. Temporary WebP dumps are removed at close.
Live screenshot matrix has delayed sigil/API requests and onboarding overlays;
targeted browser checks dismiss both onboarding prompts before hit testing.

The 10-screen baseline replay exited 1: 9 comparison entries exceeded zero tolerance,
including two missing phone picker images covered by onboarding. Baseline welcome
overlays versus dismissed-after views account for broad differences; live API/sigil
requests remained pending at timeout. This is not a pixel-identical validation claim.
The targeted geometry/hit-test checks above passed independently.

After fd716b9 waits for late onboarding and dismisses it again, the two phone
picker screenshots reran successfully (2 captured, 0 skipped), with footer hit
testing enabled. Images were visually reviewed; archived screenshot-tool tests
remain 2/2. No application source changed after f5164c7.
