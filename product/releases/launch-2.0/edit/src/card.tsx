// The card-over-blur camera shared by the screen-recording clips (DesignReview, MultiHarness).
// A clip is data: one source recording, a list of CUTS (source spans played at a rate, or held
// frames) and a CAMERA (keyed shots in output seconds). <CardEdit> just renders them.
import type React from 'react';
import { AbsoluteFill, Easing, Freeze, OffthreadVideo, Series, useCurrentFrame } from 'remotion';
import { INK } from './blocks';

export const FPS = 60;
export const WIDTH = 1920;
export const HEIGHT = 1080;

// Every owner recording so far: 2974×1882 @ 60 fps (the retina browser window).
const SRC = { w: 2974, h: 1882 };

// A cut either plays a source span at a rate, or holds one source frame for a while.
export type Play = { kind: 'play'; from: number; to: number; rate: number; note: string };
export type Hold = { kind: 'hold'; at: number; seconds: number; note: string };
export type Cut = Play | Hold;

export const play = (from: number, to: number, rate: number, note: string): Play => ({
  kind: 'play',
  from,
  to,
  rate,
  note,
});
export const hold = (at: number, seconds: number, note: string): Hold => ({
  kind: 'hold',
  at,
  seconds,
  note,
});

const cutFrames = (c: Cut) =>
  Math.round((c.kind === 'play' ? (c.to - c.from) / c.rate : c.seconds) * FPS);

// Frame offsets of each cut, the total length, and `at(i)`: cut i's start in output seconds.
export const timeline = (cuts: Cut[]) => {
  const starts = cuts.reduce<number[]>((acc, c, i) => [...acc, acc[i] + cutFrames(c)], [0]);
  return { starts, duration: starts[cuts.length], at: (i: number) => starts[i] / FPS };
};

// Camera state. A shot lifts the source region [x, x+w] × [top, …] out as a card at `scale`,
// centred over a blurred, dimmed backdrop. focus 0 = that region pixel-aligned in the plain frame.
// zoom is the soft push inside the card, anchored at (ox, oy) as fractions of the card: every
// hold drifts in toward where the action is, so no shot sits dead still.
export type Shot = {
  focus: number;
  x: number;
  w: number;
  top: number;
  scale: number;
  zoom: number;
  ox: number;
  oy: number;
};
// Output seconds. Two keys at the same instant are a hard cut.
export type Key = { t: number; shot: Shot };

export const STILL = { zoom: 1, ox: 0.5, oy: 0.5 };
export const push = (s: Shot, zoom: number): Shot => ({ ...s, zoom });

const ease = Easing.inOut(Easing.cubic);
const lerp = (a: number, b: number, u: number) => a + (b - a) * u;

const shotAt = (camera: Key[], t: number): Shot => {
  const i = camera.slice(0, -1).findLastIndex((k) => k.t <= t);
  const a = camera[i].shot;
  const b = camera[i + 1].shot;
  const u = ease(Math.min(1, (t - camera[i].t) / (camera[i + 1].t - camera[i].t)));
  return {
    focus: lerp(a.focus, b.focus, u),
    x: lerp(a.x, b.x, u),
    w: lerp(a.w, b.w, u),
    top: lerp(a.top, b.top, u),
    scale: lerp(a.scale, b.scale, u),
    zoom: lerp(a.zoom, b.zoom, u),
    ox: lerp(a.ox, b.ox, u),
    oy: lerp(a.oy, b.oy, u),
  };
};

// Full frame: the source covers the 16:9 output (crops ~67 px top and bottom).
const COVER = WIDTH / SRC.w;
const COVER_Y = (HEIGHT - SRC.h * COVER) / 2;
const CARD_H = HEIGHT - 80;

type FootageProps<C> = { src: string; cut: C; style: React.CSSProperties };

const PlayFootage: React.FC<FootageProps<Play>> = ({ src, cut, style }) => (
  <OffthreadVideo
    src={src}
    trimBefore={Math.round(cut.from * FPS)}
    playbackRate={cut.rate}
    muted
    style={{ position: 'absolute', maxWidth: 'none', ...style }}
  />
);

const HoldFootage: React.FC<FootageProps<Hold>> = ({ src, cut, style }) => (
  <Freeze frame={0}>
    <OffthreadVideo
      src={src}
      trimBefore={Math.round(cut.at * FPS)}
      muted
      style={{ position: 'absolute', maxWidth: 'none', ...style }}
    />
  </Freeze>
);

const Footage: React.FC<FootageProps<Cut>> = ({ src, cut, style }) =>
  cut.kind === 'play' ? (
    <PlayFootage src={src} cut={cut} style={style} />
  ) : (
    <HoldFootage src={src} cut={cut} style={style} />
  );

const Frame: React.FC<{ src: string; camera: Key[]; cut: Cut; startFrame: number }> = ({
  src,
  camera,
  cut,
  startFrame,
}) => {
  const frame = useCurrentFrame();
  const { focus, x, w, top, scale: s, zoom, ox, oy } = shotAt(camera, (startFrame + frame) / FPS);

  // Card rect interpolated from where the region sits in the full frame (focus 0) to the
  // centred card (focus 1). At focus 0 the card is pixel-aligned with the backdrop.
  const scale = lerp(COVER, s, focus);
  const cardH = lerp(SRC.h * COVER, Math.min(CARD_H, (SRC.h - top) * s), focus);
  const cardX = lerp(x * COVER, (WIDTH - w * s) / 2, focus);
  const cardY = lerp(COVER_Y, (HEIGHT - cardH) / 2, focus);
  const srcTop = lerp(0, top, focus);

  return (
    <AbsoluteFill style={{ backgroundColor: INK.night, overflow: 'hidden' }}>
      <Footage
        src={src}
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
          width: w * scale,
          height: cardH,
          overflow: 'hidden',
          borderRadius: 14 * focus,
          boxShadow: `0 ${30 * focus}px ${90 * focus}px rgba(0,0,0,${0.6 * focus})`,
          outline: `1px solid rgba(255,255,255,${0.08 * focus})`,
        }}
      >
        <div
          style={{
            position: 'absolute',
            inset: 0,
            transform: `scale(${zoom})`,
            transformOrigin: `${ox * 100}% ${oy * 100}%`,
          }}
        >
          <Footage
            src={src}
            cut={cut}
            style={{
              left: -x * scale,
              top: -srcTop * scale,
              width: SRC.w * scale,
              height: SRC.h * scale,
            }}
          />
        </div>
      </div>
    </AbsoluteFill>
  );
};

export const CardEdit: React.FC<{ src: string; cuts: Cut[]; camera: Key[] }> = ({
  src,
  cuts,
  camera,
}) => {
  const { starts } = timeline(cuts);
  return (
    <Series>
      {cuts.map((cut, i) => (
        <Series.Sequence key={cut.note} durationInFrames={cutFrames(cut)}>
          <Frame src={src} camera={camera} cut={cut} startFrame={starts[i]} />
        </Series.Sequence>
      ))}
    </Series>
  );
};
