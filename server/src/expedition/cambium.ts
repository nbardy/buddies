import { execFile } from 'node:child_process';

// A repository hook once inherited provider keys (2026-11-01). Scrub env and disable hooks.
export function exec(bin: 'git' | 'git-cambium', cwd: string, args: string[]) {
  const keep =
    /^(PATH|HOME|USER|LOGNAME|LANG|LC_ALL|TZ|TMPDIR|GIT_(AUTHOR|COMMITTER)_(NAME|EMAIL))$/;
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => keep.test(k)));
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(
      bin,
      args,
      {
        cwd,
        timeout: 900000,
        maxBuffer: 16 << 20,
        env: {
          ...env,
          GIT_CONFIG_COUNT: '2',
          GIT_CONFIG_KEY_0: 'core.hooksPath',
          GIT_CONFIG_VALUE_0: '/dev/null',
          GIT_CONFIG_KEY_1: 'core.fsmonitor',
          GIT_CONFIG_VALUE_1: 'false',
          GIT_TERMINAL_PROMPT: '0',
        },
      },
      (error, stdout, stderr) =>
        resolve({
          code: error ? -1 : 0,
          stdout: stdout.trim(),
          stderr: stderr + (error?.message ?? ''),
        })
    );
  });
}
export async function git(cwd: string, args: string[]) {
  const result = await exec('git', cwd, args);
  if (result.code) throw new Error(`git ${args.join(' ')}: ${result.stderr.slice(-600)}`);
  return result.stdout;
}
