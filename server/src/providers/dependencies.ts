import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Dependencies, DependencyCheck } from '@unleashd/shared';
import type { Express } from 'express';

// Fresh installs used to reach spawn ENOENT on their first message. Probe a real
// response, not merely --version. Guard: dependencies.test.ts (real child processes).
// Pattern: one-write-path (docs/patterns.md#one-write-path)
export function createDependencyChecks(env = process.env, timeoutMs = 45_000) {
  const probeEnv: NodeJS.ProcessEnv = {
    ...env,
    PATH: `${env.PATH ?? ''}${path.delimiter}${path.join(env.HOME || os.homedir(), '.cargo', 'bin')}`,
  };
  // An app launched from Claude must not make this independent health probe
  // look like a nested interactive session. Guard: dependencies.test.ts.
  probeEnv.CLAUDECODE = undefined;
  let checks: DependencyCheck[] = [];
  let pending: Promise<void> | null = null;
  const children = new Set<ReturnType<typeof spawn>>();

  async function run(command: string, args: string[], cwd: string) {
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
      }, timeoutMs);
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

  async function probe(id: DependencyCheck['id'], cwd: string): Promise<DependencyCheck> {
    if (id === 'rust') {
      const results = await Promise.all([
        run('rustc', ['--version'], cwd),
        run('cargo', ['--version'], cwd),
      ]);
      return results.every((r) => r.code === 0)
        ? { id, status: 'ready', message: 'Rust and Cargo are available.' }
        : {
            id,
            status: 'missing',
            message:
              'Rust is needed for source builds. Install with brew install rust or https://rustup.rs, then check again.',
          };
    }
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
        : /not logged in|please log in|authentication|unauthorized|invalid.*key|login required/i.test(
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
    checks = ['rust', 'claude', 'codex'].map((id) => ({
      id: id as DependencyCheck['id'],
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
          check.status === 'checking'
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
    snapshot: (): Dependencies => ({ checks }),
    refresh,
    close: () => {
      for (const child of children) kill(child);
    },
  };
}

export function registerDependencyRoutes(app: Express, service = createDependencyChecks()) {
  void service.refresh();
  app.get('/api/dependencies', (_req, res) => res.json(service.snapshot()));
  app.post('/api/dependencies/check', (_req, res) => {
    void service.refresh();
    res.status(202).json(service.snapshot());
  });
  return service;
}
