import { test } from 'node:test';
import { ensureCapabilitySchema } from '../src/schema/schema-capability.js';
import assert from 'node:assert/strict';
import pg from 'pg';
import {
  APPROVAL_POLICY_SCHEMA_SQL,
  ApprovalPolicyStore,
} from '../src/config/approval-policy-store.js';

function fakePool(handler: (sql: string, params: unknown[]) => { rows: any[]; rowCount?: number }) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  return {
    calls,
    pool: {
      query: async (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        return handler(sql, params);
      },
    } as unknown as pg.Pool,
  };
}

test('approval policy schema uses narrow constrained tables', () => {
  assert.match(APPROVAL_POLICY_SCHEMA_SQL, /account_comment_approval_policy/);
  assert.match(APPROVAL_POLICY_SCHEMA_SQL, /source_rules','auto_approve_all/);
  assert.match(APPROVAL_POLICY_SCHEMA_SQL, /group_publish_approval_policy/);
  assert.match(APPROVAL_POLICY_SCHEMA_SQL, /client_and_feishu','client_only/);
});

test('missing environment/group policy rows preserve legacy defaults', async () => {
  const { pool } = fakePool((sql) => {
    if (sql.includes('environment_comment_approval_policy')) return { rows: [] };
    return { rows: [{ group_label: 'team-a', delivery: null }] };
  });
  const store = new ApprovalPolicyStore({ schemaEnsurer: ensureCapabilitySchema, pool });
  assert.equal(await store.getAccountCommentMode('acc-1'), 'source_rules');
  assert.deepEqual(await store.getGroupPublishPolicyForAccount('acc-1'), {
    groupLabel: 'team-a',
    delivery: 'client_and_feishu',
  });
});

/**
 * change environment-level-rule-mode-and-approval：有效模式解析先由执行账号反查其当前绑定环境。
 * 反查的两条歧义判据（多环境 / 跨客户争用）由那条 SQL 的 `env_count=1 AND owner_count<=1` 承担，
 * 不满足时该查询**返回零行** —— 于是 accountMode(undefined) = source_rules，方向天然收紧。
 */
test('账号读经环境反查；SQL 同时带绑定唯一性与跨客户争用判据，不新增第二次查询', async () => {
  const { pool, calls } = fakePool((sql) => {
    if (sql.includes('environment_comment_approval_policy')) {
      return { rows: [{ mode: 'auto_approve_all' }] };
    }
    return { rows: [] };
  });
  const store = new ApprovalPolicyStore({ schemaEnsurer: ensureCapabilitySchema, pool });
  assert.equal(await store.getAccountCommentMode('acc-1'), 'auto_approve_all');
  assert.equal(calls.length, 1, '热路径 MUST NOT 因为改环境键而多打一次查询');
  assert.match(calls[0].sql, /client_environments/);
  assert.match(calls[0].sql, /b\.env_count=1 AND b\.owner_count<=1/);
  // 账号键旧表 MUST NOT 再参与运行时判定。
  assert.doesNotMatch(calls[0].sql, /account_comment_approval_policy/);
});

test('反查不到唯一环境（零行）回落 source_rules，MUST NOT 沿用账号键存量值', async () => {
  const { pool } = fakePool(() => ({ rows: [] }));
  const store = new ApprovalPolicyStore({ schemaEnsurer: ensureCapabilitySchema, pool });
  assert.equal(await store.getAccountCommentMode('ambiguous-acc'), 'source_rules');
});

test('环境 auto_approve_all 写校验环境存在并返回数据库真态', async () => {
  const { pool, calls } = fakePool((sql) => {
    if (sql.includes('INSERT INTO environment_comment_approval_policy')) {
      return { rows: [{ env_key: 'env-1' }], rowCount: 1 };
    }
    if (sql.includes('WITH requested AS')) {
      return { rows: [{
        env_key: 'env-1',
        mode: 'auto_approve_all',
        updated_by: 'panel:alice',
        updated_at: new Date(0),
        bound_account: 'acc-1',
        account_exists: true,
        duplicate_count: 1,
        owner_count: 1,
      }] };
    }
    return { rows: [] };
  });
  const result = await new ApprovalPolicyStore({ schemaEnsurer: ensureCapabilitySchema, pool })
    .setEnvironmentCommentMode('env-1', 'auto_approve_all', 'panel:alice');
  assert.deepEqual(result, {
    ok: true,
    row: {
      envKey: 'env-1',
      mode: 'auto_approve_all',
      configured: true,
      updatedBy: 'panel:alice',
      updatedAt: 0,
      boundAccountId: 'acc-1',
    },
  });
  assert.ok(calls.some((call) => call.sql.includes('ON CONFLICT(env_key) DO UPDATE')));
});

