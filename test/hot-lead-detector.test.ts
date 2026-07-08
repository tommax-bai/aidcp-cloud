import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../src/event-bus/index.js';
import { HotLeadDetector } from '../src/hot-lead/hot-lead-detector.js';
import { MemoryHotLeadQueue } from '../src/hot-lead/hot-lead-queue.js';
import type { NoteDetailData } from '../src/event-bus/types.js';

function detail(over: Partial<NoteDetailData> = {}): NoteDetailData {
  return {
    noteId: 'n1',
    title: '一篇很火的帖',
    content: 'body',
    likeCount: 5000,
    collectCount: 100,
    publishedAtText: '2小时前',
    ...over,
  };
}

function makeDetector(over: {
  hasCommented?: (a: string, n: string) => Promise<boolean>;
} = {}) {
  const bus = new EventBus();
  const queue = new MemoryHotLeadQueue();
  const detector = new HotLeadDetector({
    eventBus: bus,
    queue,
    getAccountId: () => 'acc-1',
    ...(over.hasCommented ? { hasCommented: over.hasCommented } : {}),
  });
  detector.subscribe();
  return { bus, queue, detector };
}

// 帮助：等 fire-and-forget 的 quality.pass 处理完（微任务队列排空）
const flush = () => new Promise((r) => setTimeout(r, 5));

test('quality.pass + 命中热度闸 → 入队', async () => {
  const { bus, queue } = makeDetector();
  bus.emit('note.detail.arrived', { detail: detail(), accountId: 'acc-1', ts: 1 });
  bus.emit('quality.pass', { noteId: 'n1', sourcePageType: 'feed', reason: 'ok', ts: 2 });
  await flush();
  const pend = await queue.listPending('acc-1');
  assert.equal(pend.length, 1);
  assert.equal(pend[0].noteId, 'n1');
  assert.equal(pend[0].snapshot.velocity, 2500);
});

test('quality.reject 的帖不入队（即使很火）', async () => {
  const { bus, queue } = makeDetector();
  bus.emit('note.detail.arrived', { detail: detail(), accountId: 'acc-1', ts: 1 });
  bus.emit('quality.reject', { noteId: 'n1', sourcePageType: 'feed', reason: 'low_quality', ts: 2 });
  await flush();
  assert.equal((await queue.listPending('acc-1')).length, 0);
});

test('未命中热度闸（裸日期超窗）→ 不入队', async () => {
  const { bus, queue } = makeDetector();
  bus.emit('note.detail.arrived', { detail: detail({ publishedAtText: '07-05' }), accountId: 'acc-1', ts: 1 });
  bus.emit('quality.pass', { noteId: 'n1', sourcePageType: 'feed', reason: 'ok', ts: 2 });
  await flush();
  assert.equal((await queue.listPending('acc-1')).length, 0);
});

test('缓存 miss（quality.pass 的 noteId 无对应详情）→ 跳过', async () => {
  const { bus, queue } = makeDetector();
  bus.emit('note.detail.arrived', { detail: detail({ noteId: 'n1' }), accountId: 'acc-1', ts: 1 });
  bus.emit('quality.pass', { noteId: 'OTHER', sourcePageType: 'feed', reason: 'ok', ts: 2 });
  await flush();
  assert.equal((await queue.listPending('acc-1')).length, 0);
});

test('已评过 → 不入队（hasCommented 去重）', async () => {
  const { bus, queue } = makeDetector({ hasCommented: async () => true });
  bus.emit('note.detail.arrived', { detail: detail(), accountId: 'acc-1', ts: 1 });
  bus.emit('quality.pass', { noteId: 'n1', sourcePageType: 'feed', reason: 'ok', ts: 2 });
  await flush();
  assert.equal((await queue.listPending('acc-1')).length, 0);
});

test('refreshOnly 图快照不缓存、不误触发', async () => {
  const { bus, queue } = makeDetector();
  bus.emit('note.detail.arrived', { detail: detail({ refreshOnly: true }), accountId: 'acc-1', ts: 1 });
  bus.emit('quality.pass', { noteId: 'n1', sourcePageType: 'feed', reason: 'ok', ts: 2 });
  await flush();
  assert.equal((await queue.listPending('acc-1')).length, 0);
});
