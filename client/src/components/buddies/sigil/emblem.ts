// Glowing kernel genome, originally the workspace emblem; now used for Buddies
// (owner, #channels-feature 2026-09-30 swapped the two icon styles).
//
// A Buddy sigil is a bright pattern AROUND a dark silhouette. A workspace
// emblem is the opposite (owner, #channels-feature 2026-09-25): a dark ground,
// the pattern glowing at full strength inside a central kernel and fading to
// ~10% toward the edges. The kernel carries the identity, so it is not the
// sigil's rectangle↔oval superellipse but a superformula — lobes, pinches and
// asymmetric bulges — pushed further by radial noise.
//
// The pattern itself reuses the sigil decoder (same field, CPPN, palette), so
// the two families share a visual language. The kernel and ground read their
// own seeded decoder rows. Changing this decoder, its seed, or the ORDER of
// `take()` calls redraws every icon using this style — bump EMBLEM_VERSION
// when you do it on purpose.

import {
  LATENT_DIM,
  type Latent,
  type SigilGenome,
  decodeGenome,
  gaussianStream,
  hash32,
} from './genome';

export const EMBLEM_VERSION = 1;

/** Pattern opacity at the rim, where the emblem fades into its ground. */
export const EMBLEM_EDGE_OPACITY = 0.1;

export type EmblemGenome = {
  field: SigilGenome;
  ground: { lightness: number; chroma: number; hue: number };
  // Superformula r(θ) = (|cos(mθ/4)|^n2 + |sin(mθ/4)|^n3)^(−1/n1), with m
  // continuous: the renderer crossfades the two neighbouring integer lobes.
  // `scale` holds 1 / max r(θ) for floor(m) and floor(m) + 1, so every shape
  // fills the same radius however spiky it is.
  kernel: {
    lobes: number;
    n1: number;
    n2: number;
    n3: number;
    scale: readonly [number, number];
    radius: number;
    softness: number; // half-width of the kernel's edge, in radii; a glow extends past it
    rotation: number;
    warp: number;
    warpFrequency: number;
    warpPhase: number;
  };
};

const KERNEL_ROWS = 16;
const DECODER = (() => {
  const next = gaussianStream(hash32('workspace-emblem-decoder-v1'));
  const scale = 1 / Math.sqrt(LATENT_DIM);
  return Array.from({ length: KERNEL_ROWS }, () =>
    Float64Array.from({ length: LATENT_DIM }, () => next() * scale)
  );
})();

const sig = (x: number) => 1 / (1 + Math.exp(-x));
const lerp = (lo: number, hi: number, t: number) => lo + (hi - lo) * t;

export function superformula(theta: number, m: number, n1: number, n2: number, n3: number) {
  const a = Math.abs(Math.cos((m * theta) / 4)) ** n2;
  const b = Math.abs(Math.sin((m * theta) / 4)) ** n3;
  return (a + b + 1e-6) ** (-1 / n1);
}

function maxRadius(m: number, n1: number, n2: number, n3: number): number {
  let max = 0;
  for (let i = 0; i < 720; i++) {
    max = Math.max(max, superformula((i / 720) * 2 * Math.PI, m, n1, n2, n3));
  }
  return max;
}

export function decodeEmblem(z: Latent, seed: number): EmblemGenome {
  const projected = DECODER.map((row) => row.reduce((sum, w, i) => sum + w * z[i], 0));
  let cursor = 0;
  const take = () => projected[cursor++];

  const base = decodeGenome(z, seed);
  // Light inks only: the pattern is the bright thing on a dark ground.
  const lightLow = lerp(0.5, 0.64, sig(take()));
  const field: SigilGenome = {
    ...base,
    // The kernel shows only the middle of the field; zoom in so it carries
    // pattern rather than one flat tone.
    frame: { ...base.frame, zoom: base.frame.zoom * 1.8 },
    palette: {
      ...base.palette,
      polarity: 0,
      lightLow,
      lightHigh: Math.min(0.97, lightLow + lerp(0.25, 0.4, sig(take()))),
    },
  };
  const ground = {
    lightness: lerp(0.13, 0.19, sig(take())),
    chroma: base.palette.chroma * lerp(0.2, 0.45, sig(take())),
    hue: base.palette.hue + 30 * Math.tanh(take()),
  };

  const lobes = lerp(2.6, 8.4, sig(1.1 * take()));
  // Small n1 pinches the lobes into points; large n1 rounds them out.
  const n1 = lerp(0.45, 4, sig(take()));
  const n2 = lerp(0.8, 4.5, sig(take()));
  const n3 = lerp(0.8, 4.5, sig(take()));
  const m0 = Math.floor(lobes);
  const kernel = {
    lobes,
    n1,
    n2,
    n3,
    scale: [1 / maxRadius(m0, n1, n2, n3), 1 / maxRadius(m0 + 1, n1, n2, n3)] as const,
    radius: lerp(0.52, 0.7, sig(take())),
    softness: lerp(0.05, 0.14, sig(take())),
    rotation: Math.PI * Math.tanh(take()),
    warp: lerp(0.05, 0.24, sig(take())),
    warpFrequency: lerp(0.9, 2.2, sig(take())),
    warpPhase: 10 * take(),
  };
  return { field, ground, kernel };
}

export function workspaceLatent(name: string): Latent {
  const next = gaussianStream(hash32(`workspace-latent:${name}`));
  return Array.from({ length: LATENT_DIM }, next);
}

export function workspaceEmblemGenome(name: string): EmblemGenome {
  return decodeEmblem(workspaceLatent(name), hash32(`workspace:${name}`));
}

/** CSS colour of the ground — what a not-yet-rendered emblem shows. */
export function emblemGroundCss(genome: EmblemGenome): string {
  const { lightness, chroma, hue } = genome.ground;
  return `oklch(${lightness.toFixed(3)} ${chroma.toFixed(3)} ${hue.toFixed(1)})`;
}
