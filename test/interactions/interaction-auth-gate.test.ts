/**
 * 反方向跨属主互斥的收口（Block③ L3）——闸在 api、写在 automation。
 *
 * 覆盖三件事，一件都不能少：
 *   ① **fail-closed**：闸拒绝 / 闸调不通 / 回执过期 ⇒ automation MUST 拒绝写入，且**一行都不写**；
 *   ② **闸在事务之外**：RPC MUST 发生在 automation `BEGIN` 之前（否则形成 PostgreSQL 检测不到的
 *      跨连接等待环：api 连接等 automation 持有的行、automation 连接等 api 持有的行）；
 *   ③ **api 属主实现**：环境级行锁跑在自己的事务里、回落顺序与拒绝档优先级逐字保留。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Pool, PoolClient } from 'pg';
import { InteractionStore } from '../../src/interactions/interaction-store.js';
import { PgInteractionAuthGate } from '../../src/interactions/interaction-auth-gate.js';
import type {
  InteractionAuthGate,
  InteractionAuthWriteAuthorization,
} from '../../src/kernel/interaction-auth-gate-types.js';
import type { InteractionAuthStatusPayload } from '../../src/kernel/interaction-types.js';
import { INTERACTION_TEST_EXECUTION_TARGET } from '../helpers/interaction-store-test-deps.js';

const AUTH_PAYLOAD: InteractionAuthStatusPayload = {
  envKey: 'env-gate', accountId: 'acct-gate', platform: 'wechat_channels', status: 'active',
  browserState: 'closed',
  capabilities: { commentsRead: true, commentsReply: true, dmRead: true, dmSendText: true, dmSendImage: false },
  identity: null, runtimeControlsVersion: 0, checkedAt: 1_784_044_800_000, reasonCode: null,
};

/** 记录 automation 侧真正执行到的 SQL；`connects` 为 0 即证明「一行都没写、连连接都没取」。 */
function recordingPool(): { pool: Pool; sql: string[]; connects: () => number; trace: string[] } {
  const sql: string[] = [];
  const trace: string[] = [];
  let connects = 0;
  const client = {
    query: async (text: string) => {
      sql.push(text);
      trace.push(text.trim().split(/\s+/).slice(0, 2).join(' '));
      if (text.includes('INSERT INTO event_outbox')) return { rows: [{ id: 1 }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
    release: () => {},
  };
  const pool = {
    connect: async () => { connects += 1; trace.push('CONNECT'); return client as unknown as PoolClient; },
  } as unknown as Pool;
  return { pool, sql, connects: () => connects, trace };
}

function gateReturning(result: InteractionAuthWriteAuthorization, trace?: string[]): InteractionAuthGate {
  return {
    authorizeAuthStateWrite: async () => { trace?.push('GATE'); return result; },
    checkAccountScope: async () => { trace?.push('GATE'); return { ok: true }; },
  };
}

test('闸拒绝（账号不存在）⇒ 登录态一行都不写，且错误码/文案/状态与改动前逐字一致', async () => {
  const { pool, sql, connects } = recordingPool();
  const store = new InteractionStore({
    pool, authGate: gateReturning({ ok: false, reason: 'account_not_found' }),
    executionTarget: INTERACTION_TEST_EXECUTION_TARGET,
  });
  await assert.rejects(store.upsertAuthStatus(AUTH_PAYLOAD), (error: unknown) => {
    const err = error as { code?: string; message?: string; httpStatus?: number };
    assert.equal(err.code, 'INTERACTION_NOT_FOUND');
    assert.equal(err.message, '账号不存在。');
    assert.equal(err.httpStatus, 404);
    return true;
  });
  assert.equal(connects(), 0, '闸拒绝时 MUST NOT 开事务');
  assert.deepEqual(sql, []);
});

test('闸调不通（端口未注入 / 实现抛错）⇒ 拒绝写入，绝不「问不到就当放行」', async () => {
  const unconfigured = new InteractionStore({ pool: recordingPool().pool });
  await assert.rejects(unconfigured.upsertAuthStatus(AUTH_PAYLOAD),
    /interaction_auth_gate_port_not_configured/);

  const { pool, sql, connects } = recordingPool();
  const throwing = new InteractionStore({
    pool,
    authGate: {
      authorizeAuthStateWrite: () => Promise.reject(new Error('interaction_auth_gate_unavailable_in_api_mode')),
      checkAccountScope: () => Promise.reject(new Error('interaction_auth_gate_unavailable_in_api_mode')),
    },
    executionTarget: INTERACTION_TEST_EXECUTION_TARGET,
  });
  await assert.rejects(throwing.upsertAuthStatus(AUTH_PAYLOAD), /interaction_auth_gate_unavailable_in_api_mode/);
  assert.equal(connects(), 0);
  assert.deepEqual(sql, []);
});

test('回执过期 ⇒ 事务回滚、登录态不落地（宁可让边缘重报，也不按旧判定放行）', async () => {
  const { pool, sql } = recordingPool();
  const now = 1_784_044_900_000;
  const store = new InteractionStore({
    pool, clock: () => now,
    authGate: gateReturning({
      ok: true,
      receipt: {
        platform: 'wechat_channels', accountId: 'acct-gate', envKey: 'env-gate',
        issuedAt: now - 60_000, expiresAt: now - 1, environmentSerialization: 'registered',
      },
    }),
    executionTarget: INTERACTION_TEST_EXECUTION_TARGET,
  });
  await assert.rejects(store.upsertAuthStatus(AUTH_PAYLOAD), (error: unknown) => {
    const err = error as { code?: string; details?: { issues?: { code: string }[] } };
    assert.equal(err.code, 'INTERACTION_STATE_CONFLICT');
    assert.equal(err.details?.issues?.[0]?.code, 'auth_receipt_expired');
    return true;
  });
  assert.ok(sql.some((text) => text === 'ROLLBACK'), '过期路径 MUST 回滚');
  assert.ok(!sql.some((text) => text.includes('INSERT INTO interaction_auth_state')), '过期 ⇒ 一行登录态都不写');
});

test('闸的调用点在 BEGIN 之前（跨连接等待环是 PostgreSQL 检测不到的死锁）', async () => {
  const { pool, trace } = recordingPool();
  const store = new InteractionStore({
    pool, authGate: gateReturning({
      ok: true,
      receipt: {
        platform: 'wechat_channels', accountId: 'acct-gate', envKey: 'env-gate',
        issuedAt: 0, expiresAt: Number.MAX_SAFE_INTEGER, environmentSerialization: 'registered',
      },
    }, trace),
    clock: () => 1_784_044_800_000,
    executionTarget: INTERACTION_TEST_EXECUTION_TARGET,
  });
  await store.upsertAuthStatus(AUTH_PAYLOAD);
  assert.deepEqual(trace.slice(0, 3), ['GATE', 'CONNECT', 'BEGIN']);
});

test('批次入库：撤销 hold 命中 ⇒ 与改动前同码同文案拒绝，且不开事务', async () => {
  const { pool, connects } = recordingPool();
  const store = new InteractionStore({
    pool,
    authGate: {
      authorizeAuthStateWrite: async () => ({ ok: false, reason: 'account_not_found' }),
      checkAccountScope: async () => ({ ok: false, reason: 'environment_revoked' }),
    },
    executionTarget: INTERACTION_TEST_EXECUTION_TARGET,
  });
  await assert.rejects(store.ingestBatch({
    batchId: 'b1', requestId: null, envKey: 'env-gate', accountId: 'acct-gate', platform: 'wechat_channels',
    channel: 'comment', scopeExternalId: null, cursorBefore: null, cursorAfter: null, hasMore: false,
    threads: [], messages: [], observedAt: 1_784_044_800_000,
  }), (error: unknown) => {
    const err = error as { code?: string; message?: string; httpStatus?: number };
    assert.equal(err.code, 'INTERACTION_FEATURE_DISABLED');
    assert.equal(err.message, '环境归属已撤销，互动清理仍待定位。');
    assert.equal(err.httpStatus, 409);
    return true;
  });
  assert.equal(connects(), 0);
});

/* ─────────────────────────── api 属主实现（PgInteractionAuthGate） ─────────────────────────── */

function apiPool(rowsFor: (sql: string) => { rows: unknown[]; rowCount: number }): { pool: Pool; sql: string[] } {
  const sql: string[] = [];
  const client = {
    query: async (text: string) => { sql.push(text.replace(/\s+/g, ' ').trim()); return rowsFor(text); },
    release: () => {},
  };
  return { pool: { connect: async () => client as unknown as PoolClient } as unknown as Pool, sql };
}

test('授权闸：环境级行锁与账号校验跑在 api 自己的一笔事务里，且回执带串行档', async () => {
  const { pool, sql } = apiPool((text) => {
    if (text.includes('FROM client_environments')) return { rows: [{}], rowCount: 1 };
    if (text.includes('FROM accounts')) return { rows: [{ platform: 'wechat_channels' }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
  const result = await new PgInteractionAuthGate({ pool }).authorizeAuthStateWrite({
    platform: 'wechat_channels', accountId: 'acct-gate', envKey: 'env-gate', now: 1_000, ttlMs: 10_000,
  });
  assert.ok(result.ok);
  assert.deepEqual(result.receipt, {
    platform: 'wechat_channels', accountId: 'acct-gate', envKey: 'env-gate',
    issuedAt: 1_000, expiresAt: 11_000, environmentSerialization: 'registered',
  });
  assert.equal(sql[0], 'BEGIN');
  assert.ok(sql.some((text) => text.includes('FROM client_environments') && text.includes('FOR UPDATE')));
  assert.equal(sql.at(-1), 'COMMIT');
  // 首写路径 MUST NOT 查撤销 hold（改动前就是带 allowRevocationHold 调用的）。
  assert.ok(!sql.some((text) => text.includes('client_env_revocation_holds')));
});

test('授权闸：注册表无行 → 回落锁归属行；两者皆无 → unclaimed 且如实告警', async () => {
  const warnings: string[] = [];
  const logger = { warn: (message: string) => { warnings.push(message); } };
  const scoped = apiPool((text) => {
    if (text.includes('FROM client_env_scope')) return { rows: [{}], rowCount: 1 };
    if (text.includes('FROM accounts')) return { rows: [{ platform: 'wechat_channels' }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
  const scopedResult = await new PgInteractionAuthGate({ pool: scoped.pool, logger })
    .authorizeAuthStateWrite({ platform: 'wechat_channels', accountId: 'a', envKey: 'e', now: 0, ttlMs: 1 });
  assert.ok(scopedResult.ok);
  assert.equal(scopedResult.receipt.environmentSerialization, 'customer_scoped');

  const unclaimed = apiPool((text) =>
    text.includes('FROM accounts') ? { rows: [{ platform: 'wechat_channels' }], rowCount: 1 } : { rows: [], rowCount: 0 });
  const unclaimedResult = await new PgInteractionAuthGate({ pool: unclaimed.pool, logger })
    .authorizeAuthStateWrite({ platform: 'wechat_channels', accountId: 'a', envKey: 'e', now: 0, ttlMs: 1 });
  assert.ok(unclaimedResult.ok);
  assert.equal(unclaimedResult.receipt.environmentSerialization, 'unclaimed',
    '没锁到 MUST 作为可判定的值交出去，绝不当作已加锁');
  assert.ok(warnings.some((text) => text.includes('既未注册也未归属任何客户')));
});

test('授权闸：账号不存在 / 平台不符各自成档，且失败路径回滚不留痕', async () => {
  const missing = apiPool((text) =>
    text.includes('FROM client_environments') ? { rows: [{}], rowCount: 1 } : { rows: [], rowCount: 0 });
  assert.deepEqual(
    await new PgInteractionAuthGate({ pool: missing.pool }).authorizeAuthStateWrite({
      platform: 'wechat_channels', accountId: 'a', envKey: 'e', now: 0, ttlMs: 1 }),
    { ok: false, reason: 'account_not_found' },
  );
  assert.equal(missing.sql.at(-1), 'ROLLBACK');

  const mismatch = apiPool((text) => {
    if (text.includes('FROM client_environments')) return { rows: [{}], rowCount: 1 };
    if (text.includes('FROM accounts')) return { rows: [{ platform: 'xiaohongshu' }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
  assert.deepEqual(
    await new PgInteractionAuthGate({ pool: mismatch.pool }).authorizeAuthStateWrite({
      platform: 'wechat_channels', accountId: 'a', envKey: 'e', now: 0, ttlMs: 1 }),
    { ok: false, reason: 'account_platform_mismatch' },
  );
});

test('批次闸：撤销 hold 优先于账号校验（拒绝档顺序即优先级），且不取环境级行锁', async () => {
  const held = apiPool((text) =>
    text.includes('client_env_revocation_holds') ? { rows: [{}], rowCount: 1 } : { rows: [], rowCount: 0 });
  assert.deepEqual(
    await new PgInteractionAuthGate({ pool: held.pool }).checkAccountScope({
      platform: 'wechat_channels', accountId: 'a', envKey: 'e' }),
    { ok: false, reason: 'environment_revoked' },
  );
  assert.ok(!held.sql.some((text) => text.includes('FROM accounts')), 'hold 命中即定，不再往下判');
  assert.ok(!held.sql.some((text) => text.includes('client_environments')), '批次路径不取环境级行锁');
});