test('未绑定账号的环境可保存可读取，并如实标注当前没有执行对象', async () => {
  const { pool } = fakePool((sql) => {
    if (sql.includes('INSERT INTO environment_comment_approval_policy')) {
      return { rows: [{ env_key: 'env-unbound' }], rowCount: 1 };
    }
    if (sql.includes('WITH requested AS')) {
      return { rows: [{
        env_key: 'env-unbound',
        mode: 'auto_approve_all',
        updated_by: 'client:u1',
        updated_at: new Date(5),
        bound_account: null,
        account_exists: false,
        duplicate_count: 0,
        owner_count: 1,
      }] };
    }
    return { rows: [] };
  });
  const result = await new ApprovalPolicyStore({ schemaEnsurer: ensureCapabilitySchema, pool })
    .setOwnedEnvironmentCommentMode('u1', 'env-unbound', 'auto_approve_all', 'client:u1');
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.row.configured, true);
  assert.equal(result.row.mode, 'auto_approve_all');
  assert.equal(result.row.boundAccountId, null, '未绑定 MUST NOT 编造执行对象');
  assert.equal(result.row.updatedBy, 'client:u1', '客户来源署名 MUST 与管理员可区分');
});

test('环境策略目录按 envKey 批量单查，悬空 account_id 不冒充执行对象', async () => {
  const { pool, calls } = fakePool((sql, params) => {
    if (!sql.includes('WITH requested AS')) return { rows: [] };
    assert.deepEqual(params, [['env-bound', 'env-dangling']]);
    return { rows: [
      {
        env_key: 'env-bound',
        mode: 'source_rules',
        updated_by: null,
        updated_at: null,
        bound_account: 'acc-live',
        account_exists: true,
        duplicate_count: 1,
        owner_count: 1,
      },
      {
        env_key: 'env-dangling',
        mode: 'auto_approve_all',
        updated_by: 'panel:alice',
        updated_at: new Date(9),
        bound_account: 'acc-deleted',
        account_exists: false,
        duplicate_count: 1,
        owner_count: 1,
      },
    ] };
  });
  const policies = await new ApprovalPolicyStore({ schemaEnsurer: ensureCapabilitySchema, pool })
    .listEnvironmentCommentPolicies(['env-bound', 'env-dangling', 'env-bound']);
  assert.equal(calls.length, 1, '目录投影 MUST 单查询，不按环境 N+1');
  assert.equal(policies.get('env-bound')?.boundAccountId, 'acc-live');
  assert.equal(policies.get('env-dangling')?.boundAccountId, null);
  assert.equal(policies.get('env-dangling')?.mode, 'auto_approve_all');
});

