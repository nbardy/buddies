// "They show their work" (script v2, 2026-09-30): two phrases (8 bars, 15 s), four beats from two
// recordings. A Buddy's reply plays a video inline → the emblem post lands in the thread → the
// emblem sheet itself, full frame → the owner answers "Great work!". Owner, 2026-09-30: "stay a
// little longer… it's too fast", and the bare sheet of icons was "confusing", so the sheet now has a
// line saying what it is and the post before it reads in the thread. Footage: ../footage/FOOTAGE.md.
import type React from 'react';
import { AbsoluteFill, Series, staticFile, useCurrentFrame } from 'remotion';
import { Block, clamp01, INK } from './blocks';
import { CardEdit, FPS, type Key, STILL, type Shot, play, push, timeline } from './card';

export { FPS, HEIGHT, WIDTH } from './card';

const BEAT = 60 / 128;
const BAR = 4 * BEAT;

const REPLY = staticFile('2026-09-26_native-multimedia_2_reply-plays-video-inline.mp4');
const B = staticFile('2026-09-26_design-iteration_B_emblem-response-great-work.mov');

type Part = {
  src: string;
  from: number;
  to: number;
  bars: number;
  note: string;
  camera: (seconds: number) => Key[];
  label?: string; // one line saying what the shot is
};

// The thread pane (x 2156–2974). The inline player sits at source rows 1038–1438.
const PANE: Shot = { focus: 1, x: 2156, w: 818, top: 600, scale: 1, ...STILL, ox: 0.55, oy: 0.64 };
const POST: Shot = { focus: 1, x: 2156, w: 818, top: 300, scale: 1.15, ...STILL, ox: 0.5, oy: 0.6 }; // the emblem post
const FULL: Shot = { focus: 0, x: 0, w: 2974, top: 0, scale: 1, ...STILL };
const PANE_LOW: Shot = { focus: 1, x: 2156, w: 818, top: 632, scale: 0.8, ...STILL, oy: 0.85 }; // composer + posted reply

const PARTS: Part[] = [
  {
    src: REPLY,
    from: 2.0,
    to: 2.0 + 2 * BAR,
    bars: 2,
    note: 'the reply, its video already playing inline',
    camera: (s) => [
      { t: 0, shot: PANE },
      { t: 0.8, shot: PANE },
      { t: s, shot: push(PANE, 1.3) },
    ],
  },
  {
    src: B,
    from: 2.0,
    to: 8.9,
    bars: 2,
    note: 'the emblem post lands in the thread',
    camera: (s) => [
      { t: 0, shot: POST },
      { t: s, shot: push(POST, 1.08) },
    ],
  },
  {
    src: B,
    from: 9.1,
    to: 10.75,
    bars: 2,
    note: 'emblem sheet full frame (image viewer)',
    camera: (s) => [
      { t: 0, shot: FULL },
      { t: s, shot: push(FULL, 1.08) },
    ],
    label: 'New emblems for every workspace, drawn by an agent.',
  },
  {
    src: B,
    from: 14.0,
    to: 18.2,
    bars: 2,
    note: 'owner types "Great work!" and posts',
    camera: (s) => [
      { t: 0, shot: PANE_LOW },
      { t: s, shot: push(PANE_LOW, 1.05) },
    ],
  },
];

const frames = (p: Part) => Math.round(p.bars * BAR * FPS);
export const DURATION = PARTS.reduce((n, p) => n + frames(p), 0);

const Label: React.FC<{ text: string }> = ({ text }) => {
  const t = useCurrentFrame() / FPS - 0.5 * BEAT;
  return (
    <div style={{ position: 'absolute', left: 70, bottom: 70, opacity: clamp01(t / 0.1) }}>
      <Block text={text} u={t} size="md" fill={INK.cream} ink={INK.plate} rot={-1} />
    </div>
  );
};

const PartClip: React.FC<{ part: Part }> = ({ part }) => {
  const seconds = part.bars * BAR;
  const cuts = [play(part.from, part.to, (part.to - part.from) / seconds, part.note)];
  return (
    <AbsoluteFill>
      <CardEdit src={part.src} cuts={cuts} camera={part.camera(timeline(cuts).duration / FPS)} />
      {part.label ? <Label text={part.label} /> : null}
    </AbsoluteFill>
  );
};

export const ShowWork: React.FC = () => (
  <Series>
    {PARTS.map((p) => (
      <Series.Sequence key={p.note} durationInFrames={frames(p)}>
        <PartClip part={p} />
      </Series.Sequence>
    ))}
  </Series>
);
