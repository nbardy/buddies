# Mobile Threads alignment

Owner request: post_01a10643-3653-73b9-8a77-8bdb9ceef451 in #buddies-dev.

Committed 58bb285 (not pushed). Only ThreadsPane.css and ThreadsMobile.tsx changed.
MobilePage already supplies a 16px gutter; removed the card/message inset inside it.
Author/avatar stay in their heading row; body spans the full card width. Channel heading
uses a single line and participants occupy the second line. Existing ui-truncate is reused.

Validation: Biome passes for both files; all nine client invariants pass (13987 CSS lines).
Both tested files were byte-compared with git show 58bb285 and match the commit.
Read-only browser screenshots: output/screenshots/threads-align-before and
output/screenshots/threads-align-final/compare.html. Desktop has 0% changed pixels;
mobile changes are expected. Browser geometry recorded in the final manifest:
bodyX = headX = 16, no horizontal overflow. Sigil worker request remained pending at
capture timeout, though avatars rendered. Startup Dependencies dialog was dismissed
by clicking its Close button in a temporary copy of the screenshot runner; no app writes.
Final top-of-page phone review: output/screenshots/threads-align-reviewed/threads@phone.png.

The temporary runner also checked body/head gutter equality and document overflow in
real DOM geometry. Other concurrent working-tree changes were left unstaged.
