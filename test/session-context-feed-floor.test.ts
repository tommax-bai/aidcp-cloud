import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionContext } from '../src/agents/session-context.js';

// feed-scroll-card-floor：feedBatchNewCount 差分（简版「上一批」基准）。
// 调用方（RoleDispatcher）在 feed 来源时剔除缺 noteId 的卡后传入，故这里只测已过滤的 id 列表。

test('feedBatchNewCount：首批全新 → 全计', () => {
  const ctx = new SessionContext();
  assert.equal(ctx.feedBatchNewCount(['a', 'b', 'c']), 3);
});

test('feedBatchNewCount：返回未刷新（同一批 noteId）→ 0', () => {
  const ctx = new SessionContext();
  ctx.feedBatchNewCount(['a', 'b', 'c']);
  assert.equal(ctx.feedBatchNewCount(['a', 'b', 'c']), 0, '同批重报应算 0 新卡（返回未刷新不加延迟）');
});

test('feedBatchNewCount：部分重叠 → 只计真正的新卡', () => {
  const ctx = new SessionContext();
  ctx.feedBatchNewCount(['a', 'b', 'c']);
  assert.equal(ctx.feedBatchNewCount(['b', 'c', 'd', 'e']), 2, 'd,e 为新');
});

test('feedBatchNewCount：基准是「上一批」而非全时段（换批后旧 id 再现算新）', () => {
  const ctx = new SessionContext();
  ctx.feedBatchNewCount(['a', 'b', 'c']); // 上一批 = {a,b,c}
  ctx.feedBatchNewCount(['d']);           // 上一批 = {d}
  // a 曾在更早批出现，但不在「上一批 {d}」中 → 简版语义按新卡计（安全方向：多加停留）
  assert.equal(ctx.feedBatchNewCount(['a']), 1);
});

test('feedBatchNewCount：批内重复 noteId 去重计数', () => {
  const ctx = new SessionContext();
  assert.equal(ctx.feedBatchNewCount(['a', 'a', 'b']), 2, '同批重复只计一次');
});

test('feedBatchNewCount：空批 → 0（不改基准语义下一批全新）', () => {
  const ctx = new SessionContext();
  ctx.feedBatchNewCount(['a', 'b']);
  assert.equal(ctx.feedBatchNewCount([]), 0);
  // 空批把基准清空 → 下一批 {a} 相对空基准全新
  assert.equal(ctx.feedBatchNewCount(['a']), 1);
});

test('feedBatchNewCount：缺 noteId 的卡被调用方剔除后不使「返回未刷新」误判为新', () => {
  const ctx = new SessionContext();
  // 首批可解析 id = [a,b]（另有若干无 noteId 卡被调用方剔除，不入参）
  ctx.feedBatchNewCount(['a', 'b']);
  // 返回未刷新：同样只有 [a,b] 可解析 → 0 新卡
  assert.equal(ctx.feedBatchNewCount(['a', 'b']), 0);
});
