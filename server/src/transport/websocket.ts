import fs from 'node:fs';
import type { CommandError, GeneralCommandError, ServerMessageInput } from '@unleashd/shared';
import { WebSocket } from 'ws';
import { labelled } from '../observability/event-loop-stall';

export function sendToClient(ws: WebSocket, data: ServerMessageInput): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}

export function sendProtocolError(ws: WebSocket, message: string): void {
  sendToClient(ws, { type: 'error', message });
}

export function validateWorkingDirectory(
  workingDirectory: string
): GeneralCommandError | undefined {
  try {
    return fs.statSync(workingDirectory).isDirectory()
      ? undefined
      : { code: 'invalid_directory', message: 'Path is not a directory' };
  } catch {
    return {
      code: 'invalid_directory',
      message: `No matching folder: ${workingDirectory}`,
    };
  }
}

export function sendAck(
  ws: WebSocket,
  commandId: string,
  result: Extract<ServerMessageInput, { type: 'ack' }>['result']
): void {
  sendToClient(ws, { type: 'ack', commandId, result });
}

/**
 * A rejection never carries a snapshot (v2 embedded the whole conversation,
 * messages included). Callers send the authoritative field as a patch first.
 */
export function sendCommandRejected(
  ws: WebSocket,
  input: { commandId: string; conversationId?: string; error: CommandError }
): void {
  sendAck(ws, input.commandId, {
    t: 'rejected',
    conversationId: input.conversationId ?? null,
    error: input.error,
  });
}

export const WS_LIVENESS_INTERVAL_MS = 20_000;

/**
 * Ping every `intervalMs`; terminate() a peer that has not ponged since the last ping, so a
 * half-open socket (slept laptop, dev proxy) closes and the client reconnects
 * (docs/ws-contract-surprises.md#liveness). Guard: websocket-lifecycle.test.ts "liveness …".
 */
export function superviseLiveness(ws: WebSocket, intervalMs: number): void {
  let answeredSinceLastPing = true;
  let lastTickAt = Date.now();
  let lastBufferedAmount = 0;
  ws.on('pong', () => {
    answeredSinceLastPing = true;
  });
  const timer = setInterval(
    labelled('timer ws-liveness', () => {
      const now = Date.now();
      // A live peer can miss a pong when our loop stalled (late tick) or our ping queues behind a
      // large send (draining buffer); a half-open socket shows neither.
      const tickWasLate = now - lastTickAt > intervalMs * 1.5;
      const sendBufferDraining = ws.bufferedAmount > 0 && ws.bufferedAmount < lastBufferedAmount;
      lastTickAt = now;
      lastBufferedAmount = ws.bufferedAmount;
      if (!answeredSinceLastPing && !tickWasLate && !sendBufferDraining) {
        ws.terminate();
        return;
      }
      answeredSinceLastPing = false;
      ws.ping();
    }),
    intervalMs
  );
  // The HTTP server keeps the process alive; a heartbeat must not.
  timer.unref();
  ws.on('close', () => clearInterval(timer));
}

export function sendCommandAccepted(ws: WebSocket, input: { commandId: string }): void {
  sendAck(ws, input.commandId, { t: 'accepted' });
}
