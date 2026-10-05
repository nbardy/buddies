// Beats 1–5, the open. One agent chat: type, send, it pops, it minimizes. A second one. Then the
// pace ramps (2, 4, 8, 16, 30 a second) until chat windows bury the frame. Hard cut to black:
// "AI Overload." Then the reveal in the same scene (OverloadReveal.tsx): the Buddies robots pop in
// beside the line, gather into the logo, and the launch song drops on it (owner, 2026-10-05).
// The windows are styled after the desktop agent apps people already juggle (a Claude-style
// studio, a Codex-style workbench, a ChatGPT-style assistant, a CLI), per owner direction
// 2026-09-26, with no product names or logos. Timeline is data (FOCUS, GAPS, T).
import type React from 'react';
import { AbsoluteFill, Easing, Sequence, interpolate, random, useCurrentFrame } from 'remotion';
import { clamp01, easeOutBack, lerp } from './blocks';
import * as Reveal from './OverloadReveal';
import { type Cue, KEYS, POPS, SFX, Soundtrack } from './soundtrack';

export const FPS = 60;
export const WIDTH = 1920;
export const HEIGHT = 1080;

// Output seconds. Music should put a hit on every pile arrival up to the 1/16 s run.
export const INTRO_ROBOTS = 5; // owner pick, 2026-10-03; the end card's mark matches it
// Owner, 2026-10-05: "open faster". The two focus chats take 3.9 s (were 6.2).
const CUT = 9.4; // hard cut to black; the riser ends here, 5.5 s after rampStart (riser.wav's length)
const T = {
  rampStart: 3.9, // first pile window; the ramp runs 5 s (sum of GAPS)
  cut: CUT,
  end: CUT + Reveal.END, // the reveal: "AI Overload.", the robots, the logo, one bar on it
};
// The launch song (../../sound/launch.py) starts on the first robot and drops on the logo lock;
// the edit's bar grid (Assembly.bar) counts from the lock.
export const CUE_IN = T.cut + Reveal.CUE_IN;
export const LOCK = T.cut + Reveal.LOCK;
export const DURATION = Math.round(T.end * FPS);
const frames = (s: number) => Math.round(s * FPS);

// ---- App skins -------------------------------------------------------------------------------------

const SANS = '-apple-system, "SF Pro Text", "Segoe UI", Helvetica, Arial, sans-serif';
const SERIF = 'Georgia, "Times New Roman", serif';
const MONO = '"SF Mono", Menlo, Consolas, monospace';

// A desktop agent app: sidebar of recent chats, greeting over a big composer until you send.
type AppSkin = {
  layout: 'app';
  bg: string;
  sidebar: string; // CSS background
  divider: string;
  text: string;
  muted: string;
  bubble: string;
  bubbleText: string;
  composer: string;
  composerBorder: string;
  radius: number; // composer corner radius; the assistant style is a full pill
  send: string;
  sendInk: string;
  headingFont: string;
  heading: (repo: string) => string;
  placeholder: string;
  nav: string[];
  chips: (repo: string) => string[]; // context chips above the composer; none for chat apps
  model: string;
};
// A coding-agent CLI in a terminal window.
type TermSkin = { layout: 'terminal'; bg: string; bar: string; text: string; muted: string; accent: string; box: string };
type Skin = AppSkin | TermSkin;

const noChips = () => [];
const STUDIO_NAV = ['New chat', 'Projects', 'Artifacts', 'Scheduled'];
const WORKBENCH_NAV = ['New chat', 'Pull requests', 'Scheduled', 'Plugins'];
const ASSISTANT_NAV = ['New chat', 'Search chats', 'Library', 'Projects'];

