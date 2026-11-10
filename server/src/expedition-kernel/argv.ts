// A command string → argv, without a shell. Plans write commands as one string; the host runs them
// with execve semantics (checks.ts), so nothing a shell would do happens: no pipes, no `&&`, no
// redirection, no expansion. This parser is the one place that rule lives. It honours what a reader
// expects of a command line (whitespace splits words; '…' is literal; "…" is literal except
// `\"` and `\\`; a backslash outside quotes takes the next character literally) and refuses every
// character a shell would have treated specially, so a command never silently means something
// other than what its author read. The static gate (gates.ts) refuses at plan time; the executor
// parses again at run time (a log written before the gate existed still gets a typed error).

export type Parsed =
  | { readonly t: 'argv'; readonly argv: readonly [string, ...string[]] }
  | { readonly t: 'refused'; readonly why: string };

/** Outside quotes, each of these would be shell syntax. */
const SHELL_SYNTAX: ReadonlyMap<string, string> = new Map([
  ['|', 'a pipe'],
  ['&', 'a background or `&&` operator'],
  [';', 'a command separator'],
  ['<', 'a redirection'],
  ['>', 'a redirection'],
  ['(', 'a subshell'],
  [')', 'a subshell'],
  ['`', 'command substitution'],
  ['$', 'expansion'],
  ['*', 'a glob'],
  ['?', 'a glob'],
  ['[', 'a glob'],
  ['\n', 'a second command line'],
]);
/** Inside double quotes a shell still expands these. */
const EXPANDS_IN_DOUBLE_QUOTES: ReadonlyMap<string, string> = new Map([
  ['`', 'command substitution'],
  ['$', 'expansion'],
]);
/** Special only at the start of a word. */
const WORD_START: ReadonlyMap<string, string> = new Map([
  ['~', 'home expansion'],
  ['#', 'a comment'],
]);

type Mode = 'plain' | 'single' | 'double';

export function parseCommand(command: string): Parsed {
  const refuse = (why: string): Parsed => ({
    t: 'refused',
    why: `command ${JSON.stringify(command)}: ${why} (commands run without a shell)`,
  });
  const words: string[] = [];
  let word = '';
  /** A word has started, even an empty one (`''`). */
  let inWord = false;
  let mode: Mode = 'plain';
  for (let i = 0; i < command.length; i++) {
    const c = command[i] as string;
    if (mode === 'single') {
      if (c === "'") mode = 'plain';
      else word += c;
      continue;
    }
    if (mode === 'double') {
      const special = EXPANDS_IN_DOUBLE_QUOTES.get(c);
      if (special) return refuse(`\`${c}\` inside double quotes is ${special}`);
      if (c === '"') mode = 'plain';
      else if (c === '\\' && (command[i + 1] === '"' || command[i + 1] === '\\'))
        word += command[++i];
      else word += c;
      continue;
    }
    if (c === ' ' || c === '\t') {
      if (inWord) words.push(word);
      word = '';
      inWord = false;
      continue;
    }
    const start = WORD_START.get(c);
    if (start && !inWord) return refuse(`\`${c}\` at the start of a word is ${start}`);
    const special = SHELL_SYNTAX.get(c);
    if (special) return refuse(`\`${c === '\n' ? '\\n' : c}\` is ${special}`);
    inWord = true;
    if (c === "'") mode = 'single';
    else if (c === '"') mode = 'double';
    else if (c === '\\') {
      const next = command[i + 1];
      if (next === undefined) return refuse('it ends in a lone backslash');
      word += next;
      i++;
    } else word += c;
  }
  if (mode !== 'plain') return refuse(`an unterminated ${mode === 'single' ? "'" : '"'} quote`);
  if (inWord) words.push(word);
  const [bin, ...args] = words;
  if (bin === undefined) return refuse('it is empty');
  return { t: 'argv', argv: [bin, ...args] };
}
