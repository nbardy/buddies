#!/usr/bin/env node
// The render queue: every Remotion render or still goes through here, so at most MAX of them run at
// once on this machine, and each gets a fair share of the cores.
//
//   node render.mjs render src/index.ts Assembly out/x.mp4 --crf=18 --muted
//   node render.mjs still  src/index.ts Assembly out/x.png --frame=900
//
// Why (owner, 2026-10-04): several sessions each started renders with Remotion's default
// concurrency (half the cores per render). Six ran at once, every Chrome fought for the CPU and the
// GPU, and all of them crawled. A render now waits for one of MAX slots (default 2, override with
// REMOTION_MAX_RENDERS). Slots are files in the OS temp dir holding the owner's pid, so renders from
// any checkout or worktree share one queue; a slot whose pid is dead is reclaimed.
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX = Number(process.env.REMOTION_MAX_RENDERS ?? 2);
const SLOTS = path.join(os.tmpdir(), 'remotion-render-slots');
const here = path.dirname(fileURLToPath(import.meta.url));
const REMOTION = path.join(here, 'node_modules', '.bin', 'remotion');

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};

// One pass over the slots: claim a free one (exclusive create), reclaim dead ones for the next pass.
const tryClaim = () => {
  fs.mkdirSync(SLOTS, { recursive: true });
  for (let i = 0; i < MAX; i++) {
    const slot = path.join(SLOTS, `slot-${i}`);
    try {
      fs.writeFileSync(slot, String(process.pid), { flag: 'wx' });
      return slot;
    } catch {
      const holder = Number(fs.readFileSync(slot, 'utf8'));
      if (!alive(holder)) fs.rmSync(slot, { force: true });
    }
  }
  return null;
};

const claim = async () => {
  let slot = tryClaim();
  if (!slot) console.error(`render queue: ${MAX} renders already running; waiting for a slot…`);
  while (!slot) {
    await new Promise((r) => setTimeout(r, 2000));
    slot = tryClaim();
  }
  return slot;
};

// Split the machine between the slots, leaving a core free, unless the caller chose a concurrency.
const args = process.argv.slice(2);
const hasConcurrency = args.some((a) => a.startsWith('--concurrency'));
const share = Math.max(1, Math.floor(os.cpus().length / MAX) - 1);
const finalArgs = hasConcurrency ? args : [...args, `--concurrency=${share}`];

const slot = await claim();
const release = () => fs.rmSync(slot, { force: true });
// remotion.config.ts refuses to render without this, so nothing can skip the queue.
const child = spawn(REMOTION, finalArgs, { stdio: 'inherit', env: { ...process.env, REMOTION_RENDER_QUEUE: '1' } });
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => child.kill(sig));
}
child.on('exit', (code, signal) => {
  release();
  process.exit(code ?? (signal ? 1 : 0));
});