type Look = 'studioDark' | 'studioLight' | 'workbenchDark' | 'assistantDark' | 'assistantLight' | 'terminal';
const SKINS: Record<Look, Skin> = {
  studioDark: {
    layout: 'app', bg: '#1a1a19', sidebar: '#1f1f1e', divider: '#2c2c2a', text: '#ecebe7', muted: '#8f8d88',
    bubble: '#30302e', bubbleText: '#ecebe7', composer: '#232322', composerBorder: '#3b3b38', radius: 20,
    send: '#c96442', sendInk: '#fff', headingFont: SERIF, heading: () => 'Good afternoon',
    placeholder: 'How can I help you today?', nav: STUDIO_NAV, chips: noChips, model: 'Agent · Medium',
  },
  studioLight: {
    layout: 'app', bg: '#faf9f5', sidebar: '#f3f1ea', divider: '#e6e3d9', text: '#2f2c25', muted: '#8b877c',
    bubble: '#efece3', bubbleText: '#2f2c25', composer: '#ffffff', composerBorder: '#e2dfd4', radius: 20,
    send: '#c96442', sendInk: '#fff', headingFont: SERIF, heading: () => 'Good afternoon',
    placeholder: 'How can I help you today?', nav: STUDIO_NAV, chips: noChips, model: 'Agent · Medium',
  },
  workbenchDark: {
    layout: 'app', bg: '#1b1b1b', sidebar: 'linear-gradient(165deg, #2c2338, #201d26 55%, #1c1c1c)', divider: '#2a2a2a',
    text: '#ececec', muted: '#8a8a8a', bubble: '#2d2d2d', bubbleText: '#ececec', composer: '#2a2a2a',
    composerBorder: '#353535', radius: 22, send: '#3b82f6', sendInk: '#fff', headingFont: SANS,
    heading: (repo) => `What should we build in ${repo}?`, placeholder: 'Do anything', nav: WORKBENCH_NAV,
    chips: (repo) => [repo, 'Local', 'main'], model: 'Extra High',
  },
  assistantDark: {
    layout: 'app', bg: '#212121', sidebar: '#171717', divider: '#262626', text: '#ececec', muted: '#9b9b9b',
    bubble: '#303030', bubbleText: '#ececec', composer: '#303030', composerBorder: '#303030', radius: 34,
    send: '#ffffff', sendInk: '#000', headingFont: SANS, heading: () => 'What are we working on?',
    placeholder: 'Ask anything', nav: ASSISTANT_NAV, chips: noChips, model: 'Thinking',
  },
  assistantLight: {
    layout: 'app', bg: '#ffffff', sidebar: '#f9f9f9', divider: '#ececec', text: '#0d0d0d', muted: '#8f8f8f',
    bubble: '#f1f1f1', bubbleText: '#0d0d0d', composer: '#ffffff', composerBorder: '#e3e3e3', radius: 34,
    send: '#000000', sendInk: '#fff', headingFont: SANS, heading: () => 'What are we working on?',
    placeholder: 'Ask anything', nav: ASSISTANT_NAV, chips: noChips, model: 'Thinking',
  },
  terminal: { layout: 'terminal', bg: '#0e0e0e', bar: '#1c1c1c', text: '#d8d8d8', muted: '#7a7a7a', accent: '#d97757', box: '#4a4a4a' },
};
// Weighted: mostly the two screenshots' styles, then the assistant, then the CLI.
const LOOK_POOL: Look[] = ['studioDark', 'studioDark', 'workbenchDark', 'workbenchDark', 'studioLight', 'assistantDark', 'assistantLight', 'terminal'];

// ---- Window content ------------------------------------------------------------------------------

type Tone = 'quiet' | 'warn' | 'error';
type Status = { kind: 'thinking' } | { kind: 'label'; text: string; tone: Tone };

// Placement is the one thing that differs in kind: the first two windows own the frame and then
// minimize into a tray; everything after lands where it lands and stays.
type Place =
  | { kind: 'focus'; scale: number; trayX: number; trayY: number; minimizeAt: number }
  | { kind: 'pile'; x: number; y: number; rot: number; scale: number };

