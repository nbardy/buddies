// The Buddies type kit (owner, 2026-10-03, picking the Pair title card: "this is sweet, what other
// text based pages and styles do we need, let's do them all around this"). Every text page of the
// launch video, restyled in the Pair look, plus the graphics around the launch (link card, README
// banner, avatar). The look: night ground, a slow aurora, cream Bricolage, and the Pair's two
// circle colours (violet, teal) as the only accents. Words rise out of a soft blur; nothing slams.
// Copy is the video's current copy (Overload, HomeIntro, PostIntroBenefits, beat9, Close).
import type React from 'react';
import { AbsoluteFill, Img, Sequence, staticFile, useCurrentFrame } from 'remotion';
import claude from '../../logos/claude.svg';
import cursor from '../../logos/cursor.svg';
import grok from '../../logos/grok.svg';
import openai from '../../logos/openai.svg';
import { clamp01, FONT, lerp } from './blocks';
import { AURA, MARK, NIGHT } from './BuddiesLogos';

export const FPS = 60;

// ---- Tokens
const CREAM = '#fdf6e3';
const QUIET = 'rgba(253,246,227,.62)';
type Tone = 'cream' | 'quiet' | 'violet' | 'teal' | 'pink';
const TONE: Record<Tone, string> = { cream: CREAM, quiet: QUIET, violet: AURA.violet, teal: AURA.teal, pink: AURA.pink };
const GLASS = { background: 'rgba(253,246,227,.07)', border: '1.5px solid rgba(253,246,227,.14)', backdropFilter: 'blur(14px)' };
const DISPLAY = { fontWeight: 700, fontStretch: '92%', fontVariationSettings: "'opsz' 96" } as const;
const TEXT = { fontVariationSettings: "'opsz' 48" } as const;

const easeOutCubic = (x: number) => 1 - (1 - x) ** 3;
const easeInOut = (x: number) => (x < 0.5 ? 4 * x ** 3 : 1 - (-2 * x + 2) ** 3 / 2);
const rise = (t: number, at: number, dur = 0.55) => easeOutCubic(clamp01((t - at) / dur));
const useT = () => useCurrentFrame() / FPS;

// ---- Primitives

// The ground: night plus three aurora glows that drift slowly with time.
const Stage: React.FC<{ t: number; glow?: number; children: React.ReactNode }> = ({ t, glow = 0.3, children }) => {
  const dx = Math.sin(t * 0.5) * 3;
  const dy = Math.cos(t * 0.4) * 2;
  return (
    <AbsoluteFill style={{ background: NIGHT, overflow: 'hidden', fontFamily: FONT }}>
      <AbsoluteFill
        style={{
          filter: 'blur(90px)',
          opacity: glow,
          transform: `translate(${dx}%, ${dy}%) scale(1.1)`,
          background: `radial-gradient(30% 40% at 32% 46%, ${AURA.violet}, transparent 70%),
            radial-gradient(28% 42% at 68% 42%, ${AURA.teal}, transparent 70%),
            radial-gradient(26% 34% at 50% 70%, ${AURA.pink}, transparent 70%)`,
        }}
      />
      {children}
    </AbsoluteFill>
  );
};

// A line of words, each rising out of a blur `gap` seconds after the one before.
type Seg = [string, Tone];
const Words: React.FC<{ segs: Seg[]; t: number; at: number; size: number; weight?: number; gap?: number; display?: boolean }> = ({
  segs,
  t,
  at,
  size,
  weight = 700,
  gap = 0.07,
  display = false,
}) => {
  const words = segs.flatMap(([text, tone]) => text.split(' ').map((w) => ({ w, tone })));
  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        justifyContent: 'center',
        columnGap: '0.24em',
        fontSize: size,
        letterSpacing: -size * 0.02,
        lineHeight: 1.06,
        ...(display ? DISPLAY : TEXT),
        fontWeight: weight,
      }}
    >
      {words.map(({ w, tone }, i) => {
        const p = rise(t, at + i * gap);
        return (
          <span
            key={`${i}-${w}`}
            style={{ color: TONE[tone], opacity: p, filter: `blur(${lerp(10, 0, p)}px)`, transform: `translateY(${lerp(size * 0.18, 0, p)}px)` }}
          >
            {w}
          </span>
        );
      })}
    </div>
  );
};

