import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { labelled } from '../observability/event-loop-stall';

// Host checks inherit no secrets and no shell. Quotes are argv grouping, never expansion.
export function argv(command: string): string[] {
  const words: string[] = [];
  let word = '',
    quote = '',
    started = false;
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (c === quote) {
      quote = '';
      continue;
    }
    if (quote) {
      if (quote === '"' && /[$`]/.test(c)) throw new Error('Shell expansion is not supported');
      word += c;
      continue;
    }
    if (/\s/.test(c)) {
      if (started) words.push(word);
      word = '';
      started = false;
    } else if (c === '"' || c === "'") {
      quote = c;
      started = true;
    } else if (c === '\\') {
      word += command[++i] ?? '';
      started = true;
    } else {
      if (/[|&;<>`$*?()[\]\n]/.test(c)) throw new Error('Commands run without shell syntax');
      word += c;
      started = true;
    }
  }
  if (quote) throw new Error('Unclosed command quote');
  if (started) words.push(word);
  if (!words.length) throw new Error('Empty command');
  return words;
}
export async function command(text: string, cwd: string, minutes: number, stop: AbortSignal) {
  const [bin, ...args] = argv(text);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'expedition-check-'));
  const env = Object.fromEntries(
    ['PATH', 'USER', 'LANG', 'LC_ALL', 'TZ'].flatMap((k) =>
      process.env[k] ? [[k, process.env[k]]] : []
    )
  );
  try {
    return await new Promise<{ code: number; stdout: string; tail: string }>((resolve, reject) => {
      const child = spawn(bin!, args, {
        cwd,
        env: { ...env, HOME: scratch, TMPDIR: scratch },
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '',
        tail = '';
      const kill = () => {
        try {
          process.kill(-child.pid!, 'SIGKILL');
        } catch {}
      };
      child.stdout.on('data', (b) => {
        stdout = (stdout + b).slice(-1048576);
        tail = (tail + b).slice(-4000);
      });
      child.stderr.on('data', (b) => {
        tail = (tail + b).slice(-4000);
      });
      const timer = setTimeout(
        labelled('expedition-check', kill),
        Math.min(minutes * 60000, 2147483647)
      );
      stop.addEventListener('abort', kill, { once: true });
      if (stop.aborted) kill();
      child.on('error', reject);
      child.on('exit', kill);
      child.on('close', (code) => {
        clearTimeout(timer);
        stop.removeEventListener('abort', kill);
        resolve({ code: code ?? -1, stdout, tail });
      });
    });
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}
