import type { Provider } from '@unleashd/shared';

/**
 * A Buddy's memory is its Buddy docs, never the harness's own. Claude Code loads
 * `~/.claude/projects/<cwd>/memory/MEMORY.md` into every session in that cwd and lets the model
 * write beside it, so Buddy turns in a workspace read the owner's interactive-session notes and
 * wrote stale Buddy facts there (six notes, found 2026-09-28; owner approved turning it off:
 * agent_notes/2026-09-28_buddy-worker-spawn-gap.md). Claude 2.1.283 reads `autoMemoryEnabled`
 * from `--settings` (flagSettings, above user settings), even under `--setting-sources ''`.
 * Only Claude is known to load cwd-keyed memory; give a harness args here when it grows one.
 * Guard: buddies-v2 "Buddy turns run with harness auto-memory off; an owner chat keeps it".
 */
export const CLAUDE_MEMORY_OFF = { autoMemoryEnabled: false } as const;

export const HARNESS_MEMORY_OFF: Record<Provider, readonly string[]> = {
  claude: ['--settings', JSON.stringify(CLAUDE_MEMORY_OFF)],
  codex: [],
  opencode: [],
  gemini: [],
  cursor: [],
  muse: [],
};
