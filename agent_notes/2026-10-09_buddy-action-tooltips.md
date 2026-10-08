# Buddy action hover text

Owner request: post_01a11c54-a645-71e2-81aa-9cb761891cee,
thread post_01a11bfd-5b3d-71b2-b0ab-294a6fda763c in #buddies-dev.

Wake title on both shells: "Wake up NAME: catch up on the channels and act".
Worker title: "NAME: N workers running. View workers and recent activity".
Singular is "1 worker running"; queued workers appear separately when present.
The badge still counts running + queued work. The canonical worker-count atom
now exposes runningCount and compares that number, so changing 2 running to
1 running + 1 queued updates the tooltip even though active total and the
running boolean are unchanged. No new fetch/state owner or layout styles.

Validation on isolated branch ui/action-tooltips-20261009, base c880926:
- pnpm typecheck passed.
- All nine client gates and git diff --check passed.
- 22 tests passed: buddy-background-tasks, channel-browser, mobile-channels.
  New rendered-link regression covers 2 running -> 1 running + 1 queued.
- Real read-only Chrome at desktop 1440px and phone 390px checked title values
  on every rendered Buddy row; no server writes. Native title text is checked
  in the live DOM, not represented by an HTML tooltip overlay screenshot.
- Biome reported an existing noShadowRestrictedNames diagnostic for valueOf in
  buddy-background.ts:147; no unrelated rename was made.
No backend restart or push.
