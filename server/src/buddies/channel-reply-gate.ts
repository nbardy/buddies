import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ExecuteCommandRequest } from '@nbardy/agent-cli';
import { executeCommand } from '@nbardy/agent-cli';
import type { ConversationConfig, Provider, ResolvedExecutionConfig } from '@unleashd/shared';
import { runDetached } from './detached-cli';

// The thread follow-up gate: "should you respond, or leave it to another team
// member?" asked of one Buddy about one new thread post. It is a bare CLI run
// on the Buddy's seat model — no Buddy MCP, no tools, no session files,
// a scratch cwd so no repository instructions load — and it may answer only
// `<yes>` or `<no>`. Anything else is `unparseable`, never read as a guess:
// a Buddy that rambles past GATE_MAX_CHARS is stopped and stays silent.

export type GateVerdict =
  | { kind: 'respond' }
  | { kind: 'pass' }
  | { kind: 'unparseable'; output: string }
  | { kind: 'failed'; reason: string };

// `config` is the Buddy's seat config in the thread (runner.ts), so
// a Buddy the owner moved onto another harness is asked there too — not on a
// profile harness that may be down.
export type ReplyGate = (input: {
  config: ConversationConfig;
  prompt: string;
}) => Promise<GateVerdict>;

// `<yes>` / `<no>` plus whitespace. Past this the answer is already invalid, so
// the run is stopped rather than left to spend tokens.
const GATE_MAX_CHARS = 32;
const GATE_TIMEOUT_MS = 90_000;

export function parseGateVerdict(output: string): GateVerdict {
  switch (output.trim()) {
    case '<yes>':
      return { kind: 'respond' };
    case '<no>':
      return { kind: 'pass' };
    case '':
      // A finished run with no text is a harness failure, not a `<no>`. An
      // owner post then gets the same visible notice as any other failed gate.
      return { kind: 'failed', reason: 'no answer' };
    default:
      return { kind: 'unparseable', output };
  }
}

// One flag set per harness a Buddy can run on (turn-policy.ts `assertBuddyProviderSupportsMcp`
// admits only required-MCP harnesses). Each drops tools, user and project instructions, and
// session persistence: a persisted gate transcript would be imported by the disk adapters and
// show up as a conversation. `null`: no reply gate on that harness.
// Pattern: table-driven (docs/patterns.md#table-driven)
/** The read-only, no-persistence flags per harness; the memory reviewer restricts itself the same way. */
export const RESTRICTED_FLAGS = {
  claude: ['--setting-sources', '', '--no-session-persistence'],
  codex: ['--ephemeral', '--ignore-user-config', '--ignore-rules', '-s', 'read-only'],
  muse: [
    '--no-session-log',
    '--no-foreign-personal-context',
    '--disable-shell',
    '--disable-write',
    '--disable-web-tools',
  ],
  cursor: ['--mode', 'ask'],
};

const GATE_HARNESSES: Record<Provider, { args: string[]; effort: boolean } | null> = {
  claude: { args: ['--tools', '', ...RESTRICTED_FLAGS.claude], effort: true },
  codex: { args: RESTRICTED_FLAGS.codex, effort: true },
  muse: { args: RESTRICTED_FLAGS.muse, effort: true },
  // Cursor has no flag to drop tools or persistence. `--mode ask` makes it read-only and, without
  // `--force`, nothing needing approval executes; any tool.use still ends the gate as
  // unparseable. The cwd is a fresh temp dir, so Cursor refuses to start unless `--trust` is
  // passed — a real seat turn runs in a directory the owner already trusted, which is why the
  // same harness answers a mention and then fails this gate. Its transcript is deleted after
  // exit (runDetached), and effort lives in the model id.
  cursor: { args: [...RESTRICTED_FLAGS.cursor, '--trust'], effort: false },
  opencode: null,
  gemini: null,
};

async function runGate(
  execute: typeof executeCommand,
  request: ExecuteCommandRequest
): Promise<GateVerdict> {
  const deadline = AbortSignal.timeout(GATE_TIMEOUT_MS);
  let output = '';
  let providerError = '';
  let violation: GateVerdict | null = null;
  const result = await runDetached(execute, request, deadline, (event, stop) => {
    if (event.type === 'text.delta') output += event.text;
    if (event.type === 'error' || event.type === 'out_of_tokens') providerError = event.message;
    // Native child states replace completed tool events; they still violate the no-tools gate.
    // Guard: buddies-v2.test.ts "native child events cannot bypass restricted Buddy runs".
    const broken =
      event.type === 'tool.use'
        ? `(called tool ${event.name})`
        : event.type === 'subagent.state'
          ? `(sub-agent ${event.operation})`
          : output.length > GATE_MAX_CHARS
            ? output
            : null;
    if (broken === null) return;
    violation ??= { kind: 'unparseable', output: broken };
    stop();
  });
  if (violation) return violation;
  if (deadline.aborted)
    return { kind: 'failed', reason: `no answer within ${GATE_TIMEOUT_MS / 1000}s` };
  const completion = result();
  if (completion.reason !== 'success')
    return {
      kind: 'failed',
      reason: `gate run ended: ${completion.reason}${providerError ? ` (${providerError})` : ''}`,
    };
  return parseGateVerdict(output);
}

export function createCliReplyGate(ports: {
  resolveExecution(config: ConversationConfig): Promise<ResolvedExecutionConfig>;
  execute?: typeof executeCommand;
}): ReplyGate {
  const execute = ports.execute ?? executeCommand;
  return async ({ config, prompt }) => {
    const execution = await ports.resolveExecution(config);
    const gate = GATE_HARNESSES[execution.provider];
    if (!gate)
      return { kind: 'failed', reason: `no reply gate for provider ${execution.provider}` };
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unleashd-reply-gate-'));
    try {
      const request = {
        harness: execution.provider,
        mode: 'conversation',
        prompt,
        cwd: directory,
        model: execution.modelId,
        ...(gate.effort ? { reasoningEffort: execution.reasoningEffort } : {}),
        yolo: false,
        detached: true,
        extraArgs: gate.args,
      } as ExecuteCommandRequest;
      return await runGate(execute, request);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  };
}
