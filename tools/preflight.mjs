#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
// Install preflight (runs as `preinstall`). The one-command install used to die with a raw
// module error ("No such built-in module: node:sqlite") on Node 22.5-22.12, because
// package.json promised >=22.5 while node:sqlite is unflagged only from 22.13, and with a
// pnpm workspace error when the clone skipped --recursive. Each problem here names its fix.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MIN_NODE = [22, 13, 0];

const atLeast = (v, min) => {
  for (let i = 0; i < 3; i++) {
    if (v[i] !== min[i]) return v[i] > min[i];
  }
  return true;
};

/** @param {{ nodeVersion: string, isGitCheckout: boolean, submoduleReady: boolean }} env */
export function findProblems({ nodeVersion, isGitCheckout, submoduleReady }) {
  const problems = [];
  const v = nodeVersion.replace(/^v/, '').split('.').map(Number);
  if (!atLeast(v, MIN_NODE)) {
    problems.push(
      `Node ${nodeVersion} is too old: unleashd needs Node ${MIN_NODE.join('.')} or newer ` +
        '(the Buddies store uses node:sqlite). Install a current Node LTS from ' +
        'https://nodejs.org, or run `nvm install` in this folder.'
    );
  }
  if (isGitCheckout && !submoduleReady) {
    problems.push(
      'vendor/agent-cli-tool is empty: the repository was cloned without its submodule. ' +
        'Run `git submodule update --init --recursive`, then install again.'
    );
  }
  return problems;
}

// Pattern: fix-guards (docs/patterns.md#fix-guards)
// Missing Rust previously produced spawnSync rustc ENOENT during build. Install
// preflight verifies the toolchain AFTER installation; preflight.test.mjs guards it.
export function checkDependencies({ env = process.env, log = console.warn } = {}) {
  const cargoBin = path.join(env.HOME || os.homedir(), '.cargo', 'bin');
  const installEnv = { ...env, PATH: `${env.PATH || ''}${path.delimiter}${cargoBin}` };
  const available = (bin) =>
    spawnSync(bin, ['--version'], {
      env: installEnv,
      timeout: 10_000,
      stdio: 'ignore',
    }).status === 0;
  if (!available('rustc') || !available('cargo')) {
    let result;
    if (available('brew')) {
      log('Rust is required to build the native addons. Installing with brew install rust…');
      result = spawnSync('brew', ['install', 'rust'], {
        env: installEnv,
        timeout: 600_000,
        stdio: 'inherit',
      });
    } else if (available('claude')) {
      log('Homebrew is unavailable. Asking Claude Code to install Rust with rustup…');
      result = spawnSync(
        'claude',
        [
          '-p',
          'Install the stable Rust toolchain and Cargo for this user using the official rustup installer at https://rustup.rs with its noninteractive -y option. Do not change project files or use sudo. Verify rustc and cargo --version afterward.',
          '--allowedTools',
          'Bash',
          '--no-session-persistence',
        ],
        { env: installEnv, cwd: os.tmpdir(), timeout: 600_000, stdio: 'inherit' }
      );
    }
    if (!result || result.status !== 0 || !available('rustc') || !available('cargo')) {
      throw new Error(
        'Rust installation did not complete. Run `brew install rust` or install from https://rustup.rs, then run pnpm install again. If using Claude, run `claude auth login` first.'
      );
    }
  }
  for (const bin of ['claude', 'codex']) {
    log(
      available(bin)
        ? `${bin} found. The app will check whether it can respond at launch.`
        : `${bin} is not available. Install ${bin === 'claude' ? 'Claude Code (https://code.claude.com/docs/en/quickstart)' : 'Codex (npm install -g @openai/codex)'}, then log in. At least one agent is needed to send messages.`
    );
  }
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const problems = findProblems({
    nodeVersion: process.version,
    isGitCheckout: fs.existsSync(path.join(root, '.gitmodules')),
    submoduleReady: fs.existsSync(path.join(root, 'vendor/agent-cli-tool/package.json')),
  });
  if (problems.length > 0) {
    console.error(`\nunleashd can't install yet:\n${problems.map((p) => `  - ${p}`).join('\n')}\n`);
    process.exit(1);
  }
  if (fs.existsSync(path.join(root, '.gitmodules'))) {
    try {
      checkDependencies();
    } catch (error) {
      console.error(`\nunleashd can't install yet: ${error.message}\n`);
      process.exit(1);
    }
  }
}
