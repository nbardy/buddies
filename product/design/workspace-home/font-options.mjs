// Render the workspace Home with candidate typefaces (style override in a read-only session).
import * as fs from 'node:fs';
import { openSession, resolveAuthToken, sleep } from '/Users/nicholasbardy/git/unleashd/tools/lib/headless-chrome.mjs';

const base = 'http://localhost:7489';
const [workspace, outDir] = process.argv.slice(2);
const b64 = (p) => fs.readFileSync(p).toString('base64');
const face = (family, file, extra = '') =>
  `@font-face{font-family:'${family}';src:url(data:font/ttf;base64,${b64(file)}) format('truetype');font-display:block;${extra}}`;

const fonts = [
  face('Opt Geist', '/tmp/fonts/Geist[wght].ttf', 'font-weight:100 900;'),
  face('Opt Inter', '/tmp/fonts/Inter[opsz,wght].ttf', 'font-weight:100 900;'),
  face('Opt Instrument Serif', '/tmp/fonts/InstrumentSerif-Regular.ttf'),
  face('Opt Bricolage', '/Users/nicholasbardy/git/unleashd/product/releases/launch-2.0/fonts/BricolageGrotesque.ttf', 'font-weight:200 800;'),
].join('\n');

// Each option: headline, section heads + card titles, and body copy on the Home.
const options = {
  current: '',
  geist: `.landing{--landing-display:'Opt Geist'} .landing, .landing *{font-family:'Opt Geist',sans-serif}
    .landing-hero h1{font-weight:700;letter-spacing:-0.045em}
    .landing-project-title{font-weight:600;letter-spacing:-0.01em}`,
  serif: `.landing, .landing *{font-family:'Opt Inter',sans-serif}
    .landing-hero h1{font-family:'Opt Instrument Serif',serif !important;font-weight:400;letter-spacing:-0.01em;font-size:64px;line-height:1}
    .landing-section-head h2{font-family:'Opt Inter',sans-serif;font-weight:600}
    .landing-project-title{font-weight:600;letter-spacing:-0.01em}`,
  bricolage: `.landing{--landing-display:'Opt Bricolage'} .landing, .landing *{font-family:'Opt Inter',sans-serif}
    .landing-hero h1, .landing-section-head h2, .landing-project-title{font-family:'Opt Bricolage',sans-serif !important}
    .landing-hero h1{font-weight:750;letter-spacing:-0.03em;font-variation-settings:'opsz' 96}
    .landing-project-title{font-weight:600;letter-spacing:-0.005em}`,
};

const session = await openSession({ baseUrl: base, token: resolveAuthToken(), clockMs: Date.now() });
try {
  await session.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
  await session.goto(`${base}/buddies/workspaces/${workspace}/channels`, 3000);
  await session.waitForNetworkIdle(500, 20000, /sigil|prefetch/);
  await sleep(1500);
  // Freeze the aura so every option shows the same glow.
  await session.evaluate(`document.getAnimations().forEach(a => a.pause())`);
  await session.evaluate(`(() => { const s = document.createElement('style'); s.textContent = ${JSON.stringify(fonts)}; document.head.append(s); })()`);
  for (const [name, css] of Object.entries(options)) {
    await session.evaluate(`(() => {
      let el = document.getElementById('font-probe');
      if (!el) { el = document.createElement('style'); el.id = 'font-probe'; document.head.append(el); }
      el.textContent = ${JSON.stringify(css)};
      return document.fonts.ready.then(() => true);
    })()`);
    await sleep(600);
    await session.capture(`${outDir}/${name}.png`);
  }
} finally {
  await session.close();
}
