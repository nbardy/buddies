// The close: GitHub + "Fork it" and "Run it on your computer" (block type, like the demo), then the
// quiet close in plain type: the Vim ethos over the coda and the end card over its final chord.
// Every section is timed in beats of the EDM cue (../../sound/edm.py, 128 BPM) so the assembly can
// drop each one on its bar.
// Sections are data (text, timing, colour); the components just render them.
import type React from 'react';
import { AbsoluteFill, Easing, Img, OffthreadVideo, Series, staticFile, useCurrentFrame } from 'remotion';
import { Block, clamp01, FONT, INK, lerp } from './blocks';
import * as Intro from './BuddiesIntro';
import { AURA } from './BuddiesLogos';
import { INTRO_ROBOTS } from './Overload';

export const FPS = 60;
export const WIDTH = 1920;
export const HEIGHT = 1080;
export const BEAT = 60 / 128;
export const beats = (n: number) => Math.round(n * BEAT * FPS);

type Size = 'md' | 'xl' | 'xxl';
type Word = { text: string; beat: number; size: Size; fill: string; ink: string; rot: number };

// ---- Open source: the real GitHub page, a push-in to Fork, the click, "Fork it." --------------------
// Owner, 2026-09-30: "just show github and a fork real quick". The page is a logged-out dark-mode
// capture (../footage/2026-09-30_github_repo.png, 2974×1882). Nothing is forked: the click is a
// cursor and a press flash drawn over the still.
const REPO_SHOT = staticFile('2026-09-30_github_repo.png');
const REPO_URL = 'github.com/nbardy/unleashd';
const CARD_W = 1500;
const CHROME_H = 64;
const SHOT_SCALE = CARD_W / 2974;
// Fork button in capture px (x 2474–2678, y 177–231), as card px.
const FORK_BTN = { x: 2474 * SHOT_SCALE, y: CHROME_H + 177 * SHOT_SCALE, w: 204 * SHOT_SCALE, h: 54 * SHOT_SCALE };
const FORK_AT = { x: FORK_BTN.x + FORK_BTN.w / 2, y: FORK_BTN.y + FORK_BTN.h / 2 };
const CARD_AT = { x: (1920 - CARD_W) / 2, y: 60 };
const FORK_TO = { x: 1560, y: 200 }; // where the push-in carries the button: the card then overfills the frame, browser bar above it
const ZOOM = 2.0;
const CLICK_BEAT = 4;
const FORK: Word[] = [
  { text: 'Fork it.', beat: CLICK_BEAT, size: 'xl', fill: INK.yellow, ink: INK.plate, rot: -3 },
  { text: 'Add the features you want.', beat: CLICK_BEAT + 1, size: 'md', fill: INK.surface, ink: INK.cream, rot: 0 },
];
export const FORK_FRAMES = beats(8);

const BrowserBar: React.FC<{ url: string }> = ({ url }) => (
  <div style={{ display: 'flex', alignItems: 'center', gap: 22, height: CHROME_H, padding: '0 22px', background: '#e8e8e8' }}>
    <div style={{ display: 'flex', gap: 10 }}>
      {[INK.red, INK.yellow, '#859900'].map((c) => (
        <span key={c} style={{ width: 16, height: 16, borderRadius: 8, background: c }} />
      ))}
    </div>
    <div
      style={{
        flex: 1,
        height: 40,
        borderRadius: 20,
        background: '#fff',
        display: 'flex',
        alignItems: 'center',
        padding: '0 22px',
        fontFamily: FONT,
        fontSize: 26,
        fontWeight: 600,
        color: '#333',
      }}
    >
      {url}
    </div>
  </div>
);

const Cursor: React.FC<{ x: number; y: number; press: number }> = ({ x, y, press }) => (
  <svg
    width={44}
    height={60}
    viewBox="0 0 22 30"
    style={{ position: 'absolute', left: x, top: y, transform: `scale(${1 - 0.15 * press})`, transformOrigin: '0 0' }}
  >
    <path d="M1 1 L1 23 L6.5 17.5 L10.5 27 L14 25.5 L10 16.5 L17.5 16.5 Z" fill="#fff" stroke="#000" strokeWidth={1.4} />
  </svg>
);

