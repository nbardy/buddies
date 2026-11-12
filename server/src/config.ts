/**
 * workingDirectory ignore matcher — patterns come from the existing
 * ~/.agent-viewer/settings.json `ignore` field (see Settings in server.ts).
 *
 * Pattern semantics:
 *   - No "*" in pattern  → prefix match (startsWith)
 *   - Contains "*"       → glob match (anchored ^...$, "*" → ".*")
 *
 * Patterns are matched against a discovered session's working directory in server.ts so
 * ignored sessions never become conversations.
 *
 * server.ts calls setIgnorePatterns() once settings are loaded and reads the compiled set via
 * shouldIgnoreWorkingDirectory().
 */

interface CompiledIgnore {
  raw: string;
  test: (workingDirectory: string) => boolean;
}

let compiledIgnores: CompiledIgnore[] = [];

function compilePattern(pattern: string): CompiledIgnore {
  if (!pattern.includes('*')) {
    return { raw: pattern, test: (cwd) => cwd.startsWith(pattern) };
  }
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^${escaped.replace(/\*/g, '.*')}$`);
  return { raw: pattern, test: (cwd) => re.test(cwd) };
}

export function setIgnorePatterns(patterns: readonly string[]): void {
  const valid = patterns.filter((p) => typeof p === 'string' && p.length > 0);
  compiledIgnores = valid.map(compilePattern);
  console.log(`Ignore patterns active: ${compiledIgnores.length}`);
}

export function shouldIgnoreWorkingDirectory(workingDirectory: string): boolean {
  if (compiledIgnores.length === 0) return false;
  return compiledIgnores.some((p) => p.test(workingDirectory));
}
