/**
 * 配置面审计（`interaction_audit_events`，§5.1 归 api 单写）的跨属主投递（Block③ L3）。
 *
 * 这条改的是**边界违规**：automation 的 `InteractionStore.audit()` 过去直插这张 api 属主表。
 * 之所以不能像同文件的过期 DELETE 那样走写端口，判据只有一条 ——
 * **这笔 INSERT 与 automation 的业务写在同一笔事务里**（本文件第一条用例把这条判据钉死）。
 * 故改最终一致：automation 本域 outbox（事务型）→ 中继 → api 侧按主键幂等落地。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Pool, PoolClient } from 'pg';
import type { InteractionAuthStatusPayload } from '../../src/kernel/interaction-types.js';
import { InteractionStore } from '../../src/interactions/interaction-store.js';
import { InteractionApiWrites } from '../../src/interactions/interaction-api-writes.js';
import {
  INTERACTION_AUDIT_OUTBOX_TOPIC,
  decodeInteractionAuditEvent,
  type InteractionAuditEventRecord,
} from '../../src/kernel/interaction-audit-outbox.js';
import {
  INTERACTION_TEST_EXECUTION_TARGET,
  allowAllAuthGate,
} from '../helpers/interaction-store-test-deps.js';

const AUTH_PAYLOAD: InteractionAuthStatusPayload = {
  envKey: 'env-audit', accountId: 'acct-audit', platform: 'wechat_channels', status: 'active',
  browserState: 'closed',
  capabilities: { commentsRead: true, commentsReply: true, dmRead: true, dmSendText: true, dmSendImage: false },
  identity: null, runtimeControlsVersion: 0, checkedAt: 1_784_044_800_000, reasonCode: null,
};

test('判据落实：登录态首写的审计入队跑在**业务事务的同一条连接**上（故只能走 outbox，不能走写端口）', async () => {
  const onClient: string[] = [];
  const onPool: string[] = [];
  const client = {
    query: async (sql: string) => {
      onClient.push(sql);
      if (sql.includes('INSERT INTO event_outbox')) return { rows: [{ id: 7 }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
    release: () => {},
  };
  const pool = {
    connect: async () => client as unknown as PoolClient,
    query: async (sql: string) => { onPool.push(sql); return { rows: [], rowCount: 0 }; },
  } as unknown as Pool;
  const store = new InteractionStore({
    pool, clock: () => 1_784_044_800_000, idGen: () => 'audit-fixed',
    authGate: allowAllAuthGate(), executionTarget: INTERACTION_TEST_EXECUTION_TARGET,
  });
  await store.upsertAuthStatus(AUTH_PAYLOAD);

  const emitIndex = onClient.findIndex((sql) => sql.includes('INSERT INTO event_outbox'));
  assert.ok(emitIndex > 0, '审计入队 MUST 发生在业务事务的连接上（若走 pool 就不再同生共死）');
  assert.equal(onClient.indexOf('BEGIN'), 0);
  assert.ok(emitIndex < onClient.lastIndexOf('COMMIT'), '入队 MUST 在 COMMIT 之前 —— 业务回滚则审计事件不存在');
  assert.deepEqual(onPool, [], '审计 MUST NOT 另开一条池连接旁路提交');
  assert.ok(!onClient.some((sql) => sql.includes('INSERT INTO interaction_audit_events')),
    'automation 侧 MUST NOT 再直插 api 属主表');
});

test('入队载荷逐字承载审计行（含 event_id 与业务时刻），target 随本机部署归属', async () => {
  const emitted: { sql: string; params: unknown[] }[] = [];
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      emitted.push({ sql, params });
      return { rows: [{ id: 1 }], rowCount: 1 };
    },
  } as unknown as Pool;
  const store = new InteractionStore({
    pool, clock: () => 1_784_044_812_345, idGen: (prefix) => `${prefix}-fixed`,
    authGate: allowAllAuthGate(), executionTarget: INTERACTION_TEST_EXECUTION_TARGET,
  });
  await store.recordAudit({
    accountId: 'acct-audit', envKey: 'env-audit', actor: 'admin', action: 'config_published',
    entityType: 'config', entityId: 'cfg-1', summary: 'x'.repeat(600), labels: { version: 3 },
  });
  const insert = emitted.find(({ sql }) => sql.includes('INSERT INTO event_outbox'));
  assert.ok(insert);
  assert.equal(insert.params[0], INTERACTION_AUDIT_OUTBOX_TOPIC);
  assert.equal(insert.params[2], INTERACTION_TEST_EXECUTION_TARGET);
  const record = decodeInteractionAuditEvent(JSON.parse(insert.params[1] as string));
  assert.deepEqual(record, {
    eventId: 'audit-fixed', platform: 'wechat_channels', accountId: 'acct-audit', envKey: 'env-audit',
    actor: 'admin', action: 'config_published', configVersion: null, entityType: 'config', entityId: 'cfg-1',
    summary: 'x'.repeat(512), labels: { version: 3 }, createdAt: 1_784_044_812_345,
  });
});

test('target 缺失 ⇒ 审计当场抛错，绝不把归属未知的事件静默入队', async () => {
  const seen: string[] = [];
  const pool = { query: async (sql: string) => { seen.push(sql); return { rows: [{ id: 1 }] }; } } as unknown as Pool;
  const store = new InteractionStore({ pool, authGate: allowAllAuthGate() });
  await assert.rejects(store.recordAudit({
    accountId: 'a', envKey: null, actor: 'admin', action: 'x', entityType: 'y', summary: 'z',
  }), /interaction_audit_execution_target_not_configured/);
  assert.deepEqual(seen, []);
});

test('api 侧落地按主键幂等：重放同一 event_id 只报告 false，绝不重复插入', async () => {
  const record: InteractionAuditEventRecord = {
    eventId: 'audit-1', platform: 'wechat_channels', accountId: 'acct-audit', envKey: 'env-audit',
    actor: 'edge', action: 'auth_status_updated', configVersion: null, entityType: 'auth', entityId: null,
    summary: 'active', labels: { browserState: 'closed' }, createdAt: 1_784_044_812_345,
  };
  const seen = new Set<string>();
  const captured: { sql: string; params: unknown[] }[] = [];
  const apiPool = {
    query: async (sql: string, params: unknown[] = []) => {
      captured.push({ sql, params });
      const key = params[0] as string;
      const fresh = !seen.has(key);
      seen.add(key);
      return { rows: [], rowCount: fresh ? 1 : 0 };
    },
  } as unknown as Pool;
  const writes = new InteractionApiWrites();
  assert.equal(await writes.insertAuditEvent(apiPool, record), true);
  assert.equal(await writes.insertAuditEvent(apiPool, record), false, '至少一次投递 ⇒ 重放 MUST 幂等');
  assert.match(captured[0].sql, /ON CONFLICT \(event_id\) DO NOTHING/);
  assert.match(captured[0].sql, /to_timestamp\(\$12\/1000\.0\)/);
  assert.equal(captured[0].params[11], 1_784_044_812_345, 'created_at MUST 用业务发生时刻，不是中继落地时刻');
});

test('解码守卫：结构不符返回 null（由中继抛错停在该条之前），MUST NOT 补默认值伪造审计行', () => {
  assert.equal(decodeInteractionAuditEvent(null), null);
  assert.equal(decodeInteractionAuditEvent({ eventId: '', platform: 'p', accountId: 'a' }), null);
  assert.equal(decodeInteractionAuditEvent({
    eventId: 'e', platform: 'p', accountId: 'a', envKey: null, actor: 'x', action: 'y',
    configVersion: null, entityType: 't', entityId: null, summary: 's', labels: {},
  }), null, '缺 createdAt MUST NOT 用「现在」补上');
});
