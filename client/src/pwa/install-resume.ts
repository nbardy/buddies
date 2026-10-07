import {
  FOREGROUND_SETTLE_MS,
  WAKE_GAP_MS,
  createResumeTracker,
  createWakeDetector,
} from './resume';

declare global {
  var __unleashdKeepOnResume: (() => boolean) | undefined;
}

/** Dev only: tell the patched Vite client not to reload a page that was backgrounded or frozen. */
export function installKeepOnResume(): void {
  if (import.meta.env?.DEV !== true || typeof document === 'undefined') return;
  const tracker = createResumeTracker(FOREGROUND_SETTLE_MS);
  const schedule: Parameters<typeof tracker.noteVisible>[0] = (afterMs, callback) => {
    window.setTimeout(callback, afterMs);
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') tracker.noteHidden();
    else tracker.noteVisible(schedule);
  });
  // A sleeping or swap-stalled page stays "visible" (no visibilitychange); the clock gap shows it.
  // Checked when Vite decides, not on a poll: timers are frozen until after the decision may run.
  const wake = createWakeDetector(WAKE_GAP_MS, Date.now);
  globalThis.__unleashdKeepOnResume = () => {
    if (wake.gapExceeded() && document.visibilityState === 'visible') {
      tracker.noteHidden();
      tracker.noteVisible(schedule);
    }
    return tracker.keep();
  };
  window.setInterval(() => void globalThis.__unleashdKeepOnResume?.(), 1_000);
}
