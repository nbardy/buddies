import { execFile } from 'node:child_process';
import { delimiter, join } from 'node:path';

// Finder launches an app with PATH=/usr/bin:/bin:/usr/sbin:/sbin, so `claude` and `codex`
// are invisible unless we recover the PATH the user's terminal has. We ask their own login
// shell ONCE at launch, instead of appending known directories (~/.local/bin, ~/.bun/bin…):
// a list breaks again on the next unusual install location (nvm, fnm, volta, asdf, pnpm,
// a custom npm prefix) — ~/.bun/bin was the miss that made Codex read "missing" while the
// owner's terminal ran it fine (2026-10-05). The server detects agents with, and its real
// turns spawn them under, the process PATH, so handing it this one value keeps detection
// and spawn on the same environment.
//
// `-i` as well as `-l`: nvm/fnm/bun installers write PATH to ~/.zshrc, which a plain login
// shell never reads. The PATH is fenced by markers because rc files print banners.

const START = '__BUDDIES_PATH_START__';
const END = '__BUDDIES_PATH_END__';

export type LoginPath =
  | { kind: 'login-shell'; path: string; shell: string }
  // The shell failed or timed out. Provenance is data: the caller logs it and the app
  // runs with the well-known directories instead of pretending the shell answered.
  | { kind: 'fallback'; path: string; reason: string };

export function fallbackDirs(home: string): string[] {
  return [
    join(home, '.local', 'bin'),
    join(home, '.bun', 'bin'),
    join(home, '.cargo', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ];
}

export function extractFencedPath(output: string): string | null {
  const start = output.lastIndexOf(START);
  if (start < 0) return null;
  const end = output.indexOf(END, start);
  if (end < 0) return null;
  const value = output.slice(start + START.length, end);
  return value.length > 0 ? value : null;
}

/** Merge keeping first occurrence: the bundled node and login-shell order win. */
export function mergePath(...parts: string[]): string {
  return [...new Set(parts.flatMap((part) => part.split(delimiter)).filter(Boolean))].join(
    delimiter
  );
}

export function resolveLoginPath(
  env: Record<string, string | undefined>,
  home: string,
  timeoutMs = 8000
): Promise<LoginPath> {
  const shell = env.SHELL || '/bin/zsh';
  const inherited = env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin';
  const fallback = (reason: string): LoginPath => ({
    kind: 'fallback',
    path: mergePath(inherited, ...fallbackDirs(home)),
    reason,
  });
  return new Promise((resolve) => {
    execFile(
      shell,
      ['-ilc', `printf '%s%s%s' '${START}' "$PATH" '${END}'`],
      {
        env: { ...env, HOME: home },
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
        maxBuffer: 1 << 20,
      },
      (error, stdout) => {
        if (error)
          return resolve(fallback(`${shell} -ilc failed: ${error.message.split('\n')[0]}`));
        const path = extractFencedPath(stdout);
        if (path === null) return resolve(fallback(`${shell} -ilc printed no PATH`));
        resolve({ kind: 'login-shell', path: mergePath(path, inherited), shell });
      }
    ).stdin?.end();
  });
}
