import { execFile } from 'node:child_process';

// A repository hook once inherited provider keys (2026-11-01). Scrub env and disable hooks.
export function exec(bin: 'git' | 'git-cambium', cwd: string, args: string[], timeout = 900000) {
  const keep =
    /^(PATH|HOME|USER|LOGNAME|LANG|LC_ALL|TZ|TMPDIR|GIT_(AUTHOR|COMMITTER)_(NAME|EMAIL))$/;
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => keep.test(k)));
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(
      bin,
      args,
      {
        cwd,
        timeout,
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
          stdout,
          stderr: stderr + (error?.message ?? ''),
        })
    );
  });
}
export async function git(cwd: string, args: string[]) {
  const result = await exec('git', cwd, args);
  if (result.code) throw new Error(`git ${args.join(' ')}: ${result.stderr.slice(-600)}`);
  return result.stdout.trim();
}
// Shared checkouts may be on another session's branch. Guard: expedition-backend base checkouts.
export async function resolveBase(repo: string, override?: string) {
  // 15 s, not 3: a real fetch of the owner's largest repository takes about 4 s, so the first real
  // proposal card read "fetch failed" over an up-to-date main (2026-11-12). A launch can wait.
  const fetched = await exec('git', repo, ['fetch', 'origin'], 15_000);
  const head = 'refs/remotes/origin/HEAD';
  const recorded = () => exec('git', repo, ['rev-parse', '--symbolic-full-name', head]);
  let remote = await recorded();
  // A checkout that was not made by `git clone` never recorded the remote's default branch: 12 of
  // the owner's 14 repositories with a remote (2026-11-12), so every launch there fell back to the
  // folder's current branch, often another session's. Ask the remote once, bounded like the fetch.
  // Guard: expedition-small "a remote added by hand".
  if (remote.code !== 0) {
    await exec('git', repo, ['remote', 'set-head', 'origin', '--auto'], 5000);
    remote = await recorded();
  }
  const fallback = !override && remote.code !== 0;
  const ref = override ?? (fallback ? 'HEAD' : remote.stdout.trim());
  const commit = await git(repo, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]);
  const branch = await exec('git', repo, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  const name = fallback
    ? `this folder's ${branch.code === 0 ? `current branch ${branch.stdout.trim()}` : 'detached HEAD'}`
    : ref.replace(/^refs\/remotes\//, '');
  return {
    commit,
    line: `starts from ${name} at ${commit.slice(0, 7)}${fallback ? ': the repository has no origin default branch' : ''}, fetch ${fetched.code === 0 ? 'succeeded' : 'failed'}`,
  };
}
