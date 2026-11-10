import assert from 'node:assert/strict';
import test from 'node:test';
import { outcomeOf } from './lib/diagnostics.mjs';
import { crossCheck } from './typecheck.mjs';

// tsrs, an experimental port of TypeScript, is the default checker (2026-11-11). CI runs it and
// tsc 7 side by side; this comparison is the only thing standing between a tsrs regression and a
// type error that silently stops being reported. Fed outputs here, no compiler runs.
const A = "src/a.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.";
const B = "src/b.ts(4,1): error TS2304: Cannot find name 'missing'.";
const C = [
  "src/c.ts(9,3): error TS2345: Argument of type '{ x: number; }' is not assignable to parameter of type 'Point'.",
  "  Property 'y' is missing in type '{ x: number; }' but required in type 'Point'.",
].join('\n');
const run = (label, code, text, signal = null) => ({
  label,
  outcome: outcomeOf({ code, signal, text }),
});

test('the same diagnostics in another order, with other exit codes, agree', () => {
  // tsc 7.0 exits 1 on type errors, tsrs exits 2; neither code is a divergence.
  const verdict = crossCheck(
    run('tsrs', 2, `${B}\n${C}\n${A}\n`),
    run('tsc', 1, `${A}\n${B}\n${C}\n`)
  );
  assert.equal(verdict.kind, 'agree');
});

test('a diagnostic only one checker reports is a divergence, named with its side', () => {
  const verdict = crossCheck(run('tsrs', 2, `${A}\n`), run('tsc', 1, `${A}\n${B}\n`));
  assert.equal(verdict.kind, 'diverge');
  assert.deepEqual(verdict.lines, [`only tsc:  ${B}`]);
});

test('a differing continuation line of a multi-line diagnostic is a divergence', () => {
  const reworded = C.replace("Property 'y'", "Property 'z'");
  const verdict = crossCheck(run('tsrs', 2, reworded), run('tsc', 1, C));
  assert.equal(verdict.kind, 'diverge');
  assert.equal(verdict.lines.length, 2);
});

test('tsrs clean where tsc fails is a divergence, not a pass', () => {
  const verdict = crossCheck(run('tsrs', 0, ''), run('tsc', 1, `${A}\n`));
  assert.equal(verdict.kind, 'diverge');
});

test('a checker that could not run never agrees, even with an empty output on both sides', () => {
  const missing = run('tsrs', 1, "Error: Cannot find module 'tsrs/package.json'");
  assert.equal(missing.outcome.kind, 'broken');
  assert.equal(crossCheck(missing, run('tsc', 0, '')).kind, 'diverge');
  assert.equal(run('tsrs', null, '', 'SIGSEGV').outcome.kind, 'broken');
  assert.equal(run('tsrs', 1, 'error: unknown option --fasst').outcome.kind, 'broken');
});
