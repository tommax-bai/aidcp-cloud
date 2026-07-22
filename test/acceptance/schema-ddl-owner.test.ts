/**
 * AC-SCHEMA-DDL-OWNER — DDL 单一所有者的机械闸（change cloud-schema-migration-executor 任务 4.1–4.3）。
 *
 * 与 AC-PROTO-* / AC-PUB-* / AC-RISK-* 同级的红线用例：`src/` 下的运行时建表 / 改表 / 建索引
 * 只能越来越少，MUST NOT 越来越多。新增 DDL 的正确落点是 migrations/。
 *
 * 允许清单是 test/schema/runtime-ddl-allowlist.json，由 scripts/generate-ddl-allowlist.ts 生成；
 * 那个脚本只在「收口了一批存储、条目变少」之后跑，绝不是「测试红了就跑一下」的自动登记器。
 *
 * 清单的键不含行号：行号随无关编辑漂移，带行号的清单每次改代码都要重刷，很快就没人认真看了。
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

import { repoRoot, scanRuntimeDdl, stableKey } from '../../src/schema/ddl-scan.js';

interface Allowlist {
  baseline: { textHits: number; effectiveHits: number; files: number };
  entries: Record<string, Record<string, number>>;
}

async function readAllowlist(): Promise<Allowlist> {
  const file = path.join(repoRoot(), 'test', 'schema', 'runtime-ddl-allowlist.json');
  return JSON.parse(await readFile(file, 'utf8')) as Allowlist;
}

test('AC-SCHEMA-DDL-OWNER-01 运行时 DDL 集合是允许清单的子集（清单只减不增）', async () => {
  const [report, allowlist] = await Promise.all([scanRuntimeDdl(), readAllowlist()]);

  const actual = new Map<string, Map<string, number>>();
  for (const hit of report.hits) {
    const perFile = actual.get(hit.file) ?? new Map<string, number>();
    const key = stableKey(hit);
    perFile.set(key, (perFile.get(key) ?? 0) + 1);
    actual.set(hit.file, perFile);
  }

  const violations: string[] = [];
  for (const [file, perFile] of actual) {
    const allowed = allowlist.entries[file];
    if (!allowed) {
      violations.push(`${file}：整个文件不在允许清单里（新增运行时 DDL？DDL 只能加在 migrations/）`);
      continue;
    }
    for (const [key, count] of perFile) {
      const cap = allowed[key] ?? 0;
      if (count > cap) {
        violations.push(`${file} 的 ${key}：实测 ${count} 处 > 允许 ${cap} 处（DDL 只能加在 migrations/）`);
      }
    }
  }

  assert.deepEqual(
    violations,
    [],
    `运行时 DDL 超出允许清单：\n${violations.join('\n')}\n`
      + '正确动作是把这条 DDL 写成一个新的 migrations/*.sql，而不是把它登记进清单。',
  );
});

test('AC-SCHEMA-DDL-OWNER-02 三元组只减不增（文本命中 / 去注释后生效 / 分布文件数）', async () => {
  const [report, allowlist] = await Promise.all([scanRuntimeDdl(), readAllowlist()]);
  // 三个数一起断言：只盯一个数会漏掉「注释里搬来搬去」与「同一文件里堆更多条」两种退化。
  assert.ok(
    report.textHitCount <= allowlist.baseline.textHits,
    `文本命中 ${report.textHitCount} 超过冻结基线 ${allowlist.baseline.textHits}`,
  );
  assert.ok(
    report.effectiveHitCount <= allowlist.baseline.effectiveHits,
    `去注释后生效 ${report.effectiveHitCount} 超过冻结基线 ${allowlist.baseline.effectiveHits}`,
  );
  assert.ok(
    report.fileCount <= allowlist.baseline.files,
    `分布文件数 ${report.fileCount} 超过冻结基线 ${allowlist.baseline.files}`,
  );
});

test('AC-SCHEMA-DDL-OWNER-03 扫描器先剥注释：注释里的 DDL 不算运行时建表点', async () => {
  const { scanSource } = await import('../../src/schema/ddl-scan.js');
  const commented = [
    '// CREATE TABLE ghost_a (x INT);',
    '/* CREATE TABLE ghost_b (x INT); */',
    'const sql = `',
    '  -- CREATE TABLE ghost_c (x INT);',
    '  CREATE TABLE IF NOT EXISTS real_one (x INT);',
    '`;',
  ].join('\n');

  const stripped = scanSource('probe.ts', commented, true);
  assert.deepEqual(stripped.map((h) => h.object), ['real_one'], '注释里的三张 ghost 表 MUST NOT 被计入');

  const raw = scanSource('probe.ts', commented, false);
  assert.equal(raw.length, 4, '未剥注释时会多出 3 条假目标——这正是必须先剥注释的理由');
});