export const Fork: React.FC = () => {
  const t = useCurrentFrame() / FPS;
  const push = Easing.inOut(Easing.cubic)(clamp01(t / (3.5 * BEAT)));
  const s = lerp(1, ZOOM, push);
  const btn = { x: lerp(CARD_AT.x + FORK_AT.x, FORK_TO.x, push), y: lerp(CARD_AT.y + FORK_AT.y, FORK_TO.y, push) };
  const glide = Easing.out(Easing.cubic)(clamp01((t - BEAT) / (2.5 * BEAT)));
  const sinceClick = t - CLICK_BEAT * BEAT;
  const press = sinceClick < 0 ? 0 : Math.max(0, 1 - Math.abs(sinceClick - 0.06) / 0.12);
  const flash = sinceClick < 0 ? 0.12 * glide : lerp(0.45, 0.14, clamp01(sinceClick / 0.4));
  return (
    <AbsoluteFill style={{ background: INK.plate }}>
      <div
        style={{
          position: 'absolute',
          left: CARD_AT.x,
          top: CARD_AT.y,
          width: CARD_W,
          borderRadius: 16,
          overflow: 'hidden',
          boxShadow: '0 40px 100px rgba(0,0,0,.55)',
          transformOrigin: `${FORK_AT.x}px ${FORK_AT.y}px`,
          transform: `translate(${btn.x - CARD_AT.x - FORK_AT.x}px, ${btn.y - CARD_AT.y - FORK_AT.y}px) scale(${s})`,
        }}
      >
        <BrowserBar url={REPO_URL} />
        <Img src={REPO_SHOT} style={{ display: 'block', width: CARD_W }} />
        <div
          style={{
            position: 'absolute',
            left: FORK_BTN.x,
            top: FORK_BTN.y,
            width: FORK_BTN.w,
            height: FORK_BTN.h,
            borderRadius: 4,
            background: `rgba(255,255,255,${flash})`,
          }}
        />
      </div>
      <Cursor x={lerp(1560, btn.x + 6, glide)} y={lerp(980, btn.y + 4, glide)} press={press} />
      <div style={{ position: 'absolute', left: 150, top: 640, display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 18 }}>
        {FORK.map((w) => (
          <Block key={w.text} text={w.text} u={t - w.beat * BEAT} size={w.size} fill={w.fill} ink={w.ink} rot={w.rot} />
        ))}
      </div>
    </AbsoluteFill>
  );
};

// ---- Beat 9: "Run it on your computer." The real app, captured from localhost, in a browser
// frame whose address bar shows the URL it was captured from. -------------------------------------
// Captured 2026-09-30 at 4ddfa88 with ../capture/record-page.mjs (#unleashd-2, read-only), 4 s.
const APP = staticFile('2026-09-30_feature_app.mp4');
const APP_URL = 'localhost:7489';
const RUN: Word[] = [
  { text: 'Run it on', beat: 0, size: 'xl', fill: INK.cyan, ink: INK.plate, rot: -2 },
  { text: 'your computer.', beat: 0.5, size: 'xl', fill: INK.wordmarkOrange, ink: INK.plate, rot: 2 },
];
export const RUN_FRAMES = beats(8);

export const Run: React.FC = () => {
  const t = useCurrentFrame() / FPS;
  const settle = Easing.out(Easing.cubic)(clamp01(t / (2 * BEAT)));
  return (
    <AbsoluteFill style={{ background: INK.plate, alignItems: 'center', justifyContent: 'center' }}>
      <div
        style={{
          width: 1500,
          borderRadius: 16,
          overflow: 'hidden',
          background: '#e8e8e8',
          boxShadow: '0 40px 100px rgba(0,0,0,.55)',
          transform: `translateY(${lerp(60, 110, settle)}px) scale(${lerp(1.08, 1, settle)})`,
        }}
      >
        <BrowserBar url={APP_URL} />
        <OffthreadVideo src={APP} muted style={{ display: 'block', width: 1500 }} />
      </div>
      <div style={{ position: 'absolute', left: 120, top: 70, display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 6 }}>
        {RUN.map((w) => (
          <Block key={w.text} text={w.text} u={t - w.beat * BEAT} size={w.size} fill={w.fill} ink={w.ink} rot={w.rot} />
        ))}
      </div>
    </AbsoluteFill>
  );
};

// ---- The quiet close (owner, 2026-09-30): no recap, no beat coming back, and no colour slabs —
// those stay for the demo. Plain type that surfaces word by word over the coda, then the end card
// over one soft chord, fading to black. -----------------------------------------------------------
type Quiet = { text: string; at: number; size: number; weight: number; color: string };

// Each word rises out of a soft blur; `at` is seconds into the card, words 0.12 s apart.
const QuietLine: React.FC<{ line: Quiet; t: number }> = ({ line, t }) => (
  <div style={{ display: 'flex', gap: '0.26em', fontFamily: FONT, fontSize: line.size, fontWeight: line.weight, color: line.color, letterSpacing: -0.5 }}>
    {line.text.split(' ').map((word, i) => {
      const u = Easing.out(Easing.cubic)(clamp01((t - line.at - i * 0.12) / 0.6));
      return (
        <span key={`${i}-${word}`} style={{ opacity: u, filter: `blur(${lerp(10, 0, u)}px)`, transform: `translateY(${lerp(14, 0, u)}px)` }}>
          {word}
        </span>
      );
    })}
  </div>
);

