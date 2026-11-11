import { cancelTurn, runTurn } from '../../src/server';
import type { RunTurnRequest } from '../../src/turns/run-turn';

// Only a control transport: calls the production exports in the real backend. No alternate runner.
process.on('message', (message: { id: number; cancel?: string; request: RunTurnRequest }) => {
  void (async () => {
    try {
      const outcome =
        message.cancel === undefined
          ? await runTurn(message.request)
          : await cancelTurn(message.cancel);
      process.send?.({ id: message.id, outcome });
    } catch (error) {
      process.send?.({
        id: message.id,
        error: {
          name: error instanceof Error ? error.constructor.name : 'Error',
          message: String(error),
        },
      });
    }
  })();
});
