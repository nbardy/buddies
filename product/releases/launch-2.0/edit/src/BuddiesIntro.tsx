// The Buddies logo intro (owner, 2026-10-03): little robot buddies pop in one by one, each beside
// "Replying…" like the typing rows in a channel; the text rolls up, the faces simplify to plain
// circles, and the circles slide together into the Huddle mark as "buddies" lands beside it.
// Two cast sizes to compare, 3 and 5 (owner: "3 seems pretty good already").
// The picture is silent: its sound is the music. On the score's 128 bpm grid the robots pop on the
// melody's notes, "Replying…" rolls up in the build bar, and the discs lock on the drop, the first
// downbeat of the song (owner, 2026-10-04, after rejecting one-shot stingers as kitsch; plan in
// ../../sound/INTRO_SOUND_PLAN.md, music in ../../sound/reveal.py).
import type React from 'react';
import { AbsoluteFill, useCurrentFrame } from 'remotion';
import { clamp01, easeOutBack, FONT, lerp } from './blocks';
import { AURA, NIGHT } from './BuddiesLogos';

export const BEAT = 60 / 128; // = reveal.py and the score: one grid for picture and music
export const BAR = 4 * BEAT;
export const FPS = 60;
const CREAM = '#fdf6e3';
const PEACH = 'oklch(0.8 0.11 55)';

const easeOutCubic = (x: number) => 1 - (1 - x) ** 3;
const easeInOut = (x: number) => (x < 0.5 ? 4 * x ** 3 : 1 - (-2 * x + 2) ** 3 / 2);
const span = (t: number, from: number, dur: number) => clamp01((t - from) / dur);

// ---- The cast: everything that differs between the 3 and the 5 version is data.
type Spot = { x: number; y: number; r: number }; // in the mark's 100-unit box
type Cast = {
  colors: string[];
  huddle: Spot[];
  rowPitch: number; // px between "Replying…" rows
  avatar: number; // robot head radius in px while replying
  text: number; // "Replying…" font size
  pops: number[]; // each robot's pop, in 8ths from the first: the melody's rhythm (reveal.py MELODY)
};
const ringOf = (n: number, ring: number, r: number): Spot[] =>
  Array.from({ length: n }, (_, k) => {
    const a = (-90 + (k * 360) / n) * (Math.PI / 180);
    return { x: 50 + ring * Math.cos(a), y: 52 + ring * Math.sin(a), r };
  });

export type Count = 3 | 5;
export const CAST: Record<Count, Cast> = {
  3: {
    colors: [AURA.violet, AURA.blue, AURA.pink],
    huddle: [
      { x: 50, y: 36, r: 24 },
      { x: 35, y: 61, r: 24 },
      { x: 65, y: 61, r: 24 },
    ],
    rowPitch: 230,
    avatar: 84,
    text: 84,
    pops: [0, 2, 4],
  },
  5: {
    colors: [AURA.violet, AURA.blue, AURA.teal, AURA.pink, PEACH],
    huddle: ringOf(5, 17, 19),
    rowPitch: 172,
    avatar: 60,
    text: 66,
    pops: [0, 2, 3, 4, 6],
  },
};

// ---- Timeline (seconds), on the music's grid. Bar 1 (from POP_AT): the robots pop on the melody.
// Bar 2: they keep "replying" for a beat, roll up on beat 2, gather from beat 3. The lock is the drop,
// bar 3's downbeat, where "buddies" lands too; one more bar holds the logo before the home scene.
export const POP_AT = 0.2; // the music cue starts here (cue bar 1)
type Beats = { pop: (i: number) => number; roll: number; gather: number; lock: number; word: number; tag: number; end: number };
const beats = (c: Cast): Beats => {
  const lock = POP_AT + 2 * BAR;
  return {
    pop: (i) => POP_AT + (c.pops[i] * BEAT) / 2,
    roll: POP_AT + BAR + BEAT,
    gather: POP_AT + BAR + 2 * BEAT,
    lock,
    word: lock,
    tag: lock + 2 * BEAT,
    end: lock + BAR,
  };
};
export const frames = (n: Count) => Math.round(beats(CAST[n]).end * FPS);
export const lockAt = (n: Count) => beats(CAST[n]).lock;

