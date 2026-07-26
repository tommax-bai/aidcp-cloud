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
import { PANEL_FRAME_MAX_BYTES } from '../../src/kernel/panel-frame-limits.js';
import {
  PANEL_EVENT_DELIVERY_CONTRACT_VERSION,
  type PanelEventDelivery,
} from '../../src/kernel/panel-event-delivery-port.js';
import { PANEL_WS_MAX_FRAME_BYTES } from '../../src/panel/panel-ws.js';

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

/** 内存桩：装 event_outbox 行 + 两级游标（主题维 / 遗留聚合），回应 emit/consumer 的各类 SQL（与 event-outbox.test.ts 同构，忽略 xmin 水位子句）。 */
class FakePool implements OutboxQueryable {
  private seq = 0;
  readonly events: { id: number; topic: string; payload: unknown; execution_target: string; created_at: Date }[] = [];
  readonly cursors = new Map<string, number>();
  readonly topicCursors = new Map<string, number>();

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
    if (s.startsWith('SELECT COALESCE(')) {
      const [consumer, target, topic] = params as [string, string, string];
      const scoped = this.topicCursors.get(`${consumer}|${target}|${topic}`);
      const legacy = this.cursors.get(`${consumer}|${target}`);
      return { rows: [{ last_id: scoped ?? legacy ?? 0 }], rowCount: 1 };
    }
    if (s.startsWith('SELECT id, topic, payload')) {
      const target = params[0] as string;
      const topic = params[1] as string;
      const afterId = Number(params[2]);
      const limit = Number(params[3]);
      const rows = this.events
        .filter((e) => e.execution_target === target && e.topic === topic && e.id > afterId)
        .sort((a, b) => a.id - b.id)
        .slice(0, limit);
      return { rows, rowCount: rows.length };
    }
    if (s.startsWith('INSERT INTO event_outbox_topic_cursor')) {
      const key = `${params[0] as string}|${params[1] as string}|${params[2] as string}`;
      const next = Number(params[3]);
      this.topicCursors.set(key, Math.max(this.topicCursors.get(key) ?? 0, next));
      return { rows: [], rowCount: 1 };
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

test('encode/decode round-trip：{event,data,ts} 原样往返', () => {
  const enc = encodePanelEventPayload('note.detail', { noteId: 'abc', n: 3 }, 1_700_000_000_000);
  assert.deepEqual(enc, { event: 'note.detail', data: { noteId: 'abc', n: 3 }, ts: 1_700_000_000_000 });
  assert.deepEqual(decodePanelEventPayload(enc), {
    event: 'note.detail',
    data: { noteId: 'abc', n: 3 },
    ts: 1_700_000_000_000,
  });
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
  const unsub = bridgeEventBusToOutbox({
    eventBus: bus,
    pool,
    executionTarget: 'dev',
    now: () => 1_700_000_000_000,
    logger: silent,
  });

  bus.emit('note.detail', { noteId: 'x' });
  bus.emit('page.scroll', { dy: 200 });
  await flush();

  // tee 侧：两条都进了 outbox，topic 固定为 panel.event，payload 为信封
  assert.equal(pool.events.length, 2);
  assert.ok(pool.events.every((e) => e.topic === PANEL_EVENT_OUTBOX_TOPIC));
  assert.deepEqual(pool.events[0].payload, {
    event: 'note.detail',
    data: { noteId: 'x' },
    ts: 1_700_000_000_000,
  });

  // replay 侧：解码成带稳定 deliveryId 的版本化信封，逐条交给注入 sink
  const got: PanelEventDelivery[] = [];
  const replay = new PanelEventReplay({
    pool,
    executionTarget: 'dev',
    sink: (delivery) => {
      got.push(delivery);
    },
    logger: silent,
  });
  const handled = await replay.runOnce();

  assert.equal(handled, 2);
  assert.deepEqual(got, [
    {
      contractVersion: PANEL_EVENT_DELIVERY_CONTRACT_VERSION,
      executionTarget: 'dev',
      deliveryId: 'event_outbox:dev:1',
      event: 'note.detail',
      data: { noteId: 'x' },
      originTs: 1_700_000_000_000,
    },
    {
      contractVersion: PANEL_EVENT_DELIVERY_CONTRACT_VERSION,
      executionTarget: 'dev',
      deliveryId: 'event_outbox:dev:2',
      event: 'page.scroll',
      data: { dy: 200 },
      originTs: 1_700_000_000_000,
    },
  ]);

  unsub();
});

// ── A6：信封原始时间戳（回放不得被面板当成「刚刚发生」）────────────────────────────

test('回放透传原始时刻；老行（信封无 ts）回落到 outbox 行的 created_at，绝不冒充「此刻」', async () => {
  const pool = new FakePool();
  // 手写一条「本字段加入之前」的老行：payload 只有 {event,data}，没有 ts
  pool.events.push({
    id: 1,
    topic: PANEL_EVENT_OUTBOX_TOPIC,
    payload: { event: 'legacy.event', data: { a: 1 } },
    execution_target: 'dev',
    created_at: new Date(1000),
  });

  const got: (number | undefined)[] = [];
  const replay = new PanelEventReplay({
    pool,
    executionTarget: 'dev',
    sink: (delivery) => {
      got.push(delivery.originTs);
    },
    logger: silent,
  });
  await replay.runOnce();

  // FakePool 给第 1 行的 created_at = new Date(1 * 1000)
  assert.deepEqual(got, [1000]);
});

// ── 单帧上限：超限降级为摘要，绝不静默丢弃 ─────────────────────────────────────────

test('tee 侧超限载荷降级为摘要帧（truncated 标记 + 原始体积），事件本身不丢', async () => {
  const bus = new FakeBus();
  const pool = new FakePool();
  bridgeEventBusToOutbox({
    eventBus: bus,
    pool,
    executionTarget: 'dev',
    maxBytes: 1024,
    now: () => 42,
    logger: silent,
  });

  bus.emit('page.cards.arrived', { cards: 'x'.repeat(4096) });
  await flush();

  assert.equal(pool.events.length, 1); // 事件仍在——降级不是丢弃
  const payload = pool.events[0].payload as { event: string; ts: number; data: Record<string, unknown> };
  assert.equal(payload.event, 'page.cards.arrived');
  assert.equal(payload.ts, 42);
  assert.equal(payload.data.truncated, true);
  assert.equal(payload.data.reason, 'payload_too_large');
  assert.ok((payload.data.bytes as number) > 4096);
  // 库里落的那条 JSON 明显小于原载荷（大 blob 被挡在生产库外）
  assert.ok(JSON.stringify(pool.events[0].payload).length < 1024);
});

test('tee 侧上限默认与推送端同源（两层共用 kernel 常量，MUST NOT 各写一份）', () => {
  assert.equal(PANEL_WS_MAX_FRAME_BYTES, PANEL_FRAME_MAX_BYTES);
});

test('target 隔离：tee 写 dev，replay ol 拿不到', async () => {
  const bus = new FakeBus();
  const pool = new FakePool();
  bridgeEventBusToOutbox({ eventBus: bus, pool, executionTarget: 'dev', logger: silent });
  bus.emit('e', { a: 1 });
  await flush();

  const got: unknown[] = [];
  const replay = new PanelEventReplay({
    pool,
    executionTarget: 'ol',
    sink: (delivery) => {
      got.push(delivery.data);
    },
    logger: silent,
  });
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
  const replay = new PanelEventReplay({
    pool,
    executionTarget: 'dev',
    sink: (delivery) => {
      got.push(delivery.data);
    },
    logger: silent,
  });
  await replay.runOnce();
  assert.equal((got[0] as Record<string, unknown>).keep, 'ok');
  assert.doesNotThrow(() => JSON.stringify(got[0]));
});

test('replay await HTTP sink：响应丢失时 cursor 不推进，下一轮以相同 deliveryId 重投', async () => {
  const pool = new FakePool();
  pool.events.push({
    id: 7,
    topic: PANEL_EVENT_OUTBOX_TOPIC,
    payload: { event: 'risk.changed', data: { status: 'restricted' }, ts: 7_000 },
    execution_target: 'dev',
    created_at: new Date(7_000),
  });
  const attempts: string[] = [];
  let loseResponse = true;
  const replay = new PanelEventReplay({
    pool,
    executionTarget: 'dev',
    sink: async (delivery) => {
      attempts.push(delivery.deliveryId);
      if (loseResponse) throw new Error('response_lost_after_fanout');
    },
    logger: silent,
  });

  assert.equal(await replay.runOnce(), 0);
  assert.equal(pool.topicCursors.get('panel-event-replay|dev|panel.event'), undefined);

  loseResponse = false;
  assert.equal(await replay.runOnce(), 1);
  assert.deepEqual(attempts, ['event_outbox:dev:7', 'event_outbox:dev:7']);
  assert.equal(pool.topicCursors.get('panel-event-replay|dev|panel.event'), 7);
});

test('replay 串行 await sink：前一条未确认时不会投递后一条', async () => {
  const pool = new FakePool();
  pool.events.push(
    {
      id: 1,
      topic: PANEL_EVENT_OUTBOX_TOPIC,
      payload: { event: 'first', data: null },
      execution_target: 'dev',
      created_at: new Date(1_000),
    },
    {
      id: 2,
      topic: PANEL_EVENT_OUTBOX_TOPIC,
      payload: { event: 'second', data: null },
      execution_target: 'dev',
      created_at: new Date(2_000),
    },
  );
  const order: string[] = [];
  let releaseFirst!: () => void;
  const firstAccepted = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const replay = new PanelEventReplay({
    pool,
    executionTarget: 'dev',
    sink: async (delivery) => {
      order.push(`start:${delivery.event}`);
      if (delivery.event === 'first') await firstAccepted;
      order.push(`done:${delivery.event}`);
    },
    logger: silent,
  });

  const run = replay.runOnce();
  await flush();
  assert.deepEqual(order, ['start:first']);
  releaseFirst();
  assert.equal(await run, 2);
  assert.deepEqual(order, ['start:first', 'done:first', 'start:second', 'done:second']);
});
