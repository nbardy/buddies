// Separate entry: the rebrand drafts render without touching Root.tsx (another cut is mid-edit there).
// pnpm exec remotion still src/wordmark-entry.tsx BuddiesWordmark out/buddies-<option>.png --props='{"option":"aurora"}'
// pnpm exec remotion still src/wordmark-entry.tsx BuddiesLogoSheet out/buddies-logo-sheet.png
// pnpm exec remotion render src/wordmark-entry.tsx BuddiesLogoReel out/buddies-logo-reel.mp4 --crf=16
// pnpm exec remotion render src/wordmark-entry.tsx KitReel out/buddies-kit-reel.mp4 --crf=16
// pnpm exec remotion render src/wordmark-entry.tsx Intro-5-drop out/buddies-intro-5-drop.mp4 --crf=16   (-trailer, -impact)
// pnpm exec remotion still src/wordmark-entry.tsx KitOg out/buddies-og.png   (also KitBanner, KitAvatar, Kit-<page>)
import { Composition, registerRoot } from 'remotion';
import * as I from './BuddiesIntro';
import * as K from './BuddiesKit';
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
    {(Object.keys(I.HITS) as I.Hit[]).map((hit) => (
      <Composition key={hit} id={`Intro-5-${hit}`} component={I.IntroStandalone} defaultProps={{ count: 5, hit } satisfies I.StandaloneProps} durationInFrames={I.standaloneFrames(5)} fps={I.FPS} width={1920} height={1080} />
    ))}
    <Composition id="KitReel" component={K.KitReel} durationInFrames={K.REEL_FRAMES} fps={K.FPS} width={1920} height={1080} />
    {K.PAGES.map((p) => (
      <Composition key={p} id={`Kit-${p}`} component={K.KitPage} defaultProps={{ page: p }} durationInFrames={K.frames(p)} fps={K.FPS} width={1920} height={1080} />
    ))}
    <Composition id="KitOg" component={K.OgCard} durationInFrames={1} fps={K.FPS} width={1200} height={630} />
    <Composition id="KitBanner" component={K.Banner} durationInFrames={1} fps={K.FPS} width={1280} height={320} />
    <Composition id="KitAvatar" component={K.Avatar} durationInFrames={1} fps={K.FPS} width={512} height={512} />
  </>
));
