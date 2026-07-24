/**
 * EventBus → outbox firehose 桥单元测试（change 2e-api-split）。
 *
 * 用内存 fake（FakeBus 模拟 EventBus.onAny/emit；FakePool 模拟 event_outbox / event_outbox_cursor 两表）
 * 验：tee 侧把 onAny 事件编码进 outbox payload（topic='panel.event'、payload={event,data}）；replay 侧
 * 用 OutboxConsumer 解码回 {event,data} 交给注入 sink；target 隔离；脏（循环引用）载荷被净化不抛崩。
 *
 * 测不到的（真机 PG 集成，留 backlog，见 event-outbox.integration.test.ts）：真 PostgreSQL 上的
 * BIGSERIAL 单调 / xmin 安全水位 / GREATEST 游标 CAS / jsonb 往返 / pg_notify 事务作用域投递。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PANEL_EVENT_OUTBOX_TOPIC,
  PanelEventReplay,
  bridgeEventBusToOutbox,
  decodePanelEventPayload,
  encodePanelEventPayload,
  toJsonSafe,
  type EventBusLike,
} from '../../src/transport/eventbus-outbox-bridge.js';
import type { OutboxQueryable } from '../../src/transport/event-outbox.js';

const silent = { log() {}, warn() {} };

/** 让 tee 侧 fire-and-forget 的写库微任务链跑完（emit 内两次 await：INSERT + pg_notify）。 */
const flush = () => new Promise((r) => setTimeout(r, 0));

/** 最小 EventBus：只实现 onAny + 一个测试用 emit 触发 wildcard。 */
class FakeBus implements EventBusLike {
  private readonly handlers = new Set<(event: string, data: unknown) => void>();
  onAny(handler: (event: string, data: unknown) => void): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }
  emit(event: string, data: unknown): void {
    for (const h of this.handlers) h(event, data);
  }
}

/** 内存桩：装 event_outbox 行 + (consumer,target) 游标，回应 emit/consumer 的五类 SQL（与 event-outbox.test.ts 同构，忽略 xmin 水位子句）。 */
class FakePool implements OutboxQueryable {
  private seq = 0;
  readonly events: { id: number; topic: string; payload: unknown; execution_target: string; created_at: Date }[] = [];
  readonly cursors = new Map<string, number>();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async query(sql: string, params: unknown[] = []): Promise<any> {
    const s = sql.trim();
    if (s.startsWith('INSERT INTO event_outbox ')) {
      const id = ++this.seq;
      this.events.push({
        id,
        topic: params[0] as string,
        payload: JSON.parse(params[1] as string),
        execution_target: params[2] as string,
        created_at: new Date(id * 1000),
      });
      return { rows: [{ id }], rowCount: 1 };
    }
    if (s.startsWith('SELECT pg_notify')) return { rows: [], rowCount: 1 };
    if (s.startsWith('SELECT last_id FROM event_outbox_cursor')) {
      const key = `${params[0] as string}|${params[1] as string}`;
      const last = this.cursors.get(key);
      return last === undefined ? { rows: [], rowCount: 0 } : { rows: [{ last_id: last }], rowCount: 1 };
    }
    if (s.startsWith('SELECT id, topic, payload')) {
      const target = params[0] as string;
      const afterId = Number(params[1]);
      const limit = Number(params[2]);
      const rows = this.events
        .filter((e) => e.execution_target === target && e.id > afterId)
        .sort((a, b) => a.id - b.id)
        .slice(0, limit);
      return { rows, rowCount: rows.length };
    }
    if (s.startsWith('INSERT INTO event_outbox_cursor')) {
      const key = `${params[0] as string}|${params[1] as string}`;
      const next = Number(params[2]);
      this.cursors.set(key, Math.max(this.cursors.get(key) ?? 0, next));
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`FakePool: 未预期的 SQL: ${s.slice(0, 60)}`);
  }
}

// ── 编解码纯函数 ───────────────────────────────────────────────────────────────

test('encode/decode round-trip：{event,data} 原样往返', () => {
  const enc = encodePanelEventPayload('note.detail', { noteId: 'abc', n: 3 });
  assert.deepEqual(enc, { event: 'note.detail', data: { noteId: 'abc', n: 3 } });
  assert.deepEqual(decodePanelEventPayload(enc), { event: 'note.detail', data: { noteId: 'abc', n: 3 } });
});

