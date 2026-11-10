// "Native multimedia" → "Code + Design + Marketing!": the owner @mentions the Marketing Designer
// for the latest video, the reply lands in the thread and the launch video plays inline. It opens
// the product-features section, over the EDM build (../../sound/edm.py), drop on the big card.
// Timeline, camera and cards are data (CUTS, CAMERA, CARDS); the component just renders them.
// Footage and how it was made: ../footage/FOOTAGE.md.
import type React from 'react';
import {
  AbsoluteFill,
  Audio,
  Easing,
  OffthreadVideo,
  Sequence,
  Series,
  staticFile,
  useCurrentFrame,
} from 'remotion';
import edm from '../../sound/edm-build.wav';
import { Block, INK } from './blocks';
import { SFX } from './soundtrack';

export const FPS = 60;
export const WIDTH = 1920;
export const HEIGHT = 1080;

// The music grid: edm.py is 128 BPM with the drop at bar 5. Cuts and cards land on beats.
const BEAT = 60 / 128;
const DROP = 16 * BEAT; // 7.5 s
export const DURATION = Math.round(20 * BEAT * FPS); // bar 5 ends: 9.375 s

// Both sources are 2974×1882 @ 60 fps: the owner's macOS recording, and our frame-stepped capture
// of the app (../capture/record-thread.mjs) made at the same size so the two cut together.
const SRC = { w: 2974, h: 1882 };
const ASK = staticFile('2026-09-26_native-multimedia_1_owner-asks-for-latest-video.mov');
const REPLY = staticFile('2026-09-26_native-multimedia_2_reply-plays-video-inline.mp4');

type Cut = { src: string; from: number; frames: number; rate: number; note: string };
const SEND = Math.round(7 * BEAT * FPS); // the cut to the thread lands on beat 8
const CUTS: Cut[] = [
  // Typing runs 0.9–9.4 s in the source; the pauses after "video," are the slow part, cut off.
  {
    src: ASK,
    from: 0.9,
    frames: SEND,
    rate: (9.4 - 0.9) / (SEND / FPS),
    note: '"@Marketing Designer Can you share with me the latest video"',
  },
  // Capture: thread from 1.0 s; the inline video starts at 2.6 s (output ≈ 4.9 s).
  {
    src: REPLY,
    from: 1.0,
    frames: DURATION - SEND,
    rate: 1,
    note: 'reply lands, the launch video plays inline',
  },
];

// Camera: a source window (px) shown at `scale`, centred at (cx, cy). focus 1 blurs and dims
// the rest of the frame behind the window; focus 0 is the plain full-frame recording.
type Rect = { x: number; y: number; w: number; h: number };
type Shot = { focus: number; win: Rect; scale: number; cx: number; cy: number };
const COVER = WIDTH / SRC.w;
const FULL: Shot = {
  focus: 0,
  win: { x: 0, y: 0, ...SRC },
  scale: COVER,
  cx: WIDTH / 2,
  cy: HEIGHT / 2,
};
// Composer strip of the channel column: the mention chip, the typed text, the Buddy's model.
const COMPOSER: Shot = {
  focus: 1,
  win: { x: 572, y: 1380, w: 2402, h: 502 },
  scale: 0.78,
  cx: WIDTH / 2,
  cy: HEIGHT / 2,
};
// Thread pane: the owner's post, the reply, the video player.
const THREAD: Shot = {
  focus: 1,
  win: { x: 2156, y: 160, w: 818, h: 1290 },
  scale: 0.8,
  cx: WIDTH / 2,
  cy: HEIGHT / 2,
};
// The inline player (measured on the capture at 6 s: x 2266–2941, y 1048–1428), pushed in.
const PLAYER: Shot = {
  focus: 1,
  win: { x: 2256, y: 1038, w: 695, h: 400 },
  scale: 2.2,
  cx: WIDTH / 2,
  cy: HEIGHT / 2 - 40,
};

type Key = { t: number; shot: Shot };
const CAMERA: Key[] = [
  { t: 0, shot: FULL },
  { t: 0.15, shot: FULL },
  { t: 0.9, shot: COMPOSER },
  { t: SEND / FPS, shot: COMPOSER }, // hard cut to the thread
  { t: SEND / FPS, shot: THREAD },
  { t: 10 * BEAT, shot: THREAD }, // the video has started
  { t: 13 * BEAT, shot: PLAYER },
  { t: DURATION / FPS, shot: PLAYER },
];

const ease = Easing.inOut(Easing.cubic);
const mix = (a: number, b: number, u: number) => a + (b - a) * u;

const shotAt = (t: number): Shot => {
  const i = CAMERA.slice(0, -1).findLastIndex((k) => k.t <= t);
  const a = CAMERA[i].shot;
  const b = CAMERA[i + 1].shot;
  const u = ease(Math.min(1, (t - CAMERA[i].t) / (CAMERA[i + 1].t - CAMERA[i].t)));
  return {
    focus: mix(a.focus, b.focus, u),
    win: {
      x: mix(a.win.x, b.win.x, u),
      y: mix(a.win.y, b.win.y, u),
      w: mix(a.win.w, b.win.w, u),
      h: mix(a.win.h, b.win.h, u),
    },
    scale: mix(a.scale, b.scale, u),
    cx: mix(a.cx, b.cx, u),
    cy: mix(a.cy, b.cy, u),
  };
};