type WindowSpec = {
  at: number; // output seconds the window pops in
  look: Look;
  repo: string;
  prompt: string;
  recents: string[]; // sidebar chat titles
  status: Status;
  typeAt: number; // seconds after `at`
  typeFor: number;
  place: Place;
};
const sendAt = (w: WindowSpec) => w.typeAt + w.typeFor + 0.12;
const statusAt = (w: WindowSpec) => sendAt(w) + 0.3;

const PROMPTS = [
  'fix the flaky login test',
  'write the migration for orders',
  'summarize this PR for me',
  'add dark mode to settings',
  'find the memory leak',
  'rename userId everywhere',
  'is this safe to deploy?',
  'draft the release notes',
  'review my SQL',
  'undo what you just did',
  'keep going',
  'which branch are you on??',
  'make the tests pass',
  'port this to Rust',
  'update the docs too',
  'why is prod slow',
  'try again',
  'no, the OTHER config file',
  'bump every dependency',
  'answer the support ticket',
  'did you push that?',
  'plan the Q4 roadmap',
  'add retries to the webhook',
  'what were we doing?',
  'write the investor update',
  'ship it',
  'stop. wait. go back',
  "check the other agent's work",
];
const REPOS = ['api-server', 'web', 'mobile', 'infra', 'billing', 'docs', 'auth', 'data-pipeline'];
const STATUSES: Status[] = [
  { kind: 'thinking' },
  { kind: 'label', text: 'Needs your approval', tone: 'warn' },
  { kind: 'label', text: 'Editing 41 files', tone: 'quiet' },
  { kind: 'thinking' },
  { kind: 'label', text: 'Waiting for input', tone: 'warn' },
  { kind: 'label', text: 'Rate limited, retrying', tone: 'error' },
  { kind: 'label', text: 'Running tool 9 of 30', tone: 'quiet' },
  { kind: 'label', text: 'Context limit reached', tone: 'error' },
];
const titleCase = (s: string) => s[0].toUpperCase() + s.slice(1);
const recentsFrom = (start: number, n: number) =>
  Array.from({ length: n }, (_, j) => titleCase(PROMPTS[(start + j * 5) % PROMPTS.length]));

type FocusSpec = WindowSpec & { place: Extract<Place, { kind: 'focus' }> };
const FOCUS: FocusSpec[] = [
  {
    at: 0.15,
    look: 'studioDark',
    repo: 'auth',
    prompt: 'Refactor the auth module and add tests',
    recents: recentsFrom(0, 6),
    status: { kind: 'thinking' },
    typeAt: 0.3,
    typeFor: 1.3,
    place: { kind: 'focus', scale: 1.5, trayX: 150, trayY: 80, minimizeAt: 2.0 },
  },
  {
    at: 2.35,
    look: 'workbenchDark',
    repo: 'api-server',
    prompt: 'Why is CI failing on main?',
    recents: recentsFrom(3, 6),
    status: { kind: 'label', text: 'Running tool 3 of 14', tone: 'quiet' },
    typeAt: 0.2,
    typeFor: 0.7,
    place: { kind: 'focus', scale: 1.4, trayX: 370, trayY: 80, minimizeAt: 1.2 },
  },
];

// Arrival gaps: 2 a second, then 4, 8, 16, 30 — one second each, "too many to count" by the end.
const GAPS = (
  [
    [0.5, 2],
    [0.25, 4],
    [0.125, 8],
    [1 / 16, 16],
    [1 / 30, 30],
  ] as const
).flatMap(([gap, n]) => Array<number>(n).fill(gap));
const ARRIVALS = GAPS.reduce<number[]>((acc, gap, i) => [...acc, acc[i] + gap], [T.rampStart]).slice(0, -1);

const W = 900;
const H = 560;

