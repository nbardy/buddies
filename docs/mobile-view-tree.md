# Mobile view tree (PWA)

(Moved out of AGENTS.md to keep startup context small.)

## Mobile view tree (PWA) — two view trees over one core

Mobile is a second view tree over the same shared core, not a fork. One `jotaiStore` (`atoms/store.ts:14`), one WS socket, one `handleMessage` spine.

### What mobile may import

```
atoms/*, hooks/*, utils/*, shared/*, views/*, components/buddies/{api,types,ui-contract,buddies-shaping}.ts
```

**Shared views (owner decision O1, T20).** Device-agnostic content lives in `client/src/views/<group>/` and both trees render it: `views/conversation/` holds `SubAgentPanel`, `ResumeSource`, `QueuedMessages`, `TurnStatus`. `views/transcript/` holds `TranscriptGroup`, the one row view under both list containers (`'hover' | 'footer'` actions). `views/composer/` holds `PromptPalette` (`'popover' | 'sheet'`), `ComposerAttachments` (`'chips' | 'gallery'`) + `UploadErrorNotice`, and `SendControls` (`'labelled' | 'icons'`); the composers themselves (Chat.tsx input, `ComposerMobile` + `FullscreenComposer`) stay per tree. Where the output differs by device the view takes a named variant chosen by its caller (`presentation: 'tree' | 'cards'`, `'icon' | 'card'`, `'list' | 'disclosure'`, `'header' | 'composer'`), never a boolean and never `useDeviceKind`. A view never imports `mobile/*` or a desktop shell component (Sidebar, Gallery, SettingsMenu, ShellDesktop) — guard `client/test/views-boundary.test.ts`. Its CSS sits next to it with component-prefixed classes plus `ui/primitives.css` (`ui-section__*`, `ui-surface`, `ui-badge`, moved there from `mobile-ui.css`).

Never import another `components/*.tsx` or its CSS. Shared logic lives in `utils/` so mobile can reuse it without pulling desktop view trees. `components/buddies/*` is the one allowed exception — its `buddies-shaping.ts` is pure shaping (no JSX/CSS side-effects) co-located with `api.ts`/`types.ts`/`ui-contract.ts`.

Grep gates (run `pnpm check:client-invariants` / `bash tools/check-client-invariants.sh`):
- **G1** — `jotaiStore.set` only inside `client/src/atoms/`. Components call actions.
- **G2** — no raw `.buddyContext` / `.purpose` reads in `client/src/mobile/` — read the row's `kind` / `matchConversationKind` (`shared/src/conversation-config.ts`).
- **G3** — the shells never import each other (O1, lean-scope 06 §2.3): `mobile/` never imports the desktop shell (`components/*` outside `components/buddies/`), and the desktop shell never imports `mobile/`. The views half of O1 (`views/` never imports a shell or `mobile/`) is `client/test/views-boundary.test.ts`.
- **G4–G8** — secure-context wrappers, one CSS owner per class, the token scale, the CSS line ceiling (see the script).
- **G9** — width `@media` queries only in shell CSS (`App.css`, `components/Sidebar.css`, `mobile/styles/*`). A view that differs by device colocates `[data-device="mobile"] .x { … }` in its own sheet (`ShellMobile` puts `data-device="mobile"` on its root) or reads a `data-layout` / `presentation` variant. A width query in a view sheet also fired for a desktop window narrowed after load, which keeps the desktop tree, so it styled a layout that tree never renders. Overlay sheets use the `.ui-sheet*` primitive in `ui/primitives.css`, never a mobile-only class, because shared views render them on both trees.

### DeviceKind — the only sum type at the shell

```ts
// client/src/mobile/hooks/useDeviceKind.ts
export type DeviceKind = 'mobile' | 'desktop';
export function useDeviceKind(): DeviceKind { /* sticky per page load */ }
```