const Pill: React.FC<{ t: number; at: number; size: number; children: React.ReactNode }> = ({ t, at, size, children }) => {
  const p = rise(t, at, 0.45);
  return (
    <div
      style={{
        ...GLASS,
        display: 'flex',
        alignItems: 'center',
        gap: size * 0.45,
        borderRadius: 999,
        padding: `${size * 0.42}px ${size * 0.8}px`,
        fontSize: size,
        fontWeight: 600,
        color: CREAM,
        opacity: p,
        transform: `translateY(${lerp(16, 0, p)}px) scale(${lerp(0.94, 1, p)})`,
      }}
    >
      {children}
    </div>
  );
};

const Dot: React.FC<{ color: string; size: number }> = ({ color, size }) => (
  <span style={{ width: size, height: size, borderRadius: '50%', background: color, display: 'inline-block', flexShrink: 0 }} />
);

// The chosen lockup (Pair title card): the mark, then "Buddies" in title case.
const WORD_EM = 3.01; // rendered width of "Buddies" in ems at this weight/stretch, measured off the Pair still
const Wordmark: React.FC<{ t: number; at: number; size: number }> = ({ t, at, size }) => (
  <div style={{ display: 'flex', fontSize: size, color: CREAM, letterSpacing: -size * 0.026, lineHeight: 1, ...DISPLAY }}>
    {'Buddies'.split('').map((ch, i) => {
      const p = rise(t, at + i * 0.04, 0.45);
      return (
        <span key={`${i}${ch}`} style={{ opacity: p, filter: `blur(${lerp(8, 0, p)}px)`, transform: `translateY(${lerp(size * 0.25, 0, p)}px)` }}>
          {ch}
        </span>
      );
    })}
  </div>
);

// The mark builds centred, then slides left as the word arrives.
const Lockup: React.FC<{ t: number; at: number; mark: number; word: number; wordAt: number }> = ({ t, at, mark, word, wordAt }) => {
  const shift = ((word * WORD_EM + mark * 0.24) / 2) * (1 - easeInOut(clamp01((t - wordAt + 0.2) / 0.55)));
  const Pair = MARK.pair;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: mark * 0.24, transform: `translateX(${shift}px)` }}>
      <Pair u={t - at} size={mark} />
      <Wordmark t={t} at={wordAt} size={word} />
    </div>
  );
};

const Centre: React.FC<{ gap: number; children: React.ReactNode }> = ({ gap, children }) => (
  <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap, textAlign: 'center' }}>{children}</AbsoluteFill>
);

// The product footage behind captions and the home statement, softened so it never competes with
// the type. The blur also hides real channel and Buddy names in the sidebar.
const Footage: React.FC<{ blur: number; dim: number }> = ({ blur, dim }) => (
  <AbsoluteFill>
    <Img src={staticFile('2026-10-02_home_new.png')} style={{ width: '100%', height: '100%', objectFit: 'cover', filter: `blur(${blur}px)`, transform: 'scale(1.04)' }} />
    <AbsoluteFill style={{ background: `rgba(11,10,20,${dim})` }} />
  </AbsoluteFill>
);

// ---- Video pages (1920×1080). Each takes t = seconds into the page.

const Overload: React.FC = () => {
  const t = useT();
  return (
    <Stage t={t} glow={0.22}>
      <Centre gap={30}>
        <Words segs={[['AI', 'cream'], ['Overload.', 'pink']]} t={t} at={0.1} size={170} display gap={0.12} />
        <Words segs={[["We're all feeling it.", 'quiet']]} t={t} at={0.9} size={56} weight={500} />
        <div style={{ height: 30 }} />
        <Words segs={[["Don't worry, we've got you", 'cream'], ['covered.', 'teal']]} t={t} at={1.8} size={64} weight={600} />
      </Centre>
    </Stage>
  );
};

const Title: React.FC = () => {
  const t = useT();
  return (
    <Stage t={t} glow={lerp(0, 0.3, clamp01(t / 1.2))}>
      <Centre gap={34}>
        <Words segs={[['Introducing', 'quiet']]} t={t} at={0.05} size={46} weight={500} />
        <Lockup t={t} at={0.3} mark={230} word={230} wordAt={1.15} />
        <Words segs={[['your team of AI agents', 'quiet']]} t={t} at={2.0} size={52} weight={500} gap={0.05} />
      </Centre>
    </Stage>
  );
};

const Statement: React.FC = () => {
  const t = useT();
  return (
    <AbsoluteFill style={{ fontFamily: FONT }}>
      <Footage blur={16} dim={0.62} />
      <Centre gap={20}>
        <Words segs={[['Swarms of agents,', 'cream']]} t={t} at={0.2} size={108} display />
        <Words segs={[['organized around', 'cream'], ['tasks', 'violet'], ['and', 'cream'], ['channels.', 'teal']]} t={t} at={0.5} size={108} display />
        <div style={{ height: 22 }} />
        <Words segs={[['Manage your team of agents just like a team of employees.', 'quiet']]} t={t} at={1.5} size={46} weight={500} gap={0.04} />
      </Centre>
    </AbsoluteFill>
  );
};

