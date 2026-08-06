#!/usr/bin/env node
// codemod-repoint.mjs <cloudRepoRoot> [--dry] <file.ts> [...]
// (change invert-split-fact-source, cutover task 5.3 — pilot-validated version)
//
// Rewrites relative src/** import specifiers in test files to owner aliases
// (@api/@automation/@content/@kernel). composition-owned and UNMAPPED targets are
// reported, never rewritten (they are the 5.6/P5 adjudication lists). Runtime
// data reads via `new URL('../../src/...')` are named so a human routes them
// through test/helpers/sibling-repos.ts.
// Owner lookup = boundaries/module-ownership.json (frozen historical record,
// path unchanged after the flip).
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';

const args = process.argv.slice(2).filter((a) => a !== '--dry');
const dry = process.argv.includes('--dry');
const ROOT = args[0];
const ownership = JSON.parse(readFileSync(join(ROOT, 'boundaries/module-ownership.json'), 'utf8'));
const ownerOf = new Map(ownership.map((e) => [e.path, e.layer]));
const SPEC_RE = /((?:from\s+|import\s*\(\s*|require\s*\(\s*|import\s+)['"])(\.[^'"]+)(['"])/g;

for (const file of args.slice(1)) {
  const abs = resolve(file);
  const text = readFileSync(abs, 'utf8');
  const notes = [];
  const out = text.replace(SPEC_RE, (whole, pre, spec, post) => {
    const rel = relative(ROOT, resolve(dirname(abs), spec));
    if (!rel.startsWith('src/')) return whole;
    const owner = ownerOf.get(rel.replace(/\.js$/, '.ts'));
    if (!owner) { notes.push(`UNMAPPED ${rel}`); return whole; }
    if (owner === 'composition') { notes.push(`COMPOSITION ${rel} — 5.6 名单，人工处置`); return whole; }
    const under = rel.replace(/^src\//, '').replace(/\.ts$/, '.js');
    notes.push(`${spec} -> @${owner}/${under}`);
    return `${pre}@${owner}/${under}${post}`;
  });
  for (const m of text.matchAll(/new URL\(\s*[`'"](\.\.\/)+(src\/[^'"`]+)/g))
    notes.push(`DATA-READ ${m[2]} — 改经 test/helpers/sibling-repos.ts`);
  console.log(`== ${relative(ROOT, abs)}`);
  notes.forEach((n) => console.log('   ' + n));
  if (!dry && out !== text) writeFileSync(abs, out);
}
