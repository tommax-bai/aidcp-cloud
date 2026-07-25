/**
 * outbox 通知唤醒长连接单测（change outbox-listen-and-topic-cursor）。零数据库依赖：用内存假 Client
 * 驱动「连上 → LISTEN → 收通知 → 断开 → 有界退避重连」全链。
 *
 * 只覆盖会真正咬人的四件事：LISTEN 真发出且通知落到唤醒回调、退避确实**有上限**（不形成重连风暴、
 * 也不悄悄放弃）、落点抛错不拆连接、频道名不是合法标识符时构造即拒（LISTEN 无法参数化）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  OutboxNotifyListener,
  type NotifyClientLike,
  type OutboxNotification,
} from '../../src/transport/outbox-notify-listener.js';
import { buildOutboxHealthReport } from '../../src/transport/outbox-health.js';

const silent = { log() {}, warn() {}, error() {} };

class FakeClient implements NotifyClientLike {
  readonly queries: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly listeners = new Map<string, ((arg: any) => void)[]>();
  connected = false;
  ended = false;
  connectFails = false;

  async connect(): Promise<void> {
    if (this.connectFails) throw new Error('connect boom');
    this.connected = true;
  }

  async query(sql: string): Promise<unknown> {
    this.queries.push(sql);
    return { rows: [] };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, listener: (arg: any) => void): unknown {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
    return this;
  }

  removeAllListeners(): unknown {
    this.listeners.clear();
    return this;
  }

  async end(): Promise<void> {
    this.ended = true;
  }

  fire(event: string, arg?: unknown): void {
    for (const l of [...(this.listeners.get(event) ?? [])]) l(arg);
  }
}

/** 手动时钟 + 手动定时器：退避排期可断言、不睡真时间。 */
function makeTimers() {
  const scheduled: { fn: () => void; ms: number }[] = [];
  return {
    scheduled,
    setTimer: (fn: () => void, ms: number) => {
      scheduled.push({ fn, ms });
      return scheduled.length as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: () => {},
    runLast: () => {
      const last = scheduled[scheduled.length - 1];
      last.fn();
    },
  };
}

test('listener：连上后真的发出 LISTEN，通知的 topic 落到唤醒回调', async () => {
  const client = new FakeClient();
  const woken: (string | undefined)[] = [];
  const listener = new OutboxNotifyListener({
    createClient: () => client,
    onNotify: (topic) => woken.push(topic),
    logger: silent,
  });
  await listener.start();

  assert.deepEqual(client.queries, ['LISTEN event_outbox'], '专用连接上只跑 LISTEN，不跑业务查询');
  assert.equal(listener.health().connected, true);

  client.fire('notification', { channel: 'event_outbox', payload: 'risk.command' } satisfies OutboxNotification);
  client.fire('notification', { channel: 'event_outbox', payload: '' }); // 载荷超限降级 → 主题未知
  client.fire('notification', { channel: '别人的频道', payload: 'x' }); // 非本频道 → 丢弃
  assert.deepEqual(woken, ['risk.command', undefined]);
  assert.equal(listener.health().notifications, 2);

  await listener.stop();
  assert.equal(client.ended, true, 'stop 必须释放专用连接');
});

test('listener：断开后有界退避重连——指数增长但封顶，且永不放弃', async () => {
  const timers = makeTimers();
  const clients: FakeClient[] = [];
  const listener = new OutboxNotifyListener({
    createClient: () => {
      const c = new FakeClient();
      c.connectFails = true; // 一直连不上，逼出完整退避序列
      clients.push(c);
      return c;
    },
    onNotify: () => {},
    reconnectBaseMs: 1_000,
    reconnectMaxMs: 4_000,
    logger: silent,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    now: () => 0,
    random: () => 0.5, // 抖动系数恰为 1.0，退避值可精确断言
  });

  await listener.start();
  // 每次触发重连后必须让微任务跑完再触发下一次：connectOnce 是异步的，同步连打会命中「同一次尝试」。
  for (let i = 0; i < 4; i += 1) {
    timers.runLast();
    await new Promise((r) => setImmediate(r));
  }

  assert.deepEqual(
    timers.scheduled.map((s) => s.ms),
    [1_000, 2_000, 4_000, 4_000, 4_000],
    '退避指数增长到上限即封顶，绝不无限增长（也绝不退化成重连风暴）',
  );
  const health = listener.health();
  assert.equal(health.connected, false, '连不上就如实说连不上，绝不假装已接线');
  assert.equal(health.consecutiveFailures, 5);
  assert.ok(health.lastError?.includes('connect boom'));
  assert.equal(timers.scheduled.length, 5, '仍在排下一次重连——放弃 = 悄悄关掉加速器');

  await listener.stop();
});

test('listener：唤醒落点抛错只 warn，不拆连接（一个消费者的问题不该断掉整条通道）', async () => {
  const client = new FakeClient();
  const warns: string[] = [];
  const listener = new OutboxNotifyListener({
    createClient: () => client,
    onNotify: () => { throw new Error('wake boom'); },
    logger: { log() {}, warn: (m: string) => warns.push(m), error() {} },
  });
  await listener.start();
  client.fire('notification', { channel: 'event_outbox', payload: 't' });

  assert.equal(listener.health().connected, true, '连接仍在');
  assert.equal(warns.length, 1);
  assert.match(warns[0], /通知落点抛错/);
  await listener.stop();
});

test('listener：频道名不是合法标识符即构造期拒绝（LISTEN 无法参数化，绝不拼接）', () => {
  assert.throws(
    () => new OutboxNotifyListener({ createClient: () => new FakeClient(), onNotify: () => {}, channel: 'a; DROP TABLE x' }),
    /不是合法标识符/,
  );
});

test('健康巡检：通道断开 / 主题被堵 / 积压超阈值都判 degraded（不静默）', async () => {
  const nominal = await buildOutboxHealthReport({
    listener: { health: () => ({ channel: 'event_outbox', connected: true, running: true, consecutiveFailures: 0, reconnects: 0, notifications: 3, lastConnectedAt: 1, lastNotifyAt: 2, lastError: null, lastErrorAt: null, nextRetryAt: null }) },
    consumers: [
      {
        name: 'risk-command',
        stats: () => ({ consumer: 'risk-command', executionTarget: 'dev' as const, topics: ['risk.command'], running: true, pollIntervalMs: 2000, ticks: 5, wakes: 2, wakesIgnored: 7, handledTotal: 4, lastTickAt: 1, lastErrorAt: null, lastError: null, cursors: { 'risk.command': 4 }, blocked: [] }),
        backlogByTopic: async () => ({ 'risk.command': 0 }),
      },
    ],
  });
  assert.equal(nominal.degraded, false);

  const blocked = await buildOutboxHealthReport({
    listener: { health: () => ({ channel: 'event_outbox', connected: false, running: true, consecutiveFailures: 3, reconnects: 2, notifications: 0, lastConnectedAt: null, lastNotifyAt: null, lastError: 'boom', lastErrorAt: 9, nextRetryAt: 10 }) },
    consumers: [
      {
        name: 'risk-command',
        stats: () => ({ consumer: 'risk-command', executionTarget: 'dev' as const, topics: ['risk.command'], running: true, pollIntervalMs: 2000, ticks: 5, wakes: 0, wakesIgnored: 0, handledTotal: 0, lastTickAt: 1, lastErrorAt: null, lastError: null, cursors: { 'risk.command': 0 }, blocked: [{ topic: 'risk.command', eventId: 7, since: 1, attempts: 12, lastError: '毒消息' }] }),
        backlogByTopic: async () => ({ 'risk.command': 3 }),
      },
    ],
  });
  assert.equal(blocked.degraded, true);
  assert.match(blocked.line, /通知通道 DOWN/);
  assert.match(blocked.line, /堵塞主题=risk\.command@id7×12/);
});
