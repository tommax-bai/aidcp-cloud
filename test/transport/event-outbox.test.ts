/**
 * event-outbox 传输原语单元测试（change block2-outbox-transport）。零数据库依赖：用内存桩 queryable
 * 模拟 event_outbox / event_outbox_cursor 两表，验 emit 的 SQL 形状与 consumer 的
 * 批读 → 分派 → 游标推进 / at-least-once / target 过滤逻辑。
 *
 * 测不到的（真机验收项，见 event-outbox.integration.test.ts）：真 PostgreSQL 上 BIGSERIAL 的
 * id 单调、GREATEST upsert 的并发 CAS、jsonb 往返、pg_notify 的事务作用域投递。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  EVENT_OUTBOX_NOTIFY_CHANNEL,
  OutboxConsumer,
  emitOutboxEvent,
  isExecutionTarget,
  type OutboxEvent,
  type OutboxQueryable,
} from '../../src/transport/event-outbox.js';

const silent = { log() {}, warn() {} };

interface Call {
  sql: string;
  params: unknown[];
}

/**
 * 内存桩：装 event_outbox 行、`(consumer,target,topic)` 主题游标与遗留 `(consumer,target)` 聚合游标，
 * 按 SQL 关键字回应 emit/consumer 的六类查询。记录每次调用，供断言 SQL 形状与参数。
 */
class FakePool implements OutboxQueryable {
  readonly calls: Call[] = [];
  private seq = 0;
  readonly events: {
    id: number;
    topic: string;
    payload: unknown;
    execution_target: string;
    created_at: Date;
  }[] = [];
  /** 遗留聚合游标：`consumer|target`。 */
  readonly cursors = new Map<string, number>();
  /** 分维游标：`consumer|target|topic`。 */
  readonly topicCursors = new Map<string, number>();
  notifyFails = false;

  seed(topic: string, payload: unknown, target: string): number {
    const id = ++this.seq;
    this.events.push({ id, topic, payload, execution_target: target, created_at: new Date(id * 1000) });
    return id;
  }

  // 桩 query 返回 any：pg.QueryResult 的完整字段（command/oid/fields）本测试用不到，
  // 用 any 令 FakePool 结构上满足 OutboxQueryable 的泛型 query 签名。
  async query(sql: string, params: unknown[] = []): Promise<any> {
    this.calls.push({ sql, params });
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
    if (s.startsWith('SELECT pg_notify')) {
      if (this.notifyFails) throw new Error('notify boom');
      return { rows: [], rowCount: 1 };
    }
    // 两级回落读游标：主题行 → 遗留聚合行 → 0（COALESCE 语义）
    if (s.startsWith('SELECT COALESCE(')) {
      const [consumer, target, topic] = params as [string, string, string];
      const scoped = this.topicCursors.get(`${consumer}|${target}|${topic}`);
      const legacy = this.cursors.get(`${consumer}|${target}`);
      return { rows: [{ last_id: scoped ?? legacy ?? 0 }], rowCount: 1 };
    }
    if (s.startsWith('SELECT count(*)::bigint AS pending')) {
      const [target, topic, after] = params as [string, string, number];
      const pending = this.events.filter(
        (e) => e.execution_target === target && e.topic === topic && e.id > Number(after),
      ).length;
      return { rows: [{ pending }], rowCount: 1 };
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
      this.topicCursors.set(key, Math.max(this.topicCursors.get(key) ?? 0, next)); // GREATEST 语义
      return { rows: [], rowCount: 1 };
    }
    if (s.startsWith('INSERT INTO event_outbox_cursor')) {
      const key = `${params[0] as string}|${params[1] as string}`;
      const next = Number(params[2]);
      const prev = this.cursors.get(key) ?? 0;
      this.cursors.set(key, Math.max(prev, next)); // GREATEST 语义
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`FakePool: 未预期的 SQL: ${s.slice(0, 60)}`);
  }
}

// ── emit ────────────────────────────────────────────────────────────────────

