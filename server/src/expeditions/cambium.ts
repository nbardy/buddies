import { execFile } from 'node:child_process';
import { z } from 'zod';

// The host's git and Cambium calls (docs/expeditions-lean-design.md §3.2), each a typed result.

/** Incident audit 2026-11-01 #7: git ran with the full server env, so a repository hook ran
 * agent-written code with every provider key in reach. Only these variables pass; hooks and
 * fsmonitor are off as command-line config, which outranks the repository's own. Only `archive`
 * (it pushes) gets the ssh agent socket. Known limit: `filter.<x>.smudge` still runs. */
const KEEP = ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR'];
const IDENTITY = /^GIT_(AUTHOR|COMMITTER)_(NAME|EMAIL)$/;
export const gitEnv = (withSsh: boolean): NodeJS.ProcessEnv => ({
  ...Object.fromEntries(
    Object.entries(process.env).filter(
      ([k]) => KEEP.includes(k) || IDENTITY.test(k) || (withSsh && k === 'SSH_AUTH_SOCK')
    )
  ),
  GIT_CONFIG_COUNT: '2',
  GIT_CONFIG_KEY_0: 'core.hooksPath',
  GIT_CONFIG_VALUE_0: '/dev/null',
  GIT_CONFIG_KEY_1: 'core.fsmonitor',
  GIT_CONFIG_VALUE_1: 'false',
  GIT_TERMINAL_PROMPT: '0',
});

type Exec = { code: number; stdout: string; stderr: string };
/** Never throws: the exit code is data. A timeout or spawn error is code -1. */
export function exec(bin: 'git' | 'git-cambium', cwd: string, args: string[], ssh = false) {
  const options = { cwd, env: gitEnv(ssh), timeout: 15 * 60_000, maxBuffer: 16 << 20 };
  return new Promise<Exec>((resolve) =>
    execFile(bin, args, options, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === 'number' ? error.code : -1) : 0;
      resolve({ code, stdout: stdout.trim(), stderr: `${stderr}${error?.message ?? ''}`.trim() });
    })
  );
}

/** git that must succeed: throws `git <args>: <stderr tail>` otherwise. */
export async function git(cwd: string, args: string[]): Promise<string> {
  const r = await exec('git', cwd, args);
  if (r.code !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.slice(-600)}`);
  return r.stdout;
}

export type Added = { t: 'ok'; path: string } | { t: 'failed'; message: string };
export async function add(
  repo: string,
  a: { workspace: string; branch: string; path: string; baseSha: string }
): Promise<Added> {
  const args = ['add', '-json', '-b', a.branch, '-name', a.workspace, '-ephemeral', a.path];
  const r = await exec('git-cambium', repo, [...args, a.baseSha]);
  if (r.code !== 0) return { t: 'failed', message: `cambium add: ${r.stderr.slice(-600)}` };
  return { t: 'ok', path: z.object({ path: z.string() }).parse(JSON.parse(r.stdout)).path };
}

export type Released =
  | { t: 'removed'; salvageRef: string | null }
  | { t: 'absent' }
  | { t: 'refused'; reason: string; detail: string }
  | { t: 'failed'; message: string };
const Removed = z.object({ removed: z.literal(true), salvageRef: z.string() });
const Refusal = z.object({ reason: z.string(), detail: z.string() });
/** `remove --safe --salvage-ref`: a dirty tree is snapshotted at the ref, never lost. */
export async function release(repo: string, workspace: string, ref: string): Promise<Released> {
  const listed = await exec('git-cambium', repo, ['list', '--json']);
  if (listed.code !== 0) return { t: 'failed', message: `cambium list: ${listed.stderr}` };
  const names = z.array(z.object({ name: z.string() })).parse(JSON.parse(listed.stdout || '[]'));
  if (!names.some((w) => w.name === workspace)) return { t: 'absent' };
  const args = ['remove', '-safe', '-json', '-salvage-ref', ref, workspace];
  const r = await exec('git-cambium', repo, args);
  if (r.code === 3) return { t: 'refused', ...Refusal.parse(JSON.parse(r.stdout)) };
  if (r.code !== 0) return { t: 'failed', message: `cambium remove: ${r.stderr.slice(-600)}` };
  return { t: 'removed', salvageRef: Removed.parse(JSON.parse(r.stdout)).salvageRef || null };
}

export type Archived =
  | { t: 'archived'; sha: string }
  | { t: 'refused'; reason: string }
  | { t: 'failed'; message: string };
/** Tags the branch on origin, then deletes it; a rerun (`already: true`) counts as archived. */
export async function archive(repo: string, branch: string, tag: string): Promise<Archived> {
  const r = await exec('git-cambium', repo, ['archive', '-json', branch, tag], true);
  if (r.code === 3) return { t: 'refused', reason: `${branch}: ${refusalText(r.stdout)}` };
  if (r.code !== 0) return { t: 'failed', message: `${branch}: ${r.stderr.slice(-600)}` };
  return { t: 'archived', sha: z.object({ sha: z.string() }).parse(JSON.parse(r.stdout)).sha };
}
const refusalText = (stdout: string) => {
  const r = Refusal.parse(JSON.parse(stdout));
  return `${r.reason} (${r.detail})`;
};

/** Short names under refs/heads/expedition/<id>/. */
export async function branches(repo: string, id: string): Promise<string[]> {
  const out = await git(repo, [
    'for-each-ref',
    '--format=%(refname:short)',
    `refs/heads/expedition/${id}/`,
  ]);
  return out.split('\n').filter(Boolean);
}

export type Tip = { t: 'tip'; sha: string } | { t: 'lost' };
/** The attempt branch's tip at turn end. Review 2026-11-03: a crew that renamed or deleted its
 * branch made this throw on every step, so the attempt never settled and retire was refused. The
 * branch is put back at the tree's HEAD; with the tree gone too, the turn is `lost`. */
export async function tip(repo: string, branch: string, tree: string): Promise<Tip> {
  const ref = await exec('git', repo, ['rev-parse', '--verify', `refs/heads/${branch}^{commit}`]);
  if (ref.code === 0) return { t: 'tip', sha: ref.stdout };
  const head = await exec('git', tree, ['rev-parse', '--verify', 'HEAD^{commit}']);
  if (head.code !== 0) return { t: 'lost' };
  await git(repo, ['branch', branch, head.stdout]);
  return { t: 'tip', sha: head.stdout };
}
