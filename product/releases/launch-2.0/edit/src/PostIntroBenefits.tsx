// The four benefits land one per bar of the build (script v2, 2026-09-30): the promise rides the
// build and the drop starts the proof. Behind them, the new workspace home (owner, 2026-10-02: it
// replaces the old home take as the first product screen; see HomeIntro.tsx for the image).
import type React from 'react';
import { AbsoluteFill, Img, Sequence, useCurrentFrame } from 'remotion';
import { Block, INK, lerp } from './blocks';
import { HOME, HOME_SRC, SIDEBAR_W } from './HomeIntro';
import { SFX, Soundtrack } from './soundtrack';

export const FPS = 60;
export const WIDTH = 1920;
export const HEIGHT = 1080;
const BEAT = 60 / 128;
export const boundary = (i: number) => Math.round(i * 4 * BEAT * FPS);
export const DURATION = boundary(4);

export const TITLES = [
  { lines: ['Multi harness'], fill: INK.cyan, rot: -2 },
  { lines: ['Completely free'], fill: '#FDDB00', rot: 2 },
  { lines: ['Open source'], fill: INK.wordmarkOrange, rot: -2 },
  { lines: ['Completely', 'customizable'], fill: INK.cyan, rot: 1.5 },
];

// The card is 1780 px wide; the screenshot (HOME_SRC) is about 3:2, so the card shows its top.
const CARD_W = 1780;
const Home: React.FC = () => (
  <>
    <Img src={HOME} style={{ position: 'absolute', left: 0, top: 0, width: CARD_W, height: Math.round((CARD_W * HOME_SRC.h) / HOME_SRC.w) }} />
    <div
      style={{
        position: 'absolute',
        left: 0,
        top: 0,
        width: Math.round((SIDEBAR_W / 1920) * CARD_W),
        height: '100%',
        backdropFilter: 'blur(12px)',
        background: 'rgba(5,9,11,.35)',
      }}
    />
  </>
);

export const PostIntroBenefits: React.FC = () => {
  const frame = useCurrentFrame();
  const index = TITLES.findLastIndex((_, i) => frame >= boundary(i));
  const title = TITLES[index];
  const u = (frame - boundary(index)) / FPS;
  return (
    <AbsoluteFill style={{ background: INK.plate, overflow: 'hidden' }}>
      <div
        style={{
          position: 'absolute', left: 70, top: 62, width: 1780, height: 690,
          borderRadius: 24, overflow: 'hidden',
          boxShadow: '0 32px 80px rgba(0,0,0,.45)',
          border: '1px solid rgba(253,246,227,.14)',
          transform: `scale(${lerp(1, 1.055, frame / DURATION)})`,
        }}
      >
        <Home />
      </div>
      <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(0deg, #002b36 2%, transparent 35%)' }} />
      <div style={{ position: 'absolute', left: 80, right: 80, bottom: 75, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
        {title.lines.map((line, i) => (
          <div key={`${index}-${line}`} style={{ transform: title.lines.length > 1 ? 'scale(.85)' : undefined, marginTop: title.lines.length > 1 && i > 0 ? -20 : 0 }}>
            <Block text={line} u={u - i * 0.07} size="xl" fill={title.fill} ink={INK.plate} rot={i % 2 ? -title.rot : title.rot} />
          </div>
        ))}
      </div>
    </AbsoluteFill>
  );
};

// One soft thud marks each benefit. The marimba handoff that used to thin out here into the old EDM
// build is gone (2026-10-05): the launch song now runs straight through, and the handoff's
// Bm G D A clashed with the song's D A Bm G under these bars (G over A on the second benefit).
export const BenefitsSound: React.FC = () => (
  <Soundtrack
    fps={FPS}
    cues={TITLES.map((_, i) => ({ at: boundary(i) / FPS, src: SFX.thud, volume: 0.13 }))}
  />
);

export const BenefitsWithSound: React.FC = () => (
  <AbsoluteFill>
    <PostIntroBenefits />
    <Sequence layout="none"><BenefitsSound /></Sequence>
  </AbsoluteFill>
);
