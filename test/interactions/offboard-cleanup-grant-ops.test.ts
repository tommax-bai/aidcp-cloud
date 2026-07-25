import { test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { PgOffboardCleanupGrantOps } from '../../src/interactions/offboard-cleanup-grant-ops.js';

/**
 * Block③ L3：离场清理授权的签发 / 烧票收回 automation 属主域后的行为锁定。
 *
 * 这两个操作在搬迁前**SQL 层零测试覆盖**（`offboard-cleanup-grant.test.ts` 只测签票/验签纯函数，
 * `client-auth-server.test.ts` 用内存假 store 测路由契约），所以「搬迁零语义变化」这句话
 * 当时的测试套件根本验不了。本文件补上属主侧那几条不变量——每一条都对应一个能踩的红线：
 *
 * 1. **烧票与取行加锁必须同一笔事务**：烧票那条 UPDATE 不查影响行数，其正确性完全依赖
 *    同事务内 `FOR UPDATE` 已证明该行存在且持锁。拆开即「0 行也返回成功」= 静默假成功。
 * 2. **失败路径 COMMIT、不是 ROLLBACK**：被拒绝的授权尝试要留下审计行；回滚会把审计一起丢。
 * 3. **行不存在时不写审计**（没有 accountId / envKey 可写，绝不编造）。
 * 4. **签发未命中 → ROLLBACK + false，不写审计**。
 */
function recordingPool(dispatch: (sql: string, params?: unknown[]) => { rows: unknown[] }) {
  const sqls: string[] = [];
  const client = {
    query: async (sql: string, params?: unknown[]) => {
      // 只留「动词 + 目标」这一截作为形态断言，避免把列清单也断言进来（那是噪声、不是不变量）。
      sqls.push(sql.trim().split(/\s+/).slice(0, 3).join(' '));
      return dispatch(sql, params);
    },
    release() {},
  };
  const pool = { connect: async () => client } as unknown as pg.Pool;
  return { pool, sqls };
}

const GRANT_ROW = {
  offboard_id: 'ob-1', env_key: 'env-1', account_id: 'acct-1', state: 'pending_edge',
  reason: 'environment_unbind', requested_at: new Date('2026-07-24T00:00:00Z'),
  purge_due_at: new Date('2026-07-31T00:00:00Z'), user_id: 'user-a',
  cleanup_grant_jti_hash: 'hash-1', cleanup_grant_edge_id: 'ads-1',
  cleanup_grant_expires_at: new Date('2026-07-25T12:00:00Z'), cleanup_grant_used_at: null,
};
const CONSUME_INPUT = {
  userId: 'user-a', offboardId: 'ob-1', envKey: 'env-1', accountId: 'acct-1',
  edgeId: 'ads-1', jtiHash: 'hash-1', now: Date.parse('2026-07-25T10:00:00Z'),
};

test('consumeCleanupGrant 成功：取行加锁 → 烧票 → 记 consumed 审计 → COMMIT，全在一笔事务里', async () => {
  const { pool, sqls } = recordingPool((sql) => {
    if (/^\s*SELECT/.test(sql)) {
      assert.match(sql, /FROM interaction_offboards WHERE offboard_id=\$1 FOR UPDATE/);
      return { rows: [GRANT_ROW] };
    }
    return { rows: [] };
  });
  const result = await new PgOffboardCleanupGrantOps({ pool }).consumeCleanupGrant(CONSUME_INPUT);
  assert.deepEqual(result, {
    ok: true,
    offboard: {
      offboardId: 'ob-1', envKey: 'env-1', accountId: 'acct-1', state: 'pending_edge',
      reason: 'environment_unbind',
      requestedAt: GRANT_ROW.requested_at.getTime(), purgeDueAt: GRANT_ROW.purge_due_at.getTime(),
    },
  });
  // 顺序与事务边界即不变量 1：BEGIN → 取行 FOR UPDATE → 烧票 → 审计 → COMMIT，中间没有二次 BEGIN。
  assert.deepEqual(sqls, [
    'BEGIN',
    sqls[1], // 取行那条的形态已在 dispatch 里用正则断言过（含 FOR UPDATE）
    'UPDATE interaction_offboards SET',
    'INSERT INTO interaction_offboard_audit',
    'COMMIT',
  ]);
  assert.match(sqls[1], /^SELECT offboard_id,env_key,account_id/);
});

test('consumeCleanupGrant 被拒：记 rejected 审计并 COMMIT（绝不 ROLLBACK 把审计丢掉）', async () => {
  const used = { ...GRANT_ROW, cleanup_grant_used_at: new Date('2026-07-25T09:00:00Z') };
  const audits: unknown[][] = [];
  const { pool, sqls } = recordingPool((sql, params) => {
    if (/^\s*SELECT/.test(sql)) return { rows: [used] };
    if (/INSERT INTO interaction_offboard_audit/.test(sql)) audits.push(params as unknown[]);
    return { rows: [] };
  });
  const result = await new PgOffboardCleanupGrantOps({ pool }).consumeCleanupGrant(CONSUME_INPUT);
  assert.deepEqual(result, { ok: false, reason: 'already_used' });
  assert.deepEqual(sqls, ['BEGIN', sqls[1], 'INSERT INTO interaction_offboard_audit', 'COMMIT']);
  assert.match(sqls[1], /^SELECT offboard_id/);
  assert.equal(audits.length, 1);
  // 审计行带上被拒原因（status 位），且绝不含任何明文票据。
  assert.ok((audits[0] as string[]).includes('cleanup_grant_rejected'));
  assert.ok((audits[0] as string[]).includes('already_used'));
});

test('consumeCleanupGrant 行不存在：不写审计（绝不编造 accountId/envKey），仍提交', async () => {
  const { pool, sqls } = recordingPool(() => ({ rows: [] }));
  const result = await new PgOffboardCleanupGrantOps({ pool }).consumeCleanupGrant(CONSUME_INPUT);
  assert.deepEqual(result, { ok: false, reason: 'not_found' });
  assert.deepEqual(sqls, ['BEGIN', sqls[1], 'COMMIT']);
});

test('issueCleanupGrant 未命中（不归属 / 状态不符）：ROLLBACK + false，不写审计', async () => {
  const { pool, sqls } = recordingPool((sql) => {
    if (/^\s*UPDATE interaction_offboards/.test(sql)) {
      assert.match(sql, /WHERE offboard_id=\$1 AND user_id=\$2 AND state IN \('pending_edge','dispatched'\)/);
      return { rows: [] }; // RETURNING 空 = 未命中
    }
    return { rows: [] };
  });
  const ok = await new PgOffboardCleanupGrantOps({ pool }).issueCleanupGrant({
    offboardId: 'ob-1', userId: 'user-a', edgeId: 'ads-1', jtiHash: 'hash-1',
    expiresAt: Date.parse('2026-07-25T12:00:00Z'),
  });
  assert.equal(ok, false);
  assert.deepEqual(sqls, ['BEGIN', 'UPDATE interaction_offboards SET', 'ROLLBACK']);
});
