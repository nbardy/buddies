import { join } from 'node:path';
import { mergePath } from './login-path';

export interface ServerEnvInput {
  inherited: Record<string, string | undefined>;
  nodeBin: string;
  loginPath: string;
  port: number;
  dataDir: string;
  buddiesHome: string;
}

/** The environment the bundled server runs with. One function, so the test checks what ships. */
export function serverEnv(input: ServerEnvInput): Record<string, string | undefined> {
  return {
    ...input.inherited,
    PATH: mergePath(input.nodeBin, input.loginPath),
    // A packaged app never builds from source, so Rust is not a prerequisite: the server
    // neither probes nor installs it (UNLEASHD_SOURCE_BUILDS, dependencies.ts).
    UNLEASHD_SOURCE_BUILDS: '0',
    NODE_ENV: 'production',
    PORT: String(input.port),
    UNLEASHD_HOST: '127.0.0.1',
    UNLEASHD_DATA_DIR: input.dataDir,
    BUDDIES_HOME: input.buddiesHome,
    UNLEASHD_BUDDIES_DB: join(input.buddiesHome, 'buddies-v3.sqlite'),
    // Fix-guard: these stores sit outside ~/.buddies and ~/.agent-viewer, which the
    // copied-store gate (server/src/buddies/execution-gate.ts) reads as a COPY and disables
    // Buddy execution, so no DM in the app would ever get a reply (caught 2026-10-05 before
    // the first release). They are the app's own authoritative stores: opt in.
    // Guard: desktop/test/server-env.test.ts.
    UNLEASHD_BUDDY_EXECUTION: '1',
  };
}
