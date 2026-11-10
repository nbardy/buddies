// What a TypeScript checker said, as data: parse a run's output into outcomes and diagnostics, and
// compare two checkers' diagnostics. Pure functions, so the comparison that guards tsrs against
// diverging from TypeScript is testable without running a compiler (tools/diagnostics.test.mjs).

const DIAGNOSTIC = /\berror TS\d+:/;

/**
 * The diagnostics in a checker's output: one entry per diagnostic (its first line plus any
 * indented continuation lines), trimmed, de-duplicated and sorted, so two checkers that report
 * the same errors in a different order compare equal.
 */
export function diagnosticsOf(text) {
  const entries = text
    .split(/\r?\n(?=\S)/)
    .map((entry) => entry.trimEnd())
    .filter((entry) => DIAGNOSTIC.test(entry));
  return [...new Set(entries)].sort();
}

/**
 * Outcome = Clean ⊕ Diagnostics(entries) ⊕ Broken(reason): what one checker run means.
 * A non-zero exit WITH diagnostics is a type failure (tsc 7.0 exits 1, tsrs and tsc 7.1 exit 2);
 * a non-zero exit or signal with none means the checker itself could not run (missing binary,
 * crash, an option it does not know).
 */
export function outcomeOf({ code, signal, text }) {
  if (signal) return { kind: 'broken', reason: `killed by ${signal}` };
  if (code === 0) return { kind: 'clean' };
  const entries = diagnosticsOf(text);
  if (entries.length > 0) return { kind: 'diagnostics', entries };
  const last = text.trim().split('\n').at(-1) ?? '';
  return { kind: 'broken', reason: `exit ${code}${last ? `: ${last}` : ' with no output'}` };
}

/**
 * Two checkers' diagnostics for the same project. Same ⊕ Differ({onlyLeft, onlyRight}).
 * Broken outcomes are not comparable and are reported by the caller, never treated as equal.
 */
export function compareDiagnostics(left, right) {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  const onlyLeft = left.filter((entry) => !rightSet.has(entry));
  const onlyRight = right.filter((entry) => !leftSet.has(entry));
  return onlyLeft.length === 0 && onlyRight.length === 0
    ? { kind: 'same' }
    : { kind: 'differ', onlyLeft, onlyRight };
}