`T1`: `'mobile'|'desktop'` not `boolean isMobile` — anonymous `true⊕false` leaks `if(isMobile)` downstream. Computed once at module load via `matchMedia('(max-width: 768px)')` and cached for the page load (`sticky`, not resize-reactive — live swap would remount the tree and lose composer drafts). `matchMedia` missing → typed `throw` (`T4`, no silent desktop default). Single dispatch point is `App.tsx: const device = useDeviceKind()` → `SHELLS[device]` (δ #1) → `pick(r)` leaf factory (δ #2). Leaf handlers never re-ask `isMobile`.

### Shared views (`client/src/views/`, owner decision O1)

Device-agnostic content lives in `client/src/views/<group>/` and is used by
both trees. A view never imports `mobile/*`, the desktop shell components
(Sidebar, Gallery, SettingsMenu) or `useDeviceKind`. When the devices differ
only in presentation, the caller picks a named variant, never a boolean:

- `views/config/` — the provider/model/reasoning option list
  (`config-options.ts`, pure) and `ConversationConfigPicker`.
  `ConfigOverlay presentation: 'popover' | 'sheet'` is the desktop Chat header
  popover and the mobile model sheet.
- `views/search/` — `SearchView presentation: 'palette' | 'page'`: the desktop
  ⌘P palette and the mobile Search tab share one ranking (Buddies, local
  conversations, grouped message history) and one result list. Its state is
  `atoms/search.ts` (`searchQueryAtom`, a sum type — never an `atom<string>('')`
  sentinel — and `searchMatchesFamily(folder)`).

Device-specific derived views that are not shared content still live in
`mobile/atoms/`, never in `conversations.ts`.

### Creation actions (`views/new-conversation/`)

`+ New` on Chats opens `mobile/components/NewConversationSheet`, a
`<dialog>` around the SAME `NewConversationForm` the desktop Sidebar shows in
its modal (`layout: 'modal' | 'sheet'`, T20-F). The form creates a chat through
the core `createConversation` action (there is no second creation spine; the
old "New swarm" option was deleted 2026-11-12):

- `createBuddyViaBuilder()` (re-exported by `mobile/atoms/create.ts`) is a different shape (no directory, no config):
  `POST /api/buddies/builder` with a client-owned `conversationId`, then route
  to the returned Builder thread.

`recentDirectoriesAtom` (`atoms/conversations.ts`) is shared with the desktop
`PathAutocomplete` — it replaced a local `useMemo` in `Sidebar.tsx` so the two
trees cannot drift on what counts as a recent folder.

### UI state

`atoms/ui.ts` holds device-local state only. Nothing in it syncs to the server:

- **prefs** (`atomWithStorage` under `localStorage['unleashd-ui-local']`) — `{ galleryExpandedProjects, galleryCollapsedProjects, showTempSessions, showDoneConversations, showWorkerConversations, lastWorkingDirectory, promotedWorkers }`
- **seen** (`localStorage['unleashd-seen-message-index']`) — NEW-badge message index per conversation, its own key because it changes on every viewed message

Done (hidden) is not UI state: it is `conversation.done`, stored on the
server's conversation record and changed with the `set_conversation_done`
WebSocket command. Until 2026-09-24 it lived with the NEW-badge indexes in a
server-synced blob (`ui-state.json`, debounced `POST /api/ui-state`) keyed by
`sessionId ?? id`. The server rotates sessionId, and the snapshot POST lost
writes on refresh and reconnect, so hidden conversations kept reappearing.
The server retired that file once (`retireLegacyUiState`, deleted in T23b after
the live retirement ran).

Storage reads go through `DeviceUiPrefsSchema.partial().safeParse` (discard whole
blob on failure — no silent half-merge). Read with `useAtomValue(prefsAtom).field`;
mutate only via exported action functions. Phone never mutates desktop-local
fields. The active conversation is the route, never a pref.

### Mutation rule

Writes live in `client/src/atoms/` only. Keyed stores (rows, transcripts,
streams) are written through their `patch` atom for the ids an event names;
everything else is a plain `jotaiStore.set` of a new value. `mutate()` and
immer were removed in T19. See [client state](client-state.md).

### Single-bridge + single-handler rules

- **Single bridge:** only `App.tsx` `AppInner` mounts `useWebSocketBridge` (hoisted above `AppRoutes`). Never mount a second bridge in `mobile/` — it would double-connect and fight over `sendFnAtom`/`wsStatusAtom`.
- **Never a second `handleMessage`:** the WS-push → `handleMessage` (`atoms/actions.ts`) dispatcher is the single shared spine. Mobile consumes it through the hoisted bridge; no mobile file defines its own handler.

---

### Channels: same URL, per-device mount

`/buddies/workspaces/:id/channels?channel=&thread=` is one URL on both devices.
Desktop mounts `WorkspaceSlack` OUTSIDE the shell (its rail replaces the
sidebar); mobile mounts `ChannelsMobile` INSIDE `ShellMobile` (`App.tsx`:
`OUTSIDE_SHELL` / `INSIDE_SHELL` keyed by `DeviceKind`). On mobile the query
picks Home ⊕ Channel ⊕ Thread ⊕ Task (`mobile/channels/channel-route.ts`; Task is
the desktop `?channel=&task=` Task filter, restored on mobile by the 2026-09-26
feature audit after the lean rewrite left it desktop-only); every screen but Home
is an immersive pane, so ShellMobile hides the tab bar there and uses the
pane layout. Shared, CSS-owning pieces come from `components/buddies/`
(`ChannelMarkdown`, `ChannelComposer`, `channel-data.ts`); a channel post's
purpose is read through `postPurposeLabel`/`postPurposeTag`, since gate G2 greps
for raw `.purpose` in `mobile/`.

### One conversation pane, two entry points

`mobile/conversations/ConversationView.tsx` is the only mobile conversation UI.
`ChatMobile` is a 15-line route wrapper for `/chat/:id`; buddy threads route to
the same place, and any buddy surface wanting an inline thread embeds
`ConversationView` directly. Logic added to `ChatMobile` is logic buddy threads
silently do not get — keep it a wrapper.

Shared with desktop rather than reimplemented:
- `atoms/fork-actions.ts` — `forkConversation()` used by both `Chat.tsx` and the
  mobile header. Soft handoff: new conversation + `resumedFromConversationId` +
  transcript seeded into `draft:<new id>`.
- `utils/conversation-transcript.ts` — transcript and fork-draft text.
- `utils/ids.ts` — `newId()`. `crypto.randomUUID` is secure-context-gated and is
  `undefined` over a plain-http LAN IP, which is exactly how phones reach the dev
  server. Gate G4 bans bare `crypto.randomUUID`.

### Layout contract: panes fill their parent, never the viewport

`.mobile-content` is already `100dvh − tab-bar`. A route that sizes itself to the
viewport ends up taller than its own scrollport, and anything pinned to its
bottom edge (the composer) lands underneath the tab bar — unreachable, because
the inner message list's `overscroll-behavior: contain` blocks scroll chaining
to the outer container.

`ShellMobile` therefore has two layout modes, keyed on the route:
- list routes scroll as a page — `.mobile-content__inner` is `flex: 1 0 auto`
- `/chat/*` is a fixed-height pane — `.mobile-content--pane` makes the inner
  `flex: 1 1 0` so it has a *definite* height and the pane scrolls internally

`height: 100%` alone does not work here: against an `auto`-basis parent it falls
back to content height, which produced a 43,000px pane.
