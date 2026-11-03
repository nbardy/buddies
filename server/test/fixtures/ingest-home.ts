import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** A throwaway HOME with a Claude project dir and an app data dir, for the real ingest crate. */
export function ingestHome(prefix: string) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const appData = path.join(home, '.agent-viewer');
  const project = path.join(home, 'git', 'demo');
  fs.mkdirSync(project, { recursive: true });
  const claudeDir = path.join(home, '.claude', 'projects', project.replaceAll('/', '-'));
  fs.mkdirSync(claudeDir, { recursive: true });
  return {
    home,
    appData,
    project,
    transcript: (sessionId: string) => path.join(claudeDir, `${sessionId}.jsonl`),
    cleanup: () => fs.rmSync(home, { recursive: true, force: true }),
  };
}

/** One Claude transcript line. `uuid` is derived from role + time, so equal lines dedupe. */
export function claudeLine(
  sessionId: string,
  role: 'user' | 'assistant',
  text: string,
  at: number,
  cwd: string
): string {
  return `${JSON.stringify({
    type: role,
    sessionId,
    cwd,
    timestamp: new Date(at).toISOString(),
    uuid: `${role}-${at}`,
    message:
      role === 'user'
        ? { role, content: text }
        : { role, id: `msg-${at}`, model: 'claude-opus-5-5', content: [{ type: 'text', text }] },
  })}\n`;
}

export async function until<T>(read: () => T | undefined, ms = 60_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
