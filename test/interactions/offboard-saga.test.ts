/**
 * change offboard-saga 的聚焦回归：离场分表 saga 中断（Step B 失败）后重入清完剩余、
 * 翻到 purged、不遗漏也不重复。纯逻辑级（mock client / pool，无数据库连接）。
 *
 * 注：原本这里还有一条「离场写窄接口把写落在正确的离场表上」的用例，验的是那个**接调用方事务句柄**的
 * 旧形态。Block③ L3 最终一致改造把它整体换成了属主自开事务的物化操作，覆盖迁到
 * `offboard-materialization.test.ts`（含幂等、无绑定不编造、终态分支）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Pool } from 'pg';
import { InteractionStore } from '../../src/interactions/interaction-store.js';
import { InteractionApiWrites } from '../../src/interactions/interaction-api-writes.js';

/** Step A 清的 automation 表（绑定行 interaction_auth_state 已挪到 Step C，与翻 purged 同事务）。 */
const AUTOMATION_TABLES = [
  'interaction_threads', 'interaction_sync_batches', 'interaction_sync_cursors',
  'interaction_api_requests', 'interaction_runtime_controls',
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
      // 归属核验：账号仍绑在被离场的那个环境上 → 账号级清理放行。
      if (sql.includes('SELECT env_key FROM interaction_auth_state')) {
        return { rows: [{ env_key: 'env-1' }], rowCount: 1 };
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
  assert.equal(deleted.includes('interaction_auth_state'), false,
    '绑定行只在 Step C 与翻 purged 同事务删：中断时它必须还在，重入才能重算出同一个归属结论');
  assert.equal(offboardState, 'pending_edge', '离场行未翻 purged，可被下一轮再取到');

  // 重入：Step A 幂等重删 automation（无害）、Step B 补删 reply、Step C 删绑定 + 翻 purged。
  assert.equal(await store.purgeDueOffboards(1_784_044_900_000), 1);
  for (const t of REPLY_TABLES) assert.ok(deleted.includes(t), `reply 表重入应删完: ${t}`);
  assert.ok(deleted.includes('interaction_auth_state'), '重入跑完 Step C 才删绑定行');
  assert.equal(offboardState, 'purged');

  // 再跑一次：已 purged 不再入选，不重复删、不重复计数。
  const before = deleted.length;
  assert.equal(await store.purgeDueOffboards(1_784_044_900_000), 0);
  assert.equal(deleted.length, before);
});
