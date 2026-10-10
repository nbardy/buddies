# DM Queue and Interrupt controls

Owner thread: post_01a1263c-2e19-743b-aaea-2a347ebf69bf in buddies-dev.
Local commit: 0720cd641669cf57b483fdb5506f9775156ba8fd (not pushed).

While replying, desktop DMs show Queue · Shift+Enter and Interrupt · Enter.
Phone DMs show explicit Queue and Interrupt buttons; keyboard Enter remains a newline.
Idle desktop Shift+Enter remains a newline. Both actions reuse existing durable
queue_message / interrupt_and_send commands, with no server/schema changes.

Shift+Tab “append a result” is ambiguous. Asked the owner whether this means queue
the composer message or append literal text; no reply yet. Left Shift+Tab unchanged.

Validation:
- 12 channel-dm.test.tsx tests passed from archived exact commit 0720cd6,
  using the existing dependencies. The archive was removed after checking.
- pnpm typecheck passed on the working tree. New dependencies verified at HEAD:
  interruptAndSend in atoms/actions.ts and command modes in atoms/commands.ts.
- Read-only CDP browser check on desktop 1440px and phone 390px: rendered buttons,
  keyboard Enter / Shift+Enter and phone Queue / Interrupt produced the correct
  outgoing command types. WebSocket sends were captured locally, never forwarded;
  local running-row injection exercised busy state without starting any real turn.
- Visually inspected desktop and phone busy composer captures; both fit correctly.
  Transient captures removed after review per AGENTS.md.
- Client invariants G1–G7 and G9 passed; G8 fails at 14728 CSS lines vs 14606 ceiling
  in the shared dirty tree. This commit changes no CSS.

## Owner correction: preserve multiline typing

Superseding local commit: 40400bc. Shift+Enter now always keeps native newline
behavior; Shift+Tab queues the current draft using queue_message. Empty/unready
Shift+Tab preserves normal focus traversal. Enter interrupts during a live reply.
The visible desktop Queue shortcut changed to Shift+Tab; phone buttons unchanged.

12 DM tests and pnpm typecheck passed. Read-only desktop browser check confirms
Shift+Enter is not prevented, leaves the draft intact and emits no command;
Shift+Tab is prevented and emits queue_message. Inspected updated visible label.
Committed handler/label verified directly with git grep HEAD. No live writes sent.
Transient captures deleted after inspection. Commit not pushed.

## Source publication authorized and complete

Owner requested merge main and push at 14:44Z. Both DM commits were already on
main, 14 commits ahead of origin/main with no divergence. Archived exact
40400bc09aa4c199daa20bd2c94e1c1bc5dd8816 passed all 266 client tests,
client tsc -b and all nine client invariant gates. Pushed the exact commit to
origin/main (d094cf3..40400bc), including its earlier committed local UI ancestors.
Uncommitted concurrent edits were not staged. Source push does not claim a
packaged desktop deployment or runtime handover.
