import { readFileSync } from 'node:fs';
import path from 'node:path';

// Brief and command rendering. A `{{slot}}` is filled from the call's item; a slot with no field,
// or a field that is not text or a number, is an issue naming the slot, never a blank.

export type Rendered = { t: 'ok'; text: string } | { t: 'invalid'; issues: string[] };

const SLOT = /\{\{\s*([^{}\s]+)\s*\}\}/g;

/** One pass, so a value containing `{{x}}` is never expanded a second time. */
function fillSlots(
  template: string,
  item: Readonly<Record<string, unknown>>,
  where: string
): Rendered {
  const issues: string[] = [];
  const text = template.replace(SLOT, (whole, slot: string) => {
    if (!Object.hasOwn(item, slot)) {
      issues.push(`${where}: slot {{${slot}}} has no matching field in the item`);
      return whole;
    }
    const value = item[slot];
    if (typeof value === 'string' || typeof value === 'number') return String(value);
    issues.push(`${where}: slot {{${slot}}} must be a string or number, got ${describe(value)}`);
    return whole;
  });
  return issues.length === 0 ? { t: 'ok', text } : { t: 'invalid', issues: [...new Set(issues)] };
}

const describe = (v: unknown): string =>
  v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;

/** The same slot rule for a command line. */
export function renderCommand(command: string, item: Readonly<Record<string, unknown>>): Rendered {
  return fillSlots(command, item, 'command');
}

/** `<folder>/briefs/<name>.md`, or an issue when `name` could leave the briefs directory. */
export function briefPath(
  folder: string,
  name: string
): { t: 'ok'; file: string } | { t: 'invalid'; issues: string[] } {
  if (name === '' || /[\\/\0]/.test(name) || name.includes('..')) {
    return {
      t: 'invalid',
      issues: [`brief name '${name}' must not be empty or contain '/', '\\' or '..'`],
    };
  }
  return { t: 'ok', file: path.join(folder, 'briefs', `${name}.md`) };
}

/** Shared wording, so the static gate and the renderer report a missing brief identically. */
export const missingBriefIssue = (name: string): string => `brief briefs/${name}.md not found`;

export function renderBrief(
  folder: string,
  name: string,
  item: Readonly<Record<string, unknown>>,
  rules: readonly string[]
): Rendered {
  const located = briefPath(folder, name);
  if (located.t === 'invalid') return located;
  let template: string;
  try {
    template = readFileSync(located.file, 'utf8');
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return {
      t: 'invalid',
      issues: [
        code === 'ENOENT'
          ? missingBriefIssue(name)
          : `brief briefs/${name}.md unreadable: ${(e as Error).message}`,
      ],
    };
  }
  const filled = fillSlots(template, item, `briefs/${name}.md`);
  if (filled.t === 'invalid') return filled;
  return { t: 'ok', text: `${filled.text.trimEnd()}\n\n${rulesSection(rules)}` };
}

const rulesSection = (rules: readonly string[]): string =>
  `---\n\n## Rules from the contract\n\n${rules.map((r) => `- ${r}`).join('\n')}\n`;