test('emit：INSERT 到 event_outbox（jsonb 转型）+ pg_notify，返回 id', async () => {
  const pool = new FakePool();
  const { id } = await emitOutboxEvent(pool, { topic: 'risk.signal', payload: { a: 1 }, executionTarget: 'dev' }, silent);
  assert.equal(id, 1);

  const insert = pool.calls.find((c) => c.sql.includes('INSERT INTO event_outbox '));
  assert.ok(insert, '应发 INSERT');
  assert.match(insert.sql, /\$2::jsonb/);
  assert.deepEqual(insert.params, ['risk.signal', JSON.stringify({ a: 1 }), 'dev']);

  const notify = pool.calls.find((c) => c.sql.includes('pg_notify'));
  assert.ok(notify, '应发 pg_notify 加速器');
  assert.deepEqual(notify.params, [EVENT_OUTBOX_NOTIFY_CHANNEL, 'risk.signal']);
});

test('emit：pg_notify 失败只 warn、不影响返回 id（轮询兜底）', async () => {
  const pool = new FakePool();
  pool.notifyFails = true;
  const { id } = await emitOutboxEvent(pool, { topic: 't', payload: null, executionTarget: 'ol' }, silent);
  assert.equal(id, 1);
});

test('emit：非法 target 抛错，不写库', async () => {
  const pool = new FakePool();
  await assert.rejects(
    emitOutboxEvent(pool, { topic: 't', payload: {}, executionTarget: 'prod' }, silent),
    /非法 executionTarget/,
  );
  assert.equal(pool.calls.length, 0);
});

test('emit：空 topic 抛错', async () => {
  const pool = new FakePool();
  await assert.rejects(
    emitOutboxEvent(pool, { topic: '', payload: {}, executionTarget: 'dev' }, silent),
    /topic 不能为空/,
  );
});

test('isExecutionTarget：只认 dev/ol', () => {
  assert.equal(isExecutionTarget('dev'), true);
  assert.equal(isExecutionTarget('ol'), true);
  assert.equal(isExecutionTarget('prod'), false);
  assert.equal(isExecutionTarget(undefined), false);
});

// ── consumer 构造 ─────────────────────────────────────────────────────────────

test('consumer：非法 target 构造即抛（target 缺失/非法不启动）', () => {
  assert.throws(
    () => new OutboxConsumer({ consumer: 'c', executionTarget: 'x', pool: new FakePool(), handlers: new Map() }),
    /非法 executionTarget/,
  );
});

test('consumer：batchSize 非正整数构造即抛（挡住 LIMIT 0 空转脚枪）', () => {
  for (const bad of [0, -1, 1.5, Number.NaN]) {
    assert.throws(
      () => new OutboxConsumer({ consumer: 'c', executionTarget: 'dev', pool: new FakePool(), handlers: new Map(), batchSize: bad }),
      /batchSize 必须为正整数/,
      `batchSize=${bad} 应抛`,
    );
  }
  // 合法值不抛
  assert.doesNotThrow(
    () => new OutboxConsumer({ consumer: 'c', executionTarget: 'dev', pool: new FakePool(), handlers: new Map(), batchSize: 1 }),
  );
});

test('consumer：pollIntervalMs 负/非有限构造即抛', () => {
  for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => new OutboxConsumer({ consumer: 'c', executionTarget: 'dev', pool: new FakePool(), handlers: new Map(), pollIntervalMs: bad }),
      /pollIntervalMs 必须为非负有限数/,
      `pollIntervalMs=${bad} 应抛`,
    );
  }
  assert.doesNotThrow(
    () => new OutboxConsumer({ consumer: 'c', executionTarget: 'dev', pool: new FakePool(), handlers: new Map(), pollIntervalMs: 0 }),
  );
});

// ── consumer 批读 → 分派 → 游标推进 ───────────────────────────────────────────

function makeConsumer(pool: FakePool, handlers: Map<string, (e: OutboxEvent) => Promise<void>>, opts?: { batchSize?: number; consumer?: string }) {
  return new OutboxConsumer({
    consumer: opts?.consumer ?? 'c1',
    executionTarget: 'dev',
    pool,
    handlers,
    batchSize: opts?.batchSize ?? 100,
    logger: silent,
  });
}

test('consumer：批读 → 逐条 dispatch → 游标落到本批最后 id', async () => {
  const pool = new FakePool();
  pool.seed('t', { n: 1 }, 'dev');
  pool.seed('t', { n: 2 }, 'dev');
  pool.seed('t', { n: 3 }, 'dev');
  const seen: number[] = [];
  const handlers = new Map([['t', async (e: OutboxEvent) => { seen.push((e.payload as { n: number }).n); }]]);
  const consumer = makeConsumer(pool, handlers);

  const processed = await consumer.runOnce();
  assert.equal(processed, 3);
  assert.deepEqual(seen, [1, 2, 3]);
  assert.equal(pool.topicCursors.get('c1|dev|t'), 3, '主题游标落到 3');
  assert.equal(pool.cursors.get('c1|dev'), 3, '遗留聚合游标同步到各主题最小值（回滚兼容）');
});

