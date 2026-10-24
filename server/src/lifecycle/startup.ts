import { exec } from 'node:child_process';
import type { Server } from 'node:http';
import { performance } from 'node:perf_hooks';
import { bootPhase, timeBootPhase, timeBootPhaseAsync } from '../observability/perf';
import { ensureAvailablePort } from './port-guard';
import { askQuestion, checkPort, killProcessOnPort } from './system-ports';

export interface StartupOptions {
  port: number;
  host: string;
  development: boolean;
  developmentClientPort: number;
  /**
   * Whether a production start opens the app in the browser. Only a server a
   * human launched in a terminal should: `server/test/auth.test.ts` boots the
   * real server on port 7527 with piped stdio, and every run of it (agents run
   * the suite constantly) popped http://localhost:7527/ open — which read to
   * the user as "opens the page on every hot reload" (2026-09-25).
   */
  browser: 'open' | 'none';
}

export interface StartupPorts {
  server: Server;
  initialize(): Promise<void>;
  startOptionalScheduler(): Promise<void>;
  pauseOptionalScheduler(): void;
  isStartupActive(): boolean;
  markReady(): boolean;
  abortStartup(): void;
  loadConversations(): Promise<void>;
}

export async function runServerStartup(
  options: StartupOptions,
  ports: StartupPorts
): Promise<void> {
  // Boot phases (boot.jsonl): never add startup work without one (docs/error-journal.md, perf).
  await timeBootPhaseAsync('initialize', () => ports.initialize());
  await ensureAvailablePort(options.port, {
    checkPort,
    askQuestion,
    killProcessOnPort,
    wait: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    exit: (code) => process.exit(code),
  });

  const listenStarted = performance.now();
  ports.server.listen(options.port, options.host, () => {
    bootPhase('listen', performance.now() - listenStarted);
    const localPort = options.development ? options.developmentClientPort : options.port;
    const startUrl = `http://localhost:${localPort}`;
    if (options.development) {
      console.log(`Server running on http://localhost:${options.port} (frontend on ${startUrl})`);
      return;
    }
    console.log(`Server running on ${startUrl} (backend on ${options.host}:${options.port})`);
    if (options.browser === 'none') return;
    const command =
      process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    exec(`${command} ${startUrl}`);
  });

  // Barrier is intentional (59da781): commands on existing history wait for the
  // list and the app conversations' runtimes (hello streams rows with loading:true).
  console.log('Loading conversations before accepting WebSocket commands...');
  await timeBootPhaseAsync('conversations_ready', () => ports.loadConversations());
  if (!ports.isStartupActive()) {
    ports.abortStartup();
    return;
  }
  await timeBootPhaseAsync('scheduler_start', () => ports.startOptionalScheduler());
  const ready = timeBootPhase('mark_ready', () => ports.markReady());
  if (!ready) {
    ports.pauseOptionalScheduler();
    return;
  }
  // No poller: transcript changes arrive from the ingest store's watcher (T13b S2).
  console.log('Initial load complete; WebSocket handlers unblocked');
}
