/**
 * Child process for event-loop-stall.test.ts: runs the stall monitor, prints `ready`, then either
 * blocks its own event loop (`busy`) or idles while the parent SIGSTOPs it (`stopped`), which is
 * what a sleeping machine does to every process. Flushes stalls.jsonl and exits.
 */
import { setTimeout as delay } from 'node:timers/promises';
import { ErrorJournal } from '../../src/observability/error-journal';
import { startEventLoopStallMonitor } from '../../src/observability/event-loop-stall';
import { flushPerf } from '../../src/observability/perf-log';

async function main(): Promise<void> {
  const journal = new ErrorJournal({ directory: process.env.UNLEASHD_DATA_DIR as string });
  await journal.initialize();
  const stop = startEventLoopStallMonitor(journal, { kind: 'off' });
  await delay(200);
  process.stdout.write('ready\n');
  if (process.argv[2] === 'busy') {
    const until = performance.now() + 600;
    while (performance.now() < until) {
      /* a real synchronous stall */
    }
  }
  await delay(1_500);
  await flushPerf();
  await journal.flush();
  stop();
}

void main();
