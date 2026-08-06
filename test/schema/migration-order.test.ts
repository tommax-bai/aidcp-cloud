/**
 * 迁移目录按执行器自己的复合序、从空库跑得完（change cloud-schema-migration-executor 任务 3.1）。
 * aidcp:test-owner=cloud
 * 零数据库依赖。
 *
 * 事实源翻转后（invert-split-fact-source 5.3）：被检对象是三个派生仓 migrations/ 的**并集**
 * （执行器在属主 URL 未设时跑的正是同一批文件），不是本仓冻结副本，也不是任何单仓子集。
 *
 * 为什么单独一条：`ddl-parity.test.ts` 比的是**对象集合**，对顺序完全无感，所以「补齐迁移的编号
 * 排在后续 ALTER 它们的历史迁移之后」这种缺陷它永远发现不了——而那正是空库拉起会当场炸掉的形态，
 * 且只会在部署现场被发现（dev/ol 的表早被存储自建好了，走的是 baseline 记账、根本不跑 up）。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { findOrderDefects } from '@automation/schema/migration-order.js';
import { versionOf } from '@automation/schema/migration-plan.js';

import { unionMigrationFiles } from '../helpers/migration-union.js';

test('空库按复合序拉起：没有任何迁移引用尚未建出的表', async () => {
  const files = await unionMigrationFiles(); // 已按复合序排好
  const defects = findOrderDefects(files);
  assert.deepEqual(
    defects.map((d) => `${d.version} → ${d.table}`),
    [],
    '这些迁移引用了排在它们之后才建出来的表。'
    + '后果不是「某一条报错」，而是 migrate up 在第一条失败处**整批停住**，全新空库根本拉不起来。'
    + '处置：把建这些表的迁移重编号到引用它们的迁移之前（补齐迁移尚未进任何真库账本时改名是零成本的）。',
  );
});

test('基线建表迁移 MUST 排在第一位（历史迁移会 ALTER 它们）', async () => {
  const files = await unionMigrationFiles();
  assert.ok(files.length > 0);
  assert.equal(
    versionOf(files[0].name),
    '0000_baseline_identity_and_corpus_tables',
    'accounts / concepts / client_users 那批表由 0005 起的历史迁移直接 ALTER，'
    + '建它们的迁移 MUST 排在全部历史迁移之前',
  );
});

/** 检查器本身要能抓到缺陷，否则它只是一条恒绿的装饰。 */
test('检查器能抓到「先 ALTER 后 CREATE」', () => {
  const defects = findOrderDefects([
    { name: '0001_alter_first.sql', content: 'ALTER TABLE zz_late ADD COLUMN a TEXT;', checksum: 'x' },
    { name: '0002_create_later.sql', content: 'CREATE TABLE IF NOT EXISTS zz_late (a TEXT);', checksum: 'y' },
  ]);
  assert.deepEqual(defects, [{ version: '0001_alter_first', table: 'zz_late' }]);
});

test('同文件内先 CREATE 后 ALTER 不算缺陷；pg_catalog 不算业务表', () => {
  const defects = findOrderDefects([
    {
      name: '0001_ok.sql',
      content:
        'CREATE TABLE IF NOT EXISTS zz_ok (a TEXT);\n'
        + 'ALTER TABLE zz_ok ADD COLUMN b TEXT;\n'
        + 'DELETE FROM pg_temp_stub WHERE false;\n'
        + "SELECT 1 FROM pg_constraint WHERE conrelid = 'zz_ok'::regclass;",
      checksum: 'x',
    },
  ]);
  assert.deepEqual(defects, []);
});
