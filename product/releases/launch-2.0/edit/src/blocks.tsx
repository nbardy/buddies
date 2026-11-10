// The launch's type motion, shared by every card: a colour slab wipes in, the word rises out of
// it, then the slab punches. Same curves as beat9/beat9.html, so the open and the close match.
import type React from 'react';
import { continueRender, delayRender } from 'remotion';
import bricolage from '../../fonts/BricolageGrotesque.ttf';

export const FONT = 'Bricolage';

// Frames must not render in a fallback face: hold the render until the variable font is in.
const fontHandle = delayRender('Bricolage Grotesque');
new FontFace(FONT, `url(${bricolage})`, { weight: '200 800', stretch: '75% 100%' })
  .load()
  .then((face) => {
    document.fonts.add(face);
    continueRender(fontHandle);
  });

// Solarized, as on the beat 9 slides.
export const INK = {
  plate: '#002b36',
  surface: '#073642',
  cream: '#fdf6e3',
  night: '#05090b',
  yellow: '#b58900',
  orange: '#cb4b16',
  red: '#dc322f',
  cyan: '#2aa198',
  wordmarkOrange: '#FD8C00',
} as const;

export const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
export const lerp = (a: number, b: number, p: number) => a + (b - a) * p;
export const easeOutExpo = (x: number) => (x >= 1 ? 1 : 1 - 2 ** (-10 * x));
export const easeOutBack = (x: number, k = 1.9) => 1 + (k + 1) * (x - 1) ** 3 + k * (x - 1) ** 2;

type Size = 'md' | 'xl' | 'xxl';
const SIZE: Record<Size, React.CSSProperties> = {
  md: {
    fontSize: 54,
    fontWeight: 700,
    fontStretch: '90%',
    padding: '12px 28px 16px',
    borderRadius: 14,
  },
  xl: {
    fontSize: 150,
    fontWeight: 800,
    fontStretch: '78%',
    padding: '6px 34px 14px',
    borderRadius: 18,
  },
  xxl: {
    fontSize: 176,
    fontWeight: 800,
    fontStretch: '78%',
    padding: '6px 34px 14px',
    borderRadius: 18,
  },
};

// u = seconds since the block's entrance.
export const Block: React.FC<{
  text: string;
  u: number;
  size: Size;
  fill: string;
  ink: string;
  rot: number;
}> = ({ text, u, size, fill, ink, rot }) => {
  const wipe = easeOutExpo(clamp01(u / 0.22));
  const rise = easeOutBack(clamp01((u - 0.06) / 0.3));
  const punch = easeOutBack(clamp01((u - 0.16) / 0.3), 3);
  const box = SIZE[size];
  return (
    <span
      style={{
        position: 'relative',
        display: 'inline-block',
        overflow: 'hidden',
        lineHeight: 1,
        letterSpacing: -1,
        fontFamily: FONT,
        fontVariationSettings: "'opsz' 96",
        visibility: u < 0 ? 'hidden' : 'visible',
        transform: `rotate(${rot}deg) scale(${lerp(1.18, 1, punch)})`,
        ...box,
      }}
    >
      <span
        style={{
          position: 'absolute',
          inset: 0,
          background: fill,
          borderRadius: box.borderRadius,
          transformOrigin: 'left center',
          transform: `scaleX(${wipe})`,
        }}
      />
      <span
        style={{
          position: 'relative',
          display: 'inline-block',
          color: ink,
          transform: `translateY(${lerp(110, 0, rise)}%)`,
        }}
      >
        {text}
      </span>
    </span>
  );
};
