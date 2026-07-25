/**
 * `event_outbox` 保留期剪裁单测（change panel-event-tee-hardening）。
 *
 * 钉住三条不变量：
 *   ① 主题没有消费者（core / monolith 形态）→ 纯按年龄剪，**照剪不误、且不告警**；
 *   ② 主题有消费者但缺进度行 → 一条都不剪，且**如实报出**是谁挡着（不静默假成功、也不装作剪过）；
 *   ③ 有进度行 → 只剪消费者已越过的 id，未消费的行原样留着（at-least-once 不被剪裁破坏）。
 * 外加兜底上限：观测类主题即使没人消费，超过硬上限也剪并告警（防生产库无界增长）。
 *
 * 零数据库依赖：内存 FakePool 只回应剪裁器发出的四类 SQL。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  OutboxRetentionPruner,
  pruneEventOutbox,
  type OutboxQueryable,
} from '../../src/transport/event-outbox.js';

const silent = { log() {}, warn() {} };

interface Row {
  id: number;
  topic: string;
  execution_target: string;
  created_at: Date;
}

/** 内存桩：装 event_outbox 行与 (consumer,target) 游标，回应剪裁器的四类 SQL。 */
class FakePool implements OutboxQueryable {
  rows: Row[] = [];
  readonly cursors = new Map<string, number>();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async query(sql: string, params: unknown[] = []): Promise<any> {
    const s = sql.trim();
    if (s.startsWith('SELECT consumer, last_id FROM event_outbox_cursor')) {
      const target = params[0] as string;
      const names = params[1] as string[];
      const rows = names
        .filter((n) => this.cursors.has(`${n}|${target}`))
        .map((n) => ({ consumer: n, last_id: this.cursors.get(`${n}|${target}`)! }));
      return { rows, rowCount: rows.length };
    }
    if (s.startsWith('SELECT id FROM event_outbox')) {
      const [target, topic, cutoff] = params as [string, string, Date];
      const hit = this.rows.filter(
        (r) => r.execution_target === target && r.topic === topic && r.created_at < cutoff,
      );
      return { rows: hit.slice(0, 1).map((r) => ({ id: r.id })), rowCount: Math.min(hit.length, 1) };
    }
    if (s.startsWith('DELETE FROM event_outbox')) {
      const hasFloor = s.includes('$4::bigint IS NULL');
      const target = params[0] as string;
      const topic = params[1] as string;
      const cutoff = params[2] as Date;
      const floor = hasFloor ? (params[3] as number | null) : null;
      const limit = Number(hasFloor ? params[4] : params[3]);
      const victims = this.rows
        .filter(
          (r) =>
            r.execution_target === target &&
            r.topic === topic &&
            r.created_at < cutoff &&
            (!hasFloor || floor === null || r.id <= floor),
        )
        .sort((a, b) => a.id - b.id)
        .slice(0, limit);
      const kill = new Set(victims.map((r) => r.id));
      this.rows = this.rows.filter((r) => !kill.has(r.id));
      return { rows: [], rowCount: victims.length };
    }
    throw new Error(`FakePool: 未预期的 SQL: ${s.slice(0, 60)}`);
  }
}

const NOW = 10_000_000;
const HOUR = 3_600_000;

function seed(pool: FakePool, topic: string, ages: number[]): void {
  let id = pool.rows.length;
  for (const ageMs of ages) {
    id += 1;
    pool.rows.push({ id, topic, execution_target: 'dev', created_at: new Date(NOW - ageMs) });
  }
}

test('无消费者的主题：纯按年龄剪，照剪不误、不报 blocked（core/monolith 形态）', async () => {
  const pool = new FakePool();
  seed(pool, 'panel.event', [5 * HOUR, 2 * HOUR, 0]); // id 1 过龄，2/3 未到龄

  const [result] = await pruneEventOutbox(pool, {
    executionTarget: 'dev',
    now: () => NOW,
    topics: [{ topic: 'panel.event', retentionMs: 3 * HOUR, consumers: [] }],
  });

  assert.equal(result.deleted, 1);
  assert.equal(result.blockedBy, null); // 「没有消费者」是正常形态，不是故障
  assert.equal(result.floorId, null);
  assert.deepEqual(pool.rows.map((r) => r.id), [2, 3]);
});

