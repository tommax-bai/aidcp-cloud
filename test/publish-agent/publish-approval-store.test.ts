/**
 * PublishApprovalStore —— 授权持久记录的单写出口（change publish-approval-signal-to-database）。
 *
 * 覆盖不变量：first-writer-wins 由「活跃行唯一」承担、作废是状态迁移而非删除、
 * execution_target 由服务端注入且缺失即拒、按本机 target 隔离。
 * 说明：本文件用注入 pool 的行为桩验逻辑；**真实部分唯一索引的原子性只能在真库上证明**，
 * 故同时对 schema/迁移文本做结构断言，两者互补。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ApprovalExecutionTargetError,
  PUBLISH_APPROVAL_SCHEMA_SQL,
  PublishApprovalStore,
} from '../../src/publish-agent/publish-approval-store.js';

function decisionRow(overrides: Record<string, unknown> = {}) {
  return {
    request_id: 'publish-42',
    revision: 1,
    subject_kind: 'publish',
    candidate_ref: '42',
    content_version: 3,
    approved: true,
    decided_by: 'ou_operator',
    decided_via: 'feishu',
    decided_at: new Date('2026-07-23T00:00:00.000Z'),
    env_key: 'env-1',
    execution_target: 'dev',
    frozen_payload: { title: 'T' },
    dispatch_state: 'pending_dispatch',
    dispatch_blocked_reason: null,
    dispatch_state_at: new Date('2026-07-23T00:00:00.000Z'),
    void_reason: null,
    ...overrides,
  };
}

const input = {
  requestId: 'publish-42',
  subjectKind: 'publish' as const,
  candidateRef: '42',
  contentVersion: 3,
  approved: true,
  decidedBy: 'ou_operator',
  decidedVia: 'feishu' as const,
  envKey: 'env-1',
  frozenPayload: { title: 'T' },
};

/** 事务型假 client：记录语句顺序，按 handler 回结果。 */
function txPool(handler: (sql: string, args: unknown[]) => { rows: unknown[]; rowCount: number }) {
  const sqls: string[] = [];
  const pool = {
    async connect() {
      return {
        async query(sql: string, args: unknown[] = []) {
          sqls.push(sql.trim().split('\n')[0]);
          return handler(sql, args);
        },
        release() {},
      };
    },
    async query(sql: string, args: unknown[] = []) {
      sqls.push(sql.trim().split('\n')[0]);
      return handler(sql, args);
    },
    async end() {},
  };
  return { sqls, pool: pool as never };
}

test('schema: 活跃行唯一索引承担 first-writer-wins；target 有 CHECK 且无默认值', () => {
  assert.match(
    PUBLISH_APPROVAL_SCHEMA_SQL,
    /CREATE UNIQUE INDEX IF NOT EXISTS idx_publish_approval_decision_active[\s\S]*?\(request_id\)[\s\S]*?WHERE dispatch_state <> 'void'/,
  );
  assert.match(PUBLISH_APPROVAL_SCHEMA_SQL, /execution_target\s+TEXT NOT NULL CHECK \(execution_target IN \('dev','ol'\)\)/);
  assert.doesNotMatch(PUBLISH_APPROVAL_SCHEMA_SQL, /execution_target[^\n]*DEFAULT/);

  const migration = readFileSync(
    new URL('../../migrations/0063_publish_approval_decision.sql', import.meta.url),
    'utf8',
  );
  assert.match(
    migration,
    /CREATE UNIQUE INDEX IF NOT EXISTS idx_publish_approval_decision_active[\s\S]*?WHERE dispatch_state <> 'void'/,
  );
  assert.match(migration, /execution_target\s+TEXT NOT NULL CHECK \(execution_target IN \('dev','ol'\)\)/);
});

test('record: execution_target 缺失即拒绝写入，不落 target 未知的授权', async () => {
  const { sqls, pool } = txPool(() => ({ rows: [], rowCount: 0 }));
  const store = new PublishApprovalStore({ executionTarget: null, pool });
  await assert.rejects(() => store.record(input), (err: unknown) => err instanceof ApprovalExecutionTargetError);
  assert.deepEqual(sqls, [], '拒绝时一条语句都不该发出');
});

