# Mobile UI system

Mobile and desktop share the semantic color tokens in `client/src/index.css`, the
primitives in `client/src/ui/`, and the content views in `client/src/views/`
(transcript rows, composer controls, conversation panels). Only the shells stay
separate: the mobile tree never imports desktop shell TSX or desktop feature CSS,
and a view picks its device variant through a `presentation` prop set by the caller.

## Layers

0. `ui/tokens.css` — the type (`--fs-*`) and spacing (`--sp-*`) scales. No other
   stylesheet may spell a px font-size, padding or gap (gate G7).
   `ui/primitives.css` — `.ui-stack`, `.ui-row`, `.ui-inline-row`, `.ui-truncate`,
   `.ui-card`, `.ui-muted`: add the class instead of re-declaring the group.
1. `index.css` — palette, semantic tokens and `--ui-radius` shared by every device.
   `ui/controls.css` owns the shared `.ui-choice` appearance used by both model pickers.
2. `mobile/styles/mobile.css` — shell, safe areas, tab bar, and legacy detail views.
   Shell CSS is the only place a width `@media` may appear (gate G9).
3. `mobile/styles/mobile-ui.css` — reusable mobile page and surface grammar.
   Bottom sheets are `.ui-sheet*` in `ui/primitives.css`, shared with views.
4. Feature CSS — only layout or states unique to that feature.

## Primitives

Import from `mobile/components/MobileUI.tsx`:

- `MobilePage` for route title, subtitle, width containment, and page spacing.
- `MobileHeaderAction` for the page's primary action, passed as `headerAside`
  (the "+ New" button on Chats and Buddies). 44px min tap target.
- `MobileSection` for a labeled group inside a page.
- `MobileCardButton` for tappable cards with consistent focus and press feedback.
- `MobileSurface` for a non-interactive card.
- `MobileBadge` for compact status labels.
- `MobilePath` for a safe, truncated working-directory label.
- `MobileEmptyPanel` for an empty result inside an otherwise populated page.
- `MobileRefreshNotice` for a page whose background refresh failed while it
  still shows what loaded before (a `stale` polled state): one muted line and a
  Retry link, never a replacement for the page.

Use the `mobile-ui-stack` class for one-column card lists. Keep data fetching,
domain copy, feature state, and feature-specific inner layouts in the feature.

```tsx
<MobilePage title="Chats" subtitle="4 projects">
  <div className="mobile-ui-stack">
    <MobileCardButton onClick={openProject}>
      <strong>{project.name}</strong>
      <MobilePath>{project.path}</MobilePath>
    </MobileCardButton>
  </div>
</MobilePage>
```

## Restraint

Do not add a primitive for a one-off arrangement. Extract only a contract used
by at least two routes, and keep the API semantic rather than exposing dozens of
spacing or color props. Primitives live in `ui/` (`ui/primitives.css`, `ui/*.tsx`)
and are shared by both trees; do not add a mobile-only copy of one. They use the
existing semantic tokens rather than introducing a second palette.

## Keep the page shell constant across states

`BuddiesMobile` used to `return` a bare `<div className="mobile-hub">` for its
loading, error, and empty states, so those states rendered no `MobilePage` and
therefore no header — which is where the create action lives. The empty state is
exactly when a user needs "+ New", and it was the one state that hid it.

Build the shell once and vary only the body:

```tsx
const shell = (body: ReactNode, subtitle: string) => (
  <MobilePage title="Buddies" subtitle={subtitle} headerAside={<MobileHeaderAction …/>}>
    {body}
  </MobilePage>
);
if (loading) return shell(<Spinner/>, 'Loading…');
if (error) return shell(<EmptyState …/>, 'Unavailable');
```

## Undefined CSS custom properties fail silently

`--accent` was referenced by ~15 mobile rules (focus rings, the unread "New"
badge, the "+ New" button) but was never defined — `index.css` defines
`--accent-primary`, `--accent-user`, and friends, but no bare `--accent`. CSS
resolves an undefined custom property to unset rather than erroring, so those
rules rendered transparent-on-dark: an invisible button, with no console warning,
no type error, and no lint failure. It is now defined in `index.css` as an alias
of `--accent-primary`.