const PILE: WindowSpec[] = ARRIVALS.map((at, i) => {
  const r = (k: string) => random(`${k}-${i}`);
  const pick = <V,>(xs: readonly V[], k: string) => xs[Math.floor(r(k) * xs.length)];
  // Early arrivals land near the middle where they can be read; the spread grows to the edges.
  const spread = lerp(0.45, 1, clamp01(i / 12));
  return {
    at,
    look: pick(LOOK_POOL, 'look'),
    repo: pick(REPOS, 'repo'),
    prompt: PROMPTS[i % PROMPTS.length],
    recents: recentsFrom(i + 1, 4 + Math.floor(r('recents') * 4)),
    status: STATUSES[i % STATUSES.length],
    typeAt: 0.08,
    typeFor: Math.min(0.9, Math.max(0.2, GAPS[i] * 2.5)),
    place: {
      kind: 'pile',
      x: WIDTH / 2 + (r('x') - 0.5) * WIDTH * 1.05 * spread,
      y: HEIGHT / 2 + (r('y') - 0.5) * HEIGHT * 1.05 * spread,
      rot: lerp(-6, 6, r('rot')),
      scale: lerp(0.55, 0.8, r('scale')),
    },
  };
});

const WINDOWS = [...FOCUS, ...PILE];

// ---- Window rendering ----------------------------------------------------------------------------

const PILL: React.CSSProperties = { padding: '3px 10px', borderRadius: 999, fontWeight: 600 };
const TONE: Record<Tone, (muted: string) => React.CSSProperties> = {
  quiet: (muted) => ({ color: muted }),
  warn: () => ({ ...PILL, background: '#f5b300', color: '#1a1400' }),
  error: () => ({ ...PILL, background: '#e5484d', color: '#fff' }),
};

// Thin dispatcher: the status kind picks the rendering.
const StatusLine: React.FC<{ status: Status; muted: string; u: number }> = ({ status, muted, u }) => {
  switch (status.kind) {
    case 'thinking':
      return <span style={{ color: muted }}>Thinking{'.'.repeat(1 + (Math.floor(u * 4) % 3))}</span>;
    case 'label':
      return <span style={TONE[status.tone](muted)}>{status.text}</span>;
  }
};

const typedText = (spec: WindowSpec, u: number) =>
  spec.prompt.slice(0, Math.round(clamp01((u - spec.typeAt) / spec.typeFor) * spec.prompt.length));
const caretOn = (u: number) => Math.floor(u * 2.2) % 2 === 0;
const sendEase = Easing.inOut(Easing.cubic);

const Lights: React.FC = () => (
  <div style={{ display: 'flex', gap: 8 }}>
    {['#ff5f57', '#febc2e', '#28c840'].map((c) => (
      <span key={c} style={{ width: 12, height: 12, borderRadius: 6, background: c }} />
    ))}
  </div>
);

