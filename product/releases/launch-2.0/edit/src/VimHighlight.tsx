// Taste call (owner, 2026-10-05: "highlight open source, some nice text style; should it be capital?"):
// the first Vim card with "open source" emphasised three ways. Render one still per variant, the
// owner picks, the winner moves into Close.tsx's VIM_CARDS and this file is deleted.
import type React from 'react';
import { AbsoluteFill, Easing, useCurrentFrame } from 'remotion';
import { clamp01, FONT, INK, lerp } from './blocks';
import { FPS } from './Close';

export { FPS };
export const WIDTH = 1920;
export const HEIGHT = 1080;
export const DURATION = Math.round(4 * FPS);

export type Variant = 'accent' | 'marker' | 'marker-caps';
const PHRASE: Record<Variant, string> = { accent: 'open source', marker: 'open source', 'marker-caps': 'Open Source' };

const rise = (t: number, at: number) => Easing.out(Easing.cubic)(clamp01((t - at) / 0.6));
const wordStyle = (u: number): React.CSSProperties => ({
  opacity: u,
  filter: `blur(${lerp(10, 0, u)}px)`,
  transform: `translateY(${lerp(14, 0, u)}px)`,
});

const Word: React.FC<{ text: string; t: number; at: number }> = ({ text, t, at }) => (
  <span style={wordStyle(rise(t, at))}>{text}</span>
);

// The phrase in the punchline's orange, nothing else.
const Accent: React.FC<{ text: string; t: number; at: number }> = ({ text, t, at }) => (
  <span style={{ ...wordStyle(rise(t, at)), color: INK.wordmarkOrange }}>{text}</span>
);

// A highlighter stroke wipes in behind the phrase after it lands; the ink flips to night for contrast.
const Marker: React.FC<{ text: string; t: number; at: number }> = ({ text, t, at }) => {
  const swipe = Easing.out(Easing.exp)(clamp01((t - at - 0.35) / 0.45));
  return (
    <span style={{ ...wordStyle(rise(t, at)), position: 'relative', padding: '0 0.12em', color: swipe > 0.5 ? INK.night : INK.cream }}>
      <span
        style={{
          position: 'absolute',
          inset: '0.12em 0 0.02em 0',
          background: INK.wordmarkOrange,
          borderRadius: '0.08em',
          transform: `rotate(-1.2deg) scaleX(${swipe})`,
          transformOrigin: 'left center',
          zIndex: -1,
        }}
      />
      {text}
    </span>
  );
};

const Phrase: Record<Variant, React.FC<{ text: string; t: number; at: number }>> = {
  accent: Accent,
  marker: Marker,
  'marker-caps': Marker,
};

export const VimHighlight: React.FC<{ variant: Variant }> = ({ variant }) => {
  const t = useCurrentFrame() / FPS;
  const P = Phrase[variant];
  return (
    <AbsoluteFill style={{ background: INK.night, alignItems: 'center', justifyContent: 'center', gap: 18 }}>
      <div style={{ display: 'flex', gap: '0.26em', fontFamily: FONT, fontSize: 118, fontWeight: 600, color: INK.cream, letterSpacing: -0.5, isolation: 'isolate' }}>
        <Word text="Vim" t={t} at={0.15} />
        <Word text="is" t={t} at={0.27} />
        <P text={PHRASE[variant]} t={t} at={0.39} />
      </div>
      <div style={{ fontFamily: FONT, fontSize: 64, fontWeight: 400, color: 'rgba(253,246,227,.72)', letterSpacing: -0.5, opacity: rise(t, 1.0) }}>
        and it's still here decades later.
      </div>
    </AbsoluteFill>
  );
};