// ---- Final lockup geometry (px): mark box, gap, lowercase "buddies".
export const MARK = 250;
export const WORD = 230;
const WORD_EM = 3.32; // rendered width of "buddies" at 800 in ems, measured off the logo sheet
export const GAP = MARK * 0.22;
const LOCKUP_W = MARK + GAP + WORD * WORD_EM;
export const MARK_LEFT = 960 - LOCKUP_W / 2;
export const MARK_TOP = 540 - MARK / 2 - 40; // room for the tagline
export const CENTRE_SHIFT = 960 - (MARK_LEFT + MARK / 2); // mark alone sits centred, then slides left

// ---- One robot: head, antenna, visor and eyes. `face` 1 → 0 simplifies it to a plain disc.
export type Pose = { x: number; y: number; r: number; face: number; blink: number; color: string };

export const Antenna: React.FC<{ p: Pose }> = ({ p }) => {
  const h = 0.48 * p.r * p.face;
  return (
    <g opacity={p.face}>
      <line x1={p.x} y1={p.y - p.r * 0.8} x2={p.x} y2={p.y - p.r - h} stroke={p.color} strokeWidth={p.r * 0.11} strokeLinecap="round" />
      <circle cx={p.x} cy={p.y - p.r - h} r={p.r * 0.15 * p.face} fill={p.color} />
    </g>
  );
};

export const Face: React.FC<{ p: Pose }> = ({ p }) => {
  const eyeY = p.y + p.r * 0.06;
  const eyeR = p.r * 0.12;
  return (
    <g opacity={p.face}>
      <rect x={p.x - p.r * 0.66} y={p.y - p.r * 0.26} width={p.r * 1.32} height={p.r * 0.64} rx={p.r * 0.32} fill="#14112a" opacity={0.82} />
      {[-0.3, 0.3].map((dx) => (
        <ellipse key={dx} cx={p.x + dx * p.r} cy={eyeY} rx={eyeR} ry={eyeR * p.blink} fill={CREAM} />
      ))}
    </g>
  );
};

// "Replying" with three dots that pulse in the robot's colour, rolling up and away at `roll`.
const Replying: React.FC<{ t: number; at: number; roll: number; x: number; y: number; size: number; color: string }> = ({
  t,
  at,
  roll,
  x,
  y,
  size,
  color,
}) => {
  const inP = easeOutCubic(span(t, at + 0.08, 0.4));
  const up = easeInOut(span(t, roll, 0.42));
  return (
    <div style={{ position: 'absolute', left: x, top: y - size * 0.7, height: size * 1.4, overflow: 'hidden' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          height: size * 1.4,
          gap: size * 0.05,
          fontFamily: FONT,
          fontSize: size,
          fontWeight: 600,
          color: CREAM,
          letterSpacing: -size * 0.01,
          opacity: inP * (1 - up),
          transform: `translate(${lerp(-18, 0, inP)}px, ${-up * size * 1.4}px)`,
          filter: `blur(${up * 6}px)`,
        }}
      >
        Replying
        {[0, 1, 2].map((d) => {
          const pulse = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin((t - at) * 7 - d * 0.9));
          return <span key={d} style={{ color, opacity: pulse }}>.</span>;
        })}
      </div>
    </div>
  );
};

export const Wordmark: React.FC<{ t: number; at: number; size: number }> = ({ t, at, size }) => (
  <div style={{ display: 'flex', fontFamily: FONT, fontSize: size, fontWeight: 800, fontVariationSettings: "'opsz' 96", letterSpacing: -size * 0.035, lineHeight: 1, color: CREAM }}>
    {'buddies'.split('').map((ch, i) => {
      const p = easeOutCubic(span(t, at + i * 0.04, 0.45));
      return (
        <span key={`${i}${ch}`} style={{ opacity: p, filter: `blur(${lerp(8, 0, p)}px)`, transform: `translateY(${lerp(size * 0.25, 0, p)}px)` }}>
          {ch}
        </span>
      );
    })}
  </div>
);

