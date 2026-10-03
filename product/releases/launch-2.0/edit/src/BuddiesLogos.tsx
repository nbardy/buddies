// Buddies logo concepts (owner, 2026-10-03: "make some buddies logos, do some animation and
// graphic art for it so we can see how it looks"). Four marks, each one SVG handler that takes
// u = seconds since its reveal began (a large u is the settled mark, used for the stills).
// Palette: the workspace-home aurora (client/src/components/buddies/ChannelLanding.css).
import type React from 'react';
import { useId } from 'react';
import { AbsoluteFill, Sequence, useCurrentFrame } from 'remotion';
import { clamp01, easeOutBack, FONT, lerp } from './blocks';

export const FPS = 60;
export const WIDTH = 1920;
export const HEIGHT = 1080;

export type Concept = 'pair' | 'bubble' | 'huddle' | 'chatty';
export const CONCEPTS: Concept[] = ['pair', 'bubble', 'huddle', 'chatty'];

export const AURA = {
  violet: 'oklch(0.62 0.2 300)',
  blue: 'oklch(0.66 0.15 240)',
  pink: 'oklch(0.7 0.17 350)',
  teal: 'oklch(0.76 0.12 200)',
  lens: 'oklch(0.9 0.06 260)',
};
export const NIGHT = '#0b0a14';
const CREAM = '#fdf6e3';
const INKDARK = '#16132a';
const SETTLED = 10;

const NAME: Record<Concept, { title: string; idea: string }> = {
  pair: { title: 'Pair', idea: 'Two buddies overlapping: you and your agent' },
  bubble: { title: 'Bubble b', idea: 'A "b" whose bowl is a chat bubble: talk to them' },
  huddle: { title: 'Huddle', idea: 'Three colours in a huddle: a team that mixes' },
  chatty: { title: 'Chatty', idea: 'A chat bubble with eyes: a friendly face' },
};

// SVG ids must be unique per instance (the sheet draws each mark several times) and CSS-safe.
const useSvgId = () => useId().replace(/[^a-zA-Z0-9]/g, '');

const Gradient: React.FC<{ id: string }> = ({ id }) => (
  <linearGradient id={id} x1="0" y1="0" x2="100" y2="100" gradientUnits="userSpaceOnUse">
    <stop offset="0.1" stopColor={AURA.violet} />
    <stop offset="0.55" stopColor={AURA.blue} />
    <stop offset="0.95" stopColor={AURA.pink} />
  </linearGradient>
);

type MarkProps = { u: number; size: number };

const Svg: React.FC<{ size: number; children: React.ReactNode }> = ({ size, children }) => (
  <svg width={size} height={size} viewBox="0 0 100 100" style={{ overflow: 'visible', display: 'block' }}>
    {children}
  </svg>
);

// Pair: the circles slide in from either side, the overlap lights up, then they "hug" (a small bump).
const Pair: React.FC<MarkProps> = ({ u, size }) => {
  const id = useSvgId();
  const a = easeOutBack(clamp01(u / 0.6), 1.2);
  const lens = clamp01((u - 0.45) / 0.25);
  const hug = 1 + 0.07 * Math.sin(Math.PI * clamp01((u - 0.7) / 0.3));
  const left = lerp(-40, 37, a);
  const right = lerp(140, 63, a);
  return (
    <Svg size={size}>
      <defs>
        <clipPath id={`${id}c`}>
          <circle cx={left} cy={50} r={28} />
        </clipPath>
      </defs>
      <g transform={`translate(50 50) scale(${hug}) translate(-50 -50)`}>
        <circle cx={left} cy={50} r={28} fill={AURA.violet} />
        <circle cx={right} cy={50} r={28} fill={AURA.teal} />
        <circle cx={right} cy={50} r={28} fill={AURA.lens} clipPath={`url(#${id}c)`} opacity={lens} />
      </g>
    </Svg>
  );
};

// Bubble b: the stem grows up, the bowl pops as a speech bubble, and the typing dots bounce once.
// The bowl is filled, not a ring: a ring with a tail on its lower right reads as a magnifier
// (search), which the first render of this concept did.
const DOTS = [47, 58, 69];
const Bubble: React.FC<MarkProps> = ({ u, size }) => {
  const id = useSvgId();
  const stem = easeOutCubic(clamp01(u / 0.35));
  const bowl = easeOutBack(clamp01((u - 0.25) / 0.4), 2.2);
  const h = 76 * stem;
  return (
    <Svg size={size}>
      <defs>
        <Gradient id={`${id}g`} />
      </defs>
      <rect x={16} y={88 - h} width={15} height={h} rx={7.5} fill={`url(#${id}g)`} />
      <g transform={`translate(58 60) scale(${bowl}) translate(-58 -60)`}>
        <circle cx={58} cy={60} r={28} fill={`url(#${id}g)`} />
        <path d="M 70 82 L 92 94 L 83 70 Z" fill={`url(#${id}g)`} />
        {DOTS.map((x, i) => {
          const hop = Math.sin(Math.PI * clamp01((u - 0.75 - i * 0.12) / 0.3));
          return <circle key={x} cx={x} cy={60 - 5 * hop} r={4.2} fill={CREAM} />;
        })}
      </g>
    </Svg>
  );
};

