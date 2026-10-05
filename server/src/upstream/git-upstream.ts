import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { UpstreamCheck, UpstreamUnavailableReason } from '@unleashd/shared';

const execFileAsync = promisify(execFile);

// Fetch-only upstream check for the install's own checkout. It never merges,
// resets or pulls: moving the checkout is the Upstream Release Manager's job,
// in a Buddy turn the owner starts (routes.ts).

const GIT_TIMEOUT_MS = 60_000;

/** The branch an install tracks. Every install is a clone of nbardy/buddies `main`. */
export const UPSTREAM_BRANCH = 'main';

export type Checkout =
  | { kind: 'checkout'; root: string }
  | { kind: 'not_checkout'; detail: string };

class GitFailure extends Error {}

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      encoding: 'utf8',
      // A background fetch must fail, not wait on a credential prompt nobody
      // sees. ssh reads a passphrase from /dev/tty directly, so an https-only
      // GIT_TERMINAL_PROMPT is not enough for `git@github.com:` remotes; an
      // owner's own GIT_SSH_COMMAND is kept as is.
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? 'ssh -o BatchMode=yes',
      },
    });
    return stdout.trim();
  } catch (error) {
    const stderr = (error as { stderr?: unknown }).stderr;
    const message = typeof stderr === 'string' && stderr.trim() ? stderr.trim() : String(error);
    throw new GitFailure(`git ${args.join(' ')}: ${message}`);
  }
}

/**
 * The install's checkout for code living in `directory`: the MAIN worktree of
 * the repository, not `--show-toplevel`. Agents run servers from linked
 * worktrees (`.claude/worktrees/*`, oompa `.ws*` iterations) against the live
 * ~/.buddies store; resolving the toplevel there registered every worktree as
 * its own "unleashd" workspace with its own two Buddies. The first entry of
 * `git worktree list` is always the main worktree, so every worktree of one
 * install resolves to the same folder and the bootstrap stays idempotent.
 */
export async function resolveCheckout(directory: string): Promise<Checkout> {
  try {
    const listing = await git(directory, ['worktree', 'list', '--porcelain']);
    const first = listing.split('\n')[0];
    if (!first.startsWith('worktree ')) {
      return { kind: 'not_checkout', detail: `unexpected worktree listing: ${first}` };
    }
    return { kind: 'checkout', root: first.slice('worktree '.length) };
  } catch (error) {
    return { kind: 'not_checkout', detail: (error as Error).message };
  }
}

/** `upstream` when the owner configured one (a fork's source), else `origin`. */
async function pickRemote(root: string): Promise<string | null> {
  const remotes = new Set((await git(root, ['remote'])).split('\n').filter(Boolean));
  if (remotes.has('upstream')) return 'upstream';
  if (remotes.has('origin')) return 'origin';
  return null;
}

function unavailable(reason: UpstreamUnavailableReason, detail: string): UpstreamCheck {
  return { kind: 'unavailable', reason, detail, checkedAt: new Date().toISOString() };
}

// `git rev-list --left-right --count HEAD...<remote>/main` prints
// "<ahead>\t<behind>": left is HEAD's side, right is the remote's.
function parseCounts(output: string): { ahead: number; behind: number } {
  const match = /^(\d+)\s+(\d+)$/.exec(output);
  if (!match) throw new GitFailure(`unexpected rev-list output: ${JSON.stringify(output)}`);
  return { ahead: Number(match[1]), behind: Number(match[2]) };
}

async function compare(root: string, remote: string): Promise<UpstreamCheck> {
  const tracking = `${remote}/${UPSTREAM_BRANCH}`;
  const { ahead, behind } = parseCounts(
    await git(root, ['rev-list', '--left-right', '--count', `HEAD...${tracking}`])
  );
  const sha = await git(root, ['rev-parse', tracking]);
  const checkedAt = new Date().toISOString();
  return behind > 0
    ? { kind: 'behind', remote, sha, behind, ahead, checkedAt }
    : { kind: 'current', remote, sha, checkedAt };
}

export async function checkUpstream(checkout: Checkout): Promise<UpstreamCheck> {
  switch (checkout.kind) {
    case 'not_checkout':
      return unavailable('not_git_checkout', checkout.detail);
    case 'checkout':
      return checkCheckout(checkout.root);
  }
}

async function checkCheckout(root: string): Promise<UpstreamCheck> {
  let remote: string | null;
  try {
    remote = await pickRemote(root);
  } catch (error) {
    return unavailable('not_git_checkout', (error as Error).message);
  }
  if (remote === null) return unavailable('no_remote', 'no `upstream` or `origin` remote');
  try {
    await git(root, ['fetch', '--quiet', remote, UPSTREAM_BRANCH]);
  } catch (error) {
    return unavailable('fetch_failed', (error as Error).message);
  }
  try {
    return await compare(root, remote);
  } catch (error) {
    return unavailable('compare_failed', (error as Error).message);
  }
}