`client/test/css-tokens.test.ts` guards the class: every bare `var(--x)` in
`client/src/**/*.css` must resolve. `var(--x, fallback)` is deliberately
defensive and is skipped. The mobile tree is held to zero debt; the desktop tree
carries a `KNOWN_UNDEFINED` ratchet of 11 pre-existing Solarized-era token names
(`--theme-base0`, `--theme-violet`, …) that still render unset — fix one, delete
its entry.

## Hover-only affordances need a mobile counterpart, not a port

The message copy action is the worked example. Desktop follows the Claude /
ChatGPT convention: a quiet action row *below* the message, revealed on
`.message:hover` / `:focus-within` (`.message-actions` in `Chat.css`). Below,
not pinned top-right, because the top-left corner of every code block already
holds `.message-code-copy-btn` — an overlay in the message corner competes with
it, and on a long assistant turn the message's top edge has scrolled away by the
time you want the button.

Touch has no hover, so that reveal has no analogue. It is also not a long-press:
long-press is already the browser's text-selection gesture, which is how people
copy a *fragment*. Mobile instead makes the action permanent but quiet — a small
pill on the message footer line, right-aligned opposite the timestamp
(`.mobile-message__copy`), costing no extra vertical rhythm.

What the two trees share is the interaction *logic*, not the markup:
`hooks/useCopyAction.ts` owns the attempt, the `idle | copied | failed` state,
and the auto-reset. `failed` is a real state because `copyText` genuinely fails
over plain-http LAN (see `docs/auth.md`); a button that silently stays on "Copy"
reads as broken. Gate G3 forbids mobile importing `components/*`, so anything
shared between the trees has to land in `hooks/`, `utils/`, or `atoms/`.

## Shared appearance and focused composition

Both view trees consume `--ui-radius` (2px) for controls, cards, menus and badges.
Feature CSS owns layout, not a separate corner scale. Inline mobile styles use
this token too. True circles (status dots and spinner rings) keep their geometry.
Model choices use `.ui-choice` from `ui/controls.css`; desktop owns its compact
row layout and mobile sets a 44px minimum touch height. Avoid new pill variants.

`FullscreenComposer` owns an explicit editing mode, entered by focusing the textarea.
It keeps the same textarea mounted and covers the entire app header and panels.
Done, Escape, native input blur and successful send restore reading. Toolbar focus
stays inside the editor; opening the prompt palette first leaves editing mode.

The frame follows `visualViewport.height`, `width`, `offsetTop` and `offsetLeft`
on resize and scroll, with `innerHeight/innerWidth` fallback. It does not subtract
a keyboard inset from `dvh`. Body/root scrolling is locked and background branches
are inert for the editing lifetime, with their previous state restored on exit.
Safe-area padding accounts for viewport panning and drops the bottom inset when
the keyboard shrinks the visual viewport. Text scrolls inside a bounded flex child;
the action row cannot shrink. Do not remount/portal the textarea on focus or restore
`:focus-within` pane expansion: both disturb native keyboard/focus behavior.

Channel and thread screens use the same frame through `ChannelComposerMobile`
(mobile/channels): focusing the field enters editing, a slim head carries Done,
and the @ menu sits in flow above the bar. Opening a mention chip's harness/model
picker on touch dismisses the keyboard and shows the picker as a bottom sheet; as
a popover above the composer the keyboard pushed it off-screen. Pane headers under
`.mobile-shell` never add `env(safe-area-inset-top)` — the shell already pads it,
and doubling it left a status-bar-sized gap above the channel header.

`views/composer/ComposerAttachments` (`presentation="gallery"`) presents one horizontally scrolling thumbnail row, with a
bounded overlay of swipeable previews and explicit Remove controls. It reuses the
shared attachment lifecycle and leaves the draft untouched. The tab bar retains an
explicit `[hidden]` rule. Browser QA and native-device limits are recorded in
`agent_notes/screenshots/fullscreen-composer-20260916/README.md`.
