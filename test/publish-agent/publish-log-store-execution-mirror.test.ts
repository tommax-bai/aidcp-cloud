/**
 * 执行态双写（change publish-log-split-prep：拆 publish_log 七态表的执行态那半，§5.4.6 模板 M1+M2）。
 *
 * 守两条不变量：
 *  - **双写两边都写到**：一次执行态迁移既落权威 publish_log，又落影子 publish_execution_state（以 record_id 关联）。
 *  - **fail-safe**：影子写失败 MUST NOT 破坏 / 阻塞主路径——发布链路是核心业务，影子挂了只告警。
 *
 * 桩用假 pool（照抄本目录既有单测风格）：按 SQL 文本把「主写 / 影子写」分流，不连真库。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PublishLogStore } from '../../src/publish-agent/publish-log-store.js';
import type { PublishRecord } from '../../src/publish-agent/types.js';

interface Call {
  sql: string;
  params: unknown[];
}

/** 假 pool：记录全部 query；影子写（命中 publish_execution_state）可选地抛错以验 fail-safe。 */
function makePool(opts: { throwOnMirror?: boolean; rejectRowCount?: number } = {}) {
  const calls: Call[] = [];
  const pool = {
    async query(sql: string, params: unknown[] = []) {
      calls.push({ sql, params });
      if (sql.includes('publish_execution_state')) {
        if (opts.throwOnMirror) throw new Error('shadow table exploded');
        return { rows: [], rowCount: 1 };
      }
      // publish_log 主写：insert 需回 id；rejectPendingApproval 的命中数可控。
      if (/INSERT INTO publish_log/.test(sql)) return { rows: [{ id: 4242 }], rowCount: 1 };
      if (/status = 'needs_review'/.test(sql)) return { rows: [], rowCount: opts.rejectRowCount ?? 1 };
      return { rows: [], rowCount: 1 };
    },
  };
  const mainWrites = () => calls.filter((c) => c.sql.includes('publish_log') && !c.sql.includes('publish_execution_state'));
  const mirrorWrites = () => calls.filter((c) => c.sql.includes('publish_execution_state'));
  return { pool, calls, mainWrites, mirrorWrites };
}

const baseRecord: PublishRecord = {
  id: 0,
  title: 't',
  content: 'c',
  sourceConcepts: [],
  sourceLikedIds: [],
  status: 'pending_approval',
  platformPostId: null,
};

test('updateStatus 双写：主写 publish_log + 影子 upsert publish_execution_state 都发生', async () => {
  const { pool, mainWrites, mirrorWrites } = makePool();
  const store = new PublishLogStore({ pool: pool as never });

  await store.updateStatus(7, 'submitted');

  assert.equal(mainWrites().length, 1, '主写 publish_log 恰一次');
  assert.match(mainWrites()[0].sql, /UPDATE publish_log SET status = \$2 WHERE id = \$1/);

  const mirror = mirrorWrites();
  assert.equal(mirror.length, 1, '影子 upsert 恰一次');
  assert.match(mirror[0].sql, /INSERT INTO publish_execution_state/);
  assert.match(mirror[0].sql, /ON CONFLICT \(record_id\) DO UPDATE/);
  assert.deepEqual(mirror[0].params, [7, 'submitted', null, null]);
});

test('insert 播种影子：以 RETURNING 的真实 id + 初始 status 落影子行', async () => {
  const { pool, mirrorWrites } = makePool();
  const store = new PublishLogStore({ pool: pool as never });

  const id = await store.insert({ ...baseRecord, status: 'pending_approval' });
  assert.equal(id, 4242);

  const mirror = mirrorWrites();
  assert.equal(mirror.length, 1);
  assert.deepEqual(mirror[0].params.slice(0, 2), [4242, 'pending_approval']);
});

test('updatePostId 双写：影子带 platform_post_id 与 post_url，status=published', async () => {
  const { pool, mirrorWrites } = makePool();
  const store = new PublishLogStore({ pool: pool as never });

  await store.updatePostId(9, 'POST_9', 'https://x/note?xsec=abc');

  const mirror = mirrorWrites();
  assert.equal(mirror.length, 1);
  assert.deepEqual(mirror[0].params, [9, 'published', 'POST_9', 'https://x/note?xsec=abc']);
});

test('fail-safe：影子写抛错时主路径仍成功、不抛（发布链路不被影子连累）', async () => {
  const { pool, mainWrites, mirrorWrites } = makePool({ throwOnMirror: true });
  const store = new PublishLogStore({ pool: pool as never });

  // 不得抛：影子的异常被 store 内部 try/catch 兜住。
  await store.updateStatus(11, 'failed');

  assert.equal(mainWrites().length, 1, '主写 publish_log 仍照常发生');
  assert.match(mainWrites()[0].sql, /UPDATE publish_log SET status = \$2/);
  assert.equal(mirrorWrites().length, 1, '影子确有尝试（随后抛错被吞）');

  // insert 同样 fail-safe：影子抛错不影响返回真实 id。
  const id = await store.insert(baseRecord);
  assert.equal(id, 4242);
});

test('条件双写：rejectPendingApproval 未命中（rowCount=0）时不写影子', async () => {
  const { pool, mirrorWrites } = makePool({ rejectRowCount: 0 });
  const store = new PublishLogStore({ pool: pool as never });

  const ok = await store.rejectPendingApproval(13);
  assert.equal(ok, false, '权威写未命中');
  assert.equal(mirrorWrites().length, 0, '权威写没发生迁移时影子不得记幻影态');
});
