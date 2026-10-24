/**
 * Capture a CPU profile of the RUNNING backend.
 *
 *   pnpm perf:profile                # 10 s
 *   pnpm perf:profile --ms 20000
 *
 * Calls POST /api/debug/profile with the server's own token (same resolution as
 * tools/screenshots.mjs), prints the .cpuprofile path. Start the slow action in the
 * app while it samples. Open the file in Chrome DevTools (Performance > Load profile).
 */
import { resolveAuthToken } from './lib/headless-chrome.mjs';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const index = args.indexOf('--ms');
  const ms = index >= 0 ? Number.parseInt(args[index + 1] ?? '', 10) : 10_000;
  const port = process.env.PORT ?? (process.env.NODE_ENV === 'development' ? '7499' : '7489');
  const baseUrl = process.env.UNLEASHD_API_URL?.trim() || `http://127.0.0.1:${port}`;
  const token = resolveAuthToken();
  const response = await fetch(`${baseUrl}/api/debug/profile?ms=${ms}`, {
    method: 'POST',
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`Profile failed (${response.status}): ${body}`);
  process.stdout.write(`${body}\n`);
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
