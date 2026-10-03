// Separate entry: the rebrand drafts render without touching Root.tsx (another cut is mid-edit there).
// pnpm exec remotion still src/wordmark-entry.tsx BuddiesWordmark out/buddies-<option>.png --props='{"option":"aurora"}'
// pnpm exec remotion still src/wordmark-entry.tsx BuddiesLogoSheet out/buddies-logo-sheet.png
// pnpm exec remotion render src/wordmark-entry.tsx BuddiesLogoReel out/buddies-logo-reel.mp4 --crf=16
import { Composition, registerRoot } from 'remotion';
import * as L from './BuddiesLogos';
import * as W from './BuddiesWordmark';

registerRoot(() => (
  <>
    <Composition
      id="BuddiesWordmark"
      component={W.BuddiesWordmark}
      defaultProps={{ option: 'aurora' } satisfies W.Props}
      durationInFrames={1}
      fps={60}
      width={W.WIDTH}
      height={W.HEIGHT}
    />
    <Composition id="BuddiesLogoSheet" component={L.LogoSheet} durationInFrames={1} fps={L.FPS} width={L.WIDTH} height={L.HEIGHT} />
    <Composition
      id="BuddiesLogoReel"
      component={L.LogoReel}
      durationInFrames={L.REVEAL * L.CONCEPTS.length}
      fps={L.FPS}
      width={L.WIDTH}
      height={L.HEIGHT}
    />
  </>
));
