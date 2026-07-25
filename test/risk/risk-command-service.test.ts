/**
 * 风控写命令服务的契约测试（change cloud-coupling-phase5 · P5-1）。
 *
 * 盯的是用户拍板异步时定下的三条判据，每条都对应一种「静默假成功」：
 *   1. 提交只回 commandId，**不含任何写后状态字段**——受理那一刻结果尚不存在，补出来的一定是编的；
 *   2. 未应用时如实回 processing，界面据此显式渲染「处理中」，而不是伪装成已生效；
 *   3. 失败必须可见——既包括单写者判失败（failed + 具名原因），也包括「查无此命令」（unknown）
 *      MUST NOT 被当成 processing，否则界面永远转圈、永远不报错。
 *
 * 用最小内存假 pg 池：只需要 INSERT / SELECT 两类语句的行为，不连真库。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PgRiskCommandService } from '../../src/risk/risk-command-service.js';

interface Row {
  command_id: number;
  execution_target: string;
  state: string;
  status: string | null;
  quota_level: string | null;
  reason: string | null;
  decided_at: Date;
}

/** 只实现本服务真正用到的四条语句形态；其余一律抛错（防止测试悄悄跑在没实现的路径上）。 */
function makeFakePool(opts: { failPlaceholder?: boolean } = {}) {
  const outbox: Array<{ id: number; topic: string; target: string }> = [];
  const outcomes = new Map<number, Row>();
  let nextId = 0;
  const pool = {
    async query(sql: string, params: unknown[] = []) {
      if (sql.includes('INSERT INTO event_outbox')) {
        nextId += 1;
        outbox.push({ id: nextId, topic: String(params[0]), target: String(params[2]) });
        return { rows: [{ id: nextId }] };
      }
      if (sql.includes('pg_notify')) return { rows: [] };
      if (sql.includes('INSERT INTO risk_command_outcome')) {
        const id = Number(params[0]);
        const target = String(params[1]);
        if (sql.includes("'submitted'")) {
          if (opts.failPlaceholder) throw new Error('relation "risk_command_outcome" does not exist');
          if (!outcomes.has(id)) {
            outcomes.set(id, {
              command_id: id, execution_target: target, state: 'submitted',
              status: null, quota_level: null, reason: null, decided_at: new Date(0),
            });
          }
          return { rows: [] };
        }
        if (sql.includes("'applied'")) {
          outcomes.set(id, {
            command_id: id, execution_target: target, state: 'applied',
            status: String(params[2]), quota_level: String(params[3]), reason: null, decided_at: new Date(1000),
          });
          return { rows: [] };
        }
        outcomes.set(id, {
          command_id: id, execution_target: target, state: 'failed',
          status: null, quota_level: null, reason: String(params[2]), decided_at: new Date(2000),
        });
        return { rows: [] };
      }
      if (sql.includes('FROM risk_command_outcome')) {
        const row = outcomes.get(Number(params[0]));
        return { rows: row && row.execution_target === String(params[1]) ? [row] : [] };
      }
      if (sql.includes('FROM event_outbox')) {
        const hit = outbox.find(
          (e) => e.id === Number(params[0]) && e.topic === String(params[1]) && e.target === String(params[2]),
        );
        return { rows: hit ? [{ id: hit.id }] : [] };
      }
      throw new Error(`fake pool: 未预期的 SQL ${sql.slice(0, 60)}`);
    },
  };
  return { pool: pool as never, outbox, outcomes };
}

const silent = { warn() {} };

test('提交回执只有 commandId，绝不含任何写后状态字段', async () => {
  const { pool, outbox } = makeFakePool();
  const svc = new PgRiskCommandService({ pool, executionTarget: 'dev', logger: silent });

  const accepted = await svc.submitSignal({
    accountId: 'a1', kind: 'manual_restrict', reason: 'ops', requestedBy: 'panel:alice',
  });
  assert.equal(typeof accepted.commandId, 'string');
  assert.deepEqual(Object.keys(accepted), ['commandId'], '回执 MUST 只有 commandId 一个字段');
  assert.equal(outbox.length, 1, '命令 MUST 真落进 outbox（不是只回了个 id）');
  assert.equal(outbox[0].topic, 'risk.command');
});

test('未应用时如实回 processing；应用后回真态；失败后原因可见', async () => {
  const { pool } = makeFakePool();
  const svc = new PgRiskCommandService({ pool, executionTarget: 'dev', logger: silent });

  const { commandId } = await svc.submitQuotaLevel({ accountId: 'a1', level: 'conservative', requestedBy: 'panel:alice' });
  assert.deepEqual(await svc.outcomeOf(commandId), { commandId, state: 'processing' });

  await svc.recordApplied(Number(commandId), 'restricted', 'conservative');
  const applied = await svc.outcomeOf(commandId);
  assert.equal(applied.state, 'applied');
  assert.equal(applied.state === 'applied' && applied.status, 'restricted');
  assert.equal(applied.state === 'applied' && applied.quotaLevel, 'conservative');

  await svc.recordFailed(Number(commandId), 'recovery_window_not_elapsed');
  const failed = await svc.outcomeOf(commandId);
  assert.equal(failed.state, 'failed');
  assert.equal(failed.state === 'failed' && failed.reason, 'recovery_window_not_elapsed');
});

test('查无此命令回 unknown，绝不回落 processing', async () => {
  const { pool } = makeFakePool();
  const svc = new PgRiskCommandService({ pool, executionTarget: 'dev', logger: silent });

  assert.deepEqual(await svc.outcomeOf('4242'), { commandId: '4242', state: 'unknown' });
  // 形状非法的 id 同样是 unknown，MUST NOT 抛也 MUST NOT 装作在处理。
  assert.deepEqual(await svc.outcomeOf('not-a-number'), { commandId: 'not-a-number', state: 'unknown' });
});

test('别的 target 的命令查不到（dev/ol 共库隔离），且不伪装成处理中', async () => {
  const { pool } = makeFakePool();
  const dev = new PgRiskCommandService({ pool, executionTarget: 'dev', logger: silent });
  const ol = new PgRiskCommandService({ pool, executionTarget: 'ol', logger: silent });

  const { commandId } = await dev.submitSignal({ accountId: 'a1', kind: 'manual_freeze', requestedBy: 'panel:alice' });
  assert.equal((await dev.outcomeOf(commandId)).state, 'processing');
  assert.equal((await ol.outcomeOf(commandId)).state, 'unknown', '跨 target MUST 查不到，且回 unknown 非 processing');
});

test('占位行写不进不影响承重链路：命令仍已入队，回读仍是 processing', async () => {
  // 迁移没跑的形态：结果账本表不存在 ⇒ 占位 INSERT 抛错。命令本身已在 outbox 里、单写者照常应用，
  // 故 MUST NOT 因此把提交报成失败，回读也 MUST 经 outbox 兜底判出 processing。
  const { pool, outbox } = makeFakePool({ failPlaceholder: true });
  const svc = new PgRiskCommandService({ pool, executionTarget: 'dev', logger: silent });

  const { commandId } = await svc.submitSignal({ accountId: 'a1', kind: 'manual_restrict', requestedBy: 'panel:alice' });
  assert.equal(outbox.length, 1);
  assert.deepEqual(await svc.outcomeOf(commandId), { commandId, state: 'processing' });
});
