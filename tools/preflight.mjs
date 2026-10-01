#!/usr/bin/env node
// Install preflight (runs as `preinstall`). The one-command install used to die with a raw
// module error ("No such built-in module: node:sqlite") on Node 22.5-22.12, because
// package.json promised >=22.5 while node:sqlite is unflagged only from 22.13, and with a
// pnpm workspace error when the clone skipped --recursive. Each problem here names its fix.
import fs from 'node:fs';
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
        'https://nodejs.org, or run `nvm install` in this folder.',
    );
  }
  if (isGitCheckout && !submoduleReady) {
    problems.push(
      'vendor/agent-cli-tool is empty: the repository was cloned without its submodule. ' +
        'Run `git submodule update --init --recursive`, then install again.',
    );
  }
  return problems;
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
}
