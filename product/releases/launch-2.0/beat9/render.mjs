#!/usr/bin/env node
// Render beat9.html to stills + a 60fps MP4. Steps window.render(t) frame by frame
// through headless Chrome (tools/lib/headless-chrome.mjs), then encodes with ffmpeg.
//   node product/releases/launch-2.0/beat9/render.mjs            -> stills + beat9.mp4
//   node product/releases/launch-2.0/beat9/render.mjs --stills   -> stills only
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openSession } from '../../../../tools/lib/headless-chrome.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const page = pathToFileURL(path.join(here, 'beat9.html')).href;
const FPS = 60;
const STILLS = { 'beat9-harness.png': 3.3, 'beat9-subs.png': 6.95 };

const session = await openSession({ baseUrl: pathToFileURL(here).href, token: null });
try {
  await session.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  await session.goto(page, 200);
  await session.evaluate('document.fonts.ready.then(() => true)');
  const missing = await session.evaluate(
    `[...document.images].filter((i) => !i.naturalWidth).map((i) => i.getAttribute('src'))`
  );
  if (missing.length) throw new Error(`Logos failed to load: ${missing.join(', ')}`);

  for (const [name, t] of Object.entries(STILLS)) {
    await session.evaluate(`render(${t})`);
    await session.capture(path.join(here, name));
  }

  if (!process.argv.includes('--stills')) {
    const frames = fs.mkdtempSync(path.join(os.tmpdir(), 'beat9-frames-'));
    const duration = await session.evaluate('window.DURATION');
    const count = Math.round(duration * FPS);
    for (let i = 0; i < count; i++) {
      await session.evaluate(`render(${i / FPS})`);
      await session.capture(path.join(frames, `f${String(i).padStart(5, '0')}.png`));
    }
    execFileSync('ffmpeg', [
      '-y',
      '-loglevel',
      'error',
      '-framerate',
      String(FPS),
      '-i',
      path.join(frames, 'f%05d.png'),
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-crf',
      '16',
      '-movflags',
      '+faststart',
      path.join(here, 'beat9.mp4'),
    ]);
    fs.rmSync(frames, { recursive: true, force: true });
  }
} finally {
  await session.close();
}
