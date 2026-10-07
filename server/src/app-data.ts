import os from 'node:os';
import path from 'node:path';

// One derivation of the app data root. (Buddy tools now run in this process,
// on the HTTP MCP endpoint, so no child needs it passed down any more.)
export const APP_DATA_DIR_ENV = 'UNLEASHD_DATA_DIR';

export function appDataDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(env[APP_DATA_DIR_ENV] ?? path.join(os.homedir(), '.agent-viewer'));
}

export function uploadsDirectory(): string {
  return path.join(appDataDirectory(), 'uploads');
}