test('consumer：target 过滤——只消费本 target 的行', async () => {
  const pool = new FakePool();
  pool.seed('t', { n: 1 }, 'dev');
  pool.seed('t', { n: 2 }, 'ol'); // 另一 target，MUST NOT 被 dev 消费者看到
  pool.seed('t', { n: 3 }, 'dev');
  const seen: number[] = [];
  const handlers = new Map([['t', async (e: OutboxEvent) => { seen.push((e.payload as { n: number }).n); }]]);
  const consumer = makeConsumer(pool, handlers);

  await consumer.runOnce();
  assert.deepEqual(seen, [1, 3]);
  // 游标推进到本 target 见到的最后一条（id=3），ol 的 id=2 不算数
  assert.equal(pool.topicCursors.get('c1|dev|t'), 3);
});

test('consumer：handler 抛错 → 游标停在失败条之前，只推进到此前连续成功条（at-least-once）', async () => {
  const pool = new FakePool();
  pool.seed('t', { n: 1 }, 'dev'); // id 1 ok
  pool.seed('t', { n: 2 }, 'dev'); // id 2 ok
  pool.seed('t', { n: 3 }, 'dev'); // id 3 抛
  pool.seed('t', { n: 4 }, 'dev'); // id 4 不该被处理（停在 3 之前）
  const seen: number[] = [];
  const handlers = new Map([
    ['t', async (e: OutboxEvent) => {
      const n = (e.payload as { n: number }).n;
      if (n === 3) throw new Error('handler boom');
      seen.push(n);
    }],
  ]);
  const consumer = makeConsumer(pool, handlers);

  const processed = await consumer.runOnce();
  assert.equal(processed, 2, '只成功处理了 id 1、2');
  assert.deepEqual(seen, [1, 2]);
  assert.equal(pool.topicCursors.get('c1|dev|t'), 2, '游标停在 2，未越过失败的 3');

  // 下一轮从 2 之后重放：id 3 仍会被投递（at-least-once）
  const seen2: number[] = [];
  handlers.set('t', async (e: OutboxEvent) => { seen2.push((e.payload as { n: number }).n); });
  await consumer.runOnce();
  assert.deepEqual(seen2, [3, 4]);
  assert.equal(pool.topicCursors.get('c1|dev|t'), 4);
});

test('consumer：第一条即抛 → 游标一步不进（不回退、也不假前进）', async () => {
  const pool = new FakePool();
  pool.seed('t', {}, 'dev');
  const handlers = new Map([['t', async () => { throw new Error('boom'); }]]);
  const consumer = makeConsumer(pool, handlers);

  const processed = await consumer.runOnce();
  assert.equal(processed, 0);
  assert.equal(pool.topicCursors.get('c1|dev|t'), undefined, '游标从未落库');
  // 未写 cursor：断言两张游标表都没发过 upsert
  assert.equal(pool.calls.some((c) => c.sql.includes('INSERT INTO event_outbox_topic_cursor')), false);
  assert.equal(pool.calls.some((c) => c.sql.includes('INSERT INTO event_outbox_cursor')), false);
});

test('consumer：未注册主题根本不被拉取（分维后它对本消费者不存在）', async () => {
  const pool = new FakePool();
  pool.seed('known', {}, 'dev');   // id 1 有 handler
  pool.seed('unknown', {}, 'dev'); // id 2 无 handler
  pool.seed('known', {}, 'dev');   // id 3 有 handler
  const seen: number[] = [];
  const handlers = new Map([['known', async (e: OutboxEvent) => { seen.push(e.id); }]]);
  const consumer = makeConsumer(pool, handlers);

  await consumer.runOnce();
  assert.deepEqual(seen, [1, 3]);
  assert.equal(pool.topicCursors.get('c1|dev|known'), 3);
  assert.equal(pool.topicCursors.get('c1|dev|unknown'), undefined, '无关主题不建游标行');
  // 只按已注册主题发查询：unknown 从未出现在任何拉取参数里
  const fetches = pool.calls.filter((c) => c.sql.trim().startsWith('SELECT id, topic, payload'));
  assert.deepEqual([...new Set(fetches.map((c) => c.params[1]))], ['known']);
});