// ---- "Open Source", shimmering (owner pick, 2026-10-05, from three takes in a2c102a): capitalised,
// in the purple magic of the app's "Let the AI Cook" scene (ColorPalettePicker.tsx). The brew's
// colours (violet, pink, teal) flow through the letters under a violet glow, one bright glint
// crosses as it lands, and four-point sparkles twinkle around it. The site headline uses the same
// gradient and speed (docs/index.html .open-source). -------------------------------------------------
const VIOLET = 'oklch(0.74 0.19 300)'; // AURA.violet lifted: at 118px the base violet reads muddy
const SPARK = '#fff6c2';
const BREW = `linear-gradient(100deg, ${VIOLET} 0%, ${AURA.pink} 25%, ${VIOLET} 50%, ${AURA.teal} 75%, ${VIOLET} 100%)`;
const FLOW = 22; // % of the 200%-wide gradient per second: one full cycle in ~9 s

// x, y in % of the phrase box; each twinkles 0 → full → 0 with a quarter turn every 1.6 s.
const SPARKLES = [
  { x: -4, y: 6, s: 40, d: 0.0 },
  { x: 22, y: -22, s: 30, d: 0.5 },
  { x: 58, y: -28, s: 44, d: 1.0 },
  { x: 97, y: -8, s: 34, d: 0.3 },
  { x: 104, y: 70, s: 28, d: 1.3 },
  { x: 40, y: 112, s: 24, d: 0.8 },
  { x: 80, y: 108, s: 32, d: 0.15 },
];
const Sparkles: React.FC<{ t: number }> = ({ t }) => (
  <>
    {SPARKLES.map((s) => {
      const since = t - s.d;
      const p = (((since / 1.6) % 1) + 1) % 1;
      const on = since >= 0 ? Math.sin(p * Math.PI) ** 0.7 : 0;
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
            filter: `drop-shadow(0 0 8px ${VIOLET})`,
          }}
        >
          <path d="M0 -6 L1.5 -1.5 L6 0 L1.5 1.5 L0 6 L-1.5 1.5 L-6 0 L-1.5 -1.5 Z" fill={SPARK} />
        </svg>
      );
    })}
  </>
);

type ShimmerSpec = { lead: string; phrase: string; at: number; size: number };

// The lead words surface like a QuietLine; the phrase surfaces as the next word, one piece so the
// gradient runs continuously across both of its words.
const ShimmerLine: React.FC<{ line: ShimmerSpec; t: number }> = ({ line, t }) => {
  const lead = line.lead.split(' ');
  const at = line.at + lead.length * 0.12;
  const u = Easing.out(Easing.cubic)(clamp01((t - at) / 0.6));
  const glint = lerp(-30, 130, Easing.inOut(Easing.cubic)(clamp01((t - at - 0.3) / 0.8)));
  return (
    <div style={{ display: 'flex', gap: '0.26em', fontFamily: FONT, fontSize: line.size, fontWeight: 600, color: INK.cream, letterSpacing: -0.5 }}>
      {lead.map((word, i) => {
        const w = Easing.out(Easing.cubic)(clamp01((t - line.at - i * 0.12) / 0.6));
        return (
          <span key={`${i}-${word}`} style={{ opacity: w, filter: `blur(${lerp(10, 0, w)}px)`, transform: `translateY(${lerp(14, 0, w)}px)` }}>
            {word}
          </span>
        );
      })}
      <span
        style={{
          position: 'relative',
          opacity: u,
          transform: `translateY(${lerp(14, 0, u)}px)`,
          filter: `blur(${lerp(10, 0, u)}px) drop-shadow(0 0 22px ${AURA.violet})`,
        }}
      >
        <span
          style={{
            fontWeight: 700,
            backgroundImage: `linear-gradient(100deg, transparent ${glint - 8}%, rgba(255,250,240,.95) ${glint}%, transparent ${glint + 8}%), ${BREW}`,
            backgroundSize: '100% 100%, 200% 100%',
            backgroundPosition: `0 0, ${-(t * FLOW) % 200}% 0`,
            WebkitBackgroundClip: 'text',
            backgroundClip: 'text',
            color: 'transparent',
          }}
        >
          {line.phrase}
        </span>
        <Sparkles t={t - at - 0.5} />
      </span>
    </div>
  );
};

