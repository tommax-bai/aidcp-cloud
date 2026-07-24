/**
 * event-outbox 传输原语 PG-gated 集成测试（change block2-outbox-transport）。
 *
 * 无 DATABASE_URL 时整组 skip（照仓内 *.integration.test.ts 范式）。真库往返验证桩测不到的东西：
 *   - BIGSERIAL id 单调；emit 3 条 → consumer 有序收齐；游标真落库；
 *   - 第二个消费者名独立从头收齐（游标按 (consumer,target) 分行）；
 *   - dev / ol target 互不可见。
 *
 * 本 change 不要求执行本文件（只需 typecheck + 单元测试）；写好待整批末尾在有库环境统一跑。
 * 运行：DATABASE_URL=postgres://… tsx --test test/transport/event-outbox.integration.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

import { OutboxConsumer, emitOutboxEvent, type OutboxEvent } from '../../src/transport/event-outbox.js';

const connectionString = process.env.DATABASE_URL;
const silent = { log() {}, warn() {} };

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS event_outbox (
  id                BIGSERIAL PRIMARY KEY,
  topic             TEXT NOT NULL,
  payload           JSONB NOT NULL,
  execution_target  TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS event_outbox_target_id_idx ON event_outbox (execution_target, id);
CREATE TABLE IF NOT EXISTS event_outbox_cursor (
  consumer          TEXT NOT NULL,
  execution_target  TEXT NOT NULL,
  last_id           BIGINT NOT NULL DEFAULT 0,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer, execution_target)
);
`;

test(
  'PostgreSQL: emit 3 条 → consumer 有序收齐 + 游标落库；第二消费者独立收齐；dev/ol 隔离',
  { skip: !connectionString },
  async () => {
    const pool = new pg.Pool({ connectionString });
    try {
      await pool.query(SCHEMA_SQL);
      await pool.query('TRUNCATE event_outbox, event_outbox_cursor RESTART IDENTITY');

      // emit 3 条 dev + 1 条 ol（事务型：在一个事务里写 dev 的三条）
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const n of [1, 2, 3]) {
          const { id } = await emitOutboxEvent(client, { topic: 'risk.signal', payload: { n }, executionTarget: 'dev' }, silent);
          assert.equal(id, n, 'BIGSERIAL id 单调');
        }
        await client.query('COMMIT');
      } finally {
        client.release();
      }
      await emitOutboxEvent(pool, { topic: 'risk.signal', payload: { n: 99 }, executionTarget: 'ol' }, silent);

      // 消费者 A（dev）：有序收齐 1,2,3，看不到 ol 的 99
      const seenA: number[] = [];
      const consumerA = new OutboxConsumer({
        consumer: 'A',
        executionTarget: 'dev',
        pool,
        handlers: new Map([['risk.signal', async (e: OutboxEvent) => { seenA.push((e.payload as { n: number }).n); }]]),
        logger: silent,
      });
      const processedA = await consumerA.runOnce();
      assert.equal(processedA, 3);
      assert.deepEqual(seenA, [1, 2, 3]);

      const curA = await pool.query('SELECT last_id FROM event_outbox_cursor WHERE consumer=$1 AND execution_target=$2', ['A', 'dev']);
      assert.equal(Number(curA.rows[0].last_id), 3, '游标落库到 3');

      // 再跑一轮：无新事件，游标不动
      assert.equal(await consumerA.runOnce(), 0);

      // 消费者 B（dev）：游标独立，从头收齐 1,2,3
      const seenB: number[] = [];
      const consumerB = new OutboxConsumer({
        consumer: 'B',
        executionTarget: 'dev',
        pool,
        handlers: new Map([['risk.signal', async (e: OutboxEvent) => { seenB.push((e.payload as { n: number }).n); }]]),
        logger: silent,
      });
      assert.equal(await consumerB.runOnce(), 3);
      assert.deepEqual(seenB, [1, 2, 3]);

      // 消费者 OL：只看到 ol 的 99
      const seenOl: number[] = [];
      const consumerOl = new OutboxConsumer({
        consumer: 'A',
        executionTarget: 'ol',
        pool,
        handlers: new Map([['risk.signal', async (e: OutboxEvent) => { seenOl.push((e.payload as { n: number }).n); }]]),
        logger: silent,
      });
      await consumerOl.runOnce();
      assert.deepEqual(seenOl, [99], 'ol 消费者只见 ol 事件');
    } finally {
      await pool.end();
    }
  },
);

test(
  'PostgreSQL: 提交乱序不吞事件——在途小 id 未提交时，压住已提交的大 id，落定后有序补投（at-least-once）',
  { skip: !connectionString },
  async () => {
    const pool = new pg.Pool({ connectionString });
    // 独立连接，模拟两个并发业务事务
    const connA = new pg.Client({ connectionString });
    const connB = new pg.Client({ connectionString });
    try {
      await pool.query(SCHEMA_SQL);
      await pool.query('TRUNCATE event_outbox, event_outbox_cursor RESTART IDENTITY');
      await connA.connect();
      await connB.connect();

      // 事务 A 先 INSERT（先拿 xid + 较小 id），但**不提交**（保持在途）
      await connA.query('BEGIN');
      const { id: idA } = await emitOutboxEvent(connA, { topic: 'risk.signal', payload: { who: 'A' }, executionTarget: 'dev' }, silent);
      // 事务 B 后 INSERT（后拿 xid + 较大 id），并**提交**
      await connB.query('BEGIN');
      const { id: idB } = await emitOutboxEvent(connB, { topic: 'risk.signal', payload: { who: 'B' }, executionTarget: 'dev' }, silent);
      await connB.query('COMMIT');
      assert.ok(idB > idA, `B 的 id(${idB}) 应大于 A 的 id(${idA})`);

      const seen: string[] = [];
      const consumer = new OutboxConsumer({
        consumer: 'C',
        executionTarget: 'dev',
        pool,
        handlers: new Map([['risk.signal', async (e: OutboxEvent) => { seen.push((e.payload as { who: string }).who); }]]),
        logger: silent,
      });

      // 安全水位：A 仍在途 → 压住已提交但 id 更大的 B，一条都不投、游标不动。
      // （若无此闸：会投 B、把游标推过 idB，A 提交后 idA<游标 → 永久吞掉。）
      const first = await consumer.runOnce();
      assert.equal(first, 0, 'A 在途时不投任何事件（含已提交的 B）');
      const cur0 = await pool.query('SELECT last_id FROM event_outbox_cursor WHERE consumer=$1 AND execution_target=$2', ['C', 'dev']);
      assert.equal(cur0.rows.length === 0 ? 0 : Number(cur0.rows[0].last_id), 0, '游标一步未进');

      // A 落定后：两条都可见且已落定 → 有序补投 A、B，一条不丢
      await connA.query('COMMIT');
      const second = await consumer.runOnce();
      assert.equal(second, 2, 'A 落定后补投 A、B 两条');
      assert.deepEqual(seen, ['A', 'B'], '按 id 有序、A 先于 B');

      const cur1 = await pool.query('SELECT last_id FROM event_outbox_cursor WHERE consumer=$1 AND execution_target=$2', ['C', 'dev']);
      assert.equal(Number(cur1.rows[0].last_id), idB, '游标落到 idB');
    } finally {
      await connA.end().catch(() => {});
      await connB.end().catch(() => {});
      await pool.end();
    }
  },
);
