/**
 * 只扩张不收缩纪律的机械断言（change cloud-schema-migration-executor 任务 7.4）。零数据库依赖。
 *
 * 判定标准（design.md D6，正文写在 migrations/README.md §5）：
 *   expand   = 旧版本代码在这条迁移之后**仍能**正常读写；
 *   contract = 旧版本代码在这条迁移之后**会坏**。
 *
 * 本用例只做一件事：标了 expand 的文件里 MUST NOT 出现收缩语句。命中即失败并提示改标 contract。
 * 判定 MUST 先剥注释 —— 迁移文件的注释里大量出现「本文件不做 DROP TABLE」这类说明文字，
 * 不剥注释会把说明当成语句，制造一堆假阳性，最后逼着人给用例加豁免、纪律就废了。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { loadMigrationFiles } from '../../src/schema/migration-files.js';
import { parseMigrationHeader, versionOf } from '../../src/schema/migration-plan.js';

/**
 * 收缩标记。MUST 与 scripts/generate-migration-headers.ts 的 CONTRACT_MARKERS 逐条一致，
 * 否则「生成时判 expand、校验时判 contract」会当场自相矛盾。
 *
 * 刻意不含 `DROP CONSTRAINT`：仓内既有的「先 DROP CONSTRAINT 再 ADD 一个更宽的 CHECK」是**放宽**，
 * 旧代码在其之后仍能正常读写，按 D6 属 expand。
 */
const CONTRACT_MARKERS: { label: string; re: RegExp }[] = [
  { label: 'DROP TABLE', re: /\bDROP\s+TABLE\b/i },
  { label: 'DROP COLUMN', re: /\bDROP\s+COLUMN\b/i },
  { label: 'DROP INDEX', re: /\bDROP\s+INDEX\b/i },
  { label: 'RENAME TO / RENAME COLUMN', re: /\bRENAME\s+(TO|COLUMN)\b/i },
  { label: 'ALTER COLUMN … TYPE（类型收窄）', re: /\bALTER\s+COLUMN\s+\w+\s+TYPE\b/i },
  { label: 'SET NOT NULL', re: /\bSET\s+NOT\s+NULL\b/i },
];

function stripSqlComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .split('\n')
    .map((l) => l.replace(/--.*$/, ''))
    .join('\n');
}

test('标为 expand 的迁移里没有收缩语句', async () => {
  const files = await loadMigrationFiles();
  const offenders: string[] = [];
  for (const file of files) {
    const { kind } = parseMigrationHeader(file.content);
    if (kind !== 'expand') continue;
    const sql = stripSqlComments(file.content);
    for (const marker of CONTRACT_MARKERS) {
      if (marker.re.test(sql)) offenders.push(`${versionOf(file.name)} 含 ${marker.label}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `以下迁移标了 expand 却含收缩语句，MUST 改标 -- aidcp:kind=contract 并按 D6 拆成独立 change 交付：\n${offenders.join('\n')}`,
  );
});

test('标为 contract 的迁移确实含收缩语句（避免把 expand 误标成 contract、白白吃掉一次显式授权）', async () => {
  const files = await loadMigrationFiles();
  const suspicious: string[] = [];
  for (const file of files) {
    const { kind } = parseMigrationHeader(file.content);
    if (kind !== 'contract') continue;
    const sql = stripSqlComments(file.content);
    if (!CONTRACT_MARKERS.some((m) => m.re.test(sql))) suspicious.push(versionOf(file.name));
  }
  assert.deepEqual(
    suspicious,
    [],
    `以下迁移标了 contract 却查不到任何收缩语句；误标会让空库拉起白白需要 --allow-contract：\n${suspicious.join('\n')}`,
  );
});
