import { labelled } from '../observability/event-loop-stall';
import type { Clock } from './ports';

// The host's real clock. `setTimeout` takes at most 2^31 - 1 ms (about 24.8 days); a longer delay
// is not clamped by Node but replaced with 1 ms (TimeoutOverflowWarning), so an expedition with a
// month-long deadline would "reach" it at once and finish. A far `wakeAt` therefore waits in steps
// of at most MAX_DELAY_MS and re-checks the time after each. Guard: expeditions-v1-executor.test.ts
// ("a month-away wakeAt does not fire").

export const MAX_DELAY_MS = 2 ** 31 - 1;

export const systemClock: Clock = {
  now: () => new Date(),
  wakeAt(at: Date, fn: () => void): () => void {
    let timer: NodeJS.Timeout | 'done' = 'done';
    const arm = (): void => {
      const delay = at.getTime() - Date.now();
      timer = setTimeout(
        labelled('timer expedition-clock', delay > MAX_DELAY_MS ? arm : fire),
        Math.min(Math.max(delay, 0), MAX_DELAY_MS)
      );
      // A pending deadline must not hold the process open on its own.
      timer.unref();
    };
    const fire = (): void => {
      timer = 'done';
      fn();
    };
    arm();
    return () => {
      if (timer !== 'done') clearTimeout(timer);
      timer = 'done';
    };
  },
};
