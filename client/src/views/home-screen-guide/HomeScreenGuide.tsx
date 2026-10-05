import { useAtomValue } from 'jotai';
import { type CSSProperties, useEffect, useState } from 'react';
import {
  dismissHomeScreenGuide,
  homeScreenGuideDismissedAtom,
  setupDismissedAtom,
} from '../../atoms/ui';
import {
  type HomeScreenOffer,
  type InstallPlatform,
  homeScreenOffer,
  probeBrowser,
} from './home-screen-offer';

// Pattern: table-driven (docs/patterns.md#table-driven)
const STEPS: Record<InstallPlatform, { title: string; steps: string[] }> = {
  ios: {
    title: 'On iPhone or iPad',
    steps: [
      'Tap Share ⬆︎ (in Safari on iOS 26 it is under the ••• button).',
      'Scroll down and tap Add to Home Screen.',
      'Tap Add. Open Buddies from your Home Screen.',
    ],
  },
  android: {
    title: 'On Android',
    steps: [
      'Tap the ⋮ menu at the top right of Chrome.',
      'Tap Add to Home screen (or Install app).',
      'Tap Install. Open Buddies from your Home screen.',
    ],
  },
  other: {
    title: 'In your browser',
    steps: [
      'Open the browser menu.',
      'Choose Add to Home Screen or Install.',
      'Open Buddies from your Home Screen.',
    ],
  },
};

// A non-modal <dialog open>: reset the UA's centred, fit-content box to a bottom sheet.
const sheet: CSSProperties = {
  position: 'fixed',
  inset: 'auto 0 0',
  width: 'auto',
  maxWidth: 'none',
  margin: 0,
  border: 'none',
  zIndex: 1000,
  padding: 'var(--sp-9) var(--sp-9) calc(var(--sp-9) + env(safe-area-inset-bottom))',
  background: 'var(--bg-panel)',
  borderTop: '2px solid var(--accent-primary)',
  boxShadow: '0 -24px 80px rgb(0 0 0 / 45%)',
  color: 'var(--text-primary)',
};

// First mobile browser visit: how to put Buddies on the Home Screen. Once per
// device; never in an installed launch, which has nothing left to install. It
// waits for Setup to close so a first visit never stacks two dialogs.
export function HomeScreenGuide() {
  const dismissed = useAtomValue(homeScreenGuideDismissedAtom);
  const setupOpen = !useAtomValue(setupDismissedAtom);
  // Probed after mount: there is no browser to ask during a server render (null = not yet asked).
  const [offer, setOffer] = useState<HomeScreenOffer | null>(null);
  useEffect(() => setOffer(homeScreenOffer(probeBrowser())), []);
  if (dismissed || setupOpen || offer === null || offer.kind === 'installed') return null;
  const guide = STEPS[offer.platform];
  return (
    <>
      <div
        aria-hidden="true"
        onClick={dismissHomeScreenGuide}
        style={{ position: 'fixed', inset: 0, zIndex: 999, background: 'rgb(0 0 0 / 50%)' }}
      />
      <dialog open aria-labelledby="home-screen-guide-title" style={sheet}>
        <h2
          id="home-screen-guide-title"
          style={{ margin: 0, fontSize: 'var(--fs-7)', fontWeight: 600 }}
        >
          Add Buddies to your Home Screen
        </h2>
        <p style={{ margin: 'var(--sp-4) 0 0', color: 'var(--text-secondary)' }}>
          It opens full screen like an app. {guide.title}:
        </p>
        <ol style={{ margin: 'var(--sp-6) 0 0', paddingLeft: 'var(--sp-8)', lineHeight: 1.6 }}>
          {guide.steps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
        <p style={{ margin: 'var(--sp-6) 0 0', color: 'var(--text-secondary)' }}>
          You may need to sign in once more inside the app.
        </p>
        <button
          type="button"
          onClick={dismissHomeScreenGuide}
          style={{
            width: '100%',
            marginTop: 'var(--sp-8)',
            padding: 'var(--sp-6)',
            border: 'none',
            background: 'var(--accent-primary)',
            color: 'var(--text-on-accent)',
            font: 'inherit',
            fontWeight: 600,
          }}
        >
          Got it
        </button>
      </dialog>
    </>
  );
}
