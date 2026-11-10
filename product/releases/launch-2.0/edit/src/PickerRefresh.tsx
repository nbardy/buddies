// Real desktop picker states captured 2026-09-27; each held image is a hard cut,
// never a reconstructed UI. Capture script + original rectangles are in the manifest.
import type React from 'react';
import { AbsoluteFill, Img, Series, staticFile, useCurrentFrame } from 'remotion';
import { Block, INK, lerp } from './blocks';

const BEAT = 60 / 128;
const end = (beats: number) => Math.round(beats * BEAT * 60);
// Script v2 (2026-09-30): two beats per harness, 2 bars in all, after the "Multi harness" slide.
// The headline stays put across the cuts; re-slamming it on every cut read as choppy.
export const DURATION = end(8);
const SHOTS = [
  { file: '03-claude', label: 'Claude', from: 0, to: 2, top: 344.359375, height: 484.84375 },
  { file: '03-codex', label: 'Codex', from: 2, to: 4, top: 392.359375, height: 436.84375 },
  { file: '03-cursor', label: 'Cursor', from: 4, to: 6, top: 390.9375, height: 438.265625 },
  { file: '03-muse', label: 'Muse', from: 6, to: 8, top: 336.765625, height: 492.4375 },
];

const Shot: React.FC<{ shot: (typeof SHOTS)[number] }> = ({ shot }) => {
  const f = useCurrentFrame();
  const height = shot.height * 2;
  return (
    <AbsoluteFill style={{ background: INK.plate, overflow: 'hidden' }}>
      <div
        style={{
          position: 'absolute',
          left: 1050,
          top: (1080 - height) / 2,
          width: 720,
          height,
          overflow: 'hidden',
          borderRadius: 10,
          boxShadow: '0 35px 90px rgba(0,0,0,.45)',
          transform: `scale(${lerp(0.94, 0.98, f / (end(shot.to) - end(shot.from)))})`,
        }}
      >
        <Img
          src={staticFile(`picker-refresh-20260927/${shot.file}.png`)}
          style={{
            position: 'absolute',
            width: 2974,
            height: 1882,
            left: -2204,
            top: -shot.top * 2,
          }}
        />
      </div>
      <div style={{ position: 'absolute', left: 100, top: 720 }}>
        <Block
          text={shot.label}
          u={f / 60 - 0.12}
          size="md"
          fill={INK.cream}
          ink={INK.plate}
          rot={-1}
        />
      </div>
    </AbsoluteFill>
  );
};

const Headline: React.FC = () => {
  const t = useCurrentFrame() / 60;
  return (
    <div
      style={{
        position: 'absolute',
        left: 95,
        top: 200,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-start',
        gap: 12,
      }}
    >
      {['Pick', 'yours.'].map((text, i) => (
        <Block
          key={text}
          text={text}
          u={t - i * 0.06}
          size="xl"
          fill={i ? INK.wordmarkOrange : INK.cyan}
          ink={INK.plate}
          rot={i ? 2 : -2}
        />
      ))}
    </div>
  );
};

export const PickerRefresh: React.FC = () => (
  <AbsoluteFill>
    <Series>
      {SHOTS.map((shot) => (
        <Series.Sequence key={shot.file} durationInFrames={end(shot.to) - end(shot.from)}>
          <Shot shot={shot} />
        </Series.Sequence>
      ))}
    </Series>
    <Headline />
  </AbsoluteFill>
);
