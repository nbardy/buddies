// Beat 6 clip: the design iteration of the workspace home, request → redesign → emblems → "Great work!".
// Timeline and camera are data (CUTS, CAMERA); the component just renders them.
// Footage and timecodes: ../footage/FOOTAGE.md.
import type React from 'react';
import {
  AbsoluteFill,
  Easing,
  OffthreadVideo,
  Series,
  interpolate,
  staticFile,
  useCurrentFrame,
} from 'remotion';

export const FPS = 60;
export const WIDTH = 1920;
export const HEIGHT = 1080;

// Source recordings: 2974×1882 @ 60 fps. The thread pane is the right 818 px, full height.
const SRC = { w: 2974, h: 1882 };
const PANE = { x: 2156, w: 818 };
const A = staticFile('2026-09-26_design-iteration_A_scroll-request-to-redesign.mov');
const B = staticFile('2026-09-26_design-iteration_B_emblem-response-great-work.mov');

type Cut = { src: string; from: number; to: number; rate: number; note: string };

// Source seconds. Output length of a cut = (to - from) / rate.
const CUTS: Cut[] = [
  { src: A, from: 0.0, to: 3.0, rate: 1.5, note: 'owner asks for icons + a design pass' },
  { src: A, from: 3.0, to: 12.0, rate: 3, note: 'redesign post and screenshots scroll by' },
  { src: B, from: 2.0, to: 8.9, rate: 2, note: 'emblem post + contact sheet in the pane' },
  { src: B, from: 9.1, to: 10.75, rate: 1, note: 'contact sheet full frame (image viewer)' },
  { src: B, from: 10.85, to: 14.0, rate: 3, note: 'home screenshots, rough-edges note' },
  { src: B, from: 14.0, to: 18.2, rate: 1, note: 'owner types "Great work!" and posts' },
];

const cutFrames = (c: Cut) => Math.round(((c.to - c.from) / c.rate) * FPS);
const cutStarts = CUTS.reduce<number[]>((acc, c, i) => [...acc, acc[i] + cutFrames(c)], [0]);
export const DURATION = cutStarts[CUTS.length];

// Camera state. focus 0 = the plain full frame; focus 1 = the pane lifted out as a card over a
// blurred, dimmed backdrop. top = first source row shown in the card when focused.
type Shot = { focus: number; top: number };
type Key = { t: number; shot: Shot };

const FULL: Shot = { focus: 0, top: 0 };
const PANE_MID: Shot = { focus: 1, top: 180 };
const PANE_LOW: Shot = { focus: 1, top: 632 }; // composer + posted reply at the bottom edge

// Output seconds. Two keys at the same instant are a hard cut.
const at = (cut: number) => cutStarts[cut] / FPS;
const CAMERA: Key[] = [
  { t: 0, shot: FULL },
  { t: 0.5, shot: FULL },
  { t: 1.7, shot: PANE_MID },
  { t: at(3), shot: PANE_MID }, // cut to the full-frame image viewer with the source
  { t: at(3), shot: FULL },
  { t: at(4), shot: FULL },
  { t: at(4), shot: PANE_MID },
  { t: at(5), shot: PANE_LOW },
  { t: DURATION / FPS, shot: PANE_LOW },
];

const ease = Easing.inOut(Easing.cubic);

const shotAt = (t: number): Shot => {
  const i = CAMERA.slice(0, -1).findLastIndex((k) => k.t <= t);
  const a = CAMERA[i];
  const b = CAMERA[i + 1];
  const u = ease(Math.min(1, (t - a.t) / (b.t - a.t)));
  return {
    focus: a.shot.focus + (b.shot.focus - a.shot.focus) * u,
    top: a.shot.top + (b.shot.top - a.shot.top) * u,
  };
};

// Full frame: the source covers the 16:9 output (crops ~67 px top and bottom).
const COVER = WIDTH / SRC.w;
const COVER_Y = (HEIGHT - SRC.h * COVER) / 2;
// Focused card: pane at this scale, centred, with a margin above and below.
const CARD_SCALE = 0.8;
const CARD_MARGIN = 40;
const CARD_H = HEIGHT - 2 * CARD_MARGIN;

const lerp = (a: number, b: number, u: number) => a + (b - a) * u;

const Footage: React.FC<{ cut: Cut; style: React.CSSProperties }> = ({ cut, style }) => (
  <OffthreadVideo
    src={cut.src}
    trimBefore={Math.round(cut.from * FPS)}
    playbackRate={cut.rate}
    muted
    style={{ position: 'absolute', maxWidth: 'none', ...style }}
  />
);

const Frame: React.FC<{ cut: Cut; startFrame: number }> = ({ cut, startFrame }) => {
  const frame = useCurrentFrame();
  const { focus, top } = shotAt((startFrame + frame) / FPS);

  // Card rect in output px and the source window it shows, both interpolated from where the
  // pane sits in the full frame (focus 0) to the centred card (focus 1). At focus 0 the card is
  // pixel-aligned with the backdrop, so it reads as the plain recording.
  const scale = lerp(COVER, CARD_SCALE, focus);
  const cardW = PANE.w * scale;
  const cardX = lerp(PANE.x * COVER, (WIDTH - PANE.w * CARD_SCALE) / 2, focus);
  const cardY = lerp(COVER_Y, CARD_MARGIN, focus);
  const srcTop = lerp(0, top, focus);
  const cardH = lerp(SRC.h * COVER, CARD_H, focus);

  return (
    <AbsoluteFill style={{ backgroundColor: '#05090b', overflow: 'hidden' }}>
      <Footage
        cut={cut}
        style={{
          left: 0,
          top: COVER_Y,
          width: SRC.w * COVER,
          height: SRC.h * COVER,
          filter: `blur(${28 * focus}px) brightness(${1 - 0.45 * focus})`,
          transform: `scale(${1 + 0.06 * focus})`,
        }}
      />
      <div
        style={{
          position: 'absolute',
          left: cardX,
          top: cardY,
          width: cardW,
          height: cardH,
          overflow: 'hidden',
          borderRadius: 14 * focus,
          boxShadow: `0 ${30 * focus}px ${90 * focus}px rgba(0,0,0,${0.6 * focus})`,
          outline: `1px solid rgba(255,255,255,${0.08 * focus})`,
        }}
      >
        <Footage
          cut={cut}
          style={{
            left: -PANE.x * scale,
            top: -srcTop * scale,
            width: SRC.w * scale,
            height: SRC.h * scale,
          }}
        />
      </div>
    </AbsoluteFill>
  );
};

export const DesignIteration: React.FC = () => (
  <Series>
    {CUTS.map((cut, i) => (
      <Series.Sequence key={`${cut.src}@${cut.from}`} durationInFrames={cutFrames(cut)}>
        <Frame cut={cut} startFrame={cutStarts[i]} />
      </Series.Sequence>
    ))}
  </Series>
);
