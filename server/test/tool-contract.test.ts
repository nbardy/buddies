import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js';
import type { Role } from '../src/buddies/grants';
import { toolsFor } from '../src/buddies/mcp';

// Fix-guard: the Buddy MCP tool contract. Agent CLIs cache `tools/list` for a whole turn and an
// adopted turn outlives the backend that started it, so a turn keeps sending the inputs it was
// told about. 74d1fd3 reshaped `channel_read.read.search` from a string to {text, ...} and every
// search from an adopted turn failed validation (CEO feedback, 2026-10-06). Rule: inputs change
// only additively. The compatibility shims for the 2026-10-06 reshapes (search string, follow
// {until}, channel_create/channel_admin) were deleted once the longest adopted turn (24 h) had
// ended; a NEW reshape needs a shim again, with its own test. Decisions S4 + N: agent_notes/2026-10-06_buddies-target-system-review.md §3
// rule 6 and §4. Regenerate the snapshot with `UPDATE_TOOL_SNAPSHOT=1`.

const ROLES: readonly Role[] = ['worker', 'owner', 'reviewer', 'builder'];
const SNAPSHOT = join(__dirname, 'fixtures/tool-contracts/input-schemas.json');

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Obj = { [key: string]: Json };
type Snapshot = Record<string, Record<string, Json>>;

// The schema an MCP client is advertised: the SDK's own conversion, as `tools/list` runs it.
const advertised = (schema: unknown): Obj =>
  toJsonSchemaCompat(schema as never, { strictUnions: true, pipeStrategy: 'input' }) as Obj;

const withoutProse = (node: Json): Json => {
  if (Array.isArray(node)) return node.map(withoutProse);
  if (node === null || typeof node !== 'object') return node;
  return Object.fromEntries(
    Object.entries(node)
      .filter(([key]) => key !== 'description' && key !== '$schema')
      .map(([key, value]) => [key, withoutProse(value)])
  );
};

function currentSnapshot(): Snapshot {
  return Object.fromEntries(
    ROLES.map((role) => [
      role,
      Object.fromEntries(
        Object.entries(toolsFor(role))
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([name, tool]) => [name, withoutProse(advertised(tool.schema))])
      ),
    ])
  );
}

const isObj = (node: Json | undefined): node is Obj =>
  node !== null && typeof node === 'object' && !Array.isArray(node);
const asList = (node: Json | undefined): Json[] => (Array.isArray(node) ? node : []);

/** Paths where `next` stops accepting something `old` accepted. Empty = purely additive. */
function breakages(old: Json | undefined, next: Json | undefined, path: string): string[] {
  if (next === undefined) return [`${path}: removed`];
  if (!isObj(old) || !isObj(next)) {
    return JSON.stringify(old) === JSON.stringify(next) ? [] : [`${path}: changed`];
  }
  const out: string[] = [];
  for (const key of ['type', 'const', 'format', 'pattern']) {
    if (key in old && JSON.stringify(old[key]) !== JSON.stringify(next[key]))
      out.push(`${path}: ${key} changed`);
  }
  if (old.enum) {
    const kept = new Set(asList(next.enum).map((v) => JSON.stringify(v)));
    for (const value of asList(old.enum))
      if (!kept.has(JSON.stringify(value))) out.push(`${path}: enum lost ${JSON.stringify(value)}`);
  }
  for (const [bound, tighter] of [
    ['maxLength', (a: number, b: number) => b < a],
    ['maxItems', (a: number, b: number) => b < a],
    ['maximum', (a: number, b: number) => b < a],
    ['minLength', (a: number, b: number) => b > a],
    ['minItems', (a: number, b: number) => b > a],
    ['minimum', (a: number, b: number) => b > a],
  ] as const) {
    const was = old[bound];
    const now = next[bound];
    if (typeof was === 'number' && typeof now === 'number' && tighter(was, now))
      out.push(`${path}: ${bound} tightened ${was} -> ${now}`);
    if (typeof now === 'number' && was === undefined) out.push(`${path}: ${bound} added`);
  }
  const oldProps = isObj(old.properties) ? old.properties : {};
  const nextProps = isObj(next.properties) ? next.properties : {};
  for (const [name, schema] of Object.entries(oldProps))
    out.push(...breakages(schema, nextProps[name], `${path}.${name}`));
  const wasRequired = new Set(asList(old.required));
  for (const name of asList(next.required))
    if (!wasRequired.has(name)) out.push(`${path}: ${String(name)} became required`);
  if (old.items !== undefined) out.push(...breakages(old.items, next.items, `${path}[]`));
  if (old.additionalProperties === false && next.additionalProperties !== false) return out; // loosening is additive
  if (old.additionalProperties !== false && next.additionalProperties === false)
    out.push(`${path}: now rejects unknown fields`);
  for (const union of ['anyOf', 'oneOf'] as const) {
    if (!old[union]) continue;
    const variants = asList(next[union]);
    asList(old[union]).forEach((variant, index) => {
      // A variant survives if SOME advertised variant still accepts everything it did.
      const kept = variants.some((candidate) => breakages(variant, candidate, '').length === 0);
      if (!kept) out.push(`${path}.${union}[${index}]: no variant still accepts it`);
    });
  }
  return out;
}

