/**
 * Block③ L3 最终一致改造 · **属主侧物化操作**的聚焦回归（纯逻辑级，mock pool，无数据库连接）。
 *
 * 钉的是这一刀的四条要害：
 *   1. 物化跑在**属主自己的连接与事务**里（自 connect + BEGIN/COMMIT），绝不接调用方的事务句柄
 *      —— 后者正是拆库后会 42P01 崩掉、或把 automation 的写打进 api 库的形态；
 *   2. **绑定由属主自己解析**（调用方不传 accountId），且解析不到时**绝不编造、绝不返回成功**；
 *   3. 无绑定又不许终态时只做「恰好一个运行控制身份」的可行收权，两个及以上不动（不误收别人的权）；
 *   4. 投递是 at-least-once ⇒ 重投必须幂等；幂等命中了别人的账号 = 台账分叉，MUST 抛而不是覆盖。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type pg from 'pg';
import { PgOffboardMaterializationOps } from '../../src/interactions/offboard-write-adapter.js';

interface Recorded { sql: string; params?: unknown[] }

function fakePool(handler: (sql: string, params?: unknown[]) => { rows: unknown[]; rowCount?: number }) {
  const calls: Recorded[] = [];
  let released = 0;
  const client = {
    query: async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      const out = handler(sql, params);
      return { rows: out.rows, rowCount: out.rowCount ?? out.rows.length };
    },
    release: () => { released += 1; },
  };
  const pool = { connect: async () => client } as unknown as pg.Pool;
  return { pool, calls, released: () => released };
}

const OFFBOARD_ROW = {
  offboard_id: 'ob-1', env_key: 'env-1', account_id: 'acct-1',
  state: 'pending_edge', reason: 'admin_revoked',
  requested_at: new Date(1_000), purge_due_at: new Date(2_000),
};

const INPUT = {
  offboardId: 'ob-1', envKey: 'env-1', userId: 'user-1',
  reason: 'admin_revoked' as const, actor: 'admin', unboundTerminalAllowed: false,
};

test('有绑定：属主自开事务里解析绑定 → 写台账 → 收权 → 审计，全程只用自己的连接', async () => {
  const { pool, calls, released } = fakePool((sql) => {
    if (sql.includes('SELECT account_id FROM interaction_auth_state')) return { rows: [{ account_id: 'acct-1' }] };
    if (sql.includes('INSERT INTO interaction_offboards')) return { rows: [OFFBOARD_ROW] };
    return { rows: [{ account_id: 'acct-1' }] };
  });
  const ops = new PgOffboardMaterializationOps({ pool });
  const outcome = await ops.materializeEnvironmentOffboard(INPUT);
  assert.ok(outcome.materialized);
  assert.deepEqual(outcome.offboard, {
    offboardId: 'ob-1', envKey: 'env-1', accountId: 'acct-1',
    state: 'pending_edge', reason: 'admin_revoked', requestedAt: 1_000, purgeDueAt: 2_000,
  });
  const order = calls.map((c) => c.sql.trim().split('\n')[0].trim());
  assert.equal(order[0], 'BEGIN');
  assert.equal(order[order.length - 1], 'COMMIT');
  // 绑定解析 MUST 早于台账写：accountId 是属主在本事务里定的，不是调用方传进来的。
  const bindingAt = calls.findIndex((c) => c.sql.includes('SELECT account_id FROM interaction_auth_state'));
  const insertAt = calls.findIndex((c) => c.sql.includes('INSERT INTO interaction_offboards'));
  assert.ok(bindingAt > 0 && bindingAt < insertAt);
  assert.ok(calls.some((c) => c.sql.includes('UPDATE interaction_runtime_controls')), '收权运行控制');
  assert.ok(calls.some((c) => c.sql.includes('UPDATE interaction_auth_state')), '收权鉴权态');
  assert.ok(calls.some((c) => c.sql.includes('INSERT INTO interaction_offboard_audit')), '写离场审计');
  assert.equal(released(), 1, '连接必须归还');
});

test('无绑定且不许终态：不写台账、只收单一运行控制身份，如实回 binding_missing（绝不返回成功）', async () => {
  const { pool, calls } = fakePool((sql) => {
    if (sql.includes('SELECT account_id FROM interaction_auth_state')) return { rows: [] };
    if (sql.includes('SELECT account_id FROM interaction_runtime_controls')) return { rows: [{ account_id: 'acct-x' }] };
    return { rows: [{ account_id: 'acct-x' }] };
  });
  const ops = new PgOffboardMaterializationOps({ pool });
  const outcome = await ops.materializeEnvironmentOffboard(INPUT);
  assert.deepEqual(outcome, { materialized: false, reason: 'binding_missing' });
  assert.ok(!calls.some((c) => c.sql.includes('INSERT INTO interaction_offboards')), '绝不凭空造台账行');
  assert.ok(calls.some((c) => c.sql.includes('UPDATE interaction_runtime_controls')), '可行范围内仍要收权');
  assert.equal(calls[calls.length - 1].sql, 'COMMIT', '收权要落盘，不能回滚掉');
});

test('无绑定且不许终态：环境下有两个运行控制身份时一个都不收（判不出是哪个就不动）', async () => {
  const { pool, calls } = fakePool((sql) => {
    if (sql.includes('SELECT account_id FROM interaction_auth_state')) return { rows: [] };
    if (sql.includes('SELECT account_id FROM interaction_runtime_controls')) {
      return { rows: [{ account_id: 'acct-x' }, { account_id: 'acct-y' }] };
    }
    return { rows: [] };
  });
  const ops = new PgOffboardMaterializationOps({ pool });
  assert.deepEqual(await ops.materializeEnvironmentOffboard(INPUT), { materialized: false, reason: 'binding_missing' });
  assert.ok(!calls.some((c) => c.sql.includes('UPDATE interaction_runtime_controls')), '判不出目标就不收权');
});

test('无绑定但允许终态（客户自助建号）：落 tombstoned 台账 + 两条审计', async () => {
  const terminal = { ...OFFBOARD_ROW, account_id: 'env-1', state: 'tombstoned', reason: 'environment_unbind' };
  const { pool, calls } = fakePool((sql) => {
    if (sql.includes('SELECT account_id FROM interaction_auth_state')) return { rows: [] };
    if (sql.includes('INSERT INTO interaction_offboards')) return { rows: [terminal] };
    return { rows: [] };
  });
  const ops = new PgOffboardMaterializationOps({ pool });
  const outcome = await ops.materializeEnvironmentOffboard({
    ...INPUT, reason: 'environment_unbind', unboundTerminalAllowed: true,
  });
  assert.ok(outcome.materialized);
  assert.equal(outcome.offboard.state, 'tombstoned');
  // 保留命名空间：accountId = envKey，**不创建账号、不建授权绑定**。
  assert.equal(outcome.offboard.accountId, 'env-1');
  const audit = calls.find((c) => c.sql.includes('INSERT INTO interaction_offboard_audit'));
  assert.ok(audit && audit.sql.includes('unbound_cleanup_not_required'));
  assert.ok(!calls.some((c) => c.sql.includes('UPDATE interaction_auth_state')), '无绑定可收，别去改不存在的授权行');
});

test('重投幂等命中了别的账号的既有离场：MUST 抛并回滚，绝不覆盖也绝不当成功', async () => {
  const { pool, calls } = fakePool((sql) => {
    if (sql.includes('SELECT account_id FROM interaction_auth_state')) return { rows: [{ account_id: 'acct-1' }] };
    if (sql.includes('INSERT INTO interaction_offboards')) return { rows: [{ ...OFFBOARD_ROW, account_id: 'acct-other' }] };
    return { rows: [] };
  });
  const ops = new PgOffboardMaterializationOps({ pool });
  await assert.rejects(() => ops.materializeEnvironmentOffboard(INPUT), /offboard_scope_conflict/);
  assert.equal(calls[calls.length - 1].sql, 'ROLLBACK');
});
