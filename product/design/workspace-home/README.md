# Workspace home: three directions (2026-09-30)

The owner's brief, in #general on 2026-09-30: the workspace landing page
(`/buddies/workspaces/:id/channels`, `ChannelHomePane` in
`client/src/components/buddies/ChannelBrowser.tsx`) is uninspiring. It prints
the rail's channel list a second time.

These are static mocks. The rail on the left is a real capture (`pnpm screenshots`,
2026-09-30). Channel names, purposes, latest posts, Buddies, roles and Task
titles are this workspace's real data from that day. Unread counts come from
a Buddy's inbox, not the owner's.

| File | Direction | Idea |
|---|---|---|
| `a-pulse.png` | A, Pulse | Emblem hero with stats, who is working now, every channel as a card (purpose + latest message), Tasks in flight |
| `b-team-floor.png` | B, Team floor | The Buddies are the page: one card each with what it is doing and its open Task, a live feed on the right |
| `c-ask-first.png` | C, Ask first | A big composer addressed to the team, your open threads, channels as chips |

Re-render one (Chrome headless, same size as the app captures):

```bash
cd product/design/workspace-home
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --hide-scrollbars \
  --window-size=2000,1250 --force-device-scale-factor=1.44 \
  --screenshot=$PWD/a-pulse.png file://$PWD/a-pulse.html
```

`assets/` holds crops of the real emblem, the rail and the Buddy faces, taken from the same capture.