// Huddle: three discs drop in one after another and the group turns into place. Screen blending
// inside an isolated group, so the overlaps mix the same on a dark or a light background.
const DISCS = [
  { cx: 50, cy: 36, fill: AURA.violet },
  { cx: 35, cy: 61, fill: AURA.blue },
  { cx: 65, cy: 61, fill: AURA.pink },
];
const Huddle: React.FC<MarkProps> = ({ u, size }) => {
  const turn = lerp(-40, 0, easeOutCubic(clamp01(u / 0.9)));
  return (
    <Svg size={size}>
      <g style={{ isolation: 'isolate' }} transform={`rotate(${turn} 50 52)`}>
        {DISCS.map((d, i) => {
          const s = easeOutBack(clamp01((u - i * 0.14) / 0.4), 2);
          return (
            <circle
              key={d.fill}
              cx={d.cx}
              cy={d.cy}
              r={24 * s}
              fill={d.fill}
              style={{ mixBlendMode: 'screen' }}
            />
          );
        })}
      </g>
    </Svg>
  );
};

// Chatty: the bubble pops, the eyes open, then it blinks once.
const Chatty: React.FC<MarkProps> = ({ u, size }) => {
  const id = useSvgId();
  const pop = easeOutBack(clamp01(u / 0.45), 2.2);
  const open = clamp01((u - 0.4) / 0.2);
  const blink = 1 - 0.85 * Math.sin(Math.PI * clamp01((u - 1.1) / 0.16));
  const eye = 7 * open * blink;
  return (
    <Svg size={size}>
      <defs>
        <Gradient id={`${id}g`} />
      </defs>
      <g transform={`translate(50 50) rotate(-6) scale(${pop}) translate(-50 -50)`}>
        <path
          d="M 34 14 H 66 A 22 22 0 0 1 88 36 V 60 A 22 22 0 0 1 66 82 H 34 L 18 92 L 22 76 A 22 22 0 0 1 12 60 V 36 A 22 22 0 0 1 34 14 Z"
          fill={`url(#${id}g)`}
        />
        <ellipse cx={39} cy={47} rx={6} ry={eye} fill={CREAM} />
        <ellipse cx={61} cy={47} rx={6} ry={eye} fill={CREAM} />
      </g>
    </Svg>
  );
};

function easeOutCubic(x: number) {
  return 1 - (1 - x) ** 3;
}

export const MARK: Record<Concept, React.FC<MarkProps>> = { pair: Pair, bubble: Bubble, huddle: Huddle, chatty: Chatty };

// The wordmark: lowercase, each letter rising out of a blur, 40 ms apart.
const Wordmark: React.FC<{ u: number; size: number; color: string }> = ({ u, size, color }) => (
  <div style={{ display: 'flex', fontFamily: FONT, fontSize: size, fontWeight: 800, fontVariationSettings: "'opsz' 96", letterSpacing: -size * 0.035, lineHeight: 1, color }}>
    {'buddies'.split('').map((ch, i) => {
      const p = easeOutCubic(clamp01((u - i * 0.04) / 0.45));
      return (
        <span key={`${i}${ch}`} style={{ opacity: p, filter: `blur(${lerp(8, 0, p)}px)`, transform: `translateY(${lerp(size * 0.25, 0, p)}px)` }}>
          {ch}
        </span>
      );
    })}
  </div>
);

const Lockup: React.FC<{ concept: Concept; u: number; mark: number; text: number; color: string; wordAt: number }> = ({
  concept,
  u,
  mark,
  text,
  color,
  wordAt,
}) => {
  const Mark = MARK[concept];
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: mark * 0.22 }}>
      <Mark u={u} size={mark} />
      <Wordmark u={u - wordAt} size={text} color={color} />
    </div>
  );
};

const Glow: React.FC<{ opacity: number }> = ({ opacity }) => (
  <AbsoluteFill
    style={{
      filter: 'blur(90px)',
      opacity,
      background: `radial-gradient(30% 40% at 34% 46%, ${AURA.violet}, transparent 70%),
        radial-gradient(28% 42% at 66% 42%, ${AURA.blue}, transparent 70%),
        radial-gradient(26% 34% at 50% 66%, ${AURA.pink}, transparent 70%)`,
    }}
  />
);

// ---- The reveal: mark builds (0–1.2 s), the word rises (1.0 s), tagline (1.9 s), hold.
export const REVEAL = Math.round(3.6 * FPS);
const WORD_AT = 0.95;
const TAG_AT = 1.9;
const MARK_PX = 250;
const WORD_PX = 230;
const WORD_EM = 3.32; // rendered width of "buddies" in ems, measured off the sheet render
const CENTRE_SHIFT = (WORD_PX * WORD_EM + MARK_PX * 0.22) / 2;
const easeInOut = (x: number) => (x < 0.5 ? 4 * x ** 3 : 1 - (-2 * x + 2) ** 3 / 2);

