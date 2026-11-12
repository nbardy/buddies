import assert from 'node:assert/strict';
import test from 'node:test';
import { toolContentPart } from '@unleashd/shared';
import { isCompletionOnlyToolUse } from '../src/turns/tool-format';

test('an oompa launch is an ordinary tool call; the swarm viewer is gone', () => {
  const command = 'env -u CLAUDECODE oompa swarm oompa/oompa.spark4.json';
  assert.equal(toolContentPart('shell', { command }).t, 'tool');
});

test('Codex completion-only shell events are suppressed', () => {
  assert.equal(
    isCompletionOnlyToolUse('shell', { command: 'ls -la', exit_code: 0 }, undefined),
    true
  );
  assert.equal(isCompletionOnlyToolUse('shell', { exit_code: 0 }, 'ls -la'), false);
  assert.equal(isCompletionOnlyToolUse('Bash', { exit_code: 0 }, undefined), false);
});
