/**
 * 迁移计划纯函数层的脱库单测（change cloud-schema-migration-executor 任务 1.10）。
 * 零数据库依赖，范式照 test/interactions/migration-contract.test.ts。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  compareVersions,
  parseMigrationHeader,
  planMigrations,
  unauthorizedContracts,
  type LedgerRow,
  type MigrationFile,
} from '../../src/schema/migration-plan.js';

const EXPAND = '-- aidcp:kind=expand\n';

function file(name: string, body = 'SELECT 1;', kindHeader = EXPAND): MigrationFile {
  const content = `${kindHeader}${body}`;
  return { name, content, checksum: `sum:${name}:${content.length}` };
}

function ledger(...rows: [string, string][]): LedgerRow[] {
  return rows.map(([version, checksum]) => ({ version, checksum }));
}

test('排序用（数字前缀, 完整文件名）复合序，同号碰撞的先后可复现', () => {
  const files = [
    file('0010_quota_config.sql'),
    file('0002_risk_control.sql'),
    file('0002_bot_chats.sql'),
    file('0009_role_category_config.sql'),
  ];
  const plan = planMigrations(files, []);
  assert.deepEqual(plan.pending.map((p) => p.version), [
    '0002_bot_chats',
    '0002_risk_control',
    '0009_role_category_config',
    '0010_quota_config',
  ]);
  // 纯字符串比较会把 0002_risk_control 排在 0002_bot_chats 之前吗？不会——但复合序的第二级必须真的生效。
  assert.ok(compareVersions('0002_bot_chats', '0002_risk_control') < 0);
  // 而纯字符串比较在这里会出错：'0009…' < '0010…' 恰好成立，但 '9_x' > '10_x' 就不成立了。
  assert.ok(compareVersions('9_x', '10_x') < 0);
});

test('已应用且校验和一致 → 跳过、不重跑；重复执行账本不变', () => {
  const f = file('0001_publish_log.sql');
  const plan = planMigrations([f], ledger(['0001_publish_log', f.checksum]));
  assert.deepEqual(plan.pending, []);
  assert.deepEqual(plan.skipped, ['0001_publish_log']);
  assert.deepEqual(plan.errors, []);
});

test('历史迁移被改动 → 整批拒绝 migration_checksum_mismatch，不重跑不覆盖', () => {
  const f = file('0001_publish_log.sql');
  const plan = planMigrations([f], ledger(['0001_publish_log', 'sum:stale']));
  assert.deepEqual(plan.pending, []);
  assert.equal(plan.errors.length, 1);
  assert.equal(plan.errors[0].code, 'migration_checksum_mismatch');
  assert.equal(plan.errors[0].version, '0001_publish_log');
});

test('插入低版本迁移 → migration_out_of_order，绝不补跑', () => {
  const applied = file('0005_account_id_columns.sql');
  const inserted = file('0003_risk_interactions.sql');
  const plan = planMigrations([inserted, applied], ledger(['0005_account_id_columns', applied.checksum]));
  assert.deepEqual(plan.pending, []);
  assert.equal(plan.errors.length, 1);
  assert.equal(plan.errors[0].code, 'migration_out_of_order');
  assert.equal(plan.errors[0].version, '0003_risk_interactions');
});

test('缺 kind 头 → migration_kind_missing；非法 kind 值同样拒绝', () => {
  const missing = planMigrations([file('0070_no_kind.sql', 'SELECT 1;', '')], []);
  assert.equal(missing.errors[0]?.code, 'migration_kind_missing');
  const bogus = planMigrations([file('0070_bad_kind.sql', 'SELECT 1;', '-- aidcp:kind=maybe\n')], []);
  assert.equal(bogus.errors[0]?.code, 'migration_kind_missing');
  assert.match(bogus.errors[0].detail, /maybe/);
});

test('contract 默认被拒，显式授权后放行', () => {
  const contract = file('0070_drop_it.sql', 'DROP TABLE x;', '-- aidcp:kind=contract\n');
  const plan = planMigrations([contract], []);
  assert.deepEqual(plan.pending.map((p) => p.kind), ['contract']);
  assert.deepEqual(unauthorizedContracts(plan.pending, false), ['0070_drop_it']);
  assert.deepEqual(unauthorizedContracts(plan.pending, true), []);
});

test('对象声明只从头注释取，多行取并集，非法条目被忽略', () => {
  const header = parseMigrationHeader(
    '-- aidcp:kind=expand\n'
    + '-- aidcp:objects=table:foo,column:foo.bar\n'
    + '-- aidcp:objects=index:idx_foo, table:foo , bogus:zzz , column:\n'
    + 'CREATE TABLE never_declared (x INT);\n',
  );
  assert.equal(header.kind, 'expand');
  assert.deepEqual(header.objects, [
    { type: 'table', name: 'foo' },
    { type: 'column', name: 'foo.bar' },
    { type: 'index', name: 'idx_foo' },
  ]);
});
