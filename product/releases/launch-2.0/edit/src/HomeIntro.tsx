// The first product screen after the title (owner, 2026-10-02): the new workspace home fades in,
// then softens behind plain type, "Swarms of Agents, organized around tasks and channels" and
// "Manage your team of agents just like a team of employees", before the faster music starts.
// One 4-bar phrase of calm (no beat yet: calm.py `opening`). The type is NOT the colour-slab
// Block of the demo scenes: the owner wants a calmer treatment here, like the close.
// Image: ../footage/2026-10-02_home_new.png (see FOOTAGE.md). The sidebar is blurred throughout:
// it lists real channel and Buddy names.
import type React from 'react';
import { AbsoluteFill, Easing, Img, staticFile, useCurrentFrame } from 'remotion';
import { clamp01, FONT, INK, lerp } from './blocks';

export const FPS = 60;
export const WIDTH = 1920;
export const HEIGHT = 1080;
const BAR = (4 * 60) / 128;
export const DURATION = Math.round(4 * BAR * FPS);

export const HOME = staticFile('2026-10-02_home_new.png'); // 2810×1880
export const HOME_W = 1920;
export const HOME_H = Math.round((HOME_W * 1880) / 2810);
export const SIDEBAR_W = Math.round((375 / 2000) * HOME_W); // the sidebar's right edge in the screenshot

// Seconds into the scene.
const FADE_IN = 1.3;
const SOFTEN_AT = 3.0;
const SOFTEN_FOR = 0.9;
const HEADLINE_AT = 3.3;
const SUBLINE_AT = 5.0;

type Word = { text: string; color: string; weight: number; italic?: boolean };
const word = (text: string, color: string = INK.cream, weight = 600, italic = false): Word => ({ text, color, weight, italic });

const HEADLINE: Word[][] = [
  [word('Swarms'), word('of'), word('Agents,')],
  [word('organized'), word('around'), word('tasks', INK.wordmarkOrange, 600, true), word('and'), word('channels')],
];
const SUBLINE: Word[] = 'Manage your team of agents just like a team of employees'.split(' ').map((w) => word(w, 'rgba(253,246,227,.78)', 400));

// Each word rises out of a soft blur, 0.11 s after the one before.
const Words: React.FC<{ words: Word[]; at: number; t: number; size: number }> = ({ words, at, t, size }) => (
  <div style={{ display: 'flex', gap: '0.26em', fontFamily: FONT, fontSize: size, letterSpacing: -0.5, lineHeight: 1.08 }}>
    {words.map((w, i) => {
      const u = Easing.out(Easing.cubic)(clamp01((t - at - i * 0.11) / 0.6));
      return (
        <span
          key={`${i}-${w.text}`}
          style={{
            color: w.color,
            fontWeight: w.weight,
            fontStyle: w.italic ? 'italic' : 'normal',
            opacity: u,
            filter: `blur(${lerp(10, 0, u)}px)`,
            transform: `translateY(${lerp(14, 0, u)}px)`,
          }}
        >
          {w.text}
        </span>
      );
    })}
  </div>
);

export const HomeIntro: React.FC = () => {
  const t = useCurrentFrame() / FPS;
  const len = DURATION / FPS;
  const appear = Easing.out(Easing.cubic)(clamp01(t / FADE_IN));
  const soften = Easing.inOut(Easing.cubic)(clamp01((t - SOFTEN_AT) / SOFTEN_FOR));
  const push = lerp(1, 1.07, t / len);
  return (
    <AbsoluteFill style={{ background: INK.night, overflow: 'hidden' }}>
      <AbsoluteFill
        style={{
          opacity: appear,
          filter: `blur(${lerp(18, 0, appear) + 16 * soften}px) brightness(${lerp(0.5, 1, appear) - 0.62 * soften})`,
          transform: `scale(${push})`,
          transformOrigin: '60% 20%',
        }}
      >
        <Img src={HOME} style={{ position: 'absolute', left: 0, top: -30, width: HOME_W, height: HOME_H }} />
        <div
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            width: SIDEBAR_W,
            height: HEIGHT,
            backdropFilter: 'blur(14px)',
            background: 'rgba(5,9,11,.35)',
          }}
        />
      </AbsoluteFill>
      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', gap: 34 }}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
          {HEADLINE.map((line, i) => (
            <Words key={line[0].text} words={line} at={HEADLINE_AT + i * 0.45} t={t} size={92} />
          ))}
        </div>
        <Words words={SUBLINE} at={SUBLINE_AT} t={t} size={46} />
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
