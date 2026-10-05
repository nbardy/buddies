// The whole launch video, script v2 (../../SCRIPT_V2_2026-09-30.md). The open keeps its own sound
// design; from the title one continuous EDM cue (../../sound/edm-full.wav, 128 BPM) runs to the end
// card, and every scene after the open is one 4-bar phrase of it: a scene change anywhere else
// read as "off step" (owner, 2026-09-30). Sections are data (SECTIONS); a section
// plays its clip from `offset` and holds the clip's last frame if its slot outlasts it.
import type React from 'react';
import { AbsoluteFill, Audio, Freeze, OffthreadVideo, Sequence, useCurrentFrame } from 'remotion';
import beat9 from '../../beat9/beat9.mp4';
import launchSong from '../../sound/launch.wav';
import * as Close from './Close';
import * as DesignReview from './DesignReview';
import * as FeatureFlash from './FeatureFlash';
import * as HomeIntro from './HomeIntro';
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
// Bar 1 is the drop: the logo locks on it (owner, 2026-10-04). The song (../../sound/launch.py)
// starts two bars earlier, on the first robot (owner, 2026-10-05); its bar b is our bar b - 2.
const MUSIC_IN = Math.round(Overload.LOCK * FPS);
const CUE_IN = Math.round(Overload.CUE_IN * FPS);
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

// Order (owner, 2026-10-05): the logo holds 2 bars; then the real sell, swarms: the home statement
// and the swarm running, slowed to 4 bars; then "Mobile Friendly!" first among the features; the
// demos ("They show their work" is 2 bars since the emblem shots were cut, owner 2026-10-05); and the
// benefits ("Open source"…) at the end, right before the Vim line ("Vim is open source…").
export const SECTIONS: Section[] = [
  section('overload', 0, Overload.DURATION, Overload.OverloadPicture, Overload.DURATION),
  section('home', bar(3), bar(6), HomeIntro.HomeIntro, HomeIntro.DURATION),
  section('swarm', bar(6), bar(10), Swarm.Swarm, Swarm.DURATION),
  section('mobile', bar(10), bar(12), FeatureFlash.FeatureFlash, FeatureFlash.DURATION),
  section('ask', bar(12), bar(16), DesignReview.DesignReview, DesignReview.DURATION),
  section('show-work', bar(16), bar(18), ShowWork.ShowWork, ShowWork.DURATION),
  section('harness-slide', bar(18), bar(20), Slides, SLIDE_SPLIT),
  section('picker', bar(20), bar(22), PickerRefresh.PickerRefresh, PickerRefresh.DURATION),
  section('subscriptions-slide', bar(22), bar(23), Slides, SLIDES_END, SLIDE_SPLIT),
  section('fork', bar(23), bar(25), Close.Fork, Close.FORK_FRAMES),
  section('run', bar(25), bar(27), Close.Run, Close.RUN_FRAMES),
  section('benefits', bar(27), bar(31), PostIntroBenefits.PostIntroBenefits, PostIntroBenefits.DURATION),
  section('vim', bar(31), bar(35), Close.Vim, Close.VIM_FRAMES),
  section('end', bar(35), bar(35) + Close.END_FRAMES, Close.EndCard, Close.END_FRAMES),
];

// One caption per product scene, always top left, in from the scene's second beat.
const CAPTIONS: { from: number; to: number; lines: [string, string] }[] = [
  { from: bar(6), to: bar(10), lines: ['Multi-agent swarms.', 'Agents @-mention each other.'] },
  { from: bar(12), to: bar(16), lines: ['Ask your agents.', 'In channels.'] },
  { from: bar(16), to: bar(18), lines: ['They show their work.', 'Images and video, right in the thread.'] },
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
export const DURATION = bar(35) + Close.END_FRAMES; // the end card's last frame

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

// Sound and picture are separate compositions too: the sound has no footage, so it renders in
// seconds, and the picture can be rendered (and reused) a section at a time.
export const AssemblySound: React.FC = () => (
  <>
    <Overload.OverloadSound />
    <Sequence from={bar(27)} layout="none">
      <PostIntroBenefits.BenefitsSound />
    </Sequence>
    <Sequence from={CUE_IN} layout="none">
      <Audio src={launchSong} />
    </Sequence>
  </>
);

export const AssemblyPicture: React.FC = () => (
  <AbsoluteFill style={{ background: '#000' }}>
    {SECTIONS.map((s) => (
      <Place key={s.id} s={s} />
    ))}
    {CAPTIONS.map((c) => (
      <Sequence key={c.lines[0]} from={c.from} durationInFrames={c.to - c.from} name={`caption: ${c.lines[0]}`}>
        <Caption lines={c.lines} />
      </Sequence>
    ))}
  </AbsoluteFill>
);

// The score: launch.py's song under everything from the first robot to the end card.
export const Assembly: React.FC = () => (
  <AbsoluteFill>
    <AssemblyPicture />
    <AssemblySound />
  </AbsoluteFill>
);
