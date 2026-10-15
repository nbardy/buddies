import { WS_PATH } from '@unleashd/shared';
import { Provider } from 'jotai';
import {
  type ComponentType,
  type LazyExoticComponent,
  type ReactElement,
  Suspense,
  lazy,
  useEffect,
} from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { handleMessage } from './atoms/actions';
import { jotaiStore } from './atoms/store';
import { UpdateBanner } from './components/UpdateBanner';
import { UpstreamUpdatePrompt } from './components/buddies/UpstreamUpdatePrompt';
import { useOwnerUnreadTitle } from './components/buddies/channel-data';
import { useWebSocket } from './hooks/useWebSocket';
import { type DeviceKind, useDeviceKind } from './mobile/hooks/useDeviceKind';
import { initSettings } from './stores/settingsStore';
import { SWARM_PAGE_LOADERS } from './swarm';
import { ConnectMobile } from './views/dependencies/ConnectMobile';
import { DependenciesPrompt } from './views/dependencies/DependenciesPrompt';
import './App.css';
import './views/dependencies/DependenciesPrompt.css';
import './components/buddies/BuddyDetail.css';

// =============================================================================
// κ: location.protocol → ws:// | wss://  (exhaustive D3, no silent fallback)
// Verification: http: → ws://, https: → wss://, else throw typed Error.
// Required before any https:// test; otherwise mixed-content blocks (PLANNING §5 #2).
// =============================================================================
function wsUrlForLocation(loc: Location): string {
  const protocol = loc.protocol;
  if (protocol === 'http:') {
    return `ws://${loc.host}${WS_PATH}`;
  }
  if (protocol === 'https:') {
    return `wss://${loc.host}${WS_PATH}`;
  }
  throw new Error(`Unsupported protocol for WebSocket: ${protocol}`);
}

/**
 * Connects the useWebSocket hook to the Jotai atom store.
 * Hoisted to App above AppRoutes so there is exactly one socket (§3).
 */
function useWebSocketBridge() {
  const wsUrl = wsUrlForLocation(window.location);
  useWebSocket(wsUrl, handleMessage);
}

// `/` is the workspace home (port of 6d04860). It used to restore the last
// conversation on desktop, which bounced this screen into a chat on every load;
// the conversation list lives at /chats.

// =============================================================================
// Code splitting. Every shell and route is its own chunk, loaded on first use,
// so the entry chunk holds only the store, the socket and this table. It used
// to import every route statically: one 1.12 MB chunk carried both device
// trees, of which a session ever renders one.
// =============================================================================

// biome-ignore lint/suspicious/noExplicitAny: React's own bound for lazy() components.
type AnyComponent = ComponentType<any>;

// Pattern: fix-guards (docs/patterns.md#fix-guards)
// Warming every route at startup loaded 15 unused swarm modules/styles on /buddies.
// Load routes on use; guard: tools/check-route-loading.mjs.
/** A named export loaded on first render. */
function lazyNamed<C extends AnyComponent>(load: () => Promise<C>): LazyExoticComponent<C> {
  return lazy(async () => ({ default: await load() }));
}

// Desktop tree
const ShellDesktop = lazyNamed(() =>
  import('./components/ShellDesktop').then((m) => m.ShellDesktop)
);
const Gallery = lazyNamed(() => import('./components/Gallery').then((m) => m.Gallery));
const ChatRoute = lazyNamed(() => import('./components/Chat').then((m) => m.ChatRoute));
const BuddiesDashboard = lazyNamed(() =>
  import('./components/BuddiesDashboard').then((m) => m.BuddiesDashboard)
);
const SwarmDashboard = lazyNamed(SWARM_PAGE_LOADERS.dashboard);
const SwarmDetail = lazyNamed(SWARM_PAGE_LOADERS.detail);
const SwarmAnalytics = lazyNamed(SWARM_PAGE_LOADERS.analytics);
const WorkspaceSlack = lazyNamed(() =>
  import('./components/buddies/ChannelBrowser').then((m) => m.WorkspaceSlack)
);

// Shared by both trees (components/buddies is the one desktop folder mobile may use)
const BuddyWorkspaceActivity = lazyNamed(() =>
  import('./components/buddies/BuddyWorkspaceActivity').then((m) => m.BuddyWorkspaceActivity)
);
const ChannelsIndex = lazyNamed(() =>
  import('./mobile/channels/ChannelsIndex').then((m) => m.ChannelsIndex)
);
const WorkspaceHome = lazyNamed(() =>
  import('./components/buddies/WorkspaceHome').then((m) => m.WorkspaceHome)
);

// Mobile tree
const ShellMobile = lazyNamed(() =>
  import('./mobile/components/ShellMobile').then((m) => m.ShellMobile)
);
const ConversationListMobile = lazyNamed(() =>
  import('./mobile/conversations/ConversationListMobile').then((m) => m.ConversationListMobile)
);
const ChatMobile = lazyNamed(() =>
  import('./mobile/conversations/ConversationView').then((m) => m.ChatMobile)
);
const BuddiesMobile = lazyNamed(() =>
  import('./mobile/buddies/BuddiesMobile').then((m) => m.BuddiesMobile)
);
const BuddyDetailMobile = lazyNamed(() =>
  import('./mobile/buddies/BuddyDetailMobile').then((m) => m.BuddyDetailMobile)
);
const SearchMobile = lazyNamed(() =>
  import('./mobile/search/SearchMobile').then((m) => m.SearchMobile)
);
const ChannelsMobile = lazyNamed(() =>
  import('./mobile/channels/ChannelsMobile').then((m) => m.ChannelsMobile)
);

