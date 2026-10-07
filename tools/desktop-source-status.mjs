import fs from 'node:fs';
import path from 'node:path';

// Pattern: one-write-path (docs/patterns.md#one-write-path)
// The source helper owns progress. The native shell only reads this file, including
// after an app restart; a dead helper becomes a visible retryable interruption.
export function writeSourceStatus(home, state) {
  const file = path.join(home, 'source-update-status.json');
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 });
  fs.renameSync(temporary, file);
}

export function readSourceStatus(home) {
  const file = path.join(home, 'source-update-status.json');
  if (!fs.existsSync(file)) return { kind: 'idle' };
  try {
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (
      state.kind === 'preparing' &&
      Number.isInteger(state.pid) &&
      state.pid > 0 &&
      typeof state.phase === 'string'
    ) {
      try {
        process.kill(state.pid, 0);
        return state;
      } catch (error) {
        if (error.code !== 'ESRCH') return state;
      }
      return {
        kind: 'failed',
        message:
          'Setup was interrupted. Retry to continue; your current version is still available.',
      };
    }
    if (
      state.kind === 'ready' &&
      typeof state.revision === 'string' &&
      typeof state.runtime === 'string'
    )
      return state;
    if (state.kind === 'failed' && typeof state.message === 'string') return state;
    throw new Error('Invalid progress data');
  } catch {
    return {
      kind: 'failed',
      message:
        'Setup progress could not be read. Retry setup; your current version is still available.',
    };
  }
}

// Pattern: sum-types (docs/patterns.md#sum-types)
function statusContent(state, currentRuntime, bundleRevision) {
  switch (state.kind) {
    case 'preparing':
      return {
        label: `Preparing source updates: ${state.phase}…`,
        message: 'Preparing source updates',
        detail: `${state.phase}. You can keep using Buddies while setup runs.`,
        action: null,
        buttons: ['Continue using Buddies', 'View setup logs'],
      };
    case 'ready': {
      if (bundleRevision && state.bundleRevision && bundleRevision !== state.bundleRevision) {
        return {
          label: 'Source checkout needs updating…',
          message: 'Your native app has been updated',
          detail:
            'Use the upstream workspace to merge the newer release into your source checkout. Your newly installed bundled version is running now.',
          action: null,
          buttons: ['OK', 'View setup logs'],
        };
      }
      const pending = state.runtime !== currentRuntime;
      return {
        label: pending ? 'Source update ready — reopen Buddies…' : 'Source updates ready…',
        message: pending ? 'Your source update is ready' : 'Source updates are ready',
        detail: pending
          ? `Verified build ${state.revision.slice(0, 7)}. Quit and reopen Buddies to activate it. Your chats and Buddies stay in place.`
          : `Running verified build ${state.revision.slice(0, 7)}. Use the upstream workspace to request future updates.`,
        action: pending ? 'quit' : null,
        buttons: pending
          ? ['Quit to reopen', 'Later', 'View setup logs']
          : ['OK', 'View setup logs'],
      };
    }
    case 'failed':
      return {
        label: 'Source setup needs attention — retry…',
        message: 'Source setup did not finish',
        detail: `${state.message}\n\nYour current version is still available. Check your connection and Git / Apple command-line tools, then retry.`,
        action: 'retry',
        buttons: ['Retry setup', 'Later', 'View setup logs'],
      };
    default:
      return {
        label: 'Set up source updates…',
        message: 'Set up source updates',
        detail:
          'Prepare a writable checkout and build tools so Buddies can receive source updates. You can keep using the bundled app during setup.',
        action: 'retry',
        buttons: ['Start setup', 'Later'],
      };
  }
}

// macOS native dialogs omit Electrobun's detail field. Keep recovery instructions
// in the visible message; guard: persisted source progress / native preview.
export function sourceStatusView(state, currentRuntime, bundleRevision = null) {
  const view = statusContent(state, currentRuntime, bundleRevision);
  return { ...view, message: `${view.message}\n\n${view.detail}` };
}
