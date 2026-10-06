import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ExecuteCommandRequest, executeCommand } from '@nbardy/agent-cli';

const CURSOR_PROJECTS_DIR = path.join(os.homedir(), '.cursor', 'projects');

/**
 * Cursor's print mode has no counterpart to claude `--no-session-persistence`
 * or codex `--ephemeral`: every run writes
 * `~/.cursor/projects/<encoded cwd>/agent-transcripts/<sessionId>/`, and the
 * Cursor disk adapter imports that as a conversation. A background run that
 * must stay invisible (the memory reviewer) therefore deletes
 * its own files, found by session id, once the process has exited.
 *
 * Found by session id rather than by re-encoding the cwd: the directory name
 * is a lossy encoding (see resolveEncodedProjectDirectory), a uuid is not.
 *
 * Only THIS run's files: its transcript and the agent-tools/*.txt spills its transcript names
 * (raw MCP output, i.e. Buddy memory). The project dir goes too once no other session is left in
 * it. Removing the whole dir unconditionally was right while every caller ran in a private
 * mkdtemp cwd, but the memory reviewer runs in the Buddy's workspace root since 2026-09-26, where
 * that dir holds the owner's own Cursor sessions. Guard: cursor-ephemeral.test.ts.
 */
export function discardCursorTranscript(
  sessionId: string,
  projectsDir: string = CURSOR_PROJECTS_DIR
): void {
  if (!sessionId || !fs.existsSync(projectsDir)) return;
  for (const project of fs.readdirSync(projectsDir)) {
    const projectDir = path.join(projectsDir, project);
    const transcripts = path.join(projectDir, 'agent-transcripts');
    const own = path.join(transcripts, sessionId);
    if (!fs.existsSync(own)) continue;
    for (const spill of namedToolSpills(own))
      fs.rmSync(path.join(projectDir, 'agent-tools', spill), { force: true });
    fs.rmSync(own, { recursive: true, force: true });
    if (fs.readdirSync(transcripts).length === 0)
      fs.rmSync(projectDir, { recursive: true, force: true });
  }
}

function namedToolSpills(transcriptDir: string): string[] {
  return fs
    .readdirSync(transcriptDir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .flatMap((entry) =>
      [
        ...fs
          .readFileSync(path.join(entry.parentPath, entry.name), 'utf8')
          .matchAll(/agent-tools\/([\w-]+\.txt)/g),
      ].map((match) => match[1])
    );
}

type Turn = ReturnType<typeof executeCommand>;
type TurnEvent = Turn['events'] extends AsyncIterable<infer E> ? E : never;
type Completion = Awaited<Turn['completed']>;
const STOP_GRACE_MS = 5_000;

/**
 * One background CLI run that must stay invisible: the memory reviewer.
 * `onEvent` sees every event and may `stop` the run; an aborted `signal` stops it too, and a
 * stopped run is killed after STOP_GRACE_MS. Resolves once the process exited AND its events
 * drained (it keeps process ownership until then). The returned `result` rethrows a failed run,
 * so a caller checks its own verdict (a violation, an abort) first.
 */
export async function runDetached(
  execute: typeof executeCommand,
  request: ExecuteCommandRequest,
  signal: AbortSignal,
  onEvent: (event: TurnEvent, stop: () => void) => void
): Promise<() => Completion> {
  const turn = execute(request);
  let kill: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    turn.stop();
    kill ??= setTimeout(() => turn.stop('SIGKILL'), STOP_GRACE_MS);
  };
  signal.addEventListener('abort', stop, { once: true });
  try {
    const consumed = (async () => {
      for await (const event of turn.events) onEvent(event, stop);
    })();
    const [completion, events] = await Promise.allSettled([turn.completed, consumed]);
    if (completion.status === 'fulfilled' && request.harness === 'cursor')
      discardCursorTranscript(completion.value.sessionId);
    return () => {
      if (events.status === 'rejected') throw events.reason;
      if (completion.status === 'rejected') throw completion.reason;
      return completion.value;
    };
  } finally {
    signal.removeEventListener('abort', stop);
    clearTimeout(kill);
  }
}