test('非所有者写 fail-closed：ownership 与 UPSERT 同一条语句，零行即拒绝', async () => {
  const { pool, calls } = fakePool((sql) => {
    if (sql.includes('INSERT INTO environment_comment_approval_policy')) {
      return { rows: [], rowCount: 0 };
    }
    return { rows: [] };
  });
  const result = await new ApprovalPolicyStore({ schemaEnsurer: ensureCapabilitySchema, pool })
    .setOwnedEnvironmentCommentMode('intruder', 'env-1', 'auto_approve_all', 'client:intruder');
  assert.deepEqual(result, { ok: false, reason: 'environment_not_owned' });
  const insert = calls.find((call) => call.sql.includes('INSERT INTO environment_comment_approval_policy'))!;
  assert.match(insert.sql, /EXISTS\(SELECT 1 FROM client_env_scope s/);
  assert.equal(
    calls.some((call) => call.sql.includes('WITH requested AS')),
    false,
    '非所有者 MUST NOT 读回该环境现有策略（否则通过响应泄露）',
  );
});

test('账号寻址写：反查歧义具名拒绝，MUST NOT 退回写账号键旧表', async () => {
  const { pool, calls } = fakePool((sql) => {
    if (sql.startsWith('SELECT 1 FROM accounts')) return { rows: [{ '?column?': 1 }] };
    if (sql.includes('count(DISTINCT e.env_key)')) {
      return { rows: [{ env_count: 2, env_key: 'env-a', owner_count: 1 }] };
    }
    return { rows: [] };
  });
  const result = await new ApprovalPolicyStore({ schemaEnsurer: ensureCapabilitySchema, pool })
    .setAccountCommentMode('acc-1', 'auto_approve_all', 'panel:alice');
  assert.deepEqual(result, { ok: false, reason: 'environment_conflict' });
  assert.equal(
    calls.some((call) => call.sql.includes('INSERT INTO account_comment_approval_policy')),
    false,
  );
  assert.equal(
    calls.some((call) => call.sql.includes('INSERT INTO environment_comment_approval_policy')),
    false,
  );
});

test('账号寻址写：跨客户争用同样拒绝', async () => {
  const { pool } = fakePool((sql) => {
    if (sql.startsWith('SELECT 1 FROM accounts')) return { rows: [{ '?column?': 1 }] };
    if (sql.includes('count(DISTINCT e.env_key)')) {
      return { rows: [{ env_count: 1, env_key: 'env-a', owner_count: 2 }] };
    }
    return { rows: [] };
  });
  assert.deepEqual(
    await new ApprovalPolicyStore({ schemaEnsurer: ensureCapabilitySchema, pool })
      .setAccountCommentMode('acc-1', 'auto_approve_all', 'panel:alice'),
    { ok: false, reason: 'environment_conflict' },
  );
});

test('group client_only write rejects unknown groups', async () => {
  const { pool } = fakePool(() => ({ rows: [] }));
  assert.deepEqual(
    await new ApprovalPolicyStore({ schemaEnsurer: ensureCapabilitySchema, pool }).setGroupPublishDelivery('missing', 'client_only', 'alice'),
    { ok: false, reason: 'group_not_found' },
  );
});

test('missing policy table fails safe to source_rules and dual-channel', async () => {
  const error = Object.assign(new Error('missing'), { code: '42P01' });
  const { pool } = fakePool(() => { throw error; });
  const store = new ApprovalPolicyStore({ schemaEnsurer: ensureCapabilitySchema, pool });
  assert.equal(await store.getAccountCommentMode('acc-1'), 'source_rules');
  assert.deepEqual(await store.getGroupPublishPolicyForAccount('acc-1'), {
    groupLabel: null,
    delivery: 'client_and_feishu',
  });
});

test('策略表不可达时客户读写返回 policy_unavailable，MUST NOT 伪装成「按来源规则」', async () => {
  const error = Object.assign(new Error('missing'), { code: '42P01' });
  const { pool } = fakePool(() => { throw error; });
  const store = new ApprovalPolicyStore({ schemaEnsurer: ensureCapabilitySchema, pool });
  assert.deepEqual(
    await store.setOwnedEnvironmentCommentMode('u1', 'env-1', 'auto_approve_all', 'client:u1'),
    { ok: false, reason: 'policy_unavailable' },
  );
  assert.deepEqual(
    await store.getOwnedEnvironmentCommentPolicy('u1', 'env-1'),
    { ok: false, reason: 'policy_unavailable' },
  );
});

test('非法模式在触库前整块拒绝', async () => {
  const { pool, calls } = fakePool(() => ({ rows: [] }));
  const store = new ApprovalPolicyStore({ schemaEnsurer: ensureCapabilitySchema, pool });
  assert.deepEqual(
    await store.setOwnedEnvironmentCommentMode('u1', 'env-1', 'auto_approve' as never, 'client:u1'),
    { ok: false, reason: 'invalid_mode' },
  );
  assert.equal(calls.length, 0);
});