// The mark the intro lands on, for reuse elsewhere (the end card): the cast's discs drop in one
// after another (u = seconds since the build began) and settle into the huddle.
export const HuddleMark: React.FC<{ count: Count; size: number; u: number }> = ({ count, size, u }) => {
  const c = CAST[count];
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" style={{ overflow: 'visible', display: 'block' }}>
      <g style={{ isolation: 'isolate' }}>
        {c.huddle.map((s, i) => (
          <circle
            key={c.colors[i]}
            cx={s.x}
            cy={s.y}
            r={s.r * easeOutBack(span(u, i * 0.1, 0.4), 2)}
            fill={c.colors[i]}
            style={{ mixBlendMode: 'screen' }}
          />
        ))}
      </g>
    </svg>
  );
};

export function BuddiesIntro({ count }: { count: Count }) {
  const t = useCurrentFrame() / FPS;
  const c = CAST[count];
  const b = beats(c);
  const n = c.colors.length;

  // Row layout while replying: avatars in a column, text to their right, block centred.
  const textW = c.text * 4.7;
  const blockW = c.avatar * 2 + 34 + textW;
  const avatarX = 960 - blockW / 2 + c.avatar;
  const rowY = (i: number) => 540 + (i - (n - 1) / 2) * c.rowPitch;

  const gather = easeInOut(span(t, b.gather, b.lock - b.gather));
  const hug = 1 + 0.06 * Math.sin(Math.PI * span(t, b.lock - 0.05, 0.3));
  const slide = CENTRE_SHIFT * (1 - easeInOut(span(t, b.word - 0.2, 0.55)));
  const unit = (MARK / 100) * hug;
  const markCx = MARK_LEFT + MARK / 2 + slide;
  const markCy = MARK_TOP + MARK / 2;

  const poses: Pose[] = c.colors.map((color, i) => {
    const pop = easeOutBack(span(t, b.pop(i), 0.38), 2.4);
    const face = 1 - easeOutCubic(span(t, b.roll + 0.08 + i * 0.04, 0.4));
    const bob = Math.sin(t * 6 + i * 1.7) * 3 * face;
    const blinkPhase = span(t, b.pop(i) + 0.9 + i * 0.23, 0.14);
    const blink = 1 - 0.9 * Math.sin(Math.PI * blinkPhase);
    const s = c.huddle[i];
    return {
      x: lerp(avatarX, markCx + (s.x - 50) * unit, gather),
      y: lerp(rowY(i) + bob, markCy + (s.y - 50) * unit, gather),
      r: lerp(c.avatar, s.r * unit, gather) * pop,
      face,
      blink,
      color,
    };
  });

  const glow = 0.14 + 0.22 * gather;
  const tag = easeOutCubic(span(t, b.tag, 0.5));

  return (
    <AbsoluteFill style={{ background: NIGHT, overflow: 'hidden' }}>
      <AbsoluteFill
        style={{
          filter: 'blur(90px)',
          opacity: glow,
          transform: `translate(${Math.sin(t * 0.5) * 3}%, ${Math.cos(t * 0.4) * 2}%) scale(1.1)`,
          background: `radial-gradient(30% 40% at 32% 46%, ${AURA.violet}, transparent 70%),
            radial-gradient(28% 42% at 68% 42%, ${AURA.blue}, transparent 70%),
            radial-gradient(26% 34% at 50% 70%, ${AURA.pink}, transparent 70%)`,
        }}
      />
      {c.colors.map((color, i) => (
        <Replying key={color} t={t} at={b.pop(i)} roll={b.roll + i * 0.06} x={avatarX + c.avatar + 34} y={rowY(i)} size={c.text} color={color} />
      ))}
      <svg width={1920} height={1080} style={{ position: 'absolute', inset: 0 }}>
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
        <Wordmark t={t} at={b.word} size={WORD} />
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
  );
}
