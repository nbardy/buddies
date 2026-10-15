import { type ExecFileException, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { WorkspaceInput } from '@unleashd/buddies-core';

const exec = promisify(execFile);

// Pattern: parse-dont-validate (docs/patterns.md#parse-dont-validate)
// Startup and owner registration share Git history plus repo-relative folder identity.
export async function workspaceRegistration(input: {
  name: string;
  rootPath: string;
}): Promise<WorkspaceInput> {
  try {
    const options = { cwd: input.rootPath, timeout: 10_000, maxBuffer: 1024 * 1024 };
    const [{ stdout: roots }, { stdout: prefix }] = await Promise.all([
      exec('git', ['rev-list', '--max-parents=0', 'HEAD'], options),
      exec('git', ['rev-parse', '--show-prefix'], options),
    ]);
    return {
      ...input,
      repositoryIdentity: JSON.stringify([roots.trim().split('\n').sort(), prefix.trim()]),
    };
  } catch (error) {
    const failure = error as ExecFileException & { stderr?: string };
    // Only absent Git/history falls back to path identity; an operational failure must not
    // turn a renamed checkout into a second workspace.
    if (
      failure.code === 'ENOENT' ||
      (failure.code === 128 &&
        /not a git repository|ambiguous argument 'HEAD'|bad revision 'HEAD'/.test(
          failure.stderr ?? ''
        ))
    )
      return input;
    throw error;
  }
}
