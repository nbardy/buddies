# Desktop thread sidebar resizing

Owner request: #buddies-dev post_01a1101d-89eb-768b-be66-1a2119ca59e4.

Implemented in local commit 1db2ba7 (not pushed): drag the thread's left divider;
ArrowLeft/ArrowRight change width by 24px, Home/End select saved limits
320/960px, double-click resets to 420px. Device-local validated storage owns
width across workspace changes and reloads. CSS limits effective width so the
channel retains min(320px, 45% of the available pane area) in narrow windows.
No global pointer listeners; pointer capture ends on release/cancel/unmount.

Validation: pnpm typecheck passed; all 9 client invariant gates passed; Biome
and diff check passed. tools/thread-resize.test.mjs runs against an actual dev
server and existing thread, using read-only headless Chrome over CDP. Native
mouse drag verified 420→600px; keyboard 624→600; reload retains 600; Home/End,
900px viewport channel space and double-click reset passed. The CDP drag helper
must move to the divider before mouse-down (initial test exposed this).

Screenshots reviewed at output/screenshots/thread-resize-review-20261006/
(default.webp and wide.webp). These show the thread content and actual widened
pane. The general before/after screenshot runner reported 0 changed pixels on
phone/desktop, but its setup dialog covered both shots; that comparison is not
visual evidence of the thread behavior. Both manifests record a sigil worker
request still open after the 20s idle wait. The dedicated browser test closes
the setup dialog and checks the real layout.

Tracked working tree was clean after commit; git grep HEAD confirmed width
atom/actions and consumers are committed together. No push or backend restart.

## Owner follow-up: divider and scrollbar polish

Local commit 57257c5 (not pushed). The old hover/focus background left an 8px
purple stripe after release. It now uses a faint gradient only during drag or
keyboard focus; pointer release clears dragging and focus immediately.

Channel and thread scrollers now reuse useScrollActivity + ui-scroll-quiet.
Shared quiet thumbs are 4px inside a 10px track, with transparent 3px borders,
rounded ends, vertical track margins and a 160ms registered-color transition.
The existing 700ms idle timer turns them off. Rail uses the same primitive.

Browser test checks release background is absent, both panes become active
on scroll, thumb radius/border/clip and active color, then idle transparency;
resize/reload/narrow-window checks still pass. Typecheck, Biome and all nine
client gates pass. Tracked tree clean after commit; HEAD symbols checked.
Screenshot driver now optionally shows scrollbars (normally hides them), used
for the reviewed scroll-active.webp. Screenshot sessions freeze transitions,
so their pictures verify static active/idle styling rather than fade timing.
