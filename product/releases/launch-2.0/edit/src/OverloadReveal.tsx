// "AI Overload" and the Buddies reveal as ONE scene (owner, 2026-10-05): the bubble-block card
// "sucks", and the separate robot intro after it (boops, fade, cut) was a weak transition. Now the
// robots pop in on the left of the "AI Overload" screen, the lines answer them, then the robots
// gather, become the Huddle mark, and the logo pops on the drop of the launch song.
// Timed on that song (../../sound/launch.py: reveal.py's Drop, the owner's pick, 128 bpm): the robots
// pop on its five boops, gather in its build bar and lock on its drop. Seconds from the cut to black.
import type React from 'react';
import { AbsoluteFill, random } from 'remotion';
import { clamp01, easeOutBack, FONT, INK, lerp } from './blocks';
import { Antenna, BAR, BEAT, CAST, CENTRE_SHIFT, Face, GAP, MARK, MARK_LEFT, MARK_TOP, type Pose, WORD, Wordmark } from './BuddiesIntro';
import { AURA, NIGHT } from './BuddiesLogos';

const CREAM = '#fdf6e3';
const ROBOTS = CAST[5];

// ---- Timeline (s from the cut). A breath of black, then "AI Overload." on the boom; the song
// starts one bar later with the first robot (its bar 1), builds (bar 2) and drops on the logo (bar 3).
export const LEAD = BEAT / 2;
const SLAM = LEAD;
const SONG = SLAM + BAR; // the song's first sample = the first robot's boop
const song = (b: number, beat = 0) => SONG + (b - 1) * BAR + beat * BEAT;
const R = {
  slam: SLAM,
  feeling: SLAM + 2 * BEAT,
  pop: (i: number) => song(1, ROBOTS.pops[i] / 2), // the boops: the melody's 8ths 0, 2, 3, 4, 6
  shift: song(1) - 0.12, // the lines make room as the first robot lands
  covered: song(1, 2),
  exit: song(2), // the build: lines leave, faces simplify
  gather: song(2, 1),
  squeeze: song(2, 3.5), // the song's dry 8th before the drop: the discs hold their breath
  lock: song(3), // the drop
  tag: song(3, 2),
};
export const LOCK = R.lock;
// Two bars on the logo, then the home scene. Owner, 2026-10-05: at one bar "buddies" went by too fast to read.
export const END = R.lock + 2 * BAR;
export const CUE_IN = SONG;

const easeOutCubic = (x: number) => 1 - (1 - x) ** 3;
const easeInOut = (x: number) => (x < 0.5 ? 4 * x ** 3 : 1 - (-2 * x + 2) ** 3 / 2);
const span = (t: number, from: number, dur: number) => clamp01((t - from) / dur);

// ---- The lines (owner pick 2026-10-05: "slam", over a red/cyan glitch with typed answers, in git history). t = seconds from the cut.

// A word slams in from 1.6x with motion blur; the frame shakes once on the boom.
const SlamWord: React.FC<{ t: number; at: number; children: React.ReactNode }> = ({ t, at, children }) => {
  const p = easeOutCubic(span(t, at, 0.2));
  return (
    <span
      style={{
        display: 'inline-block',
        opacity: span(t, at, 0.06),
        transform: `scale(${lerp(1.6, 1, p)})`,
        filter: `blur(${lerp(14, 0, p)}px)`,
      }}
    >
      {children}
    </span>
  );
};

const Rise: React.FC<{ t: number; at: number; style: React.CSSProperties; children: React.ReactNode }> = ({ t, at, style, children }) => {
  const p = easeOutCubic(span(t, at, 0.35));
  return (
    <div style={{ ...style, opacity: p, transform: `translateY(${lerp(26, 0, p)}px)`, filter: `blur(${lerp(8, 0, p)}px)` }}>
      {children}
    </div>
  );
};

// The answer's key word in the robots' colours.
const AuraWord: React.FC<{ text: string }> = ({ text }) => (
  <span
    style={{
      backgroundImage: `linear-gradient(90deg, ${AURA.violet}, ${AURA.blue} 45%, ${AURA.teal} 75%, ${AURA.pink})`,
      WebkitBackgroundClip: 'text',
      backgroundClip: 'text',
      color: 'transparent',
    }}
  >
    {text}
  </span>
);

const Lines: React.FC<{ t: number }> = ({ t }) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 26, fontFamily: FONT, color: CREAM }}>
    <div style={{ fontSize: 196, fontWeight: 800, fontStretch: '78%', letterSpacing: '-0.03em', lineHeight: 0.95, display: 'flex', gap: '0.22em' }}>
      <SlamWord t={t} at={R.slam}>AI</SlamWord>
      <SlamWord t={t} at={R.slam + 0.07}>
        Overload<span style={{ color: INK.red }}>.</span>
      </SlamWord>
    </div>
    <Rise t={t} at={R.feeling} style={{ fontSize: 62, fontWeight: 600, color: 'rgba(253,246,227,.62)' }}>
      We're all feeling it.
    </Rise>
    <Rise t={t} at={R.covered} style={{ fontSize: 62, fontWeight: 700 }}>
      Don't worry, we've got you <AuraWord text="covered." />
    </Rise>
  </div>
);

// ---- The scene

const ROW_PITCH = 150;
const HEAD = 58;
const ROBOT_X = 330; // the robots' column, left of the lines
const LINES_SHIFT = 250; // how far the lines move right to make room