const BENEFITS: { text: string; at: number }[] = [
  { text: 'Multi harness', at: 0.2 },
  { text: 'Completely free', at: 0.67 },
  { text: 'Open source', at: 1.14 },
  { text: 'Completely customizable', at: 1.61 },
];
const Benefits: React.FC = () => {
  const t = useT();
  const Pair = MARK.pair;
  return (
    <Stage t={t} glow={0.24}>
      <AbsoluteFill style={{ justifyContent: 'center', paddingLeft: 470, gap: 34 }}>
        {BENEFITS.map((b) => {
          const p = rise(t, b.at);
          return (
            <div key={b.text} style={{ display: 'flex', alignItems: 'center', gap: 40, opacity: p, transform: `translateX(${lerp(-24, 0, p)}px)` }}>
              <Pair u={(t - b.at) * 1.4} size={84} />
              <div style={{ fontSize: 104, color: CREAM, letterSpacing: -2, lineHeight: 1.04, filter: `blur(${lerp(8, 0, p)}px)`, ...DISPLAY }}>{b.text}</div>
            </div>
          );
        })}
      </AbsoluteFill>
    </Stage>
  );
};

// A caption over footage (top left), and the time-skip chip (bottom centre).
const Caption: React.FC = () => {
  const t = useT();
  const p = rise(t, 0.15);
  return (
    <AbsoluteFill style={{ fontFamily: FONT }}>
      <Footage blur={9} dim={0.3} />
      <div
        style={{
          ...GLASS,
          background: 'rgba(11,10,20,.62)',
          position: 'absolute',
          left: 64,
          top: 56,
          borderRadius: 30,
          padding: '28px 40px 30px',
          display: 'flex',
          gap: 24,
          alignItems: 'flex-start',
          opacity: p,
          transform: `translateY(${lerp(-14, 0, p)}px)`,
        }}
      >
        <div style={{ marginTop: 14 }}>
          <MARK.pair u={10} size={44} />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-start' }}>
          <Words segs={[['Ask your agents.', 'cream']]} t={t} at={0.25} size={62} display />
          <Words segs={[['In channels.', 'teal']]} t={t} at={0.55} size={44} weight={600} />
        </div>
      </div>
      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'flex-end', paddingBottom: 70 }}>
        <Pill t={t} at={1.4} size={40}>
          <Clock t={t - 1.4} />6 minutes later
        </Pill>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

// The chip's clock: one hand sweeps a full turn as the chip lands (the time skip).
const Clock: React.FC<{ t: number }> = ({ t }) => {
  const turn = 360 * easeOutCubic(clamp01(t / 0.9));
  return (
    <svg width={38} height={38} viewBox="0 0 40 40">
      <circle cx={20} cy={20} r={17} fill="none" stroke={AURA.teal} strokeWidth={4} />
      <line x1={20} y1={20} x2={20} y2={9} stroke={CREAM} strokeWidth={4} strokeLinecap="round" transform={`rotate(${turn} 20 20)`} />
      <circle cx={20} cy={20} r={3} fill={CREAM} />
    </svg>
  );
};

// grok.svg is currentColor, which renders black in an <img>: it is inverted to white on the night
// ground. The others are each kit's own dark-background file (../logos/SOURCES.md).
// The Blossom sits inside wide clear space in its own file, so it is scaled up to match the others.
type Logo = { src: string; filter: string; scale: number };
const LOGO = {
  claude: { src: claude, filter: 'none', scale: 1 },
  openai: { src: openai, filter: 'none', scale: 1.6 },
  cursor: { src: cursor, filter: 'none', scale: 1 },
  grok: { src: grok, filter: 'invert(1)', scale: 1 },
} satisfies Record<string, Logo>;
const LogoImg: React.FC<{ logo: Logo; size: number }> = ({ logo, size }) => (
  <Img src={logo.src} style={{ width: size, height: size, objectFit: 'contain', filter: logo.filter, transform: `scale(${logo.scale})` }} />
);

