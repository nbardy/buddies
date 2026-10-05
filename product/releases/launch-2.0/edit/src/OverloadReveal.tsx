// "AI Overload" and the Buddies reveal as ONE scene (owner, 2026-10-05): the bubble-block card
// "sucks", and the separate robot intro after it (boops, fade, cut) was a weak transition. Now the
// robots pop in on the left of the "AI Overload" screen, the lines answer them, then the robots
// gather, become the Huddle mark, and the logo pops on the drop of the launch song.
// Timed on that song's build (../../sound/launch.py = edm.py bars 1-4, 128 bpm): every entrance
// below is a beat of it, in seconds from the hard cut to black.
import type React from 'react';
import { AbsoluteFill, random } from 'remotion';
import { clamp01, easeOutBack, FONT, INK, lerp } from './blocks';
import { Antenna, BAR, BEAT, CAST, CENTRE_SHIFT, Face, GAP, MARK, MARK_LEFT, MARK_TOP, type Pose, WORD, Wordmark } from './BuddiesIntro';
import { AURA, NIGHT } from './BuddiesLogos';

// Two type treatments for the three lines, to compare side by side (owner to pick).
export type TypeStyle = 'slam' | 'glitch';

const CREAM = '#fdf6e3';
const MONO = '"SF Mono", Menlo, Consolas, monospace';
const ROBOTS = CAST[5];

// ---- Timeline (s from the cut). The song starts LEAD after the cut: a breath of black first.
export const LEAD = BEAT / 2;
const bar = (b: number, beat = 0) => LEAD + (b - 1) * BAR + beat * BEAT;
const R = {
  slam: bar(1), // "AI Overload." on the build's first downbeat, with the boom
  feeling: bar(1, 2),
  pop: (i: number) => bar(2, i / 2), // the five robots on the 8ths of bar 2
  shift: bar(2) - 0.12, // the lines make room as the first robot lands
  covered: bar(3),
  exit: bar(4), // lines leave, faces simplify
  gather: bar(4, 1),
  squeeze: bar(5) - BEAT / 2, // the song's dry gap: the discs hold their breath
  lock: bar(5), // the drop
  tag: bar(5, 2),
};
export const LOCK = R.lock;
export const END = R.lock + BAR; // one bar on the logo, then the home scene
export const CUE_IN = R.slam; // the song's first sample
export const POPS = ROBOTS.colors.map((_, i) => R.pop(i));

const easeOutCubic = (x: number) => 1 - (1 - x) ** 3;
const easeInOut = (x: number) => (x < 0.5 ? 4 * x ** 3 : 1 - (-2 * x + 2) ** 3 / 2);
const span = (t: number, from: number, dur: number) => clamp01((t - from) / dur);

// ---- The lines. Each style is one handler with the same signature: t = seconds from the cut.
type Lines = React.FC<{ t: number }>;

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

const SlamLines: Lines = ({ t }) => (
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

// Overload as signal noise: red and cyan copies split off and jitter, then lock into the cream
// word; the answers are typed like a terminal.
// side: +1 pulls the copy right, -1 left, so red and cyan always split apart.
const glitchOffset = (t: number, at: number, seed: string, side: 1 | -1) => {
  const settle = 1 - easeOutCubic(span(t, at, 0.55));
  const frame = Math.floor(t * 30); // jitter steps at 30 fps, like a bad signal
  const x = side * (14 + random(`${seed}x${frame}`) * 34) * settle;
  return { x, y: (random(`${seed}y${frame}`) - 0.5) * 16 * settle };
};

const Typed: React.FC<{ t: number; at: number; text: string; dur: number }> = ({ t, at, text, dur }) => {
  const n = Math.round(span(t, at, dur) * text.length);
  const caret = t >= at && Math.floor((t - at) * 4) % 2 === 0;
  return (
    <span style={{ opacity: t >= at ? 1 : 0 }}>
      {text.slice(0, n)}
      <span style={{ opacity: caret ? 1 : 0 }}>▍</span>
    </span>
  );
};

const GlitchLines: Lines = ({ t }) => {
  const word: React.CSSProperties = { fontSize: 210, fontWeight: 800, fontStretch: '75%', letterSpacing: '-0.02em', lineHeight: 0.92 };
  const red = glitchOffset(t, R.slam, 'r', 1);
  const cyan = glitchOffset(t, R.slam, 'c', -1);
  const on = t >= R.slam ? 1 : 0;
  const skew = (1 - easeOutCubic(span(t, R.slam, 0.3))) * -12;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 30, fontFamily: FONT, color: CREAM }}>
      <div style={{ position: 'relative', opacity: on, transform: `skewX(${skew}deg)` }}>
        <div style={{ ...word, position: 'absolute', color: INK.red, mixBlendMode: 'screen', transform: `translate(${red.x}px, ${red.y}px)` }}>AI OVERLOAD</div>
        <div style={{ ...word, position: 'absolute', color: INK.cyan, mixBlendMode: 'screen', transform: `translate(${cyan.x}px, ${cyan.y}px)` }}>AI OVERLOAD</div>
        <div style={{ ...word, position: 'relative', mixBlendMode: 'screen' }}>AI OVERLOAD</div>
      </div>
      <div style={{ fontFamily: MONO, fontSize: 46, fontWeight: 500, color: 'rgba(253,246,227,.62)' }}>
        <Typed t={t} at={R.feeling} text="> we're all feeling it." dur={0.4} />
      </div>
      <div style={{ fontFamily: MONO, fontSize: 46, fontWeight: 600 }}>
        <Typed t={t} at={R.covered} text="> don't worry, we've got you covered." dur={0.6} />
      </div>
    </div>
  );
};

const LINES: Record<TypeStyle, Lines> = { slam: SlamLines, glitch: GlitchLines };

// ---- The scene

const ROW_PITCH = 150;
const HEAD = 58;
const ROBOT_X = 330; // the robots' column, left of the lines
const LINES_SHIFT = 250; // how far the lines move right to make room

export const OverloadReveal: React.FC<{ t: number; type: TypeStyle }> = ({ t, type }) => {
  const Text = LINES[type];
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
          <Text t={t} />
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