const Sidebar: React.FC<{ skin: AppSkin; recents: string[] }> = ({ skin, recents }) => (
  <div
    style={{
      width: 210,
      background: skin.sidebar,
      borderRight: `1px solid ${skin.divider}`,
      padding: '14px 12px',
      display: 'flex',
      flexDirection: 'column',
      gap: 9,
      fontSize: 14,
      color: skin.text,
    }}
  >
    <Lights />
    <div style={{ height: 8 }} />
    {skin.nav.map((label) => (
      <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ width: 14, height: 14, borderRadius: 4, border: `1.5px solid ${skin.muted}` }} />
        {label}
      </div>
    ))}
    <div style={{ marginTop: 14, fontSize: 12, color: skin.muted }}>Recents</div>
    {recents.map((title) => (
      <div key={title} style={{ fontSize: 13.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {title}
      </div>
    ))}
  </div>
);

// Composer: typed text (or the placeholder), then a toolbar with +, model, mic and send.
const Composer: React.FC<{ skin: AppSkin; spec: WindowSpec; u: number }> = ({ skin, spec, u }) => {
  const sent = u >= sendAt(spec);
  const text = sent ? '' : typedText(spec, u);
  const press = 1 - 0.2 * Math.max(0, 1 - Math.abs(u - sendAt(spec)) / 0.08);
  const chips = skin.chips(spec.repo);
  return (
    <div>
      {chips.length > 0 && (
        <div style={{ display: 'flex', gap: 22, padding: '8px 18px 10px', fontSize: 14, color: skin.text }}>
          {chips.map((c) => (
            <span key={c}>{c}</span>
          ))}
        </div>
      )}
      <div
        style={{
          background: skin.composer,
          border: `1px solid ${skin.composerBorder}`,
          borderRadius: skin.radius,
          padding: '16px 18px 12px',
          boxShadow: '0 4px 18px rgba(0,0,0,.12)',
        }}
      >
        <div style={{ fontSize: 17, height: 24, whiteSpace: 'nowrap', overflow: 'hidden', color: text ? skin.text : skin.muted }}>
          {/* The caret follows what's typed; with nothing typed it sits before the placeholder. */}
          {text}
          <span style={{ color: skin.text, opacity: caretOn(u) ? 1 : 0 }}>|</span>
          {text ? '' : skin.placeholder}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginTop: 12, fontSize: 14, color: skin.muted }}>
          <span style={{ fontSize: 22, lineHeight: 1, color: skin.text }}>+</span>
          <span style={{ flex: 1 }} />
          <span>{skin.model} ⌄</span>
          <span
            style={{
              width: 32,
              height: 32,
              borderRadius: 16,
              background: skin.send,
              color: skin.sendInk,
              display: 'grid',
              placeItems: 'center',
              fontSize: 17,
              fontWeight: 700,
              transform: `scale(${press})`,
            }}
          >
            ↑
          </span>
        </div>
      </div>
    </div>
  );
};

const AppWindow: React.FC<{ skin: AppSkin; spec: WindowSpec; u: number }> = ({ skin, spec, u }) => {
  // m: 0 = empty state (greeting over a centred composer), 1 = conversation (composer at bottom).
  const m = sendEase(clamp01((u - sendAt(spec)) / 0.35));
  const pop = easeOutBack(clamp01((u - sendAt(spec) - 0.05) / 0.25), 2.2);
  return (
    <div style={{ display: 'flex', width: W, height: H, background: skin.bg, fontFamily: SANS }}>
      <Sidebar skin={skin} recents={spec.recents} />
      <div style={{ position: 'relative', flex: 1 }}>
        <div
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            top: 185,
            textAlign: 'center',
            fontFamily: skin.headingFont,
            fontSize: 32,
            color: skin.text,
            opacity: 1 - m,
            transform: `translateY(${-24 * m}px)`,
          }}
        >
          {skin.heading(spec.repo)}
        </div>
        <div style={{ position: 'absolute', left: 48, right: 48, top: lerp(255, H - 150, m) }}>
          <Composer skin={skin} spec={spec} u={u} />
        </div>
        <div
          style={{
            position: 'absolute',
            right: 48,
            top: 36,
            maxWidth: '70%',
            background: skin.bubble,
            color: skin.bubbleText,
            padding: '10px 16px',
            borderRadius: 18,
            fontSize: 17,
            lineHeight: 1.35,
            transformOrigin: 'top right',
            transform: `scale(${pop})`,
          }}
        >
          {spec.prompt}
        </div>
        <div style={{ position: 'absolute', left: 48, top: 104, fontSize: 15, visibility: u >= statusAt(spec) ? 'visible' : 'hidden' }}>
          <StatusLine status={spec.status} muted={skin.muted} u={u} />
        </div>
      </div>
    </div>
  );
};