const LogoFace: React.FC<{ logos: Logo[]; name: string }> = ({ logos, name }) => (
  <>
    <div style={{ display: 'flex', gap: 22 }}>
      {logos.map((l) => (
        <LogoImg key={l.src} logo={l} size={logos.length > 1 ? 92 : 120} />
      ))}
    </div>
    <div style={{ fontSize: 36, fontWeight: 600, color: QUIET }}>{name}</div>
  </>
);
// Muse Spark has no public logo, so its tile is its name set large.
const WordFace: React.FC<{ lines: [string, string] }> = ({ lines }) => (
  <div style={{ fontSize: 64, lineHeight: 0.96, color: CREAM, textAlign: 'center', ...DISPLAY }}>
    {lines[0]}
    <br />
    {lines[1]}
  </div>
);

const HARNESSES: { key: string; face: React.ReactNode }[] = [
  { key: 'claude', face: <LogoFace logos={[LOGO.claude]} name="Claude" /> },
  { key: 'codex', face: <LogoFace logos={[LOGO.openai]} name="Codex" /> },
  { key: 'cursor-grok', face: <LogoFace logos={[LOGO.cursor, LOGO.grok]} name="Cursor · Grok" /> },
  { key: 'muse', face: <WordFace lines={['Muse', 'Spark']} /> },
];

const Tile: React.FC<{ face: React.ReactNode; t: number; at: number }> = ({ face, t, at }) => {
  const p = rise(t, at, 0.5);
  return (
    <div
      style={{
        ...GLASS,
        width: 280,
        height: 280,
        borderRadius: 44,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 26,
        opacity: p,
        transform: `translateY(${lerp(40, 0, p)}px)`,
      }}
    >
      {face}
    </div>
  );
};

const MultiHarness: React.FC = () => {
  const t = useT();
  return (
    <Stage t={t} glow={0.24}>
      <Centre gap={64}>
        <Words segs={[['Multi', 'cream'], ['harness.', 'teal']]} t={t} at={0.1} size={150} display gap={0.12} />
        <div style={{ display: 'flex', gap: 34 }}>
          {HARNESSES.map((h, i) => (
            <Tile key={h.key} face={h.face} t={t} at={0.5 + i * 0.14} />
          ))}
        </div>
        <Words segs={[['One app.', 'cream'], ['Every agent you already use.', 'quiet']]} t={t} at={1.5} size={52} weight={600} gap={0.05} />
      </Centre>
    </Stage>
  );
};

const SUBS: { name: string; logo: Logo }[] = [
  { name: 'Claude', logo: LOGO.claude },
  { name: 'ChatGPT', logo: LOGO.openai },
  { name: 'Cursor', logo: LOGO.cursor },
];
const Subscriptions: React.FC = () => {
  const t = useT();
  return (
    <Stage t={t} glow={0.24}>
      <Centre gap={56}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <Words segs={[['Bring your own', 'cream']]} t={t} at={0.1} size={140} display gap={0.1} />
          <Words segs={[['subscriptions.', 'violet']]} t={t} at={0.4} size={140} display />
        </div>
        <div style={{ display: 'flex', gap: 28 }}>
          {SUBS.map((s, i) => (
            <Pill key={s.name} t={t} at={0.9 + i * 0.12} size={46}>
              <LogoImg logo={s.logo} size={52} />
              {s.name}
            </Pill>
          ))}
        </div>
        <Words segs={[['Buddies is', 'cream'], ['free.', 'teal'], ['Your existing plans do the work.', 'quiet']]} t={t} at={1.6} size={50} weight={600} gap={0.05} />
      </Centre>
    </Stage>
  );
};

const Fork: React.FC = () => {
  const t = useT();
  return (
    <Stage t={t} glow={0.22}>
      <Centre gap={26}>
        <Words segs={[['Fork', 'cream'], ['it.', 'violet']]} t={t} at={0.1} size={200} display gap={0.14} />
        <Words segs={[['Add the features you want.', 'quiet']]} t={t} at={0.8} size={60} weight={500} gap={0.06} />
      </Centre>
    </Stage>
  );
};

const Run: React.FC = () => {
  const t = useT();
  return (
    <Stage t={t} glow={0.22}>
      <Centre gap={6}>
        <Words segs={[['Run it on', 'cream']]} t={t} at={0.1} size={170} display gap={0.12} />
        <Words segs={[['your computer.', 'teal']]} t={t} at={0.45} size={170} display gap={0.12} />
      </Centre>
    </Stage>
  );
};

