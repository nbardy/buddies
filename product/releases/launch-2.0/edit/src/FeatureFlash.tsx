// "Mobile Friendly!", two bars, the first scene after the swarm (owner, 2026-10-05: "that should be
// first"), on the owner's own phone take of 2026-09-28 (footage P), the image grids scrolling at 1.7x. It
// was one bar on a 1.9 s cut of the same thread, late in the video. "Multiagent swarms" became its own two-bar scene
// (Swarm.tsx, from the owner's 2026-09-30 take; the old swarm screenshot was the previous product).
// "Memory!" is out for now: its capture shows another Buddy's soul text and a local path, and the old
// UI. "Familiar UI" went in script v2; the product scenes show it. Each card sits over a real capture of the running app
// (../capture/record-page.mjs; ../footage/FOOTAGE.md, "Feature clips"). Desktop captures are
// lifted out as a card of the main column, so the sidebar's real Buddy names stay blurred.
import type React from 'react';
import { AbsoluteFill, Easing, OffthreadVideo, Series, staticFile, useCurrentFrame } from 'remotion';
import { Block, clamp01, INK, lerp } from './blocks';
import { CardEdit, type Key, play, push, STILL, type Shot } from './card';

export { FPS, HEIGHT, WIDTH } from './card';

const BEAT = 60 / 128;
const FLASH_BEATS = 8;
// Round per boundary so the flashes fill whole bars (a bar is 112.5 frames).
const boundary = (i: number) => Math.round(i * FLASH_BEATS * BEAT * 60);

const clip = (name: string) => staticFile(`2026-09-26_feature_${name}.mp4`);

// The main column of a 2974×1882 desktop capture (the sidebar ends at x ≈ 560).
const column = (top: number, ox: number, oy: number): Shot => ({ focus: 1, x: 560, w: 2414, top, scale: 0.74, ...STILL, ox, oy });

type Desktop = { kind: 'desktop'; name: string; from: number; shot: Shot };
type Phone = { kind: 'phone'; src: string; from: number; rate: number }; // from: source seconds
type Footage = Desktop | Phone;
type Flash = { text: string; fill: string; rot: number; footage: Footage };

const FLASHES: Flash[] = [
  // Footage P scrolls the art-direction thread for 6.4 s, then idles and ends on Control Center.
  { text: 'Mobile Friendly!', fill: '#859900', rot: 3, footage: { kind: 'phone', src: staticFile('2026-09-28_mobile_P_art-direction-thread-scroll.mp4'), from: 0, rate: 1.7 } },
];

export const DURATION = boundary(FLASHES.length);

const DesktopShot: React.FC<{ f: Desktop; frames: number }> = ({ f, frames }) => {
  const seconds = frames / 60;
  const camera: Key[] = [
    { t: 0, shot: f.shot },
    { t: seconds, shot: push(f.shot, 1.08) },
  ];
  return <CardEdit src={clip(f.name)} cuts={[play(f.from, f.from + seconds, 1, f.name)]} camera={camera} />;
};

// A phone capture stands upright in the middle of the plate, pushing in slightly.
const PhoneShot: React.FC<{ f: Phone; frames: number }> = ({ f, frames }) => {
  const t = useCurrentFrame();
  const settle = Easing.out(Easing.cubic)(clamp01(t / frames));
  return (
    <AbsoluteFill style={{ background: INK.plate, alignItems: 'center', justifyContent: 'center' }}>
      <div
        style={{
          height: 980,
          borderRadius: 54,
          overflow: 'hidden',
          border: `12px solid ${INK.night}`,
          boxShadow: '0 40px 100px rgba(0,0,0,.55)',
          transform: `translateX(260px) scale(${lerp(1, 1.05, settle)})`,
        }}
      >
        <OffthreadVideo src={f.src} trimBefore={Math.round(f.from * 60)} playbackRate={f.rate} muted style={{ display: 'block', height: '100%' }} />
      </div>
    </AbsoluteFill>
  );
};

const FootageShot: React.FC<{ f: Footage; frames: number }> = ({ f, frames }) =>
  f.kind === 'desktop' ? <DesktopShot f={f} frames={frames} /> : <PhoneShot f={f} frames={frames} />;

const Card: React.FC<{ flash: Flash }> = ({ flash }) => {
  const t = useCurrentFrame() / 60;
  return (
    <div style={{ position: 'absolute', left: 110, bottom: 110 }}>
      <Block text={flash.text} u={t} size="xl" fill={flash.fill} ink={INK.plate} rot={flash.rot} />
    </div>
  );
};

export const FeatureFlash: React.FC = () => (
  <Series>
    {FLASHES.map((flash, i) => (
      <Series.Sequence key={flash.text} durationInFrames={boundary(i + 1) - boundary(i)}>
        <AbsoluteFill style={{ background: INK.night }}>
          <FootageShot f={flash.footage} frames={boundary(i + 1) - boundary(i)} />
          <Card flash={flash} />
        </AbsoluteFill>
      </Series.Sequence>
    ))}
  </Series>
);
