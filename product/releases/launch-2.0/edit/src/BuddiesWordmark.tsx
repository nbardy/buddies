// Rebrand drafts (owner, 2026-10-03: "leaning towards Buddies"): three wordmark treatments as the
// title card, so the name can be judged on screen before the video's title and end card change.
// Stills only. The tagline answers the one risk left after the name checks: "Buddy" already reads
// as a coding pet (Claude Code's removed /buddy), so every lockup says what the Buddies are.
// Palette: the workspace-home aurora (client/src/components/buddies/ChannelLanding.css).
import type React from 'react';
import { AbsoluteFill } from 'remotion';
import { Block, FONT, INK } from './blocks';

export const WIDTH = 1920;
export const HEIGHT = 1080;

export type Option = 'aurora' | 'pair' | 'loud';
export type Props = { option: Option };

const AURA = {
  violet: 'oklch(0.62 0.2 300)',
  blue: 'oklch(0.66 0.15 240)',
  pink: 'oklch(0.7 0.17 350)',
  teal: 'oklch(0.76 0.12 200)',
};
const NIGHT = '#0b0a14';
const TAGLINE = 'your team of AI agents';

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

const Stack: React.FC<{ children: React.ReactNode; gap: number }> = ({ children, gap }) => (
  <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap, fontFamily: FONT }}>
    {children}
  </AbsoluteFill>
);

const Line: React.FC<{ text: string; size: number; weight: number; color: string }> = ({ text, size, weight, color }) => (
  <div style={{ fontSize: size, fontWeight: weight, color, letterSpacing: -0.5, fontVariationSettings: "'opsz' 32" }}>{text}</div>
);

// A: lowercase, wide and round, filled with the home's aurora. The friendliest of the three.
const Aurora: React.FC = () => (
  <AbsoluteFill style={{ background: NIGHT }}>
    <Glow opacity={0.38} />
    <Stack gap={8}>
      <Line text="Introducing" size={44} weight={500} color="rgba(253,246,227,.6)" />
      <div
        style={{
          fontSize: 300,
          fontWeight: 800,
          fontStretch: '100%',
          fontVariationSettings: "'opsz' 96",
          letterSpacing: -10,
          lineHeight: 1.05,
          paddingBottom: 18,
          background: `linear-gradient(100deg, ${AURA.violet} 10%, ${AURA.blue} 50%, ${AURA.pink} 90%)`,
          WebkitBackgroundClip: 'text',
          color: 'transparent',
        }}
      >
        buddies
      </div>
      <Line text={TAGLINE} size={52} weight={500} color="rgba(253,246,227,.82)" />
    </Stack>
  </AbsoluteFill>
);

// B: a mark plus a cream wordmark. Two overlapping heads, violet and teal, are the "buddies";
// the mark works alone as an app icon or avatar.
const Head: React.FC<{ color: string; x: number; y: number; d: number }> = ({ color, x, y, d }) => (
  <div style={{ position: 'absolute', left: x, top: y, width: d, height: d, borderRadius: '50%', background: color, mixBlendMode: 'screen' }} />
);

const Pair: React.FC = () => (
  <AbsoluteFill style={{ background: NIGHT }}>
    <Glow opacity={0.22} />
    <Stack gap={34}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 46 }}>
        <div style={{ position: 'relative', width: 230, height: 190 }}>
          <Head color={AURA.violet} x={0} y={20} d={150} />
          <Head color={AURA.teal} x={80} y={20} d={150} />
        </div>
        <div style={{ fontSize: 230, fontWeight: 700, fontStretch: '92%', fontVariationSettings: "'opsz' 96", letterSpacing: -6, color: INK.cream, lineHeight: 1 }}>
          Buddies
        </div>
      </div>
      <Line text={TAGLINE} size={52} weight={500} color="rgba(253,246,227,.72)" />
    </Stack>
  </AbsoluteFill>
);

// C: the video's own loud language (colour slabs, condensed ExtraBold), recoloured from
// Unleashd yellow/orange to the aurora. Closest to the current cut; the least "friendly".
const SETTLED = 2; // seconds past every Block's entrance
const Loud: React.FC = () => (
  <AbsoluteFill style={{ background: INK.plate }}>
    <Stack gap={44}>
      <Block text="Introducing" u={SETTLED} size="md" fill={INK.surface} ink={INK.cream} rot={0} />
      <div style={{ fontSize: 0 }}>
        <Block text="BUDDIES" u={SETTLED} size="xxl" fill={AURA.violet} ink={INK.cream} rot={-3} />
      </div>
      <Block text={TAGLINE} u={SETTLED} size="md" fill={AURA.teal} ink={INK.plate} rot={2} />
    </Stack>
  </AbsoluteFill>
);

const CARD: Record<Option, React.FC> = { aurora: Aurora, pair: Pair, loud: Loud };

export const BuddiesWordmark: React.FC<Props> = ({ option }) => {
  const Card = CARD[option];
  return <Card />;
};
