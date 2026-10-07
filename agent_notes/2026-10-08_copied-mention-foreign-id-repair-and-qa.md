# Copied mentions: foreign-id repair and browser QA record

Task: task_01a11762-b1be-7450-b15d-8668367bc270. Candidate under review: 55cd36c. Repair: 18f06ab.
Request: post_01a11785-0cd2-72c8-9556-d8fece12c873.

## The defect (55cd36c)
`resolveReferences` turned a `[@Lead](buddy:<id not on roster>)` token into prose `@Lead` and then ran the
name pass over it, so a removed/archived/foreign explicit id silently retargeted to a local active Buddy with
the same name. The old tests asserted that retarget.

## The repair (18f06ab)
- `shared/src/body-references.ts`: an unknown explicit id is kept exactly as written and listed in the new
  `Resolution.rejected`; it is never in `mentioned`. Resolving the result again returns the same value.
- `server/src/buddies/mentions.ts` `resolveForWorkspace`, the one boundary for owner post, owner answer and the
  Buddy `post` tool, throws `CoreError('invalid')` naming the mention: no post, no delivery. A replay of the
  same key is refused again.
- Composer: `foreignMentions(view)`; the mark is drawn muted (`data-kind="foreign"`), it is not a chip or model
  recipient, the hint says `@Lead is not a Buddy in this workspace; edit it to mention someone else`, and
  Send/Enter are blocked. Preview, chips, Send and server therefore agree.
- Task chips: the rendered chip title (`ChannelMarkdown` TaskChip, TaskCardBody) carries
  `data-unleashd-ref="task:<id>"`; the paste reader matches `<a>` or `<span>` elements naming a reference.
  Plain `@Task title` still does not auto-resolve. A composer copy shows a Task as `@Title`; paste strips that
  `@` for both kinds (a Task title that itself starts with `@` loses it: known, rare).

## Partial-edit semantics (documented, intended)
A token is an atom until a keystroke lands inside it. That edit dissolves ONLY that token to the plain text the
owner saw (`@Lea`), which then reads like any typed name: it may resolve to a different exact unique Buddy name.
The edit is the owner's decision; nothing else ever changes an id. Pasted/restored foreign tokens are not
edits, so they stay foreign.

## Tests (exact names)
- `client/test/body-references.test.ts`: "tokens are trusted only for ids on the roster, and take the current
  name" (rejected list, nothing mentioned, fixpoint); "resolving an already-canonical body changes nothing".
- `client/test/composer-draft.test.ts`: "copy then paste keeps the local id, follows a rename, and never trusts a
  foreign id" (foreign `@Lead` with a local active `Lead`: token kept, flagged, no chip, send body unchanged,
  re-paste is a fixpoint, an edit dissolves it); "a rendered Task chip pastes with its id; Task identity
  survives a copy from the composer" (this found the `@Title` label bug).
- `server/test/buddies-v2.test.ts`: "an explicit id that is not on the roster is refused, never retargeted to a
  same-named Buddy" (other-workspace Lead and archived Designer: owner route 400 twice per key; Buddy tool
  refuses; only the legitimate wake exists; local Lead ran once; Designer zero runs). "owner and Buddy posts
  store the same canonical mentions, and wake once even on replay" no longer posts a foreign token.
- Run on a tree whose files for this slice equal HEAD 18f06ab: `pnpm typecheck` clean; client 254/254; server
  buddies-v2 + upstream 76/76; biome clean on touched files (one pre-existing unused-`thread` warning at
  buddies-v2 "a Buddy's @mention wakes" is not from this change).
- `bash tools/check-client-invariants.sh`: G8 FAILS (client CSS 14576 vs ceiling 14449) because other
  sessions' uncommitted edits to BuddyDetail/ChannelLanding/TaskPage/Chat.css are in the tree; this commit adds
  +1 CSS line (a selector joined to the Task mark rule). Not caused by, and not fixed in, this slice.

## Browser QA record (from the pre-repair run; original dir `output/mention-qa-2026-10-08` is disposable)
Read-only CDP against the owner's dev server (Chrome; no sends; `blockedWrites: []` on both sizes) at 55cd36c.
Observed (report.json):
- Desktop plain paste "Ask @Product Development Lead please review; mail me@lead.example; `@Buddies UI Engineer`
  stays code": one buddy mark on the lead, chip "Product Development Lead / GPT-6.1 Sol"; e-mail and inline code
  unmarked; draft stored `[@Product Development Lead](buddy:buddy_e0527b5c-…)`.
- Desktop real copy of a rendered mention then paste: copied ref `buddy:buddy_d3f11f11-…`, pasted draft the
  canonical token, mark + chip "Buddies Development Lead / Opus 5.5 · high".
- Desktop Backspace inside the mention left `@Buddies Development Lea` (no mark/chip) and it survived reload as
  that text: the partial-edit rule above.
- Phone (fullscreen composer): same plain paste result; clipboard HTML was PREPARED (a rendered anchor with
  `data-unleashd-ref`), not a touch selection on iOS Safari; paste produced mark + chip; removing a trailing
  character kept the mention and it survived reload.
Not browser-tested: this repair (foreign-id warning, blocked Send, Task chip copy). Those are covered by the
tests above only; the live backend still runs pre-repair server code until restarted.

## Limits
No push; backend not restarted. Plain `@Task title` does not resolve. Same idempotency key after a rename may
409 (unchanged). Model override and saved-draft paths untouched (`mentionedBuddies` still feeds chips and
`mentionConfigs`; foreign marks are excluded from both).
