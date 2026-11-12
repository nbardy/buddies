// Run 3 lost a valid final JSON answer after prose. Scan complete top-level values only.
// Guard: expedition-small answer parsing; truncated containers never yield a nested answer.
const JSON_FENCE = /```json[^\S\n]*\n([\s\S]*?)\n?```/g;

/** Last fenced JSON block, else the final message as JSON, else its last complete JSON value. */
export function answerValue(body: string): unknown {
  let last: string | undefined;
  for (const m of body.matchAll(JSON_FENCE)) last = m[1];
  if (last !== undefined) return JSON.parse(last.trim());
  try {
    return JSON.parse(body.trim());
  } catch {
    // Run 3's Codex final was valid bare JSON after prose. Scan complete top-level values,
    // skipping whole containers/strings so nested values cannot become accidental answers.
    // Guard: expeditions-v1-executor, exact run-3 answer shapes and truncated containers.
    let found: { value: unknown } | undefined;
    for (let i = 0; i < body.length; i++) {
      const start = i;
      const ch = body[i];
      if (i > 0 && /[\w]/.test(body[i - 1])) continue;
      if (ch === '{' || ch === '[' || ch === '"') {
        const stack: string[] = ch === '"' ? [] : [ch === '{' ? '}' : ']'];
        let quoted = ch === '"';
        let escaped = false;
        for (i++; i < body.length; i++) {
          const c = body[i];
          if (quoted) {
            if (escaped) escaped = false;
            else if (c === '\\') escaped = true;
            else if (c === '"') {
              quoted = false;
              if (stack.length === 0) break;
            }
          } else if (c === '"') quoted = true;
          else if (c === '{' || c === '[') stack.push(c === '{' ? '}' : ']');
          else if (c === '}' || c === ']') {
            if (c !== stack.pop()) break;
            if (stack.length === 0) break;
          }
        }
      } else {
        const token =
          /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)(?![\w.])/.exec(
            body.slice(i)
          );
        if (!token) continue;
        i += token[0].length - 1;
      }
      try {
        found = { value: JSON.parse(body.slice(start, i + 1)) };
      } catch {}
    }
    if (found) return found.value;
    throw new Error('no complete JSON value');
  }
}
