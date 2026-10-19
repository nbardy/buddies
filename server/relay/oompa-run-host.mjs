// A bounded Oompa/validator process, with the same pid/exit journal boundary as agent-cli.
// It outlives a backend reload; its own clock still ends the whole process group.
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const [dir, deadlineText, bin, ...args] = process.argv.slice(2);
const deadline = Number(deadlineText);
if (!dir || !bin || !Number.isFinite(deadline)) process.exit(125);
let stopping = false;
let ended = false;
const finish = (observedStatus) => {
  let status = observedStatus;
  if (ended) return;
  ended = true;
  // Release only this diagnostic's handshake, including while the backend is offline.
  const control = process.env.OOMPA_CONTINUATION_CONTROL_DIR;
  const id = process.env.OOMPA_CONTINUATION_ID;
  let sourceError;
  if (status === 0 && Date.now() >= deadline) status = 124;
  if (control && id && status === 0) {
    try {
      const { request } = JSON.parse(fs.readFileSync(path.join(dir, 'continuation.json'), 'utf8'));
      const git = (...args) =>
        execFileSync('git', ['-C', request.workspacePath, ...args], {
          encoding: 'utf8',
          maxBuffer: 2_000_000,
          timeout: Math.max(1, Math.min(3000, deadline - Date.now())),
        }).trim();
      if (git('status', '--porcelain') || git('rev-parse', 'HEAD') !== request.sourceCommit)
        throw new Error('diagnostic source changed during execution');
      for (const [relative, expected] of Object.entries(request.sourceFiles)) {
        if (
          createHash('sha256')
            .update(fs.readFileSync(path.resolve(request.workspacePath, relative)))
            .digest('hex') !== expected
        )
          throw new Error(`diagnostic source pin changed: ${relative}`);
      }
    } catch (error) {
      status = 126;
      sourceError = String(error);
    }
  }
  if (status === 0 && Date.now() >= deadline) status = 124;
  if (control && id && !stopping) {
    const request = path.join(control, 'continuation-request.json');
    try {
      if (JSON.parse(fs.readFileSync(request, 'utf8')).id === id) fs.unlinkSync(request);
    } catch {}
  }
  fs.writeFileSync(
    path.join(dir, 'exit.tmp'),
    `${JSON.stringify({ status, ...(sourceError ? { sourceError } : {}) })}\n`,
    { mode: 0o600 }
  );
  fs.renameSync(path.join(dir, 'exit.tmp'), path.join(dir, 'exit.json'));
};
const stop = (status) => {
  if (stopping) return;
  stopping = true;
  try {
    process.kill(-process.pid, 'SIGTERM');
  } catch {}
  setTimeout(() => {
    finish(status);
    try {
      process.kill(-process.pid, 'SIGKILL');
    } catch {}
    process.exit(status);
  }, 3000);
};
process.on('SIGTERM', () => stop(143));
process.on('SIGINT', () => stop(130));
const timer = setTimeout(() => stop(124), Math.max(0, deadline - Date.now()));
const child = spawn(bin, args, { stdio: ['ignore', 'inherit', 'inherit'] });
child.once('error', () => {
  clearTimeout(timer);
  finish(125);
  process.exit(125);
});
child.once('close', (code, signal) => {
  if (stopping) return;
  clearTimeout(timer);
  const status = code ?? (signal ? 143 : 125);
  // A successful command can leave grandchildren. Drain the owned group too;
  // request release waits for backend observation of the dead wrapper.
  stop(status);
});
