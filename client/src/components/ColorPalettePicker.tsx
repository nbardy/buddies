import '@fontsource-variable/inter/wght.css';
import '@fontsource-variable/plus-jakarta-sans/wght.css';
import { useRef, useState } from 'react';
import { PALETTES, type Palette16, applyPalette, useSettingsStore } from '../stores/settingsStore';
import './ColorPalettePicker.css';

interface Props {
  onClose: () => void;
}

// ─── Color math helpers ──────────────────────────────────────────────────────
// These replicate the CSS color-mix(in oklch, ...) derivations in JS so we can
// render computed swatches in the picker. The formulas match index.css exactly.

function hexToRgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

function rgbToHex(r: number, g: number, b: number): string {
  return `#${[r, g, b]
    .map((v) =>
      Math.round(Math.max(0, Math.min(255, v)))
        .toString(16)
        .padStart(2, '0')
    )
    .join('')}`;
}

// sRGB → linear
function linearize(c: number): number {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

// linear → sRGB
function delinearize(c: number): number {
  const s = c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
  return s * 255;
}

function rgbToOklch(r: number, g: number, b: number): [number, number, number] {
  const lr = linearize(r);
  const lg = linearize(g);
  const lb = linearize(b);

  const l_ = 0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb;
  const m_ = 0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb;
  const s_ = 0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb;

  const l1 = Math.cbrt(l_);
  const m1 = Math.cbrt(m_);
  const s1 = Math.cbrt(s_);

  const L = 0.2104542553 * l1 + 0.793617785 * m1 - 0.0040720468 * s1;
  const a = 1.9779984951 * l1 - 2.428592205 * m1 + 0.4505937099 * s1;
  const bVal = 0.0259040371 * l1 + 0.7827717662 * m1 - 0.808675766 * s1;

  const C = Math.sqrt(a * a + bVal * bVal);
  let H = Math.atan2(bVal, a) * (180 / Math.PI);
  if (H < 0) H += 360;

  return [L, C, H];
}

function oklchToRgb(L: number, C: number, H: number): [number, number, number] {
  const hRad = H * (Math.PI / 180);
  const a = C * Math.cos(hRad);
  const b = C * Math.sin(hRad);

  const l1 = L + 0.3963377774 * a + 0.2158037573 * b;
  const m1 = L - 0.1055613458 * a - 0.0638541728 * b;
  const s1 = L - 0.0894841775 * a - 1.291485548 * b;

  const l_ = l1 * l1 * l1;
  const m_ = m1 * m1 * m1;
  const s_ = s1 * s1 * s1;

  const r = +4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_;
  const g = -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_;
  const bVal = -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_;

  return [delinearize(r), delinearize(g), delinearize(bVal)];
}

/** Simulate color-mix(in oklch, color P%, white) */
function mixWhiteOklch(hex: string, pct: number): string {
  const [r, g, b] = hexToRgb(hex);
  const [L, C, H] = rgbToOklch(r, g, b);
  const wt = 1 - pct / 100;
  const [rr, gg, bb] = oklchToRgb(L + (1 - L) * wt, C * (pct / 100), H);
  return rgbToHex(rr, gg, bb);
}

/** Simulate color-mix(in srgb, color P%, transparent) → rgba string */
function mixTransparentSrgb(hex: string, pct: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${(pct / 100).toFixed(2)})`;
}

/** Simulate color-mix(in oklch, colorA P%, colorB) */
function mixTwoOklch(hexA: string, hexB: string, pctA: number): string {
  const [rA, gA, bA] = hexToRgb(hexA);
  const [rB, gB, bB] = hexToRgb(hexB);
  const [lA, cA, hA] = rgbToOklch(rA, gA, bA);
  const [lB, cB, hB] = rgbToOklch(rB, gB, bB);
  const t = pctA / 100;
  // Hue interpolation (shortest arc)
  let dh = hB - hA;
  if (dh > 180) dh -= 360;
  if (dh < -180) dh += 360;
  const h = hA + (1 - t) * dh;
  const [r, g, b] = oklchToRgb(lA * t + lB * (1 - t), cA * t + cB * (1 - t), h);
  return rgbToHex(r, g, b);
}

/**
 * Simulate color-mix(in oklch, accent P%, canvas) — dim variant.
 * Mixes toward the canvas background instead of black, so dim variants
 * are context-aware across light/dark themes.
 */
function mixCanvasOklch(hex: string, canvas: string, pct: number): string {
  return mixTwoOklch(hex, canvas, pct);
}

/** Simulate color-mix(in oklch, color P%, black) — used for bg elevation */
function mixBlackOklch(hex: string, pct: number): string {
  const [r, g, b] = hexToRgb(hex);
  const [L, C, H] = rgbToOklch(r, g, b);
  const [rr, gg, bb] = oklchToRgb(L * (pct / 100), C * (pct / 100), H);
  return rgbToHex(rr, gg, bb);
}

// ─── Derived token computation from a Palette16 ─────────────────────────────
// Mirrors index.css :root derivations exactly.

interface DerivedTokens {
  // Accent families: 8 intents × 4 variants
  accents: Record<string, { dim: string; base: string; bright: string; glow: string }>;
  // Background elevation ramp
  bg: { label: string; color: string }[];
  // Text scale
  text: { label: string; color: string }[];
  // Border scale
  borders: { label: string; color: string }[];
  // Semantic mappings
  semantic: { label: string; color: string; accent: string }[];
  // Message tints
  messages: { label: string; color: string }[];
}

const ACCENT_KEYS = [
  'user',
  'ai',
  'primary',
  'success',
  'warning',
  'queue',
  'danger',
  'meta',
] as const;

const SEMANTIC_MAP: { label: string; key: (typeof ACCENT_KEYS)[number] }[] = [
  { label: 'Primary', key: 'primary' },
  { label: 'User', key: 'user' },
  { label: 'Assistant', key: 'ai' },
  { label: 'Success', key: 'ai' },
  { label: 'Warning', key: 'warning' },
  { label: 'Error', key: 'danger' },
  { label: 'Queue', key: 'queue' },
  { label: 'Meta', key: 'meta' },
];

function derivePalette(p: Palette16): DerivedTokens {
  const accents: DerivedTokens['accents'] = {};
  for (const key of ACCENT_KEYS) {
    accents[key] = {
      dim: mixCanvasOklch(p[key], p.bgCanvas, 35),
      base: p[key],
      bright: mixWhiteOklch(p[key], 75),
      glow: mixTransparentSrgb(p[key], 22),
    };
  }

  const bg: DerivedTokens['bg'] = [
    { label: 'Darkest', color: mixBlackOklch(p.bgCanvas, 70) },
    { label: 'Base', color: mixBlackOklch(p.bgCanvas, 85) },
    { label: 'Content', color: p.bgCanvas },
    { label: 'Card', color: mixTwoOklch(p.bgCanvas, p.bgSurface, 85) },
    { label: 'Panel', color: p.bgSurface },
    { label: 'Hover', color: mixTwoOklch(p.bgSurface, p.textMuted, 80) },
    { label: 'Active', color: mixTwoOklch(p.bgSurface, p.textMuted, 65) },
    { label: 'Popup', color: mixTwoOklch(p.bgSurface, p.textMuted, 50) },
    { label: 'Highlight', color: mixTwoOklch(p.bgSurface, p.textMuted, 35) },
  ];

  const text: DerivedTokens['text'] = [
    { label: 'Muted', color: p.textMuted },
    { label: 'Secondary', color: p.textSubtle },
    { label: 'Primary', color: p.textBody },
    { label: 'Emphasis', color: p.textBright },
    { label: 'Bright', color: mixWhiteOklch(p.textBright, 70) },
  ];

  const borders: DerivedTokens['borders'] = [
    { label: 'Subtle (10%)', color: mixTransparentSrgb(p.textBright, 10) },
    { label: 'Default (18%)', color: mixTransparentSrgb(p.textBright, 18) },
    { label: 'Emphasis (28%)', color: mixTransparentSrgb(p.textBright, 28) },
    { label: 'Strong (42%)', color: mixTransparentSrgb(p.textBright, 42) },
  ];

  const semantic: DerivedTokens['semantic'] = SEMANTIC_MAP.map(({ label, key }) => ({
    label,
    color: p[key],
    accent: key,
  }));

  // Message tints: 8% accent mixed into bgCanvas
  const messages: DerivedTokens['messages'] = [
    { label: 'User', color: mixTwoOklch(p.user, p.bgCanvas, 8) },
    { label: 'Assistant', color: mixTwoOklch(p.ai, p.bgCanvas, 8) },
    { label: 'System', color: mixTwoOklch(p.warning, p.bgCanvas, 8) },
    { label: 'Error', color: mixTwoOklch(p.danger, p.bgCanvas, 8) },
  ];

  return { accents, bg, text, borders, semantic, messages };
}

// ─── Picker sections ─────────────────────────────────────────────────────────

/** Horizontal strip: dim → base → bright → glow for one accent */
function AccentStrip({ name, family }: { name: string; family: DerivedTokens['accents'][string] }) {
  return (
    <div className="accent-strip ui-row">
      <span className="strip-label">{name}</span>
      <div className="strip-swatches">
        <div className="strip-swatch" style={{ backgroundColor: family.dim }} title="dim" />
        <div
          className="strip-swatch strip-swatch-base"
          style={{ backgroundColor: family.base }}
          title="base"
        />
        <div className="strip-swatch" style={{ backgroundColor: family.bright }} title="bright" />
        <div
          className="strip-swatch strip-swatch-glow"
          style={{ background: family.glow, border: `1px solid ${family.base}` }}
          title="glow"
        />
      </div>
    </div>
  );
}

/** Horizontal ramp of colors with labels below */
function ColorRamp({
  items,
  bgColor,
}: { items: { label: string; color: string }[]; bgColor?: string }) {
  return (
    <div className="color-ramp">
      {items.map((item) => (
        <div key={item.label} className="ramp-item ui-stack">
          <div
            className="ramp-swatch"
            style={{
              backgroundColor: item.color,
              ...(bgColor ? { border: `1px solid ${bgColor}` } : {}),
            }}
          />
          <span className="ramp-label ui-muted">{item.label}</span>
        </div>
      ))}
    </div>
  );
}

/** Semantic role → accent mapping display */
function SemanticMap({ items }: { items: DerivedTokens['semantic'] }) {
  return (
    <div className="semantic-map">
      {items.map((item) => (
        <div key={item.label} className="semantic-item ui-row">
          <div className="semantic-swatch" style={{ backgroundColor: item.color }} />
          <span className="semantic-label">{item.label}</span>
          <span className="semantic-accent ui-muted">{item.accent}</span>
        </div>
      ))}
    </div>
  );
}

// ─── Chat preview ────────────────────────────────────────────────────────────

function ChatPreview({ palette, derived }: { palette: Palette16; derived: DerivedTokens }) {
  return (
    <div
      className="chat-preview"
      style={{ backgroundColor: palette.bgCanvas, borderColor: palette.bgSurface }}
    >
      <div className="preview-header ui-row" style={{ borderColor: palette.bgSurface }}>
        <span style={{ color: palette.textBody }}>Chat Preview</span>
        <span
          className="preview-badge"
          style={{ backgroundColor: palette.primary, color: palette.bgCanvas }}
        >
          claude
        </span>
      </div>
      <div className="preview-messages ui-stack">
        <div className="preview-message ui-stack user">
          <span className="preview-role" style={{ color: palette.user }}>
            user
          </span>
          <div
            className="preview-content"
            style={{
              background: `linear-gradient(135deg, ${derived.messages[0].color} 0%, ${mixTransparentSrgb(palette.user, 8)} 100%)`,
              color: palette.textBody,
              borderLeft: `3px solid ${palette.user}`,
            }}
          >
            How do I implement a binary search?
          </div>
        </div>
        <div className="preview-message ui-stack assistant">
          <span className="preview-role" style={{ color: palette.ai }}>
            assistant
          </span>
          <div
            className="preview-content"
            style={{
              background: `linear-gradient(135deg, ${derived.messages[1].color} 0%, ${mixTransparentSrgb(palette.ai, 8)} 100%)`,
              color: palette.textBody,
              borderLeft: `3px solid ${palette.ai}`,
            }}
          >
            Here's a binary search implementation:
            <pre
              style={{
                backgroundColor: palette.bgCanvas,
                borderColor: palette.bgSurface,
                color: palette.textMuted,
              }}
            >
              {`function binarySearch(arr, target) {
  let lo = 0, hi = arr.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] === target) return mid;
    arr[mid] < target ? lo = mid + 1 : hi = mid - 1;
  }
  return -1;
}`}
            </pre>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── "Let the AI Cook" ──────────────────────────────────────────────────────
// While a palette generates, the submit button grows into this scene: a chef
// robot stirs a cauldron and magic colour orbs rise out of it. The button sits
// on its own line below the textarea: beside it, the old "Generating..." label
// widened on every dot and squeezed the textarea (owner report, 2026-10-05).

const MAGIC_ORBS = [
  { cx: 146, r: 5, color: '#ff5f8f', delay: 0 },
  { cx: 168, r: 4, color: '#ffd166', delay: 0.4 },
  { cx: 156, r: 6, color: '#5ef3c4', delay: 0.8 },
  { cx: 178, r: 4, color: '#4fc3ff', delay: 1.2 },
  { cx: 150, r: 4, color: '#b388ff', delay: 1.6 },
  { cx: 172, r: 5, color: '#ff9f43', delay: 2 },
];

const SPARKLES = [
  { x: 128, y: 24, delay: 0 },
  { x: 204, y: 34, delay: 0.5 },
  { x: 186, y: 12, delay: 1 },
  { x: 214, y: 70, delay: 0.3 },
  { x: 116, y: 52, delay: 1.3 },
];

// Hover hint on the idle button: a tiny bubbling pot each side of the label,
// streaming stars out to the button's edge. The right side is the left one
// mirrored (scaleX(-1)), so its stars flow right.
const HINT_STARS = [
  { top: '30%', color: '#fff6c2', delay: 0 },
  { top: '66%', color: '#5ef3c4', delay: 0.45 },
  { top: '44%', color: '#ff5f8f', delay: 0.9 },
  { top: '76%', color: '#ffd166', delay: 1.35 },
];

const HINT_BUBBLES = [
  { cx: 9, r: 1.6, color: '#5ef3c4', delay: 0 },
  { cx: 13.5, r: 1.2, color: '#ffd166', delay: 0.4 },
  { cx: 16, r: 1.4, color: '#b388ff', delay: 0.8 },
];

function CookHint({ side }: { side: 'left' | 'right' }) {
  return (
    <span className={`ai-cook-hint ai-cook-hint--${side} ui-row`} aria-hidden="true">
      <span className="ai-cook-lane">
        {HINT_STARS.map((star) => (
          <span
            key={star.color}
            className="ai-cook-trail"
            style={{ animationDelay: `${star.delay}s` }}
          >
            <span className="ai-cook-star" style={{ top: star.top, color: star.color }}>
              ✦
            </span>
          </span>
        ))}
      </span>
      <svg className="ai-cook-pot" viewBox="0 0 24 24" aria-hidden="true">
        <ellipse cx="12" cy="13" rx="9" ry="2.6" fill="#3d3760" />
        <ellipse className="ai-cook-hue" cx="12" cy="13" rx="7.2" ry="1.6" fill="#ff5f8f" />
        {HINT_BUBBLES.map((bubble) => (
          <circle
            key={bubble.color}
            className="ai-cook-bubble"
            cx={bubble.cx}
            cy="10"
            r={bubble.r}
            fill={bubble.color}
            style={{ animationDelay: `${bubble.delay}s` }}
          />
        ))}
        <path d="M3.5 13 C3.5 19 7 22 12 22 C17 22 20.5 19 20.5 13 Z" fill="#2b2640" />
      </svg>
    </span>
  );
}

function CookingRobot() {
  return (
    <svg className="ai-cook-scene" viewBox="0 0 240 132" aria-hidden="true">
      <defs>
        <linearGradient id="ai-cook-brew" x1="0" x2="1">
          <stop offset="0" stopColor="#ff5f8f" />
          <stop offset="0.35" stopColor="#ffd166" />
          <stop offset="0.65" stopColor="#5ef3c4" />
          <stop offset="1" stopColor="#8f7bff" />
        </linearGradient>
        <filter id="ai-cook-glow" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="7" />
        </filter>
      </defs>
      {/* Chef robot */}
      <line
        x1="52"
        y1="82"
        x2="44"
        y2="100"
        stroke="#cfd7e8"
        strokeWidth="7"
        strokeLinecap="round"
      />
      <rect x="56" y="113" width="10" height="12" rx="3" fill="#aab3c7" />
      <rect x="78" y="113" width="10" height="12" rx="3" fill="#aab3c7" />
      <rect x="52" y="73" width="40" height="42" rx="10" fill="#cfd7e8" />
      <rect x="60" y="86" width="24" height="27" rx="4" fill="#f6f4ff" />
      <circle className="ai-cook-hue" cx="72" cy="97" r="4" fill="url(#ai-cook-brew)" />
      <rect x="68" y="66" width="8" height="8" fill="#aab3c7" />
      <rect x="52" y="38" width="40" height="30" rx="9" fill="#dfe5f1" />
      <rect x="57" y="44" width="30" height="17" rx="6" fill="#1b1830" />
      <rect className="ai-cook-eye" x="63" y="48" width="5" height="7" rx="2.5" fill="#7df9ff" />
      <rect className="ai-cook-eye" x="76" y="48" width="5" height="7" rx="2.5" fill="#7df9ff" />
      <path d="M67 57 q5 3 10 0" stroke="#7df9ff" strokeWidth="1.5" fill="none" />
      <g className="ai-cook-hat" fill="#f6f4ff">
        <circle cx="62" cy="30" r="8" />
        <circle cx="72" cy="25" r="10" />
        <circle cx="82" cy="30" r="8" />
        <rect x="60" y="30" width="24" height="10" rx="2" />
      </g>
      {/* Blur on the group: the hue animation's CSS filter would replace it on the ellipse. */}
      <g filter="url(#ai-cook-glow)" opacity="0.45">
        <ellipse
          className="ai-cook-hue"
          cx="162"
          cy="88"
          rx="44"
          ry="16"
          fill="url(#ai-cook-brew)"
        />
      </g>
      {/* Rim and brew sit behind the spoon; the pot body in front hides its tip. */}
      <ellipse cx="162" cy="96" rx="36" ry="7" fill="#3d3760" />
      <ellipse
        className="ai-cook-hue"
        cx="162"
        cy="96"
        rx="30"
        ry="4.5"
        fill="url(#ai-cook-brew)"
      />
      <g className="ai-cook-arm">
        <line
          x1="92"
          y1="82"
          x2="118"
          y2="74"
          stroke="#cfd7e8"
          strokeWidth="7"
          strokeLinecap="round"
        />
        <line
          x1="106"
          y1="67"
          x2="158"
          y2="99"
          stroke="#c8915a"
          strokeWidth="3.5"
          strokeLinecap="round"
        />
        <circle cx="118" cy="74" r="5" fill="#aab3c7" />
      </g>
      <path d="M126 96 C126 122 142 130 162 130 C182 130 198 122 198 96 Z" fill="#2b2640" />
      {MAGIC_ORBS.map((orb) => (
        <circle
          key={orb.color}
          className="ai-cook-orb"
          cx={orb.cx}
          cy="92"
          r={orb.r}
          fill={orb.color}
          style={{ color: orb.color, animationDelay: `${orb.delay}s` }}
        />
      ))}
      {SPARKLES.map((s) => (
        <g key={`${s.x}-${s.y}`} transform={`translate(${s.x} ${s.y})`}>
          <path
            className="ai-cook-sparkle"
            fill="#fff6c2"
            d="M0 -6 L1.5 -1.5 L6 0 L1.5 1.5 L0 6 L-1.5 1.5 L-6 0 L-1.5 -1.5 Z"
            style={{ animationDelay: `${s.delay}s` }}
          />
        </g>
      ))}
    </svg>
  );
}

// ─── Main picker ─────────────────────────────────────────────────────────────

export function ColorPalettePicker({ onClose }: Props) {
  const settings = useSettingsStore((s) => s.settings);
  const customPalettes = useSettingsStore((s) => s.customPalettes);
  const allPalettes = { ...PALETTES, ...customPalettes };
  const setColorPalette = useSettingsStore((s) => s.setColorPalette);
  const previewPalette = useSettingsStore((s) => s.previewPalette);
  const restorePalette = useSettingsStore((s) => s.restorePalette);
  const addCustomPalette = useSettingsStore((s) => s.addCustomPalette);
  const removeCustomPalette = useSettingsStore((s) => s.removeCustomPalette);

  const [selectedPalette, setSelectedPalette] = useState(settings.colorPalette);
  const [aiMode, setAiMode] = useState(false);
  const [aiDescription, setAiDescription] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const aiInputRef = useRef<HTMLTextAreaElement>(null);

  const currentPalette = allPalettes[selectedPalette] ?? PALETTES.solarized;
  const derived = derivePalette(currentPalette);

  const handleSelect = (key: string) => {
    setSelectedPalette(key);
    previewPalette(key);
    setAiMode(false);
  };

  const handleSave = () => {
    setColorPalette(selectedPalette);
    onClose();
  };

  const handleCancel = () => {
    restorePalette();
    onClose();
  };

  const handleAiGenerate = async () => {
    if (!aiDescription.trim() || isGenerating) return;

    setIsGenerating(true);
    setAiError(null);

    try {
      const res = await fetch('/api/generate-palette', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: aiDescription.trim() }),
      });

      if (!res.ok) {
        const data = (await res.json()) as { error: string };
        throw new Error(data.error);
      }

      const { key, palette } = (await res.json()) as { key: string; palette: Palette16 };
      addCustomPalette(key, palette);
      setSelectedPalette(key);
      // Apply directly — previewPalette would read stale customPalettes closure
      applyPalette(palette);
      setAiMode(false);
      setAiDescription('');
    } catch (err) {
      setAiError(err instanceof Error ? err.message : 'Failed to generate palette');
    } finally {
      setIsGenerating(false);
    }
  };

  return (
    <div className="palette-picker-overlay ui-row" onClick={handleCancel}>
      <div className="palette-picker ui-stack" onClick={(e) => e.stopPropagation()}>
        <div className="palette-picker-header ui-row">
          <h2>Color Palette</h2>
          <button
            type="button"
            className="close-btn ui-control ui-row ui-muted"
            onClick={handleCancel}
          >
            &times;
          </button>
        </div>

        <div className="palette-picker-content">
          {/* ─── Left: palette list ─── */}
          <div className="palette-list ui-stack">
            {Object.entries(allPalettes).map(([key, palette]) => {
              const isCustom = key in customPalettes;
              return (
                <div key={key} className="palette-option-row ui-row">
                  <button
                    type="button"
                    className={`palette-option ui-control ui-stack ${selectedPalette === key ? 'selected' : ''}`}
                    onClick={() => handleSelect(key)}
                  >
                    <div className="palette-swatches">
                      {ACCENT_KEYS.map((ak) => (
                        <div
                          key={ak}
                          className="mini-swatch"
                          style={{ backgroundColor: palette[ak] }}
                        />
                      ))}
                    </div>
                    <span className="palette-name">{palette.name}</span>
                  </button>
                  {isCustom && (
                    <button
                      type="button"
                      className="palette-delete-btn ui-control ui-row ui-muted"
                      title="Delete palette"
                      onClick={(e) => {
                        e.stopPropagation();
                        removeCustomPalette(key);
                        if (selectedPalette === key) {
                          handleSelect('solarized');
                        }
                      }}
                    >
                      &times;
                    </button>
                  )}
                </div>
              );
            })}

            <div className="palette-list-divider" />

            <button
              type="button"
              className={`ai-generate-btn ui-control ui-row ui-muted ${aiMode ? 'active' : ''}`}
              onClick={() => setAiMode(!aiMode)}
            >
              <span className="ai-sparkle">&#10022;</span>
              AI Generate
            </button>
          </div>

          {/* ─── Right: preview + token visualization ─── */}
          <div className="palette-preview-section ui-stack">
            {aiMode ? (
              <div className="ai-input-section ui-stack">
                <textarea
                  ref={aiInputRef}
                  className="ai-chat-input"
                  placeholder="Describe your color palette..."
                  value={aiDescription}
                  onChange={(e) => setAiDescription(e.target.value)}
                  disabled={isGenerating}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      handleAiGenerate();
                    }
                  }}
                  rows={3}
                />
                <button
                  type="button"
                  className={`ai-submit-btn ui-control ui-stack ${isGenerating ? 'cooking' : ''}`}
                  onClick={handleAiGenerate}
                  disabled={isGenerating || !aiDescription.trim()}
                  aria-busy={isGenerating}
                >
                  {isGenerating ? (
                    <>
                      <CookingRobot />
                      <span className="ai-cook-caption ai-cook-hue">Cooking your palette…</span>
                    </>
                  ) : (
                    <span className="ai-cook-idle ui-row">
                      <CookHint side="left" />
                      Let the AI Cook
                      <CookHint side="right" />
                    </span>
                  )}
                </button>
                {aiError && <div className="ai-error">{aiError}</div>}
              </div>
            ) : (
              <div className="preview-scroll ui-stack">
                <ChatPreview palette={currentPalette} derived={derived} />

                {/* Accent families: dim → base → bright → glow strips */}
                <div className="section-group ui-stack">
                  <h3 className="section-title">Accent Families</h3>
                  <p className="section-subtitle ui-muted">
                    dim &middot; base &middot; bright &middot; glow
                  </p>
                  <div className="accent-strips ui-stack">
                    {ACCENT_KEYS.map((key) => (
                      <AccentStrip key={key} name={key} family={derived.accents[key]} />
                    ))}
                  </div>
                </div>

                {/* Background elevation */}
                <div className="section-group ui-stack">
                  <h3 className="section-title">Background Elevation</h3>
                  <ColorRamp items={derived.bg} />
                </div>

                {/* Text scale */}
                <div className="section-group ui-stack">
                  <h3 className="section-title">Text Scale</h3>
                  <ColorRamp items={derived.text} bgColor={currentPalette.bgCanvas} />
                </div>

                {/* Borders */}
                <div className="section-group ui-stack">
                  <h3 className="section-title">Border Scale</h3>
                  <ColorRamp items={derived.borders} bgColor={currentPalette.bgCanvas} />
                </div>

                {/* Semantic roles */}
                <div className="section-group ui-stack">
                  <h3 className="section-title">Semantic Roles</h3>
                  <SemanticMap items={derived.semantic} />
                </div>

                {/* Message tints */}
                <div className="section-group ui-stack">
                  <h3 className="section-title">Message Tints</h3>
                  <ColorRamp items={derived.messages} />
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="palette-picker-footer">
          <button type="button" className="cancel-btn ui-muted" onClick={handleCancel}>
            Cancel
          </button>
          <button type="button" className="save-btn" onClick={handleSave}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
