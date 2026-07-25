import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../src/event-bus/index.js';
import { HotLeadDetector, type FireAutoContactArgs } from '../src/hot-lead/hot-lead-detector.js';
import type { NoteDetailData } from '../src/kernel/note-detail.js';

function detail(over: Partial<NoteDetailData> = {}): NoteDetailData {
  return { noteId: 'n1', title: '一篇很火的帖', content: 'body', likeCount: 5000, collectCount: 100, publishedAtText: '2小时前', ...over };
}

function makeDetector(over: {
  enabled?: boolean;
  hasCommented?: boolean;
  fired?: boolean;
  sessionRemaining?: number;
} = {}) {
  const bus = new EventBus();
  const calls = { fired: 0, consumed: 0, lastArgs: null as FireAutoContactArgs | null };
  let budget = over.sessionRemaining ?? 5;
  const detector = new HotLeadDetector({
    eventBus: bus,
    getAccountId: () => 'acc-1',
    isAutoContactEnabled: async () => over.enabled ?? true,
    hasCommented: async () => over.hasCommented ?? false,
    fireAutoContactComment: async (args) => {
      calls.fired++;
      calls.lastArgs = args;
      return { fired: over.fired ?? true };
    },
    getSessionCommentBudgetRemaining: () => budget,
    consumeSessionCommentBudget: () => { calls.consumed++; budget -= 1; },
  });
  detector.subscribe();
  return { bus, calls };
}

const flush = () => new Promise((r) => setTimeout(r, 5));

function pass(bus: EventBus, d: NoteDetailData) {
  bus.emit('note.detail.arrived', { detail: d, accountId: 'acc-1', ts: 1 });
  bus.emit('quality.pass', { noteId: d.noteId, sourcePageType: 'feed', reason: 'ok', ts: 2 });
}

test('命中 + 账号开 + 过闸 → 触发 + 消耗单场预算', async () => {
  const { bus, calls } = makeDetector();
  pass(bus, detail());
  await flush();
  assert.equal(calls.fired, 1);
  assert.equal(calls.consumed, 1);
  assert.equal(calls.lastArgs?.noteId, 'n1');
  assert.equal(calls.lastArgs?.currentDetail.noteId, 'n1');
  assert.equal(calls.lastArgs?.currentDetail.content, 'body');
});

test('账号未开自动联系评论 → 不触发（零回归）', async () => {
  const { bus, calls } = makeDetector({ enabled: false });
  pass(bus, detail());
  await flush();
  assert.equal(calls.fired, 0);
});

test('quality.reject → 不触发', async () => {
  const { bus, calls } = makeDetector();
  bus.emit('note.detail.arrived', { detail: detail(), accountId: 'acc-1', ts: 1 });
  bus.emit('quality.reject', { noteId: 'n1', sourcePageType: 'feed', reason: 'low', ts: 2 });
  await flush();
  assert.equal(calls.fired, 0);
});

test('未命中热度闸（裸日期超窗）→ 不触发', async () => {
  const { bus, calls } = makeDetector();
  pass(bus, detail({ publishedAtText: '07-05' }));
  await flush();
  assert.equal(calls.fired, 0);
});

test('已评过 → 不触发', async () => {
  const { bus, calls } = makeDetector({ hasCommented: true });
  pass(bus, detail());
  await flush();
  assert.equal(calls.fired, 0);
});

test('单场评论预算耗尽 → 不触发', async () => {
  const { bus, calls } = makeDetector({ sessionRemaining: 0 });
  pass(bus, detail());
  await flush();
  assert.equal(calls.fired, 0);
});

test('短时 triggered 标记：同一 note 触发后不再重触发', async () => {
  const { bus, calls } = makeDetector();
  pass(bus, detail());
  await flush();
  pass(bus, detail());
  await flush();
  assert.equal(calls.fired, 1);
});

test('缓存 miss（quality.pass 的 noteId 无对应详情）→ 跳过', async () => {
  const { bus, calls } = makeDetector();
  bus.emit('note.detail.arrived', { detail: detail({ noteId: 'n1' }), accountId: 'acc-1', ts: 1 });
  bus.emit('quality.pass', { noteId: 'OTHER', sourcePageType: 'feed', reason: 'ok', ts: 2 });
  await flush();
  assert.equal(calls.fired, 0);
});
