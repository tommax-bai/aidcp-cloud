/**
 * 风控命令 outbox 通道单元测试（change 2e-api-split，seam ③）。
 *
 * 零数据库依赖：复用 event-outbox 单测同款内存桩 `FakePool`（模拟 event_outbox / event_outbox_cursor
 * 两表），验：
 *   - emit → consume 往返把命令原样交给**注入的 apply 回调**（单写落地点）；
 *   - 三类命令（applySignal / setQuotaLevel / recoverRestricted）编解码保真；
 *   - emit 侧对畸形命令 fail loud、不入队；
 *   - decode 对畸形 payload 抛错（consumer 侧毒消息按 at-least-once 卡住而非静默丢）；
 *   - target 过滤：只消费本 target 的命令。
 *
 * 测不到的（真机验收项，见 event-outbox.integration.test.ts 同款清单）：真 PostgreSQL 上的
 * BIGSERIAL 单调、xmin 安全水位、GREATEST 游标 CAS、jsonb 往返、pg_notify 事务作用域投递。
 * 本测试用 FakePool 覆盖命令编解码 + 回调分派 + 游标推进逻辑，PG 层留真机 backlog。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  RISK_COMMAND_TOPIC,
  RiskCommandConsumer,
  decodeRiskCommand,
  emitRiskCommand,
  type RiskCommand,
} from '../../src/transport/risk-command-outbox.js';
import type { OutboxQueryable } from '../../src/transport/event-outbox.js';

const silent = { log() {}, warn() {} };

/**
 * 内存桩：与 test/transport/event-outbox.test.ts 同结构，装 event_outbox 行与 (consumer,target) 游标，
 * 按 SQL 关键字回应 emit/consumer 的四类查询。安全水位子句（xmin ...）在桩里被忽略——本测试不并发。
 */
class FakePool implements OutboxQueryable {
  private seq = 0;
  readonly events: {
    id: number;
    topic: string;
    payload: unknown;
    execution_target: string;
    created_at: Date;
  }[] = [];
  readonly cursors = new Map<string, number>();

  seed(topic: string, payload: unknown, target: string): number {
    const id = ++this.seq;
    this.events.push({ id, topic, payload, execution_target: target, created_at: new Date(id * 1000) });
    return id;
  }

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
    if (s.startsWith('SELECT pg_notify')) {
      return { rows: [], rowCount: 1 };
    }
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
      const prev = this.cursors.get(key) ?? 0;
      this.cursors.set(key, Math.max(prev, next));
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`FakePool: 未预期的 SQL: ${s.slice(0, 60)}`);
  }
}

function consumerWith(pool: FakePool, apply: (cmd: RiskCommand) => Promise<void>, target = 'dev'): RiskCommandConsumer {
  return new RiskCommandConsumer({ executionTarget: target, pool, apply, pollIntervalMs: 0, logger: silent });
}

// ── decode（编解码保真）───────────────────────────────────────────────────────

test('decode：三类命令往返保真', () => {
  const apply: RiskCommand = { kind: 'applySignal', accountId: 'acc-1', signal: { kind: 'confirmed', at: 123 } };
  const level: RiskCommand = { kind: 'setQuotaLevel', accountId: 'acc-1', level: 'aggressive' };
  const recover: RiskCommand = { kind: 'recoverRestricted', accountId: 'acc-1', reason: 'ops manual' };
  for (const cmd of [apply, level, recover]) {
    assert.deepEqual(decodeRiskCommand(JSON.parse(JSON.stringify(cmd))), cmd);
  }
});

test('decode：畸形 payload 抛错（毒消息 loud，不静默）', () => {
  assert.throws(() => decodeRiskCommand(null), /必须是对象/);
  assert.throws(() => decodeRiskCommand({ kind: 'nope', accountId: 'a' }), /未知 kind/);
  assert.throws(() => decodeRiskCommand({ kind: 'applySignal', accountId: '' }), /accountId/);
  assert.throws(() => decodeRiskCommand({ kind: 'applySignal', accountId: 'a' }), /signal\.kind/);
  assert.throws(() => decodeRiskCommand({ kind: 'setQuotaLevel', accountId: 'a' }), /level/);
  assert.throws(() => decodeRiskCommand({ kind: 'recoverRestricted', accountId: 'a' }), /reason/);
});

// ── emit → consume 往返 ──────────────────────────────────────────────────────

