// The whole launch video, script v2 (../../SCRIPT_V2_2026-09-30.md). The open keeps its own sound
// design; from the title one continuous EDM cue (../../sound/edm-full.wav, 128 BPM) runs to the end
// card, and every scene after the open is one 4-bar phrase of it: a scene change anywhere else
// read as "off step" (owner, 2026-09-30). Sections are data (SECTIONS); a section
// plays its clip from `offset` and holds the clip's last frame if its slot outlasts it.
import type React from 'react';
import { AbsoluteFill, Audio, Freeze, OffthreadVideo, Sequence, useCurrentFrame } from 'remotion';
import beat9 from '../../beat9/beat9.mp4';
import calmDowntempo from '../../sound/calm-downtempo.wav';
import calmHalftime from '../../sound/calm-halftime.wav';
import calmPulse from '../../sound/calm-pulse.wav';
import edmFull from '../../sound/edm-full.wav';
import * as Close from './Close';
import * as DesignReview from './DesignReview';
import * as FeatureFlash from './FeatureFlash';
import * as Overload from './Overload';
import * as PickerRefresh from './PickerRefresh';
import * as Swarm from './Swarm';
import { Block, INK } from './blocks';
import * as PostIntroBenefits from './PostIntroBenefits';
import * as ShowWork from './ShowWork';

export const FPS = 60;
export const WIDTH = 1920;
export const HEIGHT = 1080;

const BAR = (4 * 60) / 128; // 1.875 s
const MUSIC_IN = Overload.DURATION; // the build starts under the benefits
// Frame where bar b (1-based) of the cue starts. Bars are 112.5 frames, so round per bar, never accumulate.
const bar = (b: number) => MUSIC_IN + Math.round((b - 1) * BAR * FPS);

// beat9.mp4 is two slides: "Multi harness" (0–3.4 s) and "Bring your own subscriptions" (3.4–7 s).
const SLIDE_SPLIT = Math.round(3.4 * FPS);
const SLIDES_END = Math.round(7.0 * FPS);
const Slides: React.FC = () => <OffthreadVideo src={beat9} muted />;

// A section: component C (intrinsic length `frames`) starts at `from`, runs to `to`, and plays
// C from `offset` frames in. Silent sections hold C's last frame to fill a bar-aligned slot.
type Section = { id: string; from: number; to: number; C: React.FC; frames: number; offset: number };
const section = (id: string, from: number, to: number, C: React.FC, frames: number, offset = 0): Section => ({
  id,
  from,
  to,
  C,
  frames,
  offset,
});

export const SECTIONS: Section[] = [
  section('overload', 0, Overload.DURATION, Overload.Overload, Overload.DURATION),
  section('benefits', MUSIC_IN, bar(5), PostIntroBenefits.PostIntroBenefits, PostIntroBenefits.DURATION),
  section('ask', bar(5), bar(9), DesignReview.DesignReview, DesignReview.DURATION),
  section('show-work', bar(9), bar(17), ShowWork.ShowWork, ShowWork.DURATION),
  section('harness-slide', bar(17), bar(19), Slides, SLIDE_SPLIT),
  section('picker', bar(19), bar(21), PickerRefresh.PickerRefresh, PickerRefresh.DURATION),
  section('swarm', bar(21), bar(23), Swarm.Swarm, Swarm.DURATION),
  section('features', bar(23), bar(24), FeatureFlash.FeatureFlash, FeatureFlash.DURATION),
  section('subscriptions-slide', bar(24), bar(25), Slides, SLIDES_END, SLIDE_SPLIT),
  section('fork', bar(25), bar(27), Close.Fork, Close.FORK_FRAMES),
  section('run', bar(27), bar(29), Close.Run, Close.RUN_FRAMES),
  section('vim', bar(29), bar(33), Close.Vim, Close.VIM_FRAMES),
  section('end', bar(33), bar(33) + Close.END_FRAMES, Close.EndCard, Close.END_FRAMES),
];

// The cue comes up out of the intro instead of arriving at full level: the intro's tail sits near
// -21 dB mean and the build's first bar at -12 dB, a 9 dB step that read as "abrupt" (owner,
// 2026-09-30), and the marimba over the unramped build clipped at 0 dBFS. The ramp reaches 1 on the
// drop, so the drop is also the first full-level moment.
const BUILD_FRAMES = bar(5) - MUSIC_IN;
const buildRamp = (f: number) => (f >= BUILD_FRAMES ? 1 : 0.4 + 0.6 * (f / BUILD_FRAMES) ** 1.6);

// One caption per product scene, always top left, in from the scene's second beat.
const CAPTIONS: { from: number; to: number; lines: [string, string] }[] = [
  { from: bar(5), to: bar(9), lines: ['Ask your agents.', 'In channels.'] },
  { from: bar(9), to: bar(17), lines: ['They show their work.', 'Images and video, right in the thread.'] },
  { from: bar(21), to: bar(23), lines: ['Multi-agent swarms.', 'Agents @-mention each other.'] },
];
const CAPTION_IN = (60 / 128) * 0.5; // seconds after the scene's downbeat

const Caption: React.FC<{ lines: [string, string] }> = ({ lines }) => {
  const t = useCurrentFrame() / FPS - CAPTION_IN;
  return (
    <div style={{ position: 'absolute', left: 70, top: 56, display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 10 }}>
      <Block text={lines[0]} u={t} size="md" fill={INK.cyan} ink={INK.plate} rot={-1.5} />
      <Block text={lines[1]} u={t - 0.25} size="md" fill={INK.surface} ink={INK.cream} rot={0} />
    </div>
  );
};
export const DURATION = SECTIONS[SECTIONS.length - 1].to;

const Place: React.FC<{ s: Section }> = ({ s }) => {
  const plays = Math.min(s.to - s.from, s.frames - s.offset);
  return (
    <>
      <Sequence from={s.from} durationInFrames={plays} name={s.id}>
        <Sequence from={-s.offset} layout="none">
          <s.C />
        </Sequence>
      </Sequence>
      {s.to - s.from > plays ? (
        <Sequence from={s.from + plays} durationInFrames={s.to - s.from - plays} name={`${s.id} (hold)`}>
          <Freeze frame={s.frames - 1}>
            <s.C />
          </Freeze>
        </Sequence>
      ) : null}
    </>
  );
};

// The score under everything after the intro. Same bar grid and length, so the picture never changes
// with it: edm.py's EDM cue, or one of calm.py's three calmer versions (owner, 2026-09-30: "too
// upbeat and generic"). Pick one at render time: --props='{"score":"pulse"}'.
export const SCORES = { edm: edmFull, halftime: calmHalftime, pulse: calmPulse, downtempo: calmDowntempo } as const;
export type Score = keyof typeof SCORES;
export type AssemblyProps = { score: Score };

export const Assembly: React.FC<AssemblyProps> = ({ score }) => (
  <AbsoluteFill style={{ background: '#000' }}>
    {SECTIONS.map((s) => (
      <Place key={s.id} s={s} />
    ))}
    {CAPTIONS.map((c) => (
      <Sequence key={c.lines[0]} from={c.from} durationInFrames={c.to - c.from} name={`caption: ${c.lines[0]}`}>
        <Caption lines={c.lines} />
      </Sequence>
    ))}
    <Sequence from={MUSIC_IN} layout="none">
      <PostIntroBenefits.BenefitsSound />
    </Sequence>
    <Sequence from={MUSIC_IN} layout="none">
      <Audio src={SCORES[score]} volume={buildRamp} />
    </Sequence>
  </AbsoluteFill>
);