test('consumer：cursor 推进用 GREATEST upsert（崩溃/并发不回退）', async () => {
  const pool = new FakePool();
  pool.seed('t', {}, 'dev');
  const consumer = makeConsumer(pool, new Map([['t', async () => {}]]));
  await consumer.runOnce();
  const upsert = pool.calls.find((c) => c.sql.includes('INSERT INTO event_outbox_topic_cursor'));
  assert.ok(upsert);
  assert.match(upsert.sql, /GREATEST\(event_outbox_topic_cursor\.last_id, EXCLUDED\.last_id\)/);
  assert.match(upsert.sql, /ON CONFLICT \(consumer, execution_target, topic\)/);

  // 预置一个更高的游标，模拟并发写者已领先；本次较低的 id 不得让它倒退
  pool.topicCursors.set('c1|dev|t', 99);
  await consumer.runOnce();
  assert.equal(pool.topicCursors.get('c1|dev|t'), 99);
});

test('consumer：两个不同消费者名各自从头收齐（游标互不干扰）', async () => {
  const pool = new FakePool();
  pool.seed('t', { n: 1 }, 'dev');
  pool.seed('t', { n: 2 }, 'dev');
  const seenA: number[] = [];
  const seenB: number[] = [];
  const a = makeConsumer(pool, new Map([['t', async (e: OutboxEvent) => { seenA.push((e.payload as { n: number }).n); }]]), { consumer: 'A' });
  const b = makeConsumer(pool, new Map([['t', async (e: OutboxEvent) => { seenB.push((e.payload as { n: number }).n); }]]), { consumer: 'B' });

  await a.runOnce();
  await b.runOnce();
  assert.deepEqual(seenA, [1, 2]);
  assert.deepEqual(seenB, [1, 2]);
  assert.equal(pool.topicCursors.get('A|dev|t'), 2);
  assert.equal(pool.topicCursors.get('B|dev|t'), 2);
});

// ── 主题分维：毒消息只堵它自己那条主题 ────────────────────────────────────────

test('consumer：一条主题被毒消息堵住，其它主题照常推进（分维的全部意义）', async () => {
  const pool = new FakePool();
  pool.seed('poison', { n: 1 }, 'dev'); // id 1 —— 永远抛
  pool.seed('healthy', { n: 2 }, 'dev'); // id 2
  pool.seed('poison', { n: 3 }, 'dev'); // id 3 —— 被 id 1 挡在后面
  pool.seed('healthy', { n: 4 }, 'dev'); // id 4
  const healthySeen: number[] = [];
  const consumer = makeConsumer(
    pool,
    new Map([
      ['poison', async () => { throw new Error('毒消息'); }],
      ['healthy', async (e: OutboxEvent) => { healthySeen.push(e.id); }],
    ]),
  );

  await consumer.runOnce();
  assert.deepEqual(healthySeen, [2, 4], 'healthy 主题不受 poison 影响，全部投递');
  assert.equal(pool.topicCursors.get('c1|dev|healthy'), 4);
  assert.equal(pool.topicCursors.get('c1|dev|poison'), undefined, 'poison 主题的游标一步不进');

  const blocked = consumer.stats().blocked;
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0].topic, 'poison');
  assert.equal(blocked[0].eventId, 1);
  assert.equal(blocked[0].attempts, 1);

  // 再跑一轮：attempts 累加（同一条卡住），healthy 已追平不再重复投递
  await consumer.runOnce();
  assert.deepEqual(healthySeen, [2, 4]);
  assert.equal(consumer.stats().blocked[0].attempts, 2);

  // 遗留聚合游标取各主题最小值 = 0（poison 还在 0），绝不越过未消费的 poison → 回滚不会静默漏投
  assert.equal(pool.cursors.get('c1|dev'), undefined);
});