// A card line is plain quiet type or the shimmer line; CardLine only picks the renderer.
type CardLine = ({ kind: 'quiet' } & Quiet) | ({ kind: 'shimmer' } & ShimmerSpec);
const CardLineView: React.FC<{ line: CardLine; t: number }> = ({ line, t }) =>
  line.kind === 'quiet' ? <QuietLine line={line} t={t} /> : <ShimmerLine line={line} t={t} />;

const QUIET_CREAM = 'rgba(253,246,227,.72)';
const VIM_CARDS: CardLine[][] = [
  [
    { kind: 'shimmer', lead: 'Vim is', phrase: 'Open Source', at: 0.15, size: 118 },
    { kind: 'quiet', text: "and it's still here decades later.", at: 1.0, size: 64, weight: 400, color: QUIET_CREAM },
  ],
  [
    { kind: 'quiet', text: 'Agent software', at: 0.15, size: 118, weight: 600, color: INK.cream },
    { kind: 'quiet', text: 'should be too.', at: 0.7, size: 118, weight: 600, color: INK.wordmarkOrange },
  ],
];
const cardKey = (line: CardLine) => (line.kind === 'quiet' ? line.text : line.lead);
const VIM_CARD = beats(8);
const DISSOLVE = 0.35; // seconds: each card fades out before the next surfaces
export const VIM_FRAMES = VIM_CARDS.length * VIM_CARD;

const QuietCard: React.FC<{ lines: CardLine[] }> = ({ lines }) => {
  const t = useCurrentFrame() / FPS;
  const len = VIM_CARD / FPS;
  return (
    <AbsoluteFill
      style={{
        alignItems: 'center',
        justifyContent: 'center',
        gap: 18,
        opacity: 1 - clamp01((t - (len - DISSOLVE)) / DISSOLVE),
        transform: `scale(${lerp(1, 1.03, t / len)})`,
      }}
    >
      {lines.map((line) => (
        <CardLineView key={cardKey(line)} line={line} t={t} />
      ))}
    </AbsoluteFill>
  );
};

export const Vim: React.FC = () => (
  <AbsoluteFill style={{ background: INK.night }}>
    <Series>
      {VIM_CARDS.map((lines) => (
        <Series.Sequence key={cardKey(lines[0])} durationInFrames={VIM_CARD}>
          <QuietCard lines={lines} />
        </Series.Sequence>
      ))}
    </Series>
  </AbsoluteFill>
);

// ---- The end card, over the coda's final chord (6 s ring): the Buddies lockup builds (the title's
// huddle discs drop in, "buddies" rises; it replaced the 3D Unleashd wordmark in the rename, 2026-10-03),
// the call to action and the repo surface as plain type, and the frame fades to black with the chord.
// The repo was renamed to nbardy/buddies on 2026-10-05; the old URL redirects. ---------------------
export const END_FRAMES = Math.round(6.0 * FPS);
const END_FADE = 1.4;
export const EndCard: React.FC = () => {
  const t = useCurrentFrame() / FPS;
  const settle = Easing.out(Easing.cubic)(clamp01(t / 1.1));
  const out = 1 - clamp01((t - (END_FRAMES / FPS - END_FADE)) / END_FADE);
  return (
    <AbsoluteFill style={{ background: INK.night }}>
      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', gap: 26, opacity: out }}>
        <div style={{ transform: `scale(${lerp(0.96, 1, settle)})` }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 44 }}>
            <Intro.HuddleMark count={INTRO_ROBOTS} size={200} u={t} />
            <Intro.Wordmark t={t} at={0.45} size={190} />
          </div>
        </div>
        <QuietLine line={{ text: 'Try Buddies today. Free.', at: 1.2, size: 56, weight: 600, color: INK.cream }} t={t} />
        <QuietLine line={{ text: 'github.com/nbardy/buddies', at: 1.9, size: 36, weight: 400, color: QUIET_CREAM }} t={t} />
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

// Preview of the whole close in order (the assembly places each section on its own bar).
export const SECTIONS: { id: string; frames: number; C: React.FC }[] = [
  { id: 'fork', frames: FORK_FRAMES, C: Fork },
  { id: 'run', frames: RUN_FRAMES, C: Run },
  { id: 'vim', frames: VIM_FRAMES, C: Vim },
  { id: 'end', frames: END_FRAMES, C: EndCard },
];
export const DURATION = SECTIONS.reduce((n, s) => n + s.frames, 0);
export const Close: React.FC = () => (
  <Series>
    {SECTIONS.map(({ id, frames, C }) => (
      <Series.Sequence key={id} durationInFrames={frames}>
        <C />
      </Series.Sequence>
    ))}
  </Series>
);
