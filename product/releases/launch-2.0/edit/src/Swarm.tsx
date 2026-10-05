// "Multi-agent swarms" (script v2 + owner, 2026-09-30): the old swarm screenshot was the previous
// product, so this is the owner's live take of two Buddies answering an @-mention: (1) the thread
// pane lifted out of the blurred frame, on "Wave_sim CEO and Wave Simulation Lead are replying…"
// and the first reply landing; (2) the sidebar, with a focus ring on each Buddy's
// background-worker count. Four bars, two per shot (owner, 2026-10-05: slower, "so you can see the swarm running"). Footage: ../footage/FOOTAGE.md, "Swarm".
import type React from 'react';
import { AbsoluteFill, Easing, Series, staticFile, useCurrentFrame } from 'remotion';
import { INK } from './blocks';
import { CardEdit, FPS, type Key, STILL, type Shot, play } from './card';

export { FPS, HEIGHT, WIDTH } from './card';

const BEAT = 60 / 128;
const BAR = 4 * BEAT;
const CARD_H = 1000; // card.tsx: HEIGHT - 80

// The owner's 2828×1882 take with the browser's "started debugging" bar cropped off and the frame
// scaled to card.tsx's 2974×1882 (footage script in FOOTAGE.md). Coordinates below are in that space.
const SRC = staticFile('2026-09-30_swarm_agents.mp4');

type Ring = { x: number; y: number; w: number; h: number; at: number }; // source px, seconds into the part
type Part = { from: number; shot: Shot; enter: number; rings: Ring[]; note: string };

const THREAD: Shot = { focus: 1, x: 2080, w: 894, top: 780, scale: 1.1, ...STILL };
// Worker badges next to Vave Simulation Lead (3), Product Lead (2), Simulation Geometry (1), Measurement (1).
const SIDEBAR: Shot = { focus: 1, x: 0, w: 546, top: 960, scale: 1.05, ...STILL };
const pad = 14;
const badge = (x: number, y: number, w: number, at: number): Ring => ({ x: x - pad, y: y - pad, w: w + 2 * pad, h: 26 + 2 * pad, at });

const PARTS: Part[] = [
  {
    from: 4.9,
    shot: THREAD,
    enter: 0.5,
    note: 'the mention is answered: "are replying…", then the Wave Simulation Lead reply lands',
    // The "are replying…" line, source rows 1540–1630.
    rings: [{ x: 2200, y: 1530, w: 700, h: 110, at: 0.55 }],
  },
  {
    from: 6.0, // two bars from here end at 9.75 s; the take is 9.8 s
    shot: SIDEBAR,
    enter: 0,
    note: 'the sidebar: background workers per Buddy',
    rings: [badge(440, 1030, 76, 0.3), badge(448, 1456, 60, 0.9), badge(448, 1756, 60, 1.5), badge(448, 1814, 60, 2.1)],
  },
];

const PART = 2 * BAR;
const frames = Math.round(PART * FPS);

// Where a source rectangle lands on screen for a settled focus-1 card (card.tsx `Frame`, zoom 1).
const onScreen = (s: Shot, r: Ring) => {
  const cardH = Math.min(CARD_H, (1882 - s.top) * s.scale);
  const cardX = (1920 - s.w * s.scale) / 2;
  const cardY = (1080 - cardH) / 2;
  return { left: cardX + (r.x - s.x) * s.scale, top: cardY + (r.y - s.top) * s.scale, width: r.w * s.scale, height: r.h * s.scale };
};

const FocusRing: React.FC<{ shot: Shot; ring: Ring }> = ({ shot, ring }) => {
  const t = useCurrentFrame() / FPS - ring.at;
  const u = Easing.out(Easing.cubic)(Math.min(1, Math.max(0, t / 0.25)));
  const pulse = 0.5 + 0.5 * Math.sin(Math.max(0, t) * 6);
  return (
    <div
      style={{
        position: 'absolute',
        ...onScreen(shot, ring),
        opacity: u,
        borderRadius: 14,
        border: `4px solid ${INK.wordmarkOrange}`,
        boxShadow: `0 0 ${16 + 14 * pulse}px ${INK.wordmarkOrange}`,
        transform: `scale(${1.25 - 0.25 * u})`,
      }}
    />
  );
};

const PartClip: React.FC<{ part: Part }> = ({ part }) => {
  const cuts = [play(part.from, part.from + PART, 1, part.note)];
  const camera: Key[] =
    part.enter > 0
      ? [
          { t: 0, shot: { ...part.shot, focus: 0 } },
          { t: part.enter, shot: part.shot },
          { t: PART, shot: part.shot },
        ]
      : [
          { t: 0, shot: part.shot },
          { t: PART, shot: part.shot },
        ];
  return (
    <AbsoluteFill>
      <CardEdit src={SRC} cuts={cuts} camera={camera} />
      {part.rings.map((r) => (
        <FocusRing key={`${r.x}-${r.y}`} shot={part.shot} ring={r} />
      ))}
    </AbsoluteFill>
  );
};

export const DURATION = PARTS.length * frames;

export const Swarm: React.FC = () => (
  <Series>
    {PARTS.map((p) => (
      <Series.Sequence key={p.note} durationInFrames={frames}>
        <PartClip part={p} />
      </Series.Sequence>
    ))}
  </Series>
);
