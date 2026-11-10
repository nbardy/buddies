#!/usr/bin/env node
// Pattern: fix-guards (docs/patterns.md#fix-guards)
// node bound-child.mjs <command> [args...]: run one command that dies with whoever started this.
//
// Why: the dev runtime's TypeScript 7 watch compilers are native `tsc --watch` processes. A
// SIGKILLed supervisor (or one that crashed through process.exit) left all three running under
// launchd (measured 2026-11-11); while the compilers ran in-process (TS 5's API) they died with
// it. macOS has no parent-death signal, so this wrapper holds a pipe from the parent on its stdin:
// the kernel closes that pipe when the parent dies, however it dies, and the wrapper then stops
// the command. Signals sent to the wrapper are forwarded. Guard: tools/bound-child.test.mjs.
import { spawn } from 'node:child_process';

const [command, ...args] = process.argv.slice(2);
const child = spawn(command, args, { stdio: ['ignore', 'inherit', 'inherit'] });

const stop = (signal) => {
  if (child.exitCode === null && child.signalCode === null) child.kill(signal);
};
// EOF on stdin: the parent is gone (or closed the pipe on purpose to stop us).
process.stdin.on('end', () => stop('SIGTERM'));
process.stdin.on('error', () => stop('SIGTERM'));
process.stdin.resume();
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => stop(signal));

child.once('error', (error) => {
  process.stderr.write(`bound-child: could not start ${command}: ${error.message}\n`);
  process.exit(127);
});
child.once('exit', (code, signal) => {
  process.exit(code ?? (signal ? 128 : 1));
});