export const OverloadReveal: React.FC<{ t: number }> = ({ t }) => {
  const n = ROBOTS.colors.length;

  // The frame shakes once on the boom.
  const shake = (1 - span(t, R.slam, 0.32)) * (t >= R.slam ? 1 : 0);
  const shakeX = (random(`sx${Math.floor(t * 60)}`) - 0.5) * 22 * shake;
  const shakeY = (random(`sy${Math.floor(t * 60)}`) - 0.5) * 14 * shake;

  const shift = LINES_SHIFT * easeInOut(span(t, R.shift, 0.5));
  const exit = easeInOut(span(t, R.exit, 0.4));

  // The robots: pop on the 8ths, bob and blink, then lose their faces and gather into the mark.
  const gather = easeInOut(span(t, R.gather, R.squeeze - R.gather));
  const squeeze = easeInOut(span(t, R.squeeze, BEAT / 2));
  const pop = easeOutBack(span(t, R.lock, 0.45), 3.2) - easeInOut(span(t, R.lock, 0.45)); // 0 -> bump -> 0
  const hug = lerp(1, 0.86, squeeze * (1 - span(t, R.lock, 0.05))) + 0.16 * pop;
  const slide = CENTRE_SHIFT * (1 - easeInOut(span(t, R.lock + 0.1, 0.55)));
  const unit = (MARK / 100) * hug;
  const markCx = MARK_LEFT + MARK / 2 + slide;
  const markCy = MARK_TOP + MARK / 2;

  const poses: Pose[] = ROBOTS.colors.map((color, i) => {
    const p = easeOutBack(span(t, R.pop(i), 0.36), 2.6);
    const face = 1 - easeOutCubic(span(t, R.exit + 0.1 + i * 0.04, 0.4));
    const bob = Math.sin(t * 6 + i * 1.7) * 4 * face;
    const blink = 1 - 0.9 * Math.sin(Math.PI * span(t, R.pop(i) + 0.7 + i * 0.29, 0.14));
    const s = ROBOTS.huddle[i];
    const x0 = ROBOT_X + (i % 2 ? 46 : -46);
    const y0 = 540 + (i - (n - 1) / 2) * ROW_PITCH;
    return {
      x: lerp(x0, markCx + (s.x - 50) * unit, gather),
      y: lerp(y0 + bob, markCy + (s.y - 50) * unit, gather),
      r: lerp(HEAD, s.r * unit, gather) * p,
      face,
      blink,
      color,
    };
  });

  const glow = 0.1 * span(t, R.pop(0), BAR) + 0.2 * gather + 0.25 * pop;
  const flash = (1 - easeOutCubic(span(t, R.lock, 0.3))) * (t >= R.lock ? 1 : 0);
  const ring = easeOutCubic(span(t, R.lock, 0.7));
  const tag = easeOutCubic(span(t, R.tag, 0.5));

  return (
    <AbsoluteFill style={{ background: NIGHT, overflow: 'hidden' }}>
      <AbsoluteFill style={{ transform: `translate(${shakeX}px, ${shakeY}px)` }}>
        <AbsoluteFill
          style={{
            filter: 'blur(90px)',
            opacity: glow,
            background: `radial-gradient(30% 40% at 32% 46%, ${AURA.violet}, transparent 70%),
              radial-gradient(28% 42% at 68% 42%, ${AURA.blue}, transparent 70%),
              radial-gradient(26% 34% at 50% 70%, ${AURA.pink}, transparent 70%)`,
          }}
        />
        <AbsoluteFill
          style={{
            alignItems: 'center',
            justifyContent: 'center',
            opacity: 1 - exit,
            transform: `translate(${shift}px, ${-60 * exit}px)`,
            filter: `blur(${10 * exit}px)`,
          }}
        >
          <Lines t={t} />
        </AbsoluteFill>
        <svg width={1920} height={1080} style={{ position: 'absolute', inset: 0 }}>
          <circle cx={markCx} cy={markCy} r={lerp(MARK * 0.55, 1100, ring)} fill="none" stroke={CREAM} strokeWidth={lerp(10, 1, ring)} opacity={0.5 * (1 - ring) * (t >= R.lock ? 1 : 0)} />
          {poses.map((p) => (
            <Antenna key={p.color} p={p} />
          ))}
          <g style={{ isolation: 'isolate' }}>
            {poses.map((p) => (
              <circle key={p.color} cx={p.x} cy={p.y} r={Math.max(0, p.r)} fill={p.color} style={{ mixBlendMode: 'screen' }} />
            ))}
          </g>
          {poses.map((p) => (
            <Face key={p.color} p={p} />
          ))}
        </svg>
        <div style={{ position: 'absolute', left: MARK_LEFT + MARK + GAP + slide, top: MARK_TOP + MARK / 2 - WORD * 0.56 }}>
          <Wordmark t={t} at={R.lock + 0.1} size={WORD} />
        </div>
        <div
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            top: MARK_TOP + MARK + 46,
            textAlign: 'center',
            fontFamily: FONT,
            fontSize: 50,
            fontWeight: 500,
            color: 'rgba(253,246,227,.66)',
            opacity: tag,
            transform: `translateY(${lerp(12, 0, tag)}px)`,
          }}
        >
          your team of AI agents
        </div>
      </AbsoluteFill>
      <AbsoluteFill style={{ background: `radial-gradient(circle at ${markCx}px ${markCy}px, rgba(253,246,227,.55), transparent 45%)`, opacity: flash }} />
    </AbsoluteFill>
  );
};