test('decode：形状不符（缺 event / 非对象）返回 null', () => {
  assert.equal(decodePanelEventPayload(null), null);
  assert.equal(decodePanelEventPayload({ data: 1 }), null);
  assert.equal(decodePanelEventPayload('x'), null);
});

test('toJsonSafe：循环引用不抛，逐字段丢弃不可序列化的', () => {
  const circular: Record<string, unknown> = { keep: 1 };
  circular.self = circular; // 循环
  const safe = toJsonSafe(circular) as Record<string, unknown>;
  assert.equal(safe.keep, 1);
  // self 字段（循环）被丢弃，整体仍可 JSON 化
  assert.doesNotThrow(() => JSON.stringify(safe));
  assert.equal('self' in safe, false);
});

// ── tee → replay 端到端 ────────────────────────────────────────────────────────

test('tee 把 onAny 事件编码进 outbox（topic=panel.event）；replay 解码交给 sink', async () => {
  const bus = new FakeBus();
  const pool = new FakePool();
  const unsub = bridgeEventBusToOutbox({ eventBus: bus, pool, executionTarget: 'dev', logger: silent });

  bus.emit('note.detail', { noteId: 'x' });
  bus.emit('page.scroll', { dy: 200 });
  await flush();

  // tee 侧：两条都进了 outbox，topic 固定为 panel.event，payload 为信封
  assert.equal(pool.events.length, 2);
  assert.ok(pool.events.every((e) => e.topic === PANEL_EVENT_OUTBOX_TOPIC));
  assert.deepEqual(pool.events[0].payload, { event: 'note.detail', data: { noteId: 'x' } });

  // replay 侧：解码回 (event, data) 交给注入 sink
  const got: { event: string; data: unknown }[] = [];
  const replay = new PanelEventReplay({
    pool,
    executionTarget: 'dev',
    sink: (event, data) => got.push({ event, data }),
    logger: silent,
  });
  const handled = await replay.runOnce();

  assert.equal(handled, 2);
  assert.deepEqual(got, [
    { event: 'note.detail', data: { noteId: 'x' } },
    { event: 'page.scroll', data: { dy: 200 } },
  ]);

  unsub();
});

test('target 隔离：tee 写 dev，replay ol 拿不到', async () => {
  const bus = new FakeBus();
  const pool = new FakePool();
  bridgeEventBusToOutbox({ eventBus: bus, pool, executionTarget: 'dev', logger: silent });
  bus.emit('e', { a: 1 });
  await flush();

  const got: unknown[] = [];
  const replay = new PanelEventReplay({ pool, executionTarget: 'ol', sink: (_e, d) => got.push(d), logger: silent });
  const handled = await replay.runOnce();
  assert.equal(handled, 0);
  assert.equal(got.length, 0);
});

test('unsub 后 tee 不再写库', async () => {
  const bus = new FakeBus();
  const pool = new FakePool();
  const unsub = bridgeEventBusToOutbox({ eventBus: bus, pool, executionTarget: 'dev', logger: silent });
  unsub();
  bus.emit('e', { a: 1 });
  await flush();
  assert.equal(pool.events.length, 0);
});

test('replay：脏（循环引用）载荷被净化后仍能回放，sink 拿到可序列化数据', async () => {
  const bus = new FakeBus();
  const pool = new FakePool();
  bridgeEventBusToOutbox({ eventBus: bus, pool, executionTarget: 'dev', logger: silent });

  const dirty: Record<string, unknown> = { keep: 'ok' };
  dirty.loop = dirty;
  bus.emit('risk.signal', dirty);
  await flush();
  assert.equal(pool.events.length, 1); // 没有因脏载荷抛崩

  const got: unknown[] = [];
  const replay = new PanelEventReplay({ pool, executionTarget: 'dev', sink: (_e, d) => got.push(d), logger: silent });
  await replay.runOnce();
  assert.equal((got[0] as Record<string, unknown>).keep, 'ok');
  assert.doesNotThrow(() => JSON.stringify(got[0]));
});
