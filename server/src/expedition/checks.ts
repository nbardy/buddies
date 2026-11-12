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

// Pattern: one-definition (docs/patterns.md#one-definition)
// Git/Cambium and host checks share cancellation, bounded output and scrubbed process spawning.
export function exec(
  bin: string,
  cwd: string,
  args: string[],
  minutes = 15,
  signal?: AbortSignal,
  home?: string
) {
  const keep = /^(PATH|USER|LOGNAME|LANG|LC_ALL|TZ|TMPDIR|GIT_(AUTHOR|COMMITTER)_(NAME|EMAIL))$/;
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => keep.test(k)));
  return new Promise<{ code: number; stdout: string; stderr: string; tail: string }>(
    (resolve, reject) => {
      const child = spawn(bin, args, {
        cwd,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...env,
          HOME: home ?? process.env.HOME,
          TMPDIR: home ?? process.env.TMPDIR,
          GIT_CONFIG_COUNT: '2',
          GIT_CONFIG_KEY_0: 'core.hooksPath',
          GIT_CONFIG_VALUE_0: '/dev/null',
          GIT_CONFIG_KEY_1: 'core.fsmonitor',
          GIT_CONFIG_VALUE_1: 'false',
          GIT_TERMINAL_PROMPT: '0',
        },
      });
      let stdout = '';
      let stderr = '';
      let tail = '';
      const kill = () => {
        try {
          process.kill(-child.pid!, 'SIGKILL');
        } catch {}
      };
      child.stdout.on('data', (b) => {
        stdout = (stdout + b).slice(-(16 << 20));
        tail = (tail + b).slice(-4000);
      });
      child.stderr.on('data', (b) => {
        stderr = (stderr + b).slice(-4000);
        tail = (tail + b).slice(-4000);
      });
      const timer = setTimeout(labelled('expedition-command', kill), minutes * 60000);
      signal?.addEventListener('abort', kill, { once: true });
      if (signal?.aborted) kill();
      child.once('error', reject);
      child.once('exit', kill);
      child.once('close', (code) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', kill);
        resolve({ code: code ?? -1, stdout, stderr, tail });
      });
    }
  );
}
export async function git(cwd: string, args: string[]) {
  const r = await exec('git', cwd, args);
  if (r.code) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}
export async function command(text: string, cwd: string, minutes: number, signal: AbortSignal) {
  const [bin, ...args] = argv(text);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'expedition-check-'));
  try {
    return await exec(bin!, cwd, args, minutes, signal, home);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}
