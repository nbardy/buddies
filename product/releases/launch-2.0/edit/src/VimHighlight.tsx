// Taste call (owner, 2026-10-05): "Open Source" capitalised and highlighted on the first Vim card,
// in "our purple and magic approach": the app's "Let the AI Cook" animation (ColorPalettePicker.tsx,
// 960754c) — violet glow, colour orbs rising out of a cauldron, four-point sparkles twinkling. Three
// takes; the owner picks, the winner moves into Close.tsx's VIM_CARDS and this file is deleted.
// Round 1 (orange text, orange marker, marker caps) was rejected: 654032b.
import type React from 'react';
import { AbsoluteFill, Easing, useCurrentFrame } from 'remotion';
import { AURA } from './BuddiesLogos';
import { clamp01, FONT, INK, lerp } from './blocks';
import { FPS } from './Close';

export { FPS };
export const WIDTH = 1920;
export const HEIGHT = 1080;
export const DURATION = Math.round(4 * FPS);

export type Variant = 'glow' | 'shimmer' | 'conjure';

// Lifted for legibility at 118px on night; AURA.violet itself reads muddy as type.
const VIOLET = 'oklch(0.74 0.19 300)';
const SPARK = '#fff6c2';
const AT = 0.39; // the phrase surfaces after "Vim is"

const rise = (t: number, at: number) => Easing.out(Easing.cubic)(clamp01((t - at) / 0.6));
const surface = (u: number): React.CSSProperties => ({
  opacity: u,
  filter: `blur(${lerp(10, 0, u)}px)`,
  transform: `translateY(${lerp(14, 0, u)}px)`,
});

// Four-point stars around the phrase (x, y in % of its box), the cook scene's twinkle: 0 → full → 0
// with a quarter turn, 1.6 s period, staggered.
const SPARKLES = [
  { x: -4, y: 6, s: 30, d: 0.0 },
  { x: 22, y: -22, s: 22, d: 0.5 },
  { x: 58, y: -26, s: 34, d: 1.0 },
  { x: 97, y: -8, s: 26, d: 0.3 },
  { x: 104, y: 70, s: 20, d: 1.3 },
  { x: 40, y: 112, s: 18, d: 0.8 },
  { x: 80, y: 108, s: 24, d: 0.15 },
];
const Sparkles: React.FC<{ t: number; from: number }> = ({ t, from }) => (
  <>
    {SPARKLES.map((s) => {
      const p = (((t - from - s.d) / 1.6) % 1 + 1) % 1;
      const on = t - from - s.d >= 0 ? Math.sin(p * Math.PI) : 0;
      return (
        <svg
          key={`${s.x}-${s.y}`}
          viewBox="-6 -6 12 12"
          style={{
            position: 'absolute',
            left: `${s.x}%`,
            top: `${s.y}%`,
            width: s.s,
            height: s.s,
            opacity: on,
            transform: `translate(-50%, -50%) scale(${lerp(0.2, 1, on)}) rotate(${p * 90}deg)`,
            filter: `drop-shadow(0 0 6px ${VIOLET})`,
          }}
        >
          <path d="M0 -6 L1.5 -1.5 L6 0 L1.5 1.5 L0 6 L-1.5 1.5 L-6 0 L-1.5 -1.5 Z" fill={SPARK} />
        </svg>
      );
    })}
  </>
);

// Glow: the phrase in violet with a breathing halo, sparkles around it.
const Glow: React.FC<{ t: number }> = ({ t }) => {
  const breathe = 0.75 + 0.25 * Math.sin((t - AT) * 2.4);
  return (
    <span style={{ ...surface(rise(t, AT)), position: 'relative', color: VIOLET, textShadow: `0 0 ${28 * breathe}px ${AURA.violet}, 0 0 ${70 * breathe}px ${AURA.violet}` }}>
      Open Source
      <Sparkles t={t} from={AT + 0.5} />
    </span>
  );
};

