/**
 * 从 boundaries/table-ownership.json 生成 scripts/db-split/owner-tables.<owner>.txt。
 *
 * 为什么要落成 .txt：物理拆库的拷数据脚本（0077）跑在 ECS 上、用的是 bash + psql，
 * 不应该在那里现算属主映射（会引入第二套判据）。属主判据**唯一来源**是
 * boundaries/table-ownership.json；这里只是把它投影成 bash 能直接读的行格式。
 *
 * 漂移防护：test/acceptance/db-split-owner-table-lists.test.ts 断言这三个 .txt
 * 与 boundaries/table-ownership.json 逐字一致，改了属主却忘了重生成会当场红。
 *
 * 用法：npx tsx scripts/db-split/generate-owner-table-lists.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');

export interface OwnerTableLists {
  readonly [owner: string]: readonly string[];
}

export function ownerTableListsFromOwnership(ownershipJson: string): OwnerTableLists {
  const parsed = JSON.parse(ownershipJson) as { tables: { table: string; owner: string }[] };
  const grouped = new Map<string, string[]>();
  for (const row of parsed.tables) {
    const bucket = grouped.get(row.owner) ?? [];
    bucket.push(row.table);
    grouped.set(row.owner, bucket);
  }
  const out: Record<string, string[]> = {};
  for (const [owner, tables] of grouped) out[owner] = [...tables].sort();
  return out;
}

export function renderOwnerTableList(owner: string, tables: readonly string[]): string {
  return [
    '# generated from boundaries/table-ownership.json — DO NOT EDIT BY HAND',
    '# regenerate: npx tsx scripts/db-split/generate-owner-table-lists.ts',
    `# owner=${owner} count=${tables.length}`,
    ...tables,
    '',
  ].join('\n');
}

export function ownerTableListPath(owner: string, root = repoRoot): string {
  return join(root, 'scripts', 'db-split', `owner-tables.${owner}.txt`);
}

export function parseOwnerTableList(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const ownership = readFileSync(join(repoRoot, 'boundaries', 'table-ownership.json'), 'utf8');
  const lists = ownerTableListsFromOwnership(ownership);
  for (const owner of Object.keys(lists).sort()) {
    const path = ownerTableListPath(owner);
    writeFileSync(path, renderOwnerTableList(owner, lists[owner]!), 'utf8');
    console.log(`${owner}: ${lists[owner]!.length} tables -> ${path}`);
  }
}