function contractProblems(before: Snapshot, after: Snapshot): string[] {
  return ROLES.flatMap((role) =>
    Object.keys(before[role] ?? {}).flatMap((tool) =>
      breakages(before[role][tool], after[role]?.[tool], tool).map(
        (problem) => `${role}: ${problem}`
      )
    )
  );
}

test('tool input schemas change only additively; reshaped forms need a legacy canonicalizer', () => {
  const now = currentSnapshot();
  if (process.env.UPDATE_TOOL_SNAPSHOT === '1') {
    const before: Snapshot = existsSync(SNAPSHOT) ? JSON.parse(readFileSync(SNAPSHOT, 'utf8')) : {};
    const problems = contractProblems(before, now);
    assert.deepEqual(problems, [], 'refusing to snapshot a non-additive change');
    mkdirSync(dirname(SNAPSHOT), { recursive: true });
    writeFileSync(SNAPSHOT, `${JSON.stringify(now, null, 2)}\n`);
    return;
  }
  const committed: Snapshot = JSON.parse(readFileSync(SNAPSHOT, 'utf8'));
  assert.deepEqual(
    contractProblems(committed, now),
    [],
    'a tool input stopped accepting something it accepted. Adopted turns keep the tool list they ' +
      'started with. Keep the old form working with a canonicalizer and a test of its own'
  );
  // An additive change is allowed, but the snapshot must follow it or a later removal of the new
  // field would be compared against a stale baseline and slip through.
  assert.deepEqual(
    now,
    committed,
    'tool inputs changed additively: run `UPDATE_TOOL_SNAPSHOT=1 pnpm exec tsx --test ' +
      'server/test/tool-contract.test.ts` and commit server/test/fixtures/tool-contracts/'
  );
});

// Fix-guard: tool descriptions ride in every turn's context (the CEO feedback measured
// channel_read ~1,070 chars, runs 528, post 412; the worker total was 4,737). The budget counts
// what a client is actually shown: each tool description plus every nested `.describe()` text.
const WORKER_DESCRIPTION_BUDGET = 3000;

function describedChars(role: Role): number {
  const nested = (node: Json): number => {
    if (Array.isArray(node)) return node.reduce<number>((sum, item) => sum + nested(item), 0);
    if (node === null || typeof node !== 'object') return 0;
    return Object.entries(node).reduce(
      (sum, [key, value]) =>
        sum + (key === 'description' && typeof value === 'string' ? value.length : nested(value)),
      0
    );
  };
  return Object.values(toolsFor(role)).reduce(
    (sum, tool) => sum + tool.description.length + nested(advertised(tool.schema)),
    0
  );
}

test(`the worker role's tool descriptions total at most ${WORKER_DESCRIPTION_BUDGET} chars`, () => {
  const chars = describedChars('worker');
  assert.ok(
    chars <= WORKER_DESCRIPTION_BUDGET,
    `worker tool descriptions are ${chars} chars (budget ${WORKER_DESCRIPTION_BUDGET}). They are paid on every turn: keep each rule to one sentence, move detail into docs`
  );
});