test('record: 首写成功 → written:true，且授权与 PublishApproved 命令在同一事务内写出', async () => {
  const { sqls, pool } = txPool((sql) => {
    if (sql.includes('INSERT INTO publish_approval_decision')) return { rows: [decisionRow()], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
  const store = new PublishApprovalStore({ executionTarget: 'dev', pool });
  const outcome = await store.record(input);
  assert.deepEqual(outcome, { written: true, revision: 1 });
  const shape = sqls.map((sql) =>
    sql.startsWith('BEGIN') ? 'BEGIN'
      : sql.startsWith('COMMIT') ? 'COMMIT'
      : sql.includes('publish_approval_decision') ? 'decision'
      : sql.includes('publish_approval_outbox') ? 'outbox'
      : sql,
  );
  assert.deepEqual(shape, ['BEGIN', 'decision', 'outbox', 'COMMIT']);
  assert.equal(
    Object.keys(outcome).includes('published'),
    false,
    '写出口绝不返回 published——授权受理不等于平台已发布',
  );
});

test('record: 撞活跃行唯一索引 → written:false + 首个决定值（first-writer-wins）', async () => {
  const { pool } = txPool((sql) => {
    // ON CONFLICT ... DO NOTHING 返回零行 = 已有活跃决定
    if (sql.includes('INSERT INTO publish_approval_decision')) return { rows: [], rowCount: 0 };
    if (sql.includes('SELECT') && sql.includes('publish_approval_decision')) {
      return { rows: [decisionRow({ approved: false, dispatch_state: 'consumed' })], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
  const store = new PublishApprovalStore({ executionTarget: 'dev', pool });
  assert.deepEqual(await store.record(input), { written: false, alreadyDecided: false });
});

test('voidActive: 只做状态迁移（UPDATE + void_reason），绝不 DELETE；枚举外原因被拒', async () => {
  const seen: string[] = [];
  const { pool } = txPool((sql) => {
    seen.push(sql);
    return { rows: [decisionRow({ dispatch_state: 'void', void_reason: 'version_stale' })], rowCount: 1 };
  });
  const store = new PublishApprovalStore({ executionTarget: 'dev', pool });
  const row = await store.voidActive('publish-42', 'version_stale');
  assert.equal(row?.dispatchState, 'void');
  assert.equal(row?.voidReason, 'version_stale');
  assert.match(seen.join('\n'), /UPDATE publish_approval_decision/);
  assert.doesNotMatch(seen.join('\n'), /DELETE FROM publish_approval_decision/);
  await assert.rejects(() => store.voidActive('publish-42', 'nope' as never), /invalid_void_reason/);
});

test('待下发查询按本机 target 隔离；告警候选只取无阻塞原因的行', async () => {
  const captured: Array<{ sql: string; args: unknown[] }> = [];
  const { pool } = txPool((sql, args) => {
    captured.push({ sql, args });
    return { rows: [], rowCount: 0 };
  });
  const store = new PublishApprovalStore({ executionTarget: 'dev', pool });
  await store.listPendingDispatch('dev');
  await store.listStalePendingDispatch('dev', 900_000);

  assert.match(captured[0].sql, /execution_target = \$1/);
  assert.equal(captured[0].args[0], 'dev');
  assert.match(captured[1].sql, /dispatch_blocked_reason IS NULL/);
  assert.match(captured[1].sql, /execution_target = \$1/);
});

test('待下发查询可按 subject_kind 收窄：评论授权没有下发段，混进来会把候选窗口永久占满', async () => {
  const captured: Array<{ sql: string; args: unknown[] }> = [];
  const { pool } = txPool((sql, args) => {
    captured.push({ sql, args });
    return { rows: [], rowCount: 0 };
  });
  const store = new PublishApprovalStore({ executionTarget: 'dev', pool });
  await store.listPendingDispatch('dev', 200, 'publish');
  await store.listStalePendingDispatch('dev', 900_000, 50, 'publish');

  assert.match(captured[0].sql, /subject_kind = \$3/);
  assert.equal(captured[0].args[2], 'publish');
  assert.match(captured[1].sql, /subject_kind = \$4/);
  assert.equal(captured[1].args[3], 'publish');

  // 不给 subjectKind 时参数为 NULL ⇒ 谓词恒真，既有调用方行为不变。
  await store.listPendingDispatch('dev');
  assert.equal(captured[2].args[2], null);
});

test('退回待下发也接受 pending_dispatch：等槽位那条路径压根没经过 dispatching', async () => {
  const captured: Array<{ sql: string; args: unknown[] }> = [];
  const { pool } = txPool((sql, args) => {
    captured.push({ sql, args });
    return { rows: [], rowCount: 0 };
  });
  const store = new PublishApprovalStore({ executionTarget: 'dev', pool });
  await store.releaseToPending('publish-42', 'browser_slot_waiting');

  // browser_wake_failed 在 acquire 阶段就 reject：业务回调没执行 ⇒ markDispatching 没跑过 ⇒ 行仍停在
  // pending_dispatch。WHERE 若只认 dispatching，这条 UPDATE 命中 0 行、阻塞原因被静默丢弃。
  assert.match(captured[0].sql, /dispatch_state IN \('pending_dispatch','dispatching'\)/);
  assert.equal(captured[0].args[1], 'browser_slot_waiting');
});

test('活跃读只返回未作废行（历史轮次绝不混入判定）', async () => {
  const captured: string[] = [];
  const { pool } = txPool((sql) => {
    captured.push(sql);
    return { rows: [decisionRow()], rowCount: 1 };
  });
  const store = new PublishApprovalStore({ executionTarget: 'dev', pool });
  await store.readActive('publish-42');
  assert.match(captured[0], /dispatch_state <> 'void'/);
});