const Quote: React.FC = () => {
  const t = useT();
  const mark = rise(t, 0, 0.8);
  return (
    <Stage t={t} glow={0.18}>
      <div style={{ position: 'absolute', left: 110, top: 220, fontSize: 380, lineHeight: 1, color: AURA.violet, opacity: 0.35 * mark, ...DISPLAY }}>“</div>
      <Centre gap={40}>
        <div style={{ maxWidth: 1400 }}>
          <Words segs={[["Vim is open source and it's still here decades later.", 'cream']]} t={t} at={0.2} size={86} weight={600} gap={0.06} />
        </div>
        <Words segs={[['Agent software should be too.', 'teal']]} t={t} at={1.5} size={86} weight={700} gap={0.08} />
      </Centre>
    </Stage>
  );
};

const End: React.FC = () => {
  const t = useT();
  return (
    <Stage t={t} glow={lerp(0.1, 0.32, clamp01(t / 1.5))}>
      <Centre gap={44}>
        <Lockup t={t} at={0.1} mark={200} word={200} wordAt={0.8} />
        <Words segs={[['Try Buddies today.', 'cream'], ['Free.', 'teal']]} t={t} at={1.6} size={60} weight={600} gap={0.06} />
        <Pill t={t} at={2.2} size={36}>
          <Dot color={AURA.violet} size={16} />
          github.com/nbardy/buddies
        </Pill>
      </Centre>
    </Stage>
  );
};

// ---- The video pages as data: one dispatcher, one handler each.
export type Page = 'overload' | 'title' | 'statement' | 'benefits' | 'caption' | 'harness' | 'subscriptions' | 'fork' | 'run' | 'quote' | 'end';
export const PAGE: Record<Page, { C: React.FC; seconds: number }> = {
  overload: { C: Overload, seconds: 3.2 },
  title: { C: Title, seconds: 3.6 },
  statement: { C: Statement, seconds: 3.6 },
  benefits: { C: Benefits, seconds: 3.0 },
  caption: { C: Caption, seconds: 3.2 },
  harness: { C: MultiHarness, seconds: 3.4 },
  subscriptions: { C: Subscriptions, seconds: 3.4 },
  fork: { C: Fork, seconds: 2.4 },
  run: { C: Run, seconds: 2.2 },
  quote: { C: Quote, seconds: 3.8 },
  end: { C: End, seconds: 3.8 },
};
export const PAGES = Object.keys(PAGE) as Page[];
export const frames = (p: Page) => Math.round(PAGE[p].seconds * FPS);

export const KitPage: React.FC<{ page: Page }> = ({ page }) => {
  const C = PAGE[page].C;
  return <C />;
};

export const REEL_FRAMES = PAGES.reduce((n, p) => n + frames(p), 0);
export const KitReel: React.FC = () => (
  <AbsoluteFill>
    {PAGES.map((p, i) => {
      const from = PAGES.slice(0, i).reduce((n, q) => n + frames(q), 0);
      return (
        <Sequence key={p} from={from} durationInFrames={frames(p)} name={p}>
          <KitPage page={p} />
        </Sequence>
      );
    })}
  </AbsoluteFill>
);

// ---- Graphics around the launch (stills, settled).
const SETTLED = 10;

// Link preview (Open Graph / X card), 1200×630.
export const OgCard: React.FC = () => (
  <Stage t={0} glow={0.34}>
    <Centre gap={30}>
      <Lockup t={SETTLED} at={0} mark={150} word={150} wordAt={0} />
      <div style={{ fontSize: 40, fontWeight: 500, color: QUIET }}>your team of AI agents</div>
      <div style={{ display: 'flex', gap: 16, marginTop: 14 }}>
        {['Open source', 'Free', 'Multi harness'].map((s) => (
          <Pill key={s} t={SETTLED} at={0} size={24}>
            {s}
          </Pill>
        ))}
      </div>
    </Centre>
  </Stage>
);

// README header, 1280×320.
export const Banner: React.FC = () => (
  <Stage t={1.5} glow={0.3}>
    <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 56 }}>
      <Lockup t={SETTLED} at={0} mark={110} word={110} wordAt={0} />
      <div style={{ width: 2, height: 120, background: 'rgba(253,246,227,.16)' }} />
      <div style={{ fontSize: 40, lineHeight: 1.2, fontWeight: 500, color: QUIET }}>
        your team of
        <br />
        <span style={{ color: CREAM, fontWeight: 600 }}>AI agents</span>
      </div>
    </AbsoluteFill>
  </Stage>
);

// GitHub / X avatar, 512×512: the mark alone (both crop it to a circle).
export const Avatar: React.FC = () => (
  <Stage t={0.8} glow={0.4}>
    <Centre gap={0}>
      <MARK.pair u={SETTLED} size={330} />
    </Centre>
  </Stage>
);
