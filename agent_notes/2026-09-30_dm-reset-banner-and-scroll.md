# DM reset banners and bottom following

Owner requested centered, full-width tertiary banners for model/harness new chat and Refresh context, below the reset day's date, with continuation at the bottom.

ChannelDm now gives dmRows a reset timestamp from ConversationRow.createdAt. The dated notice renders inside the generation's list, including empty new generations. Both resets share ChannelDm.css. useFollowBottom can observe the entire DM timeline's size; separately loaded old generations no longer leave the new chat at the top. Reset explicitly pins following, while a reader who scrolls into history keeps their position.

Validation: pnpm typecheck passed; pnpm test:client passed 213/213. tools/check-dm-timeline.mjs passed desktop (1440) and phone (375) real-data banner checks plus an actual-browser hook probe for delayed hydration, preserving history scroll, and explicit re-pin. Pictures inspected at output/screenshots/dm-reset-2026-09-30/{desktop,phone}.png (gitignored). Browser sessions used the standard read-only CDP driver.

Screenshot baseline output/screenshots/2026-09-30T11-52-25 vs output/screenshots/2026-09-30T11-56-34: phone unchanged, desktop 0.032% changed; the automatically selected DM belonged to Buddies Release Engineer rather than Product Development Lead. Targeted screenshots cover the actual requested DM separately.

Client invariants: 8/9 gates pass; G8 CSS ceiling fails. HEAD already had 13348 CSS lines versus ceiling 13297; this change adds 14. No unrelated stylesheet cleanup or ceiling change was made. Biome check has two preexisting dependency warnings in useOwnerUnreadTitle; no errors.

No server execution or model-default semantics changed. No push.
