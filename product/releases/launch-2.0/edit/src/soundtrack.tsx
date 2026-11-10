// Sound design as data: a composition lists Cues (when, which sample, how loud) and <Soundtrack>
// plays them. Samples are synthesized by ../../sound/synth.py, so we own every sound.
import type React from 'react';
import { Audio, Sequence } from 'remotion';
import impact from '../../sound/impact.wav';
import key0 from '../../sound/key-0.wav';
import key1 from '../../sound/key-1.wav';
import key2 from '../../sound/key-2.wav';
import marA4 from '../../sound/mar-A4.wav';
import marB4 from '../../sound/mar-B4.wav';
import marD4 from '../../sound/mar-D4.wav';
import marD5 from '../../sound/mar-D5.wav';
import marFs4 from '../../sound/mar-Fs4.wav';
import marFs5 from '../../sound/mar-Fs5.wav';
import marG3 from '../../sound/mar-G3.wav';
import pad from '../../sound/pad.wav';
import pop0 from '../../sound/pop-0.wav';
import pop1 from '../../sound/pop-1.wav';
import pop2 from '../../sound/pop-2.wav';
import pop3 from '../../sound/pop-3.wav';
import pop4 from '../../sound/pop-4.wav';
import pop5 from '../../sound/pop-5.wav';
import pop6 from '../../sound/pop-6.wav';
import pop7 from '../../sound/pop-7.wav';
import riser from '../../sound/riser.wav';
import send from '../../sound/send.wav';
import sparkle from '../../sound/sparkle.wav';
import thud from '../../sound/thud.wav';
import whoosh from '../../sound/whoosh.wav';

export const KEYS = [key0, key1, key2];
export const POPS = [pop0, pop1, pop2, pop3, pop4, pop5, pop6, pop7]; // rising pitch
export const SFX = { impact, pad, riser, send, sparkle, thud, whoosh };
// The calm after the boom: soft marimba, one sample per note (modal synthesis in synth.py).
export const MARIMBA = {
  G3: marG3,
  D4: marD4,
  Fs4: marFs4,
  A4: marA4,
  B4: marB4,
  D5: marD5,
  Fs5: marFs5,
};

export type Cue = { at: number; src: string; volume: number }; // at = output seconds

export const Soundtrack: React.FC<{ cues: Cue[]; fps: number }> = ({ cues, fps }) => (
  <>
    {cues.map((c, i) => (
      <Sequence key={i} from={Math.round(c.at * fps)} layout="none">
        <Audio src={c.src} volume={c.volume} />
      </Sequence>
    ))}
  </>
);
