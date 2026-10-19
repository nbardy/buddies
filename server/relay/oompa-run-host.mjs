// A bounded Oompa/validator process, with the same pid/exit journal boundary as agent-cli.
// It outlives a backend reload; its own clock still ends the whole process group.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const [dir, deadlineText, bin, ...args] = process.argv.slice(2);
const deadline = Number(deadlineText);
if (!dir || !bin || !Number.isFinite(deadline)) process.exit(125);
let stopping = false;
let ended = false;
const finish = (status) => {
  if (ended) return;
  ended = true;
  fs.writeFileSync(path.join(dir, 'exit.tmp'), `${JSON.stringify({ status })}\n`, { mode: 0o600 });
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
  finish(status);
  process.exit(status);
});
