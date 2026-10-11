# Emoji reaction hover layout fix

Owner request: post_01a1294d-ae3a-743c-bab9-f66f4d0ef48c in #buddies-dev.

Local source commits: a359c74, 9e5cb95, ffc5a0e. No push or backend restart.

The shared ChannelPostContent emoji action used display:none until hover/focus. A real post without reactions or Edit grew from 93px to 118.1875px on desktop hover. It now uses the existing inline-flex action style continuously and reveals through opacity. Touch always shows the action; keyboard focus reveals it.

Verification on a clean isolated committed checkout (de6897c + 4bf9152 + 75722e5):
- tools/check-reaction-layout.mjs failed on original CSS: Hover changed post height, 118.1875 !== 93.
- Final browser check passes desktop hover/focus dimensions and direct button focus; phone visibility and center-point hit testing pass. Desktop stays 960 × 118.1875px, phone is 312 × 327.4375px.
- pnpm --dir client exec tsc -b passed.
- All nine check-client-invariants gates passed, CSS 14606/14606 lines.
- Biome checks passed for changed TSX and browser guard.
- Final committed files were compared with the integrated checkout using git diff 75722e5 HEAD; no differences.

Run against a dev server with real posts, replacing URL with a populated channel or thread:

    node tools/check-reaction-layout.mjs 'http://localhost:7489/buddies/workspaces/project_26fce156-5c5d-4dd9-a9d6-4b527a50af3c/channels?channel=list_4bd52262-8f0b-465d-99e5-60cc33eb8565'

Browser sessions are read-only. The guard requires a real post without existing action chips, and rejects missing data. Screenshots reviewed at desktop and phone; transient captures removed at closeout. The live page attempted one diagnostic-error POST, blocked by the screenshot harness; no application writes were allowed. Scope was emoji layout, not the diagnostic or sigil-worker loading issue observed by the broader screenshot runner.
