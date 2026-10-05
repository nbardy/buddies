// κ: the browser → whether to offer Add to Home Screen, and with which steps.
// Pattern: sum-types (docs/patterns.md#sum-types)

export type InstallPlatform = 'ios' | 'android' | 'other';
export type HomeScreenOffer =
  | { kind: 'installed' }
  | { kind: 'browser'; platform: InstallPlatform };

export type BrowserProbe = {
  userAgent: string;
  maxTouchPoints: number;
  /** iOS Safari's own flag for a Home Screen launch; absent elsewhere. */
  standalone?: boolean;
  displayModeStandalone: boolean;
};

export function homeScreenOffer(probe: BrowserProbe): HomeScreenOffer {
  // iOS reports a Home Screen launch through navigator.standalone, and older
  // versions never match the display-mode query: either one means installed.
  if (probe.displayModeStandalone || probe.standalone === true) return { kind: 'installed' };
  return { kind: 'browser', platform: platformOf(probe) };
}

function platformOf({ userAgent, maxTouchPoints }: BrowserProbe): InstallPlatform {
  if (/iPhone|iPad|iPod/.test(userAgent)) return 'ios';
  // iPadOS Safari asks for desktop sites and sends a Mac user agent; only touch
  // gives it away. Without this an iPad got the generic steps.
  if (/Macintosh/.test(userAgent) && maxTouchPoints > 1) return 'ios';
  if (/Android/.test(userAgent)) return 'android';
  return 'other';
}

export function probeBrowser(): BrowserProbe {
  return {
    userAgent: navigator.userAgent,
    maxTouchPoints: navigator.maxTouchPoints,
    standalone: (navigator as Navigator & { standalone?: boolean }).standalone,
    displayModeStandalone: window.matchMedia('(display-mode: standalone)').matches,
  };
}
