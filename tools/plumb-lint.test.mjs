import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { lintPlumb } from './plumb-lint.mjs';

const doc = (body) => `# t\n\nprose outside the fence is ignored: goal X\n\n\`\`\`plumb\n${body}\n\`\`\`\n`;

test('each structural violation is reported once; a ❌ mechanism is a gap, not an error', () => {
  const { errors, gaps } = lintPlumb(
    doc(
      [
        'role owner | leader',
        'goal G1 has-it: x',
        '  by: the host',
        'goal G2 hidden: x  -- by: only inside a comment, so it does not count',
        'inv I1 gap: y',
        '  guard: ❌ to build',
        'inv G1 dup: z',
        '  guard: t',
        'act go(x) @leader @ownr',
        'act nobody(x)',
        'theorem T1: invented construct',
      ].join('\n')
    )
  );
  assert.deepEqual(errors, [
    'line 12: duplicate id G1 (first at line 7)',
    'line 16: not a Plumb construct: theorem T1: invented construct',
    'line 9: goal G2 has no by:',
    'line 14: act go names undeclared role @ownr',
    'line 15: act nobody names no @role',
  ]);
  assert.deepEqual(gaps, ['line 11: inv I1: ❌ to build']);
});

// The committed specs stay well-formed: a doc edit that drops a `by:`, invents a construct or
// names an undeclared role fails here, not in a later reader's head.
test('the committed Plumb specs lint with zero errors', () => {
  for (const file of ['docs/plumb.md', 'docs/expeditions-leader-design.md']) {
    const { errors, blocks } = lintPlumb(fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'));
    assert.equal(blocks, true, `${file} has plumb blocks`);
    assert.deepEqual(errors, [], file);
  }
});
