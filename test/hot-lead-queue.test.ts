import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryHotLeadQueue, type HotLeadInput } from '../src/hot-lead/hot-lead-queue.js';

function lead(accountId: string, noteId: string): HotLeadInput {
  return { accountId, noteId, snapshot: { title: 't', likeCount: 5000, velocity: 2500, ageHours: 2 } };
}

test('入队成功、可列 pending（新→旧）', async () => {
  const q = new MemoryHotLeadQueue();
  const a = await q.enqueue(lead('acc-1', 'n1'));
  const b = await q.enqueue(lead('acc-1', 'n2'));
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  const pend = await q.listPending('acc-1');
  assert.deepEqual(pend.map((r) => r.noteId), ['n2', 'n1']);
});

test('队列内 pending 去重：同账号同 noteId 不重复入队', async () => {
  const q = new MemoryHotLeadQueue();
  const first = await q.enqueue(lead('acc-1', 'n1'));
  const dup = await q.enqueue(lead('acc-1', 'n1'));
  assert.equal(first.ok, true);
  assert.equal(dup.ok, false);
  assert.equal((dup as { reason: string }).reason, 'duplicate_pending');
  assert.equal((await q.listPending('acc-1')).length, 1);
});

test('按账号隔离', async () => {
  const q = new MemoryHotLeadQueue();
  await q.enqueue(lead('acc-1', 'n1'));
  await q.enqueue(lead('acc-2', 'n1'));
  assert.equal((await q.listPending('acc-1')).length, 1);
  assert.equal((await q.listPending('acc-2')).length, 1);
});

test('actioned 后不再出现在 pending；同 noteId 可再入队', async () => {
  const q = new MemoryHotLeadQueue();
  const r = await q.enqueue(lead('acc-1', 'n1'));
  assert.equal(r.ok, true);
  await q.markActioned((r as { id: number }).id);
  assert.equal((await q.listPending('acc-1')).length, 0);
  // dismissed/actioned 后同 noteId 允许再入队（部分唯一索引只约束 pending）
  const again = await q.enqueue(lead('acc-1', 'n1'));
  assert.equal(again.ok, true);
});

test('dismissed 后不再出现在 pending', async () => {
  const q = new MemoryHotLeadQueue();
  const r = await q.enqueue(lead('acc-1', 'n1'));
  await q.markDismissed((r as { id: number }).id);
  assert.equal((await q.listPending('acc-1')).length, 0);
});