// A coding-agent CLI: boxed input line, the sent prompt echoed above it, status under that.
const TerminalWindow: React.FC<{ skin: TermSkin; spec: WindowSpec; u: number }> = ({ skin, spec, u }) => {
  const sent = u >= sendAt(spec);
  return (
    <div style={{ width: W, height: H, background: skin.bg, fontFamily: MONO, color: skin.text, display: 'flex', flexDirection: 'column' }}>
      <div style={{ height: 36, background: skin.bar, display: 'flex', alignItems: 'center', padding: '0 14px', gap: 14 }}>
        <Lights />
        <span style={{ flex: 1, textAlign: 'center', fontSize: 13, color: skin.muted, marginRight: 52 }}>
          {`~/git/${spec.repo} — zsh`}
        </span>
      </div>
      <div style={{ flex: 1, padding: '18px 22px', fontSize: 17, lineHeight: 1.7, display: 'flex', flexDirection: 'column' }}>
        <div style={{ color: skin.accent }}>* agent ready in ~/git/{spec.repo}</div>
        <div style={{ visibility: sent ? 'visible' : 'hidden', color: skin.muted }}>{`> ${spec.prompt}`}</div>
        <div style={{ visibility: u >= statusAt(spec) ? 'visible' : 'hidden' }}>
          <StatusLine status={spec.status} muted={skin.accent} u={u} />
        </div>
        <div style={{ flex: 1 }} />
        <div style={{ border: `1px solid ${skin.box}`, borderRadius: 8, padding: '8px 14px', whiteSpace: 'nowrap', overflow: 'hidden' }}>
          {'> '}
          {sent ? '' : typedText(spec, u)}
          <span style={{ background: skin.text, opacity: caretOn(u) ? 1 : 0 }}>&nbsp;</span>
        </div>
        <div style={{ fontSize: 13, color: skin.muted, marginTop: 6 }}>? for shortcuts</div>
      </div>
    </div>
  );
};

// Thin dispatcher: the skin's layout picks the window.
const WindowBody: React.FC<{ skin: Skin; spec: WindowSpec; u: number }> = ({ skin, spec, u }) => {
  switch (skin.layout) {
    case 'app':
      return <AppWindow skin={skin} spec={spec} u={u} />;
    case 'terminal':
      return <TerminalWindow skin={skin} spec={spec} u={u} />;
  }
};

const ChatWindow: React.FC<{ spec: WindowSpec; u: number }> = ({ spec, u }) => (
  <div style={{ borderRadius: 14, overflow: 'hidden', boxShadow: '0 30px 80px rgba(0,0,0,.55), 0 0 0 1px rgba(255,255,255,.08)' }}>
    <WindowBody skin={SKINS[spec.look]} spec={spec} u={u} />
  </div>
);

// ---- Placement: where a window is and how big, at its local time u -------------------------------

type Pose = { x: number; y: number; rot: number; scale: number; opacity: number };
const minimize = Easing.inOut(Easing.cubic);

const focusPose = (place: Extract<Place, { kind: 'focus' }>, u: number): Pose => {
  const pop = easeOutBack(clamp01(u / 0.3));
  const m = minimize(clamp01((u - place.minimizeAt) / 0.5));
  return {
    x: lerp(WIDTH / 2, place.trayX, m),
    y: lerp(HEIGHT / 2, place.trayY, m),
    rot: 0,
    scale: lerp(place.scale, 0.22, m) * lerp(0.7, 1, pop),
    opacity: Math.min(clamp01(u / 0.08), lerp(1, 0.55, m)),
  };
};

const pilePose = (place: Extract<Place, { kind: 'pile' }>, u: number): Pose => ({
  x: place.x,
  y: place.y,
  rot: place.rot,
  scale: place.scale * lerp(0.6, 1, easeOutBack(clamp01(u / 0.2), 2.2)),
  opacity: clamp01(u / 0.05),
});

const poseOf = (place: Place, u: number): Pose => {
  switch (place.kind) {
    case 'focus':
      return focusPose(place, u);
    case 'pile':
      return pilePose(place, u);
  }
};

// ---- Scenes ------------------------------------------------------------------------------------------

