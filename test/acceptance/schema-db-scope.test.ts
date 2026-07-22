/**
 * AC-SCHEMA-DB-SCOPE — 库级作用域机制清单的机械守护（change cloud-schema-migration-executor 任务 10.1–10.2）。
 *
 * advisory lock 与外键都是**数据库级**作用域：把表搬进不同 schema，二者照常有效；
 * 只有真正拆成两个数据库才失效，而且失效方式是**静默的** —— 锁不再互斥、外键根本不存在，
 * 业务照跑、数据慢慢分叉。这正是本项目第一红线禁止的形态，所以它必须被机械清点。
 *
 * 清单的人读版本在控制仓 `aidcp/docs/database-scope-inventory.md`，
 * 机器可读副本是 test/schema/database-scope-inventory.json（由 scripts/generate-db-scope-inventory.ts 生成）。
 * 新增未登记条目即失败：只写文档不加测试等于没做，本仓已有先例证明纯文档约束会被静默打穿。
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

import { scanDbScope, toInventory, type DbScopeInventory } from '../../src/schema/db-scope-scan.js';
import { repoRoot } from '../../src/schema/ddl-scan.js';

async function readInventory(): Promise<DbScopeInventory> {
  const file = path.join(repoRoot(), 'test', 'schema', 'database-scope-inventory.json');
  return JSON.parse(await readFile(file, 'utf8')) as DbScopeInventory;
}

const HINT = '先在 aidcp/docs/database-scope-inventory.md 登记该机制（含拆 schema / 拆库后是否成立与替代方案），'
  + '再跑 npx tsx scripts/generate-db-scope-inventory.ts --write 同步机器副本。';

test('AC-SCHEMA-DB-SCOPE-01 advisory lock 调用点集合与清单一致', async () => {
  const actual = toInventory(await scanDbScope());
  const registered = await readInventory();
  assert.deepEqual(actual.advisoryLocks, registered.advisoryLocks, HINT);
  // 一处都扫不到 = 扫描路径坏了，那时「一致」是假的一致。
  assert.ok(Object.keys(actual.advisoryLocks).length > 0, '一处 advisory lock 都没扫到，先确认扫描路径');
});

test('AC-SCHEMA-DB-SCOPE-02 跨域外键目标集合与清单一致（源码侧与迁移侧各一份）', async () => {
  const actual = toInventory(await scanDbScope());
  const registered = await readInventory();
  assert.deepEqual(actual.foreignKeys, registered.foreignKeys, HINT);
  assert.deepEqual(actual.migrationForeignKeyTargets, registered.migrationForeignKeyTargets, HINT);
});

test('AC-SCHEMA-DB-SCOPE-03 硬编码 schema 名的形状探测点与清单一致', async () => {
  const actual = toInventory(await scanDbScope());
  const registered = await readInventory();
  assert.deepEqual(actual.schemaLiterals, registered.schemaLiterals, HINT);
});

test('AC-SCHEMA-DB-SCOPE-04 清单区分「拆 schema 仍成立」与「拆库静默失效」', async () => {
  const file = path.join(repoRoot(), 'test', 'schema', 'database-scope-inventory.json');
  const raw = await readFile(file, 'utf8');
  // 这份机器副本的开头 MUST 带上那句纠正误读的结论：把两种拆分混为一谈，
  // 会让人以为「搬进新 schema 就得先换掉这些锁」，从而做一次完全没必要、且风险更高的改造。
  assert.match(raw, /数据库级/);
  assert.match(raw, /静默/);
});
