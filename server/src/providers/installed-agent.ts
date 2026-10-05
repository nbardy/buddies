import { constants, accessSync, statSync } from 'node:fs';
import path from 'node:path';
import { getHarness } from '@nbardy/agent-cli';
import type { InstalledAgent, Provider } from '@unleashd/shared';

// The agents Setup installs and probes, in preference order. Codex is first because it was the
// literal fallback before this existed: an install with both keeps running what it ran. Other
// harnesses run only when an owner pins them on a Buddy.
// Design: agent_notes/2026-10-05_installed-provider-default-design.md.
const AUTO_AGENTS: readonly Provider[] = ['codex', 'claude'];

export function onPath(binary: string, env: NodeJS.ProcessEnv): boolean {
  return (env.PATH ?? '').split(path.delimiter).some((dir) => {
    if (!dir) return false;
    const file = path.join(dir, binary);
    try {
      accessSync(file, constants.X_OK);
      return statSync(file).isFile();
    } catch {
      return false;
    }
  });
}

/**
 * The agent an unpinned Buddy runs: the first of AUTO_AGENTS whose binary is on PATH.
 *
 * It reads the PATH the runner spawns with (createDependencyChecks extends process.env with
 * ~/.local/bin and ~/.cargo/bin), so "found" means the spawn will not ENOENT. It is a stat
 * walk, not `which`: it runs on every Buddy conversation open and every /api/dependencies poll,
 * and a subprocess there would block the event loop. Nothing is cached, so a first-boot install
 * that finishes after startup is seen by the next open. Readiness probes are deliberately not
 * consulted: they are 'checking' for up to 45 s after each start and can fail transiently, which
 * would flip the default between boots. An installed but logged-out agent fails visibly with its
 * own provider error instead.
 */
export function installedAgent(env: NodeJS.ProcessEnv = process.env): InstalledAgent {
  const provider = AUTO_AGENTS.find((id) => onPath(getHarness(id).binary, env));
  return provider ? { kind: 'agent', provider } : { kind: 'none' };
}