// On the drop, a punch: the window swells 6% and settles over a beat.
const punchAt = (t: number) => (t < DROP ? 1 : 1 + 0.06 * Math.exp(-(t - DROP) / (BEAT * 0.5)));

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
  const t = (startFrame + useCurrentFrame()) / FPS;
  const { focus, win, cx, cy } = shotAt(t);
  const scale = shotAt(t).scale * punchAt(t);
  const w = win.w * scale;
  const h = win.h * scale;
  return (
    <AbsoluteFill style={{ backgroundColor: INK.night, overflow: 'hidden' }}>
      <Footage
        cut={cut}
        style={{
          left: 0,
          top: (HEIGHT - SRC.h * COVER) / 2,
          width: SRC.w * COVER,
          height: SRC.h * COVER,
          filter: `blur(${28 * focus}px) brightness(${1 - 0.5 * focus})`,
          transform: `scale(${1 + 0.06 * focus})`,
        }}
      />
      <div
        style={{
          position: 'absolute',
          left: cx - w / 2,
          top: cy - h / 2,
          width: w,
          height: h,
          overflow: 'hidden',
          borderRadius: 14 * focus,
          boxShadow: `0 ${30 * focus}px ${90 * focus}px rgba(0,0,0,${0.6 * focus})`,
          outline: `1px solid rgba(255,255,255,${0.08 * focus})`,
        }}
      >
        <Footage
          cut={cut}
          style={{
            left: -win.x * scale,
            top: -win.y * scale,
            width: SRC.w * scale,
            height: SRC.h * scale,
          }}
        />
      </div>
    </AbsoluteFill>
  );
};

// Cards, one per beat. "Native multimedia" titles the segment from its first beat, over the
// typing (owner, rough cut 1: "put native multimedia at the start"); the drop brings the three
// words one per beat.
type Card = {
  text: string;
  at: number;
  out: number;
  size: 'md' | 'xl';
  fill: string;
  ink: string;
  rot: number;
  x: number;
  y: number;
};
const CARDS: Card[] = [
  {
    text: 'Native multimedia',
    at: BEAT,
    out: SEND / FPS,
    size: 'xl',
    fill: INK.cyan,
    ink: INK.plate,
    rot: -3,
    x: 110,
    y: 90,
  },
  {
    text: 'Code +',
    at: DROP,
    out: 99,
    size: 'xl',
    fill: INK.cyan,
    ink: INK.plate,
    rot: -4,
    x: 150,
    y: 140,
  },
  {
    text: 'Design +',
    at: DROP + BEAT,
    out: 99,
    size: 'xl',
    fill: INK.yellow,
    ink: INK.plate,
    rot: 2,
    x: 520,
    y: 430,
  },
  {
    text: 'Marketing!',
    at: DROP + 2 * BEAT,
    out: 99,
    size: 'xl',
    fill: INK.wordmarkOrange,
    ink: INK.plate,
    rot: -3,
    x: 900,
    y: 730,
  },
];

const Cards: React.FC = () => {
  const t = useCurrentFrame() / FPS;
  return (
    <AbsoluteFill>
      {CARDS.filter((c) => t < c.out).map((c) => (
        <div key={c.text} style={{ position: 'absolute', left: c.x, top: c.y }}>
          <Block text={c.text} u={t - c.at} size={c.size} fill={c.fill} ink={c.ink} rot={c.rot} />
        </div>
      ))}
    </AbsoluteFill>
  );
};

// Picture plus the send blip. The assembly plays this under its one continuous music cue
// (edm-full.wav); the standalone clip adds the 15 s cue below.
export const NativeMultimediaPicture: React.FC = () => (
  <AbsoluteFill>
    <Series>
      {CUTS.reduce<{ cut: Cut; start: number }[]>((acc, cut) => {
        const prev = acc.at(-1);
        return [...acc, { cut, start: prev ? prev.start + prev.cut.frames : 0 }];
      }, []).map(({ cut, start }) => (
        <Series.Sequence key={cut.src} durationInFrames={cut.frames}>
          <Frame cut={cut} startFrame={start} />
        </Series.Sequence>
      ))}
    </Series>
    <Cards />
    <Sequence from={SEND - 2} layout="none">
      <Audio src={SFX.send} volume={0.5} />
    </Sequence>
  </AbsoluteFill>
);

export const NativeMultimedia: React.FC = () => (
  <AbsoluteFill>
    <NativeMultimediaPicture />
    {/* Out over the last beat: a 0.25 s fade clipped the groove mid-bar. */}
    <Audio src={edm} volume={(f) => Math.min(1, (DURATION - f) / (BEAT * FPS))} />
  </AbsoluteFill>
);
