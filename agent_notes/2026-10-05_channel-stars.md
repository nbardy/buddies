# Channel stars — 2026-10-05

Owner request: post_01a10b33-a6f3-72cc-a10a-e49c0674cf97 in #buddies-dev.

Implemented in the working tree, uncommitted:
- Desktop rail: star appears on hover or keyboard focus; filled stars remain visible.
- Mobile channel list: always-visible star with a 44 × 48 CSS-pixel touch target.
- Star buttons are siblings of the channel opener; starring never navigates.
- One derived channelRailFamily reads the keyed workspace inbox cache and stable-partitions public channels into starred/unstarred groups for both shells, preserving server order and unread/request metadata.
- Personal stars persist in device localStorage under unleashd-starred-channels, with validation and one exported atom action. They do not sync between devices.
- ChannelStar.css adds 44 lines; the documented feature allowance in G8 increased by 44, as prior owner-requested features have done. All nine gates pass.

Validation of working tree (not a commit):
- pnpm typecheck passed, including client/test.
- 18 focused client tests passed (channel-stars, channel-browser, mobile-channels).
- Biome on new/owned state files and git diff --check passed.
- Real Chrome CDP checks on desktop 1440 × 1000 and phone 390 × 844 passed: star, first position, unchanged URL, reload persistence, unstar. Read-only browser session blocked a diagnostics POST; no server writes were allowed.
- Reviewed output/channel-stars/desktop-starred.png and phone-starred.png; focus/hover pictures alongside them.
- Standard pnpm screenshots baseline/after ran, but the Welcome modal obscured the rail in both captures, so it is not evidence of star layout. Custom checks explicitly dismissed Welcome and the mobile install guide before screenshots. Comparison returned nonzero at threshold 0 (0.030% desktop, 0.447% phone), and is not claimed as a no-regression pass.

Touched files: client/src/atoms/{ui,channel-rail}.ts, components/buddies/{ChannelBrowser,ChannelStar}.tsx, ChannelStar.css, mobile/channels/ChannelsMobile.tsx, client/test/channel-stars.test.tsx, tools/check-client-invariants.sh. Existing ChannelBrowser and gate files also carry concurrent onboarding work; do not sweep them into a commit blindly.
