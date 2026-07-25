/**
 * 委托任务认领的账号守卫已去规范化到本域投影（change automation-accounts-projection）。零数据库依赖。
 *
 * 守住两件事：认领语句里 MUST NOT 再内联 api 属主的 accounts；且必须带新鲜期谓词，
 * 使「投影缺行 / 陈旧 / 从未刷过」三种情况都选不出候选（fail-closed，绝不替一个说不准还在不在的账号动手）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PgDelegatedTaskStore } from '../../src/delegated-task/store.js';

test('claimNext 的账号守卫读本域投影，且陈旧即选不出候选', async () => {
  const calls: Array<{ sql: string; args: unknown[] }> = [];
  const pool = {
    query: async (sql: string, args: unknown[] = []) => {
      calls.push({ sql, args });
      return { rows: [] };
    },
  };
  const store = new PgDelegatedTaskStore({ pool: pool as never, executionTarget: 'dev' });

  assert.equal(await store.claimNext({ workerId: 'worker', leaseMs: 60_000, now: Date.parse('2029-12-31T00:00:00.000Z') }), null);
  const sql = calls[0].sql;

  assert.doesNotMatch(sql, /FROM accounts\b/, '认领守卫 MUST NOT 再直读 api 属主的 accounts');
  assert.match(
    sql,
    /SELECT 1 FROM automation_account_projection a\s*\n\s*WHERE a\.account_id = delegated_tasks\.account_id/,
    '账号存在性守卫 MUST 读本域投影（同库、留在这条认领语句内）',
  );
  assert.match(
    sql,
    /SELECT 1 FROM automation_account_projection_state apj_state\s*\n\s*WHERE apj_state\.fresh_until > now\(\)/,
    '投影陈旧时 MUST 选不出候选（fail-closed）',
  );
  // 行锁仍只锁 automation 自己的表——去规范化之后更不可能出现跨属主行锁。
  assert.match(sql, /FOR UPDATE SKIP LOCKED/);
  assert.doesNotMatch(sql, /FOR SHARE/);
});