// Shimmer: the brew gradient (violet, pink, teal) flowing through the letters, as the cauldron's hue
// rotates, under a soft violet glow.
const Shimmer: React.FC<{ t: number }> = ({ t }) => (
  <span style={{ ...surface(rise(t, AT)), position: 'relative', filter: `drop-shadow(0 0 22px ${AURA.violet})` }}>
    <span
      style={{
        backgroundImage: `linear-gradient(100deg, ${VIOLET} 0%, ${AURA.pink} 25%, ${VIOLET} 50%, ${AURA.teal} 75%, ${VIOLET} 100%)`,
        backgroundSize: '200% 100%',
        backgroundPosition: `${-(t * 22) % 200}% 0`,
        WebkitBackgroundClip: 'text',
        backgroundClip: 'text',
        color: 'transparent',
      }}
    >
      Open Source
    </span>
    <Sparkles t={t} from={AT + 0.5} />
  </span>
);

// Conjure: colour orbs rise out from under the phrase like the cauldron's, a violet flash as it
// lands, then it settles to violet with the glow and sparkles.
const ORBS = [
  { x: 8, r: 14, c: AURA.pink, d: 0.0 },
  { x: 30, r: 10, c: AURA.teal, d: 0.25 },
  { x: 52, r: 16, c: VIOLET, d: 0.1 },
  { x: 72, r: 11, c: AURA.blue, d: 0.4 },
  { x: 90, r: 13, c: AURA.pink, d: 0.55 },
  { x: 42, r: 9, c: AURA.teal, d: 0.85 },
  { x: 64, r: 12, c: VIOLET, d: 1.1 },
];
const Conjure: React.FC<{ t: number }> = ({ t }) => {
  const flash = Math.exp(-Math.max(0, t - AT - 0.25) * 4) * clamp01((t - AT) / 0.25);
  return (
    <span style={{ ...surface(rise(t, AT)), position: 'relative', color: VIOLET, textShadow: `0 0 ${30 + 60 * flash}px ${AURA.violet}, 0 0 ${8 * flash}px #fff` }}>
      {ORBS.map((o) => {
        const p = (((t - AT + 0.3 - o.d) / 2.4) % 1 + 1) % 1;
        const live = t - AT + 0.3 - o.d >= 0;
        const fade = live ? Math.min(1, p / 0.2) * (1 - clamp01((p - 0.6) / 0.4)) : 0;
        return (
          <span
            key={`${o.x}-${o.d}`}
            style={{
              position: 'absolute',
              left: `${o.x}%`,
              top: '78%',
              width: o.r * 2,
              height: o.r * 2,
              borderRadius: '50%',
              background: o.c,
              boxShadow: `0 0 ${o.r * 1.6}px ${o.c}`,
              opacity: 0.85 * fade,
              transform: `translate(-50%, ${lerp(0, -170, Easing.out(Easing.quad)(p))}px) scale(${lerp(0.3, 1, Math.min(1, p / 0.6))})`,
              zIndex: -1,
            }}
          />
        );
      })}
      Open Source
      <Sparkles t={t} from={AT + 0.6} />
    </span>
  );
};

const Phrase: Record<Variant, React.FC<{ t: number }>> = { glow: Glow, shimmer: Shimmer, conjure: Conjure };

const Word: React.FC<{ text: string; t: number; at: number }> = ({ text, t, at }) => (
  <span style={surface(rise(t, at))}>{text}</span>
);

export const VimHighlight: React.FC<{ variant: Variant }> = ({ variant }) => {
  const t = useCurrentFrame() / FPS;
  const P = Phrase[variant];
  return (
    <AbsoluteFill style={{ background: INK.night, alignItems: 'center', justifyContent: 'center', gap: 18 }}>
      <div style={{ display: 'flex', gap: '0.26em', fontFamily: FONT, fontSize: 118, fontWeight: 600, color: INK.cream, letterSpacing: -0.5, isolation: 'isolate' }}>
        <Word text="Vim" t={t} at={0.15} />
        <Word text="is" t={t} at={0.27} />
        <P t={t} />
      </div>
      <div style={{ fontFamily: FONT, fontSize: 64, fontWeight: 400, color: 'rgba(253,246,227,.72)', letterSpacing: -0.5, opacity: rise(t, 1.0) }}>
        and it's still here decades later.
      </div>
    </AbsoluteFill>
  );
};
