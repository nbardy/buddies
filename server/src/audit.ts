import { getHarness, listHarnesses, resolveBinary } from '@nbardy/agent-cli';

export interface AuditResult {
  name: string;
  binary: string;
  installed: boolean;
  path: string | null;
}

// resolveBinary is a PATH walk of access/stat calls (no `which` subprocess since agent-cli
// ef964ef), so the audit is cheap synchronous work and needs no async twin.
export async function auditLocalAgents(): Promise<AuditResult[]> {
  const results = await Promise.all(
    listHarnesses().map(async (name): Promise<AuditResult> => {
      const config = getHarness(name);
      try {
        const binPath = resolveBinary(config.binary);
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
