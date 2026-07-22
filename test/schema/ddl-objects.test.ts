/**
 * DDL 文本解析口径（change cloud-schema-migration-executor 第 3 / 5 节共用的 src/schema/ddl-objects.ts）。
 * 零数据库依赖。
 *
 * 这一层的假阴性代价特别高：它同时是
 *   ① `migrate verify` 头声明的生成来源（scripts/generate-migration-headers.ts），
 *   ② 存储 `init()` 探测「要求什么」的来源（src/schema/schema-capability.ts）。
 * 少解析出一列 → verify 永远报不出它缺失（而缺失清单是 baseline 唯一的准入闸），
 * 且探测会在一个真的缺这列的库上返回 ready。正是本模块自己禁止的那类静默假成功。
 */

import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

import { extractCreatedObjects, findAddedColumns } from '../../src/schema/ddl-objects.js';
import { repoRoot, stripComments } from '../../src/schema/ddl-scan.js';

test('多子句 ALTER TABLE 的每一列都被解析出来（不是只认第一列）', () => {
  const sql = `
    ALTER TABLE zz_t
      ADD COLUMN IF NOT EXISTS a CHAR(64),
      ADD COLUMN IF NOT EXISTS b TEXT,
      ADD COLUMN IF NOT EXISTS c TIMESTAMPTZ;
  `;
  const objects = extractCreatedObjects(sql);
  assert.deepEqual([...(objects.tables.get('zz_t') ?? [])].sort(), ['a', 'b', 'c']);
});

test('语句边界不串味：两条 ALTER 各自归各自的表', () => {
  const added = findAddedColumns(stripComments('ALTER TABLE t1 ADD COLUMN a INT; ALTER TABLE t2 ADD COLUMN b INT;'));
  assert.deepEqual(added.map((x) => `${x.table}.${x.column}`), ['t1.a', 't2.b']);
});

async function collectSql(dir: string, ext: string, out: string[] = []): Promise<string[]> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      await collectSql(full, ext, out);
    } else if (entry.isFile() && entry.name.endsWith(ext)) out.push(full);
  }
  return out;
}

/**
 * 真实语料上的解析完整性：仓内每一处 `ADD COLUMN` 都要被解析出来。
 * 这条断言就是当初漏掉 0041 / 0049 那 4 列的直接判据。
 */
test('migrations/ 与 src/ 里的每一处 ADD COLUMN 都被解析出来', async () => {
  const gaps: string[] = [];
  for (const [dir, ext] of [['migrations', '.sql'], ['src', '.ts']] as const) {
    for (const file of (await collectSql(path.join(repoRoot(), dir), ext)).sort()) {
      const sql = stripComments(await readFile(file, 'utf8'));
      const raw = sql.match(/\bADD\s+COLUMN\b/gi)?.length ?? 0;
      const parsed = findAddedColumns(sql).length;
      if (raw !== parsed) gaps.push(`${path.relative(repoRoot(), file)}：文本 ${raw} 处、解析出 ${parsed} 处`);
    }
  }
  assert.deepEqual(gaps, [], `下列文件的加列没被解析全，verify 与运行时探测都会对漏掉的列睁眼瞎：\n${gaps.join('\n')}`);
});
