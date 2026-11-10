/**
 * The dev runtime's two ports: Vite (the client) and the backend it proxies to. Defaults are the
 * owner's 7489/7499; UNLEASHD_DEV_CLIENT_PORT / UNLEASHD_DEV_API_PORT move a second runtime (an
 * agent worktree proving a dev change) beside the live one. Read by server.ts and
 * client/vite.config.ts; tools/dev-supervisor.mjs mirrors it (plain .mjs, it cannot import TS).
 * An unparseable value is an error, never a silent fall back to the live ports.
 */
export function devPorts(env: NodeJS.ProcessEnv = process.env): { client: number; api: number } {
  return {
    client: port(env, 'UNLEASHD_DEV_CLIENT_PORT', 7489),
    api: port(env, 'UNLEASHD_DEV_API_PORT', 7499),
  };
}

function port(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`${name} must be a TCP port (1-65535), got "${raw}"`);
  }
  return value;
}
