/**
 * change offboard-saga 的聚焦回归：
 *   1) 离场分表 saga 中断（Step B 失败）后重入清完剩余、翻到 purged、不遗漏也不重复；
 *   2) 离场写窄接口（automation 属主 offboard-write-adapter）把写落在正确的离场表上。
 * 均为纯逻辑级（mock client / pool，无数据库连接）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Pool } from 'pg';
import { InteractionStore } from '../../src/interactions/interaction-store.js';
import { InteractionApiWrites } from '../../src/interactions/interaction-api-writes.js';
import { OffboardWriteAdapter } from '../../src/interactions/offboard-write-adapter.js';

const AUTOMATION_TABLES = [
  'interaction_threads', 'interaction_sync_batches', 'interaction_sync_cursors',
  'interaction_api_requests', 'interaction_auth_state', 'interaction_runtime_controls',
];
const REPLY_TABLES = [
  'reply_templates', 'reply_rules', 'account_reply_profiles',
  'interaction_reply_config_versions', 'interaction_reply_configs',
];

test('purge saga: Step B failure leaves automation data purged but offboard un-purged; re-entry finishes the rest', async () => {
  let offboardState: 'pending_edge' | 'dispatched' | 'tombstoned' | 'purged' = 'pending_edge';
  const deleted: string[] = [];
  const client = {
    query: async (sql: string) => {
      if (sql.includes('SELECT offboard_id,account_id,env_key,user_id,edge_result_status')) {
        if (offboardState === 'purged') return { rows: [], rowCount: 0 };
        return { rows: [{ offboard_id: 'off-1', account_id: 'acct-1', env_key: 'env-1',
          user_id: 'user-1', edge_result_status: null }], rowCount: 1 };
      }
      const del = sql.match(/DELETE FROM (\w+)/);
      if (del) { deleted.push(del[1]); return { rows: [], rowCount: 1 }; }
      if (sql.includes("UPDATE interaction_offboards SET state='purged'")) {
        if (offboardState === 'purged') return { rows: [], rowCount: 0 };
        offboardState = 'purged';
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    release: () => {},
  };
  const pool = { connect: async () => client } as unknown as Pool;

  // 用真实 api 写者，只在第一次调用时人为失败，验证「窄接口 + 重入」。
  const realApi = new InteractionApiWrites();
  let replyCalls = 0;
  const apiPurge = {
    purgeReplyConfigForAccount: async (c: Parameters<InteractionApiWrites['purgeReplyConfigForAccount']>[0], accountId: string) => {
      replyCalls += 1;
      if (replyCalls === 1) throw new Error('simulated step B failure');
      return realApi.purgeReplyConfigForAccount(c, accountId);
    },
    purgeExpiredAuditEvents: (c: Parameters<InteractionApiWrites['purgeExpiredAuditEvents']>[0], now: number) =>
      realApi.purgeExpiredAuditEvents(c, now),
  };
  const store = new InteractionStore({ pool, idGen: (p) => `${p}-test`, apiPurge });

  // 首跑：Step B 抛错 → 整个 purge 抛出；automation 侧已删、离场未翻 purged、reply 未删。
  await assert.rejects(store.purgeDueOffboards(1_784_044_900_000), /simulated step B failure/);
  for (const t of AUTOMATION_TABLES) assert.ok(deleted.includes(t), `automation 表应已删: ${t}`);
  for (const t of REPLY_TABLES) assert.ok(!deleted.includes(t), `reply 表首跑不应删: ${t}`);
  assert.equal(offboardState, 'pending_edge', '离场行未翻 purged，可被下一轮再取到');

  // 重入：Step A 幂等重删 automation（无害）、Step B 补删 reply、Step C 翻 purged。
  assert.equal(await store.purgeDueOffboards(1_784_044_900_000), 1);
  for (const t of REPLY_TABLES) assert.ok(deleted.includes(t), `reply 表重入应删完: ${t}`);
  assert.equal(offboardState, 'purged');
});

test('OffboardWriteAdapter.enqueueOffboard writes offboard + revoke + audit on the passed client (automation 属主表)', async () => {
  const sqls: string[] = [];
  const client = {
    query: async (sql: string) => {
      sqls.push(sql);
      if (sql.includes('INSERT INTO interaction_offboards')) {
        return { rows: [{ offboard_id: 'off-1', env_key: 'env-1', account_id: 'acct-1',
          state: 'pending_edge', reason: 'environment_unbind',
          requested_at: new Date(1), purge_due_at: new Date(2) }], rowCount: 1 };
      }
      return { rows: [{ account_id: 'acct-1' }], rowCount: 1 };
    },
  };
  const adapter = new OffboardWriteAdapter();
  const row = await adapter.enqueueOffboard(
    client as unknown as Parameters<OffboardWriteAdapter['enqueueOffboard']>[0],
    { userId: 'user-1', envKey: 'env-1', accountId: 'acct-1', reason: 'environment_unbind', actor: 'client:user-1' },
  );
  assert.equal(row.offboard_id, 'off-1');
  assert.ok(sqls.some((s) => s.includes('INSERT INTO interaction_offboards')), '写离场记录');
  assert.ok(sqls.some((s) => s.includes('UPDATE interaction_runtime_controls')), '收权运行控制');
  assert.ok(sqls.some((s) => s.includes('UPDATE interaction_auth_state')), '收权鉴权态');
  assert.ok(sqls.some((s) => s.includes('INSERT INTO interaction_offboard_audit')), '写离场审计');
});