export const LogoReveal: React.FC<{ concept: Concept }> = ({ concept }) => {
  const u = useCurrentFrame() / FPS;
  const glow = clamp01(u / 1.2) * 0.3;
  const tag = easeOutCubic(clamp01((u - TAG_AT) / 0.5));
  // The mark builds centred, then slides left to make room as the word arrives (the invisible
  // letters already occupy their width, so without this the lone mark sits off-centre).
  const slide = CENTRE_SHIFT * (1 - easeInOut(clamp01((u - WORD_AT + 0.2) / 0.55)));
  const label = NAME[concept];
  return (
    <AbsoluteFill style={{ background: NIGHT }}>
      <Glow opacity={glow} />
      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 40 }}>
        <div style={{ transform: `translateX(${slide}px)` }}>
          <Lockup concept={concept} u={u} mark={MARK_PX} text={WORD_PX} color={CREAM} wordAt={WORD_AT} />
        </div>
        <div style={{ fontFamily: FONT, fontSize: 50, fontWeight: 500, color: 'rgba(253,246,227,.75)', opacity: tag, transform: `translateY(${lerp(12, 0, tag)}px)` }}>
          your team of AI agents
        </div>
      </AbsoluteFill>
      <div style={{ position: 'absolute', left: 60, bottom: 48, fontFamily: FONT, fontSize: 30, fontWeight: 600, color: 'rgba(253,246,227,.4)' }}>
        {label.title} · {label.idea}
      </div>
    </AbsoluteFill>
  );
};

export const LogoReel: React.FC = () => (
  <AbsoluteFill>
    {CONCEPTS.map((c, i) => (
      <Sequence key={c} from={i * REVEAL} durationInFrames={REVEAL}>
        <LogoReveal concept={c} />
      </Sequence>
    ))}
  </AbsoluteFill>
);

// ---- The sheet: each concept as a lockup, app icon, on light, and at favicon sizes.
const AppIcon: React.FC<{ concept: Concept; size: number }> = ({ concept, size }) => {
  const Mark = MARK[concept];
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: size * 0.23,
        background: `linear-gradient(160deg, #221d3d, ${NIGHT})`,
        boxShadow: '0 10px 30px rgba(0,0,0,.45), inset 0 1px 0 rgba(255,255,255,.08)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Mark u={SETTLED} size={size * 0.62} />
    </div>
  );
};

const Tab: React.FC<{ concept: Concept }> = ({ concept }) => {
  const Mark = MARK[concept];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, background: '#2a2738', borderRadius: '10px 10px 0 0', padding: '10px 16px', width: 190 }}>
        <Mark u={SETTLED} size={20} />
        <span style={{ fontFamily: 'system-ui', fontSize: 15, color: '#d8d4e8' }}>Buddies</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
        <Mark u={SETTLED} size={32} />
        <Mark u={SETTLED} size={16} />
      </div>
    </div>
  );
};

const ROW_H = 222;
const SheetRow: React.FC<{ concept: Concept }> = ({ concept }) => (
  <div style={{ height: ROW_H, display: 'flex', alignItems: 'center', gap: 56, borderTop: '1px solid rgba(253,246,227,.08)', padding: '0 60px' }}>
    <div style={{ width: 260, fontFamily: FONT }}>
      <div style={{ fontSize: 38, fontWeight: 800, color: CREAM }}>{NAME[concept].title}</div>
      <div style={{ fontSize: 20, fontWeight: 500, color: 'rgba(253,246,227,.55)', marginTop: 6 }}>{NAME[concept].idea}</div>
    </div>
    <div style={{ width: 560 }}>
      <Lockup concept={concept} u={SETTLED} mark={120} text={112} color={CREAM} wordAt={0} />
    </div>
    <AppIcon concept={concept} size={150} />
    <div style={{ width: 420, height: 170, borderRadius: 18, background: '#f6f3fb', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <Lockup concept={concept} u={SETTLED} mark={80} text={74} color={INKDARK} wordAt={0} />
    </div>
    <Tab concept={concept} />
  </div>
);

export const LogoSheet: React.FC = () => (
  <AbsoluteFill style={{ background: NIGHT, justifyContent: 'center' }}>
    <div style={{ fontFamily: FONT, fontSize: 26, fontWeight: 600, color: 'rgba(253,246,227,.45)', padding: '0 60px 18px', display: 'flex', gap: 56 }}>
      <span style={{ width: 260 }}>Concept</span>
      <span style={{ width: 560 }}>Lockup</span>
      <span style={{ width: 150 }}>App icon</span>
      <span style={{ width: 420 }}>On light</span>
      <span>Tab · 32 · 16 px</span>
    </div>
    {CONCEPTS.map((c) => (
      <SheetRow key={c} concept={c} />
    ))}
  </AbsoluteFill>
);