const Pileup: React.FC = () => {
  const frame = useCurrentFrame();
  const t = frame / FPS;
  const zoom = interpolate(t, [T.rampStart, T.cut], [1, 1.12], {
    easing: Easing.in(Easing.quad),
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const shake = interpolate(t, [9.2, T.cut], [0, 16], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const tick = Math.floor(frame / 2);
  const dx = shake * (random(`shake-x-${tick}`) - 0.5) * 2;
  const dy = shake * (random(`shake-y-${tick}`) - 0.5) * 2;
  return (
    <AbsoluteFill style={{ background: 'radial-gradient(circle at 50% 40%, #1b212b, #0b0e13 70%)', overflow: 'hidden' }}>
      <AbsoluteFill style={{ transform: `translate(${dx}px, ${dy}px) scale(${zoom})` }}>
        {WINDOWS.filter((w) => t >= w.at).map((w) => {
          const u = t - w.at;
          const p = poseOf(w.place, u);
          return (
            <div
              key={w.at}
              style={{
                position: 'absolute',
                left: 0,
                top: 0,
                opacity: p.opacity,
                transform: `translate(${p.x - W / 2}px, ${p.y - H / 2}px) rotate(${p.rot}deg) scale(${p.scale})`,
              }}
            >
              <ChatWindow spec={w} u={u} />
            </div>
          );
        })}
      </AbsoluteFill>
      <AbsoluteFill
        style={{
          background: 'radial-gradient(circle at 50% 50%, transparent 45%, rgba(0,0,0,.75))',
          opacity: interpolate(t, [T.rampStart, T.cut], [0.3, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }),
        }}
      />
    </AbsoluteFill>
  );
};

// ---- Sound: every cue is derived from the same timeline the picture uses -------------------------

// One tick per character, at the moment typedText() reveals it.
const keyCues = (w: WindowSpec, volume: number): Cue[] =>
  [...w.prompt].map((_, j) => ({
    at: w.at + w.typeAt + (w.typeFor * (j + 0.5)) / w.prompt.length,
    src: KEYS[j % KEYS.length],
    volume,
  }));

const focusCues = (w: FocusSpec): Cue[] => [
  { at: w.at, src: POPS[0], volume: 0.5 },
  ...keyCues(w, 0.35),
  { at: w.at + sendAt(w), src: SFX.send, volume: 0.6 },
  { at: w.at + w.place.minimizeAt, src: SFX.whoosh, volume: 0.45 },
];

// Pops climb in pitch as the pile grows; only the early arrivals get audible typing and a send,
// past that the pops are the rhythm.
const pileCues = (w: WindowSpec, i: number): Cue[] => [
  { at: w.at, src: POPS[Math.min(POPS.length - 1, Math.floor(i / 8))], volume: 0.45 },
  ...(i < 6 ? keyCues(w, 0.15) : []),
  ...(i < 30 ? [{ at: w.at + sendAt(w), src: SFX.send, volume: 0.22 }] : []),
];

// After the boom the launch song takes over (Assembly places it): the robots' boops are its first notes.
// Levels: the boom stays the loudest moment; stacked chords sum, so they sit lower than single notes.
const OVERLOAD_CUES: Cue[] = [
  ...FOCUS.flatMap(focusCues),
  ...PILE.flatMap(pileCues),
  { at: T.rampStart, src: SFX.riser, volume: 0.6 }, // ends exactly on T.cut: the silence is the drop
  { at: T.cut + Reveal.LEAD, src: SFX.impact, volume: 1 }, // "AI Overload."; the song starts a bar later
];

// The reveal reads its own clock: seconds since the cut.
const RevealScene: React.FC<{ type: Reveal.TypeStyle }> = ({ type }) => (
  <Reveal.OverloadReveal t={useCurrentFrame() / FPS} type={type} />
);

export type OverloadProps = { type: Reveal.TypeStyle };
export const Overload: React.FC<OverloadProps> = ({ type }) => (
  <AbsoluteFill>
    <Soundtrack cues={OVERLOAD_CUES} fps={FPS} />
    <Sequence durationInFrames={frames(T.cut)}>
      <Pileup />
    </Sequence>
    <Sequence from={frames(T.cut)} durationInFrames={frames(T.end - T.cut)}>
      <RevealScene type={type} />
    </Sequence>
  </AbsoluteFill>
);
