#!/usr/bin/env node
// Structural checker for Plumb spec blocks (```plumb fences in markdown). The dialect and its
// rules: docs/plumb.md. It checks that the spec is well-formed, nothing more: every goal names
// its mechanism (`by:`), every invariant its enforcement (`guard:`), every act a declared role,
// IDs are unique, and no column-0 line invents a construct. `❌` mechanisms are gaps: reported,
// failed only under --strict.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const CONSTRUCT = /^(role|type|struct|state|goal|inv|act|on)\b|^\?|^--|^[}|]/;
const CLAUSE = /^\s+(by|guard|requires|ensures|else):\s*(.*)$/;
const REQUIRED = { goal: 'by', inv: 'guard' };

/** Plumb blocks of a markdown file: their body lines, each with its 1-based file line. */
function blocks(markdown) {
  const out = [];
  let open = null;
  markdown.split('\n').forEach((line, i) => {
    if (open === null && /^```plumb\s*$/.test(line)) open = [];
    else if (open !== null && /^```\s*$/.test(line)) {
      out.push(open);
      open = null;
    } else if (open !== null) open.push({ n: i + 1, text: line });
  });
  return out;
}

const stripComment = (s) => s.replace(/(^|\s)--(\s.*)?$/, '').trimEnd();

/** Lint one markdown document. Returns errors and gaps as `line N: message` strings. */
export function lintPlumb(markdown) {
  const errors = [];
  const gaps = [];
  const roles = new Set();
  const ids = new Map();
  const decls = [];
  const acts = [];
  const lines = blocks(markdown).flat();

  for (const { n, text } of lines) {
    const raw = stripComment(text);
    if (raw.trim() === '') continue;
    const clause = CLAUSE.exec(raw);
    if (clause) {
      const last = decls.at(-1);
      if (last) last.clauses[clause[1]] = { n, value: clause[2].trim() };
      continue;
    }
    if (/^\s/.test(raw)) continue; // body of a multi-line struct/type
    if (!CONSTRUCT.test(raw)) {
      errors.push(`line ${n}: not a Plumb construct: ${raw.slice(0, 60)}`);
      continue;
    }
    const role = /^role\s+(.+)$/.exec(raw);
    if (role) for (const r of role[1].split('|')) roles.add(r.trim());

    const claim = /^(goal|inv)\s+(\w+)\b/.exec(raw);
    const question = /^\?\s*(\w+):/.exec(raw);
    const id = claim?.[2] ?? question?.[1];
    if (id) {
      if (ids.has(id)) errors.push(`line ${n}: duplicate id ${id} (first at line ${ids.get(id)})`);
      else ids.set(id, n);
    }
    if (claim) {
      const inline = new RegExp(`\\b${REQUIRED[claim[1]]}:\\s*(.*)$`).exec(raw);
      const clauses = inline ? { [REQUIRED[claim[1]]]: { n, value: inline[1].trim() } } : {};
      decls.push({ kind: claim[1], id: claim[2], n, clauses });
      continue;
    }
    const act = /^act\s+(\w+)\s*\([^)]*\)(.*)$/.exec(raw);
    if (act) {
      acts.push({ name: act[1], n, who: [...act[2].matchAll(/@(\w+)/g)].map((m) => m[1]) });
      decls.push({ kind: 'act', id: act[1], n, clauses: {} });
      continue;
    }
    decls.push({ kind: 'other', n, clauses: {} });
  }

  for (const d of decls.filter((d) => d.kind in REQUIRED)) {
    const key = REQUIRED[d.kind];
    const c = d.clauses[key];
    if (!c || c.value === '') errors.push(`line ${d.n}: ${d.kind} ${d.id} has no ${key}:`);
    else if (c.value.startsWith('❌')) gaps.push(`line ${c.n}: ${d.kind} ${d.id}: ${c.value}`);
  }
  for (const a of acts) {
    if (a.who.length === 0) errors.push(`line ${a.n}: act ${a.name} names no @role`);
    for (const w of a.who.filter((w) => !roles.has(w)))
      errors.push(`line ${a.n}: act ${a.name} names undeclared role @${w}`);
  }
  return { errors, gaps, blocks: lines.length > 0 };
}

function main(argv) {
  const strict = argv.includes('--strict');
  const files = argv.filter((a) => !a.startsWith('--'));
  let failed = false;
  for (const file of files) {
    const { errors, gaps, blocks: has } = lintPlumb(fs.readFileSync(file, 'utf8'));
    if (!has) {
      console.error(`${file}: no plumb blocks`);
      failed = true;
      continue;
    }
    for (const e of errors) console.error(`${file}: ${e}`);
    for (const g of gaps) console.log(`${file}: gap ${g}`);
    console.log(`${file}: ${errors.length} errors, ${gaps.length} gaps`);
    if (errors.length > 0 || (strict && gaps.length > 0)) failed = true;
  }
  process.exit(failed ? 1 : 0);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main(process.argv.slice(2));
