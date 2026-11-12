import { commandFromDisplayText } from '@unleashd/shared';

const CLAUDE_SUBAGENT_TOOL_NAMES = new Set(['Agent', 'Task']);

const TOOL_SUMMARY_MAX_LEN = 100;
const SHELL_TOOL_NAMES = new Set(['Bash', 'run_shell_command', 'shell']);

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object') return value as Record<string, unknown>;
  return null;
}

function normalizeLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function truncate(value: string, maxLen: number): string {
  if (value.length <= maxLen) return value;
  return `${value.slice(0, maxLen - 3)}...`;
}

// Claude Code names and the other harnesses' names for the same tools.
const TOOL_EMOJI = new Map<string, string>([
  ...['Bash', 'shell', 'run_shell_command'].map((n) => [n, '⚡'] as const),
  ...['Read', 'read_file'].map((n) => [n, '📖'] as const),
  ...['Write', 'write_file'].map((n) => [n, '✍️'] as const),
  ...['Edit', 'replace'].map((n) => [n, '✏️'] as const),
  ...['Glob', 'glob', 'list_directory'].map((n) => [n, '📂'] as const),
  ...['Grep', 'WebSearch', 'grep_search'].map((n) => [n, '🔍'] as const),
  ...['WebFetch', 'web_fetch'].map((n) => [n, '🌐'] as const),
  ...[...CLAUDE_SUBAGENT_TOOL_NAMES].map((n) => [n, '▶️'] as const),
  ...['NotebookRead', 'NotebookEdit', 'code_execution'].map((n) => [n, '📓'] as const),
  ['TodoWrite', '📝'],
  ['patch', '🔀'],
]);

// The input field that summarizes a tool: its own field first, then the generic ones in order.
const NAMED_ARG = new Map<string, string>([
  ...[...CLAUDE_SUBAGENT_TOOL_NAMES].map((n) => [n, 'description'] as const),
  ['WebFetch', 'url'],
  ['WebSearch', 'query'],
]);
const GENERIC_ARGS = ['file_path', 'notebook_path', 'pattern', 'path', 'dir_path', 'query'];

function argSummaryOf(name: string, record: Record<string, unknown>): string {
  const command =
    (typeof record.command === 'string' && record.command) ||
    (typeof record.cmd === 'string' && record.cmd) ||
    null;
  if (SHELL_TOOL_NAMES.has(name) && command) return normalizeLine(command);
  const named = NAMED_ARG.get(name);
  for (const field of named ? [named, ...GENERIC_ARGS] : GENERIC_ARGS) {
    const value = record[field];
    if (typeof value === 'string') return value;
  }
  return '';
}

export function formatToolUse(name: string, input?: unknown, displayText?: string): string {
  const emoji = TOOL_EMOJI.get(name) ?? '🔧';
  const record = asRecord(input);
  let argSummary = record ? argSummaryOf(name, record) : '';
  if (!argSummary && SHELL_TOOL_NAMES.has(name)) {
    const fallbackCommand = commandFromDisplayText(name, displayText);
    if (fallbackCommand) argSummary = normalizeLine(fallbackCommand);
  }

  if (argSummary) {
    argSummary = truncate(argSummary, TOOL_SUMMARY_MAX_LEN);
  }

  return `${emoji} ${name}${argSummary ? ` ${argSummary}` : ''}`;
}

/** Compact freeform exec label; the full script is rendered below it. */
export function freeformExecPreview(name: string, input?: unknown): string | null {
  if (!['exec', 'functions.exec'].includes(name) || typeof input !== 'string') return null;
  const preview = input.replace(/\s+/g, ' ').trim();
  if (!preview) return null;
  return preview.length > 120 ? `${preview.slice(0, 119)}…` : preview;
}
