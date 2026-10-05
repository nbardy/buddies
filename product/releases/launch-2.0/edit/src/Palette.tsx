// AI color themes, the proof after "Completely customizable" (owner, 2026-10-06: "the one feature cut
// I wanted to add … just need to cook"). The owner's 2026-10-05 take, cut to exactly 4 bars with the
// typed swear blurred by ../trim-palette-4bar.sh, which also scales it to this card's 1458×960 so the
// render never decodes the 2750×1812 source. A soft push-in toward the dialog, nothing else.
import type React from 'react';
import { AbsoluteFill, OffthreadVideo, useCurrentFrame } from 'remotion';
import clip from '../../clips/10_ai-color-palettes-4bar.mp4';
import { INK, lerp } from './blocks';

export const FPS = 60;
export const DURATION = 450; // 4 bars at 128 BPM
const W = 1458;
const H = 960;

export const Palette: React.FC = () => {
  const zoom = lerp(1, 1.06, useCurrentFrame() / DURATION);
  return (
    <AbsoluteFill style={{ background: INK.plate }}>
      <div
        style={{
          position: 'absolute',
          left: (1920 - W) / 2,
          top: (1080 - H) / 2,
          width: W,
          height: H,
          overflow: 'hidden',
          borderRadius: 12,
          boxShadow: '0 40px 100px rgba(0,0,0,.5)',
        }}
      >
        <OffthreadVideo src={clip} muted style={{ width: W, height: H, transform: `scale(${zoom})`, transformOrigin: '50% 42%' }} />
      </div>
    </AbsoluteFill>
  );
};
