// Beat 9 "Multi harness" proof clip: the owner @mentions a Buddy, opens its reply picker in the
// composer, runs across Claude → Codex → Cursor → Muse, picks Muse and a thinking level, and sends.
// Follows the "Multi harness" logo slide (beat9/). Footage H and timecodes: ../footage/FOOTAGE.md.
import type React from 'react';
import { staticFile } from 'remotion';
import {
  CardEdit,
  type Cut,
  FPS,
  type Key,
  type Play,
  STILL,
  type Shot,
  hold,
  play,
  push,
  timeline,
} from './card';

export { FPS, HEIGHT, WIDTH } from './card';

const H = staticFile('2026-09-26_multi-harness_H_pick-harness-in-composer.mov');

// Source seconds. Typing is 9 s in the take; it only has to read as "a message is typed".
const MENTION = play(1.0, 2.6, 1.5, 'mention menu: pick Buddies Release Engineer');
const TYPE = play(2.6, 11.8, 6, 'type "Can we push a release to github and npm"');
const PICK = play(
  11.8,
  14.8,
  1,
  'open the reply picker; hover Claude → Codex → Cursor → Muse, pick Muse'
);
const THINK = play(14.8, 17.6, 2, 'thinking level: medium, then Done');
const SEND = play(17.6, 20.5, 2, 'send; the post lands and "is replying…" appears');
const CUTS: Cut[] = [
  MENTION,
  TYPE,
  PICK,
  THINK,
  SEND,
  hold(20.5, 0.6, 'hold on "Buddies Release Engineer is replying…"'),
];

const { duration, at } = timeline(CUTS);
export const DURATION = duration;

// The composer and the picker that opens above it: source x 811–2944, picker 1070–1678,
// composer 1690–1862 (reply chip at x 903–1483, y 1791–1840). The mention menu fills the same box.
const PICKER: Shot = { focus: 1, x: 800, w: 2160, top: 1060, scale: 0.84, ...STILL };
const FULL: Shot = { ...PICKER, focus: 0 };
const TYPING: Shot = { ...PICKER, ox: 0.3, oy: 0.9 }; // the composer line
// Anchors keep the zoomed rows inside the card: the harness chips start at 0.02 and the
// "replies on" header sits at 0.07 of the card; Done is at x 0.93–0.98.
const HARNESS: Shot = { ...PICKER, ox: 0.0, oy: 0.1 }; // Claude / Codex / Cursor / Muse row
const THINKING: Shot = { ...PICKER, ox: 0.88, oy: 0.55 }; // thinking-level row through to Done
// After the send the thread pane opens and the main column narrows (x 540–2106): the post and
// "is replying…" sit at source y 1500–1680, above the emptied composer.
const POSTED: Shot = {
  focus: 1,
  x: 540,
  w: 1600,
  top: 1440,
  scale: 1.1,
  ...STILL,
  ox: 0.3,
  oy: 0.5,
};

// Output time of source second s inside a played cut.
const when = (cut: Play, s: number) => at(CUTS.indexOf(cut)) + (s - cut.from) / cut.rate;

const CAMERA: Key[] = [
  { t: 0, shot: FULL },
  { t: 0.1, shot: FULL },
  { t: 0.8, shot: PICKER },
  { t: when(TYPE, TYPE.from), shot: PICKER },
  { t: when(PICK, PICK.from), shot: push(TYPING, 1.06) },
  { t: when(PICK, 12.2), shot: push(HARNESS, 1.02) }, // picker opens
  { t: when(PICK, 12.9), shot: push(HARNESS, 1.4) }, // in on the harness row before Codex is hovered
  { t: when(THINK, THINK.from), shot: push(HARNESS, 1.46) },
  { t: when(THINK, 15.6), shot: push(THINKING, 1.08) },
  { t: when(SEND, 18.4), shot: push(THINKING, 1.1) },
  { t: when(SEND, 19.3), shot: POSTED }, // sent (18.6); the column reflows as the thread opens
  { t: duration / FPS, shot: push(POSTED, 1.06) },
];

export const MultiHarness: React.FC = () => <CardEdit src={H} cuts={CUTS} camera={CAMERA} />;
