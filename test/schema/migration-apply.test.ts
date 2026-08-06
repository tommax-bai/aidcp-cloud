/**
 * 单条迁移的施加动作（src/schema/migration-apply.ts，change restore-derived-migration-executability 任务 3.4）。
 *
 * 只钉三条会真出事的性质，全部脱库（客户端是个只记录调用的桩）：
 *   ① 执行范围外 = **零 SQL + 一条账本行**。多发一条语句就是在没有那张表的库里跑 DDL，整批停；
 *   ② 执行范围内照常发 SQL，且账本行如实记；
 *   ③ 施加失败 MUST ROLLBACK 并把原始错误抛出去（整批语义由调用方接手）。
 *
 * 第 ① 条是**注入验证**的对象：把 recordOnly 拨回 false，同一断言当场变红。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { applyMigration, type MigrationApplyClient } from '../../src/schema/migration-apply.js';
import type { PlannedMigration } from '../../src/schema/migration-plan.js';

interface Call {
  sql: string;
  params?: unknown[];
}

function stubClient(failOn?: RegExp): MigrationApplyClient & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    async query(sql: string, params?: unknown[]) {
      calls.push({ sql, params });
      if (failOn && failOn.test(sql)) throw new Error('boom');
      return undefined;
    },
  };
}

const migration: PlannedMigration = {
  version: '0055_first_class_search_activity',
  name: '0055_first_class_search_activity.sql',
  content: 'ALTER TABLE risk_counters DROP CONSTRAINT IF EXISTS risk_counters_action_check;',
  checksum: 'deadbeef',
  kind: 'expand',
};

const base = { appliedBy: 'tester', appliedFromTarget: 'dev', now: () => 0 };

test('执行范围外：零 SQL + 一条账本行，且账本行自己写明是记出来的', async () => {
  const client = stubClient();
  const receipt = await applyMigration(client, migration, { ...base, recordOnly: true });

  assert.equal(receipt.executed, false);
  assert.deepEqual(
    client.calls.map((c) => c.sql.split(/\s+/)[0]),
    ['BEGIN', 'INSERT', 'COMMIT'],
    '记账不执行 MUST 只有 BEGIN / INSERT 账本行 / COMMIT 三句——迁移正文一个字都不许发出去',
  );
  assert.equal(
    client.calls.some((c) => c.sql.includes('risk_counters')),
    false,
    '迁移正文出现在调用序列里，就是在一个没有那张表的库里跑 DDL：relation does not exist，整批停',
  );
  const ledgerRow = client.calls[1];
  assert.deepEqual(ledgerRow.params?.[0], migration.version);
  assert.deepEqual(ledgerRow.params?.[4], 'tester (record-only)');
});

test('执行范围内：迁移正文照发，账本行如实记', async () => {
  const client = stubClient();
  const receipt = await applyMigration(client, migration, { ...base, recordOnly: false });

  assert.equal(receipt.executed, true);
  assert.deepEqual(client.calls.map((c) => c.sql.split(/\s+/)[0]), ['BEGIN', 'ALTER', 'INSERT', 'COMMIT']);
  assert.equal(client.calls[2].params?.[4], 'tester');
});

test('施加失败 MUST ROLLBACK 并把原始错误抛出去，MUST NOT 吞掉后继续', async () => {
  const client = stubClient(/ALTER/);
  await assert.rejects(() => applyMigration(client, migration, { ...base, recordOnly: false }), /boom/);
  assert.deepEqual(client.calls.map((c) => c.sql.split(/\s+/)[0]), ['BEGIN', 'ALTER', 'ROLLBACK']);
  assert.equal(
    client.calls.some((c) => c.sql.startsWith('INSERT')),
    false,
    '失败的迁移绝不能留下账本行——留下就等于下次跳过它，库里永远缺那批对象',
  );
});

test('contract 类迁移的授权痕迹留在账本行上', async () => {
  const client = stubClient();
  await applyMigration(client, { ...migration, kind: 'contract' }, { ...base, recordOnly: false });
  assert.equal(client.calls[2].params?.[4], 'tester (--allow-contract)');
});
