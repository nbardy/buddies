// Design iteration, short (3 bars of the EDM cue, 5.625 s) for the assembly: the emblem post
// lands, then the owner types "Great work!". The 15 s rough cut (DesignIteration.tsx) repeats the
// idea design review already shows, so the assembly uses this unless the owner keeps the long one.
// Footage B only; timecodes in ../footage/FOOTAGE.md.
import type React from 'react';
import { staticFile } from 'remotion';
import { CardEdit, type Cut, type Key, STILL, play, push, timeline } from './card';

export { FPS, HEIGHT, WIDTH } from './card';

const B = staticFile('2026-09-26_design-iteration_B_emblem-response-great-work.mov');

const CUTS: Cut[] = [
  play(2.0, 8.9, 3, 'emblem post + contact sheet in the pane'),
  play(14.0, 18.2, 4.2 / (5.625 - 6.9 / 3), 'owner types "Great work!" and posts'),
];
const { duration, at } = timeline(CUTS);
export const DURATION = duration;

// The thread pane lifted out as a card, as in the long cut; it pans down to the composer for the reply.
const PANE = { focus: 1, x: 2156, w: 818, top: 180, scale: 0.8, ...STILL };
const PANE_LOW = { ...PANE, top: 632 };
const CAMERA: Key[] = [
  { t: 0, shot: PANE },
  { t: at(1), shot: push(PANE, 1.05) },
  { t: at(1) + 0.6, shot: PANE_LOW },
  { t: duration / 60, shot: push({ ...PANE_LOW, oy: 0.85 }, 1.06) },
];

export const DesignIterationShort: React.FC = () => (
  <CardEdit src={B} cuts={CUTS} camera={CAMERA} />
);
