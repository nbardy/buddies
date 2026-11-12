import type { ContentPart } from './content-schema.js';

function normalizeLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function commandFromDisplayText(name: string, displayText?: string): string | null {
  if (typeof displayText !== 'string') return null;
  const text = normalizeLine(displayText);
  if (!text) return null;

  const lower = text.toLowerCase();
  const nameLower = name.toLowerCase();
  if (lower === nameLower || lower === `${nameLower}:`) return null;
  if (lower.startsWith(`${nameLower}:`)) {
    const suffix = text.slice(name.length + 1).trim();
    return suffix || null;
  }
  return text;
}

/** Classify a provider tool once, at live or historical ingress. */
export function toolContentPart(
  name: string,
  input?: unknown,
  displayText?: string,
  status?: string
): ContentPart {
  return {
    t: 'tool',
    name,
    ...(input === undefined ? {} : { input }),
    ...(displayText === undefined ? {} : { displayText }),
    ...(status === undefined ? {} : { status }),
  };
}