test('emit → consume：命令原样交给注入的 apply 回调', async () => {
  const pool = new FakePool();
  await emitRiskCommand(pool, 'dev', { kind: 'applySignal', accountId: 'acc-1', signal: { kind: 'fatal' } }, silent);
  await emitRiskCommand(pool, 'dev', { kind: 'setQuotaLevel', accountId: 'acc-2', level: 'normal' }, silent);
  await emitRiskCommand(pool, 'dev', { kind: 'recoverRestricted', accountId: 'acc-3', reason: 'ops' }, silent);

  const seen: RiskCommand[] = [];
  const consumer = consumerWith(pool, async (cmd) => {
    seen.push(cmd);
  });
  const processed = await consumer.runOnce();

  assert.equal(processed, 3);
  assert.deepEqual(seen, [
    { kind: 'applySignal', accountId: 'acc-1', signal: { kind: 'fatal' } },
    { kind: 'setQuotaLevel', accountId: 'acc-2', level: 'normal' },
    { kind: 'recoverRestricted', accountId: 'acc-3', reason: 'ops' },
  ]);
});

test('emit：topic 固定 risk.command，payload 为命令本体', async () => {
  const pool = new FakePool();
  await emitRiskCommand(pool, 'dev', { kind: 'setQuotaLevel', accountId: 'a', level: 'conservative' }, silent);
  const row = pool.events.find((e) => e.topic === RISK_COMMAND_TOPIC);
  assert.ok(row, '应有一条 risk.command 行');
  assert.deepEqual(row.payload, { kind: 'setQuotaLevel', accountId: 'a', level: 'conservative' });
});

test('emit：畸形命令 fail loud、绝不入队', async () => {
  const pool = new FakePool();
  await assert.rejects(
    // @ts-expect-error 故意传畸形命令
    emitRiskCommand(pool, 'dev', { kind: 'setQuotaLevel', accountId: 'a' }, silent),
    /level/,
  );
  assert.equal(pool.events.length, 0, '畸形命令不得写入 outbox');
});

test('emit：非法 target 抛错（透传 emitOutboxEvent 的闸）', async () => {
  const pool = new FakePool();
  await assert.rejects(
    emitRiskCommand(pool, 'prod', { kind: 'recoverRestricted', accountId: 'a', reason: 'x' }, silent),
    /非法 executionTarget/,
  );
});

test('consume：只消费本 target 的命令', async () => {
  const pool = new FakePool();
  await emitRiskCommand(pool, 'dev', { kind: 'applySignal', accountId: 'dev-acc', signal: { kind: 'light' } }, silent);
  await emitRiskCommand(pool, 'ol', { kind: 'applySignal', accountId: 'ol-acc', signal: { kind: 'light' } }, silent);

  const seen: string[] = [];
  const consumer = consumerWith(pool, async (cmd) => {
    seen.push(cmd.accountId);
  }, 'dev');
  await consumer.runOnce();

  assert.deepEqual(seen, ['dev-acc'], 'dev 消费者绝不消费 ol 命令');
});

test('consume：apply 抛错停在该条之前（at-least-once 重放）', async () => {
  const pool = new FakePool();
  await emitRiskCommand(pool, 'dev', { kind: 'setQuotaLevel', accountId: 'a', level: 'normal' }, silent);
  await emitRiskCommand(pool, 'dev', { kind: 'setQuotaLevel', accountId: 'b', level: 'normal' }, silent);

  let attempts = 0;
  const seen: string[] = [];
  const consumer = consumerWith(pool, async (cmd) => {
    attempts += 1;
    if (cmd.accountId === 'a' && attempts === 1) throw new Error('boom');
    seen.push(cmd.accountId);
  });

  await consumer.runOnce(); // 第一条抛错，游标不前进
  assert.deepEqual(seen, []);
  await consumer.runOnce(); // 重放：a 成功、b 成功
  assert.deepEqual(seen, ['a', 'b']);
});

test('RiskCommandConsumer：apply 回调缺失即构造期抛错', () => {
  const pool = new FakePool();
  assert.throws(
    // @ts-expect-error 故意不传 apply
    () => new RiskCommandConsumer({ executionTarget: 'dev', pool }),
    /apply 回调必填/,
  );
});

test('RiskCommandConsumer：非法 target 构造期抛错（不启动）', () => {
  const pool = new FakePool();
  assert.throws(
    () => new RiskCommandConsumer({ executionTarget: 'prod', pool, apply: async () => {} }),
    /非法 executionTarget/,
  );
});
