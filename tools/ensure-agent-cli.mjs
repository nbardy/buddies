#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

const directory = 'vendor/agent-cli-tool';
// A fresh worktree has an empty submodule; installing first omits its workspace package.
// Guard: ensure-agent-cli.test.mjs initializes a real empty worktree and preserves local work.
if (!fs.existsSync(directory) || fs.readdirSync(directory).length === 0) {
  const result = spawnSync(
    'git',
    ['submodule', 'update', '--init', '--recursive', '--', directory],
    {
      stdio: 'inherit',
    }
  );
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
