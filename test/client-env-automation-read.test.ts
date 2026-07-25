import { test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { PgClientEnvAutomationRead } from '../src/interactions/client-env-automation-read.js';

/**
 * Block③ 物理拆库 L3：automation 侧属主实现（`ClientEnvAutomationReader` 的单进程满足者）。
 *
 * 只锁两件从 client-user-store 迁过来时**最容易漂**的事：① 谓词与投影逐字保留（平台 / 未清除态 /
 * 归属双条件），时间戳出口一律 epoch ms；② 空入参**不发查询**（跨进程后每次调用都是一次网络往返）。
 * 真 SQL 语义（索引命中、并发下的可见性）靠真库核 → 真机 backlog 簇 61。
 */
function fakePool(handler: (sql: string, params?: unknown[]) => { rows: unknown[] }) {
  const calls: { sql: string; params?: unknown[] }[] = [];
  const pool = {
    query: async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      return handler(sql, params);
    },
  } as unknown as pg.Pool;
  return { pool, calls };
}

test('PgClientEnvAutomationRead: 谓词逐字保留，时间戳出口为 epoch ms', async () => {
  const requestedAt = new Date('2026-07-22T01:00:00Z');
  const purgeDueAt = new Date('2026-07-29T01:00:00Z');
  const { pool, calls } = fakePool(() => ({ rows: [{
    offboard_id: 'ob-1', env_key: 'env-1', account_id: 'acct-1', state: 'dispatched',
    reason: 'customer_terminated', requested_at: requestedAt, purge_due_at: purgeDueAt,
  }] }));
  const reader = new PgClientEnvAutomationRead({ pool });

  assert.deepEqual(await reader.activeWechatOffboards(), [{
    offboardId: 'ob-1', envKey: 'env-1', accountId: 'acct-1', state: 'dispatched',
    reason: 'customer_terminated', requestedAt: requestedAt.getTime(), purgeDueAt: purgeDueAt.getTime(),
  }]);
  assert.match(calls[0].sql, /FROM interaction_offboards/);
  assert.match(calls[0].sql, /platform='wechat_channels' AND state <> 'purged'/);

  await reader.offboardForUser('ob-1', 'user-a');
  // 归属过滤下推到属主侧：offboardId + userId 双条件，绝不由读方在内存里放宽。
  assert.match(calls[1].sql, /WHERE offboard_id=\$1 AND user_id=\$2/);
  assert.deepEqual(calls[1].params, ['ob-1', 'user-a']);

  await reader.wechatEnvKeysForAccount('acct-1');
  assert.match(calls[2].sql, /FROM interaction_auth_state\n\s+WHERE platform='wechat_channels' AND account_id=\$1/);
});

test('PgClientEnvAutomationRead: 空入参直接返回空集，不发无谓查询（拆进程后即一次往返）', async () => {
  const { pool, calls } = fakePool(() => ({ rows: [] }));
  const reader = new PgClientEnvAutomationRead({ pool });
  assert.deepEqual(await reader.wechatBoundEnvKeys([]), []);
  assert.deepEqual(await reader.riskStateProjection([]), []);
  assert.equal(calls.length, 0);
});
