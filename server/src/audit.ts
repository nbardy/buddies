import { getHarness, listHarnesses, resolveBinaryAsync } from '@nbardy/agent-cli';

export interface AuditResult {
  name: string;
  binary: string;
  installed: boolean;
  path: string | null;
}

// Pattern: async-liveness (docs/patterns.md#async-liveness): the PATH walk runs
// off the event loop and in parallel, so boot never waits on it.
export async function auditLocalAgents(): Promise<AuditResult[]> {
  const results = await Promise.all(
    listHarnesses().map(async (name): Promise<AuditResult> => {
      const config = getHarness(name);
      try {
        const binPath = await resolveBinaryAsync(config.binary);
        return { name, binary: config.binary, installed: true, path: binPath };
      } catch {
        return { name, binary: config.binary, installed: false, path: null };
      }
    })
  );

  const available = results.filter((result) => result.installed);
  const unavailable = results.filter((result) => !result.installed);
  console.log(
    `[agents] ${available.length}/${results.length} available: ${available
      .map((result) => result.name)
      .join(', ')}`
  );
  if (unavailable.length > 0) {
    console.log(
      `[agents] unavailable until installed: ${unavailable
        .map((result) => `${result.name} (${result.binary})`)
        .join(', ')}`
    );
  }

  return results;
}
