import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Dependencies, DependencyCheck, InstalledAgent } from '@unleashd/shared';
import type { Express } from 'express';
import { installedAgent } from './installed-agent';

// Fresh installs used to reach spawn ENOENT on their first message. Probe a real
// response, not merely --version. Guard: dependencies.test.ts (real child processes).
// Pattern: one-write-path (docs/patterns.md#one-write-path)
export function createDependencyChecks(
  env = process.env,
  timeoutMs = 45_000,
  setupDirectory?: string,
  installTimeoutMs = 600_000
) {
  // The runner inherits this environment too: a ready probe must not be the
  // only process that can discover a freshly installed CLI. Guard: first-boot test.
  const home = env.HOME || os.homedir();
  env.PATH = [
    ...new Set([
      ...(env.PATH ?? '').split(path.delimiter).filter(Boolean),
      path.join(home, '.cargo', 'bin'),
      path.join(home, '.local', 'bin'),
    ]),
  ].join(path.delimiter);
  // Rust is a SOURCE-BUILD tool, not a runtime prerequisite. A packaged app (desktop) never
  // builds from source, so it sets UNLEASHD_SOURCE_BUILDS=0 and Rust is neither probed,
  // installed (the spike's first launch ran `brew install rust`) nor shown as setup.
  // This replaces the desktop's old pre-claimed rust.attempted marker file.
  const checkIds: DependencyCheck['id'][] =
    env.UNLEASHD_SOURCE_BUILDS === '0' ? ['claude', 'codex'] : ['rust', 'claude', 'codex'];
  const probeEnv: NodeJS.ProcessEnv = { ...env };
  // An app launched from Claude must not make this independent health probe
  // look like a nested interactive session. Guard: dependencies.test.ts.
  probeEnv.CLAUDECODE = undefined;
  let checks: DependencyCheck[] = [];
  let pending: Promise<void> | null = null;
  let closed = false;
  const children = new Set<ReturnType<typeof spawn>>();

  async function run(command: string, args: string[], cwd: string, limitMs = timeoutMs) {
    if (closed) return { code: null, output: '', diagnostics: '', missing: false, timedOut: false };
    return new Promise<{
      code: number | null;
      output: string;
      diagnostics: string;
      missing: boolean;
      timedOut: boolean;
    }>((resolve) => {
      const child = spawn(command, args, {
        cwd,
        env: probeEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      });
      children.add(child);
      let output = '';
      let diagnostics = '';
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        kill(child);
      }, limitMs);
      child.stdout?.on('data', (data: Buffer) => {
        output = (output + data.toString()).slice(-16_384);
      });
      child.stdout?.resume();
      child.stderr?.on('data', (data: Buffer) => {
        diagnostics = (diagnostics + data.toString()).slice(-16_384);
      });
      child.stderr?.resume();
      const finish = (code: number | null, missing = false) => {
        clearTimeout(timer);
        children.delete(child);
        resolve({ code, output, diagnostics, missing, timedOut });
      };
      child.on('error', (error: NodeJS.ErrnoException) => finish(null, error.code === 'ENOENT'));
      child.on('close', (code) => finish(code));
    });
  }

  function kill(child: ReturnType<typeof spawn>) {
    if (!child.pid) return;
    try {
      if (process.platform === 'win32') child.kill('SIGKILL');
      else process.kill(-child.pid, 'SIGKILL');
    } catch {
      /* Already exited. */
    }
  }

  // Record each attempt before spawning: crashes/restarts must not repeat installers.
  // Guard: first-boot installation regression in dependencies.test.ts.
  // UNLEASHD_AUTO_INSTALL=0 turns installing off entirely (probes still run): a test backend on a
  // temp HOME is always "first boot" and used to download rustup into it (server/test/fixtures/backend-env.ts).
  async function claimFirstBoot(id: DependencyCheck['id']) {
    if (!setupDirectory || closed || env.UNLEASHD_AUTO_INSTALL === '0') return false;
    await mkdir(setupDirectory, { recursive: true });
    try {
      await writeFile(path.join(setupDirectory, `${id}.attempted`), new Date().toISOString(), {
        flag: 'wx',
        mode: 0o600,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw error;
    }
    return true;
  }

  async function installOnce(id: DependencyCheck['id'], cwd: string, firstBoot: boolean) {
    if (!firstBoot || closed) return;
    checks = checks.map((check) =>
      check.id === id ? { id, status: 'installing', message: 'Installing automatically…' } : check
    );
    if (id === 'codex') {
      await run(
        'npm',
        [
          'install',
          '--global',
          '--prefix',
          path.join(probeEnv.HOME || os.homedir(), '.local'),
          '@openai/codex',
        ],
        cwd,
        installTimeoutMs
      );
    } else if (id === 'rust' && (await run('brew', ['--version'], cwd)).code === 0) {
      await run('brew', ['install', 'rust'], cwd, installTimeoutMs);
    } else {
      const script = path.join(cwd, `${id}-install.sh`);
      const download = await run(
        'curl',
        [
          '--fail',
          '--silent',
          '--show-error',
          '--location',
          id === 'claude' ? 'https://claude.ai/install.sh' : 'https://sh.rustup.rs',
          '--output',
          script,
        ],
        cwd,
        installTimeoutMs
      );
      if (download.code === 0 && !closed) {
        await run(
          'bash',
          [script, ...(id === 'rust' ? ['-y', '--profile', 'minimal'] : [])],
          cwd,
          installTimeoutMs
        );
      }
    }
  }

  async function probe(id: DependencyCheck['id'], cwd: string): Promise<DependencyCheck> {
    const firstBoot = await claimFirstBoot(id);
    if (id === 'rust') {
      let results = await Promise.all([
        run('rustc', ['--version'], cwd),
        run('cargo', ['--version'], cwd),
      ]);
      if (!results.every((r) => r.code === 0)) {
        await installOnce(id, cwd, firstBoot);
        results = await Promise.all([
          run('rustc', ['--version'], cwd),
          run('cargo', ['--version'], cwd),
        ]);
      }
      return results.every((r) => r.code === 0)
        ? { id, status: 'ready', message: 'Rust and Cargo are available.' }
        : {
            id,
            status: 'missing',
            message:
              'Rust is needed for source builds. Install with brew install rust or https://rustup.rs, then check again.',
          };
    }
    if ((await run(id, ['--version'], cwd)).missing) await installOnce(id, cwd, firstBoot);
    if (closed) return { id, status: 'failed', message: 'Server is stopping.' };
    const args =
      id === 'claude'
        ? [
            '-p',
            'Respond with only Yes. Do not use tools.',
            '--output-format',
            'text',
            '--tools',
            '',
            '--no-session-persistence',
            '--strict-mcp-config',
            '--mcp-config',
            '{"mcpServers":{}}',
          ]
        : [
            'exec',
            '--ephemeral',
            '--skip-git-repo-check',
            '--sandbox',
            'read-only',
            'Respond with only Yes. Do not use tools.',
          ];
    const result = await run(id, args, cwd);
    if (result.missing)
      return {
        id,
        status: 'missing',
        message:
          id === 'claude'
            ? 'Install Claude Code: https://code.claude.com/docs/en/quickstart'
            : 'Install Codex: npm install -g @openai/codex',
      };
    if (result.code === 0 && /^yes[.!]?$/i.test(result.output.trim())) {
      return { id, status: 'ready', message: 'Answered Yes — ready to use.' };
    }
    // Installed is not authenticated/ready: quota errors previously looked like
    // missing login. Only classified fixed copy crosses the API, never raw stderr.
    const diagnostics = `${result.output} ${result.diagnostics}`;
    const failure =
      /usage limit|weekly limit|rate.?limit|quota|credit balance|hit your.*limit/i.test(diagnostics)
        ? 'quota'
        : /not logged in|not authenticated|please (?:log|sign) in|authentication|unauthorized|invalid.*key|login required|login to|sign.?in required/i.test(
              diagnostics
            )
          ? 'login'
          : result.timedOut || /network|connection|ECONN|ENOTFOUND|fetch failed/i.test(diagnostics)
            ? 'network'
            : 'other';
    const messages = {
      quota:
        'Installed, but the response check hit an account usage limit. Check your usage or try again later.',
      login: 'Installed, but sign-in failed. Log in from your terminal, then check again.',
      network: result.timedOut
        ? `Installed, but no response within ${Math.round(timeoutMs / 1000)} seconds. Check your connection, then retry.`
        : 'Installed, but the response check could not connect. Check your connection, then retry.',
      other:
        'Installed, but the response check failed. Open the agent in your terminal to see the error, then check again.',
    };
    return { id, status: 'failed', failure, message: messages[failure] };
  }

  function refresh(): Promise<void> {
    if (pending) return pending;
    if (closed) return Promise.resolve();
    checks = checkIds.map((id) => ({
      id,
      status: 'checking',
      message: 'Checking…',
    }));
    pending = (async () => {
      const cwd = await mkdtemp(path.join(os.tmpdir(), 'unleashd-deps-'));
      try {
        await Promise.all(
          checks.map(async ({ id }) => {
            const result = await probe(id, cwd);
            checks = checks.map((check) => (check.id === id ? result : check));
          })
        );
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    })()
      .catch(() => {
        checks = checks.map((check) =>
          check.status === 'checking' || check.status === 'installing'
            ? { ...check, status: 'failed', message: 'Dependency check failed. Retry.' }
            : check
        );
      })
      .finally(() => {
        pending = null;
      });
    return pending;
  }
  return {
    snapshot: (): Pick<Dependencies, 'checks'> => ({ checks }),
    refresh,
    close: () => {
      closed = true;
      for (const child of children) kill(child);
    },
  };
}

export function registerDependencyRoutes(
  app: Express,
  service = createDependencyChecks(),
  agent: () => InstalledAgent = installedAgent
) {
  void service.refresh();
  // `agent` rides along so the composer's picker resolves an unpinned Buddy exactly as the
  // server will (shared buddyExecutionPreferences), from the same PATH read.
  const status = (): Dependencies => ({ ...service.snapshot(), agent: agent() });
  app.get('/api/dependencies', (_req, res) => res.json(status()));
  app.post('/api/dependencies/check', (_req, res) => {
    void service.refresh();
    res.status(202).json(status());
  });
  return service;
}