test('有消费者但缺进度行：一条不剪 + 如实报出挡路者（有到龄行时）', async () => {
  const pool = new FakePool();
  seed(pool, 'panel.event', [5 * HOUR]);

  const [result] = await pruneEventOutbox(pool, {
    executionTarget: 'dev',
    now: () => NOW,
    topics: [{ topic: 'panel.event', retentionMs: 3 * HOUR, consumers: ['panel-event-replay'] }],
  });

  assert.equal(result.deleted, 0);
  assert.deepEqual(result.blockedBy, ['panel-event-replay']);
  assert.equal(pool.rows.length, 1); // 没剪就是没剪，绝不假装剪过
});

test('缺进度行但**没有到龄行**：静默通过，不制造噪声告警', async () => {
  const pool = new FakePool();
  seed(pool, 'risk.command', [1 * HOUR]); // 未到龄

  const [result] = await pruneEventOutbox(pool, {
    executionTarget: 'dev',
    now: () => NOW,
    topics: [{ topic: 'risk.command', retentionMs: 3 * HOUR, consumers: ['risk-command'] }],
  });

  assert.equal(result.deleted, 0);
  assert.equal(result.blockedBy, null);
});

test('有进度行：只剪消费者已越过的 id，未消费的过龄行原样留着', async () => {
  const pool = new FakePool();
  seed(pool, 'panel.event', [5 * HOUR, 5 * HOUR, 5 * HOUR]); // id 1,2,3 全过龄
  pool.cursors.set('panel-event-replay|dev', 2); // 只消费到 2

  const [result] = await pruneEventOutbox(pool, {
    executionTarget: 'dev',
    now: () => NOW,
    topics: [{ topic: 'panel.event', retentionMs: 3 * HOUR, consumers: ['panel-event-replay'] }],
  });

  assert.equal(result.floorId, 2);
  assert.equal(result.deleted, 2);
  assert.deepEqual(pool.rows.map((r) => r.id), [3]); // 未消费的那条 MUST 留着
});

test('兜底上限：观测类主题即使没人消费，超硬上限也剪并如实告警；承重主题不设兜底则原样堆着', async () => {
  const pool = new FakePool();
  seed(pool, 'panel.event', [10 * 24 * HOUR]); // 10 天前的观测帧
  seed(pool, 'risk.command', [10 * 24 * HOUR]); // 10 天前的承重命令

  const warns: string[] = [];
  const pruner = new OutboxRetentionPruner({
    pool,
    executionTarget: 'dev',
    now: () => NOW,
    logger: { log() {}, warn: (m: string) => warns.push(m) },
    topics: [
      {
        topic: 'panel.event',
        retentionMs: 3 * HOUR,
        consumers: ['panel-event-replay'],
        unconsumedRetentionMs: 3 * 24 * HOUR,
      },
      { topic: 'risk.command', retentionMs: 3 * HOUR, consumers: ['risk-command'] },
    ],
  });
  const results = await pruner.runOnce();

  assert.equal(results[0].forced, 1); // 观测帧被兜底强删
  assert.equal(results[1].forced, 0); // 承重命令绝不强删
  assert.deepEqual(pool.rows.map((r) => r.topic), ['risk.command']);
  assert.ok(warns.some((w) => w.includes('兜底剪裁') && w.includes('panel.event')));
  assert.ok(warns.some((w) => w.includes('拒绝剪裁') && w.includes('risk.command')));
});

test('受阻告警只在状态跃迁时打一次（永久受阻不等于永久刷屏）', async () => {
  const pool = new FakePool();
  seed(pool, 'risk.command', [5 * HOUR]);
  const warns: string[] = [];
  const pruner = new OutboxRetentionPruner({
    pool,
    executionTarget: 'dev',
    now: () => NOW,
    logger: { log() {}, warn: (m: string) => warns.push(m) },
    topics: [{ topic: 'risk.command', retentionMs: 3 * HOUR, consumers: ['risk-command'] }],
  });

  await pruner.runOnce();
  await pruner.runOnce();
  await pruner.runOnce();
  assert.equal(warns.filter((w) => w.includes('拒绝剪裁')).length, 1);

  // 消费者上线追平 → 剪掉，并打一条恢复
  pool.cursors.set('risk-command|dev', 99);
  const [r] = await pruner.runOnce();
  assert.equal(r.deleted, 1);
  assert.equal(r.blockedBy, null);
});

test('target 非法不启动剪裁（fail-closed，绝不静默降级）', async () => {
  const pool = new FakePool();
  await assert.rejects(
    () => pruneEventOutbox(pool, { executionTarget: '', topics: [], now: () => NOW }),
    /非法 executionTarget/,
  );
  assert.throws(
    () => new OutboxRetentionPruner({ pool, executionTarget: 'prod', topics: [], logger: silent }),
    /非法 executionTarget/,
  );
});
