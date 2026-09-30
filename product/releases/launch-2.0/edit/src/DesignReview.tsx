// "Design review" clip: owner asks the Product Development Lead to post screenshots of every
// product view, and the Lead posts Mobile / iPad / Desktop threads of live captures.
// Timeline and camera are data (CUTS, CAMERA); the card camera itself is ./card.
// Footage D and timecodes: ../footage/FOOTAGE.md. The real wait is ~6 min; the cut says so.
import type React from 'react';
import { AbsoluteFill, Easing, Sequence, interpolate, staticFile, useCurrentFrame } from 'remotion';
import { FONT, INK } from './blocks';
import { CardEdit, FPS, type Cut, type Key, STILL, type Shot, hold, play, push, timeline } from './card';

export { FPS, HEIGHT, WIDTH } from './card';

// Main column x 524–2154, thread pane x 2156–2974 once it is open.
const D = staticFile('2026-09-26_design-review_D_post-screenshots-request.mov');

// Source seconds. Script v2 (2026-09-30): one 4-bar phrase (7.5 s), three shots. The owner found
// the 7-cut version "too cutty" inside the full film: ask → six minutes later the results land →
// hold on the three posts. The iPad click and scroll are gone, and so is the iPad Buddies-grid hold:
// the owner called that thumbnail "a bad screenshot" (2026-09-30).
const REQUEST = play(0.8, 5.3, 1.5, 'request appears in the composer, sent, thread opens');
const CUTS: Cut[] = [
  REQUEST,
  play(392.7, 398.1, 2.16, '~6 min later: "captured all 21 views", then Mobile / iPad / Desktop land'),
  hold(398.1, 2.0, 'the three posts in the channel, held'),
];

const { starts, duration, at } = timeline(CUTS);
export const DURATION = duration;

const COMPOSER: Shot = { focus: 1, x: 540, w: 2080, top: 706, scale: 0.85, ...STILL, ox: 0.35, oy: 0.85 };
const FULL: Shot = { ...COMPOSER, focus: 0 };
const PANE_WAIT: Shot = { focus: 1, x: 2156, w: 818, top: 632, scale: 0.8, ...STILL, oy: 0.3 }; // request + typing
const PANE_REPLY: Shot = { ...PANE_WAIT, top: 480, oy: 0.7 }; // request + "On it"
const POSTS: Shot = { focus: 1, x: 540, w: 1620, top: 800, scale: 1, ...STILL, ox: 0.3, oy: 0.6 }; // the three posts

const SENT = (3.6 - REQUEST.from) / REQUEST.rate; // the post leaves the composer
const LANDED = at(1) + (396.1 - 392.7) / 2.16; // the three posts are in the channel
const CAMERA: Key[] = [
  { t: 0, shot: FULL },
  { t: 0.15, shot: FULL },
  { t: 0.9, shot: COMPOSER },
  { t: SENT, shot: push(COMPOSER, 1.05) },
  { t: SENT + 0.8, shot: PANE_WAIT },
  { t: at(1), shot: push(PANE_WAIT, 1.04) },
  { t: at(1), shot: PANE_REPLY },
  { t: LANDED - 0.6, shot: PANE_REPLY },
  { t: LANDED, shot: POSTS },
  { t: duration / FPS, shot: push(POSTS, 1.12) },
];

// The honest time-skip: the Lead took about six minutes to capture 21 views at four sizes.
const LaterChip: React.FC = () => {
  const u = useCurrentFrame() / FPS;
  const o = interpolate(u, [0, 0.2, 1.3, 1.6], [0, 1, 1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const y = interpolate(u, [0, 0.3], [16, 0], { extrapolateRight: 'clamp', easing: Easing.out(Easing.cubic) });
  return (
    <div
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 70,
        display: 'flex',
        justifyContent: 'center',
        opacity: o,
        transform: `translateY(${y}px)`,
      }}
    >
      <span
        style={{
          fontFamily: FONT,
          fontSize: 44,
          fontWeight: 700,
          fontStretch: '90%',
          color: INK.cream,
          background: INK.surface,
          padding: '10px 28px 14px',
          borderRadius: 999,
          boxShadow: '0 20px 60px rgba(0,0,0,0.55)',
        }}
      >
        6 minutes later
      </span>
    </div>
  );
};

export const DesignReview: React.FC = () => (
  <AbsoluteFill>
    <CardEdit src={D} cuts={CUTS} camera={CAMERA} />
    <Sequence from={starts[1]} durationInFrames={starts[2] - starts[1]}>
      <LaterChip />
    </Sequence>
  </AbsoluteFill>
);