// =============================================================================
// RouteTable — element FACTORIES, not ComponentType (§3).
// ComponentType silently drops props: `desktop: Gallery` for "/done" compiles
// (filter is optional) and renders the wrong view. Factories make
// "/done" → <Gallery filter="done"/> expressible.
// =============================================================================
type RouteDef = { path: string; desktop: () => ReactElement; mobile: () => ReactElement };

const ROUTES: RouteDef[] = [
  {
    path: '/chats',
    desktop: () => <Gallery />,
    mobile: () => <ConversationListMobile scope="chats" />,
  },
  { path: '/chat/:id', desktop: () => <ChatRoute />, mobile: () => <ChatMobile /> },
  { path: '/buddies', desktop: () => <BuddiesDashboard />, mobile: () => <BuddiesMobile /> },
  {
    path: '/buddies/workspaces/:workspaceId',
    desktop: () => <BuddyWorkspaceActivity />,
    mobile: () => <BuddyWorkspaceActivity />,
  },
  {
    path: '/buddies/:buddyId',
    desktop: () => <BuddiesDashboard />,
    mobile: () => <BuddyDetailMobile />,
  },
  // Employee sections are pages, not local tab state — see
  // components/buddies/buddy-tabs.ts. `/buddies/:buddyId` canonicalises itself
  // onto this route, so Back out of Automations lands on the previous tab.
  {
    path: '/buddies/:buddyId/:tab',
    desktop: () => <BuddiesDashboard />,
    mobile: () => <BuddyDetailMobile />,
  },
  {
    path: '/workers',
    desktop: () => <SwarmDashboard layout="wide" />,
    mobile: () => <SwarmDashboard layout="narrow" />,
  },
  {
    path: '/workers/detail',
    desktop: () => <SwarmDetail layout="wide" />,
    mobile: () => <SwarmDetail layout="narrow" />,
  },
  {
    path: '/workers/analytics',
    desktop: () => <SwarmAnalytics layout="wide" />,
    mobile: () => <SwarmAnalytics layout="narrow" />,
  },
  {
    path: '/done',
    desktop: () => <Gallery filter="done" />,
    mobile: () => <ConversationListMobile />,
  },
  { path: '/search', desktop: () => <Gallery />, mobile: () => <SearchMobile /> },
  // The Channels tab's entry: redirects to the first workspace's channels.
  { path: '/channels', desktop: () => <ChannelsIndex />, mobile: () => <ChannelsIndex /> },
];

// Channels mount differently per device, at the SAME URL so links travel.
// Desktop: a full-screen surface OUTSIDE the shell — its channel rail replaces
// the conversations sidebar (inside the shell it rendered as a second sidebar
// nested beside the first; owner feedback 2026-09-23).
// Mobile: inside the shell, Slack-style — Home keeps the tab bar, a channel or
// thread is an immersive pane (ShellMobile hides the tab bar there).
// The workspace home at `/` follows the same split: desktop full-screen with
// no conversations sidebar (owner, 2026-09-25), mobile inside the tab bar.
const CHANNELS_PATH = '/buddies/workspaces/:workspaceId/channels';
const OUTSIDE_SHELL: Record<DeviceKind, ReactElement | null> = {
  desktop: (
    <>
      <Route path={CHANNELS_PATH} element={<WorkspaceSlack />} />
      <Route path="/" element={<WorkspaceHome />} />
    </>
  ),
  mobile: null,
};
const INSIDE_SHELL: Record<DeviceKind, ReactElement | null> = {
  desktop: null,
  mobile: (
    <>
      <Route
        path="/"
        element={
          <Suspense fallback={null}>
            <WorkspaceHome />
          </Suspense>
        }
      />
      <Route
        path={CHANNELS_PATH}
        element={
          <Suspense fallback={null}>
            <ChannelsMobile />
          </Suspense>
        }
      />
    </>
  ),
};

const SHELLS: Record<DeviceKind, ComponentType> = {
  desktop: ShellDesktop,
  mobile: ShellMobile,
};

// The route-level boundary sits inside the shell, so loading a destination never
// blanks the sidebar or tab bar.
function AppRoutes({ device }: { device: DeviceKind }) {
  const Shell = SHELLS[device]; // δ #1 — shell
  const pick = (r: RouteDef) => (device === 'mobile' ? r.mobile() : r.desktop()); // δ #2 — leaf
  return (
    <Suspense fallback={null}>
      <Routes>
        {OUTSIDE_SHELL[device]}
        <Route element={<Shell />}>
          {ROUTES.map((r) => (
            <Route
              key={r.path}
              path={r.path}
              element={<Suspense fallback={null}>{pick(r)}</Suspense>}
            />
          ))}
          {INSIDE_SHELL[device]}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </Suspense>
  );
}

// A phone is the thing being connected, so only desktop Setup offers it.
const SETUP_SECTIONS: Record<DeviceKind, ReactElement | null> = {
  desktop: <ConnectMobile />,
  mobile: null,
};

function AppInner() {
  const device = useDeviceKind();
  useWebSocketBridge();
  useOwnerUnreadTitle();

  useEffect(() => {
    initSettings().catch(console.error);
  }, []);

  return (
    <>
      <DependenciesPrompt>{SETUP_SECTIONS[device]}</DependenciesPrompt>
      <UpdateBanner />
      <AppRoutes device={device} />
      {/* App-wide, outside both shells: it shows on every route of either tree. */}
      <UpstreamUpdatePrompt device={device} />
    </>
  );
}

function App() {
  return (
    <Provider store={jotaiStore}>
      <BrowserRouter>
        <AppInner />
      </BrowserRouter>
    </Provider>
  );
}

export default App;