test('consumer：主题游标缺行时回落到遗留聚合行，而不是从 0 重放（存量迁移安全方向）', async () => {
  const pool = new FakePool();
  pool.seed('t', { n: 1 }, 'dev'); // id 1 —— 迁移前已被聚合游标消费掉
  pool.seed('t', { n: 2 }, 'dev'); // id 2 —— 同上
  pool.seed('t', { n: 3 }, 'dev'); // id 3 —— 迁移后新增，才是该投的
  pool.cursors.set('c1|dev', 2); // 遗留聚合行：id ≤ 2 全部主题都已消费
  const seen: number[] = [];
  const consumer = makeConsumer(pool, new Map([['t', async (e: OutboxEvent) => { seen.push(e.id); }]]));

  await consumer.runOnce();
  assert.deepEqual(seen, [3], '只投 id=3；1、2 绝不重放（消费方实测不幂等）');
  assert.equal(pool.topicCursors.get('c1|dev|t'), 3);
});

test('consumer：队列占用可观测（backlogByTopic 按主题计游标之后的积压）', async () => {
  const pool = new FakePool();
  pool.seed('a', {}, 'dev');
  pool.seed('a', {}, 'dev');
  pool.seed('b', {}, 'dev');
  const consumer = makeConsumer(
    pool,
    new Map([
      ['a', async () => { throw new Error('堵住'); }],
      ['b', async () => {}],
    ]),
  );
  await consumer.runOnce();
  assert.deepEqual(await consumer.backlogByTopic(), { a: 2, b: 0 });
});

// ── 通知唤醒：只加速、绝不放宽轮询 ────────────────────────────────────────────

test('wake：与本消费者无关的主题被丢弃（firehose 不吵醒别人）', async () => {
  const pool = new FakePool();
  const consumer = new OutboxConsumer({
    consumer: 'c1',
    executionTarget: 'dev',
    pool,
    handlers: new Map([['mine', async () => {}]]),
    pollIntervalMs: 1000,
    wakeDebounceMs: 0,
    logger: silent,
    setTimer: (_fn, _ms) => 0 as unknown as ReturnType<typeof setTimeout>,
    clearTimer: () => {},
  });
  consumer.start();
  await new Promise((r) => setImmediate(r));

  consumer.wake('someone-elses-topic');
  assert.equal(consumer.stats().wakesIgnored, 1);
  assert.equal(consumer.stats().wakes, 0);

  consumer.wake('mine');
  assert.equal(consumer.stats().wakes, 1);
  consumer.wake(undefined); // 载荷未知（超限降级）→ 照常唤醒，宁可多跑一次
  assert.equal(consumer.stats().wakes, 2);
  consumer.stop();
});

test('wake：接了通知之后兜底轮询周期一点没放宽（MUST NOT 放大 pollIntervalMs）', async () => {
  const pool = new FakePool();
  pool.seed('t', {}, 'dev');
  const delays: number[] = [];
  const consumer = new OutboxConsumer({
    consumer: 'c1',
    executionTarget: 'dev',
    pool,
    handlers: new Map([['t', async () => {}]]),
    pollIntervalMs: 2000,
    wakeDebounceMs: 0,
    logger: silent,
    setTimer: (_fn, ms) => { delays.push(ms); return delays.length as unknown as ReturnType<typeof setTimeout>; },
    clearTimer: () => {},
  });
  consumer.start();
  await new Promise((r) => setImmediate(r));
  consumer.wake('t');
  await new Promise((r) => setImmediate(r));
  consumer.stop();

  assert.ok(delays.length >= 2, '启动与唤醒后各排了一次兜底轮询');
  assert.deepEqual([...new Set(delays)], [2000], '每一次兜底轮询都仍是 2000ms，与是否收到通知无关');
  assert.equal(consumer.stats().pollIntervalMs, 2000);
});

test('consumer：start/stop 生命周期——stop 后不再排轮询', async () => {
  const pool = new FakePool();
  let scheduled = 0;
  const timers: (() => void)[] = [];
  const consumer = new OutboxConsumer({
    consumer: 'c1',
    executionTarget: 'dev',
    pool,
    handlers: new Map(),
    pollIntervalMs: 10,
    logger: silent,
    setTimer: (fn) => { scheduled += 1; timers.push(fn); return scheduled as unknown as ReturnType<typeof setTimeout>; },
    clearTimer: () => {},
  });
  consumer.start();
  // 让初始 tick 完成
  await new Promise((r) => setImmediate(r));
  assert.ok(scheduled >= 1, '启动后应排下一次轮询');
  consumer.stop();
  const before = scheduled;
  // 触发挂起的定时器；stop 后 tick MUST NOT 再排新轮询
  for (const fn of timers) fn();
  await new Promise((r) => setImmediate(r));
  assert.equal(scheduled, before, 'stop 后不再新增轮询');
});
