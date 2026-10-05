// The AI color themes short (owner, 2026-10-06): the palette scene was "too much" inside the launch
// video, so it is its own quick product video, framed by "the buddies intro and outro with the
// little jingle":
//
//   bar 1-3   the Buddies intro: the robots pop on the boops ("doop doop doop") and lock on the drop
//   bar 4     "AI color theme generation."
//   bar 5-12  the owner's take (../trim-palette-short.sh, 15 s): the camera zooms in on the prompt as
//             it is typed, follows "Let the AI Cook" to the chef, pulls back for the Matrix palette
//             and the app turning green
//   bar 13    the end card ("buddies", the link) over the song's last chord, 6 s
//
// Sound: ../../sound/palette_short.py, the launch song's jingle, drop and ending on the same grid;
// its cue 0 is BuddiesIntro.POP_AT. bar(b) = POP_AT + (b - 1) bars, in frames.
import type React from 'react';
import { AbsoluteFill, Audio, Easing, OffthreadVideo, Sequence, useCurrentFrame } from 'remotion';
import clip from '../../clips/11_ai-color-themes-short.mp4';
import song from '../../sound/palette-short.wav';
import { BuddiesIntro, POP_AT } from './BuddiesIntro';
import { Stage, Words } from './BuddiesKit';
import { EndCard, END_FRAMES } from './Close';

export const FPS = 60;
export const WIDTH = 1920;
export const HEIGHT = 1080;

const CUE = Math.round(POP_AT * FPS);
const bar = (b: number) => CUE + Math.round((b - 1) * 112.5);
export const DURATION = bar(13) + END_FRAMES;

// ---- The take as a card, 1518×1000, with a camera: centre (cx, cy) in source px and a zoom.
const SRC = { w: 2750, h: 1812 };
const CARD = { w: 1518, h: 1000 };
const BASE = CARD.h / SRC.h;
type Cam = { cx: number; cy: number; z: number };
const FULL: Cam = { cx: SRC.w / 2, cy: SRC.h / 2, z: 1 };
const PROMPT: Cam = { cx: 1390, cy: 480, z: 2.1 }; // the prompt line and, below it, the Cook button
const CHEF: Cam = { cx: 1630, cy: 770, z: 1.7 }; // the cooking stage
const DIALOG: Cam = { cx: 1395, cy: 940, z: 1.15 }; // the whole Color Palette dialog
const at = (z: number, c: Cam): Cam => ({ ...c, z });

// Clip seconds (the trim's timeline). Two neighbouring keys ease into each other.
const CAMERA: { t: number; cam: Cam }[] = [
  { t: 0, cam: FULL },
  { t: 2.7, cam: at(1.04, FULL) }, // gear → Color Palette → AI Generate
  { t: 3.25, cam: PROMPT }, // typing starts at 3.0
  { t: 6.9, cam: at(2.25, PROMPT) }, // "Let the AI Cook" pressed at 6.8
  { t: 7.6, cam: CHEF }, // the chef appears at 8.0
  { t: 11.4, cam: at(1.85, CHEF) },
  { t: 12.0, cam: DIALOG }, // Matrix Rain lands at 11.75
  { t: 13.4, cam: at(1.2, DIALOG) }, // Save
  { t: 14.0, cam: FULL }, // the app in green
  { t: 15.0, cam: at(1.03, FULL) },
];

const ease = Easing.inOut(Easing.cubic);
const lerp = (a: number, b: number, u: number) => a + (b - a) * u;
const camAt = (t: number): Cam => {
  const i = Math.max(0, CAMERA.findLastIndex((k) => k.t <= t));
  const a = CAMERA[i];
  const b = CAMERA[Math.min(i + 1, CAMERA.length - 1)];
  const u = b.t > a.t ? ease(Math.min(1, (t - a.t) / (b.t - a.t))) : 0;
  return { cx: lerp(a.cam.cx, b.cam.cx, u), cy: lerp(a.cam.cy, b.cam.cy, u), z: lerp(a.cam.z, b.cam.z, u) };
};
// Keep the frame inside the take: never show past its edges.
const clampTo = (c: number, half: number, size: number) => Math.min(size - half, Math.max(half, c));

const Take: React.FC = () => {
  const t = useCurrentFrame() / FPS;
  const cam = camAt(t);
  const s = BASE * cam.z;
  const cx = clampTo(cam.cx, CARD.w / 2 / s, SRC.w);
  const cy = clampTo(cam.cy, CARD.h / 2 / s, SRC.h);
  return (
    <Stage t={t} glow={0.22}>
      <div
        style={{
          position: 'absolute',
          left: (WIDTH - CARD.w) / 2,
          top: (HEIGHT - CARD.h) / 2,
          width: CARD.w,
          height: CARD.h,
          overflow: 'hidden',
          borderRadius: 14,
          boxShadow: '0 40px 110px rgba(0,0,0,.55)',
        }}
      >
        <OffthreadVideo
          src={clip}
          muted
          style={{ position: 'absolute', width: SRC.w * s, height: SRC.h * s, left: CARD.w / 2 - cx * s, top: CARD.h / 2 - cy * s, maxWidth: 'none' }}
        />
      </div>
    </Stage>
  );
};

const Title: React.FC = () => {
  const t = useCurrentFrame() / FPS;
  return (
    <Stage t={t}>
      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', padding: '0 160px' }}>
        <Words segs={[['AI', 'cream'], ['color theme', 'violet'], ['generation.', 'cream']]} t={t} at={0.08} size={132} display gap={0.09} />
      </AbsoluteFill>
    </Stage>
  );
};

export const PaletteShort: React.FC = () => (
  <AbsoluteFill style={{ background: '#000' }}>
    <Sequence durationInFrames={bar(4)} name="intro">
      <BuddiesIntro count={5} />
    </Sequence>
    <Sequence from={bar(4)} durationInFrames={bar(5) - bar(4)} name="title">
      <Title />
    </Sequence>
    <Sequence from={bar(5)} durationInFrames={bar(13) - bar(5)} name="take">
      <Take />
    </Sequence>
    <Sequence from={bar(13)} durationInFrames={END_FRAMES} name="end">
      <EndCard />
    </Sequence>
    <Sequence from={CUE} layout="none">
      <Audio src={song} />
    </Sequence>
  </AbsoluteFill>
);
