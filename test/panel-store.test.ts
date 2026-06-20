import { test } from 'node:test';
import assert from 'node:assert/strict';
import type pg from 'pg';
import { PgPanelStore } from '../src/panel/panel-store.js';

/** 用注入 fake pool 测查询的行映射/聚合逻辑，不依赖真 PG。 */
function poolReturning(rows: unknown[]): pg.Pool {
  return { query: async () => ({ rows }) } as unknown as pg.Pool;
}

test('todayTotals 把行映射成全 action 记录并补 0', async () => {
  const store = new PgPanelStore({ pool: poolReturning([
    { action: 'like', total: 10 },
    { action: 'view', total: 40 },
  ]) });
  const totals = await store.todayTotals();
  assert.equal(totals.like, 10);
  assert.equal(totals.view, 40);
  assert.equal(totals.collect, 0); // 缺失补 0
  assert.equal(totals.follow, 0);
});

test('todayTotals 忽略未知 action', async () => {
  const store = new PgPanelStore({ pool: poolReturning([{ action: 'bogus', total: 99 }]) });
  const totals = await store.todayTotals();
  assert.equal(Object.values(totals).every((v) => v === 0), true);
});

test('likeRate 计算 rate 与健康区间（15%-35%）', async () => {
  const healthy = await new PgPanelStore({ pool: poolReturning([{ likes: 10, views: 40 }]) }).likeRate();
  assert.equal(healthy.rate, 0.25);
  assert.equal(healthy.healthy, true);

  const over = await new PgPanelStore({ pool: poolReturning([{ likes: 20, views: 40 }]) }).likeRate();
  assert.equal(over.rate, 0.5);
  assert.equal(over.healthy, false); // > 35%
});

test('likeRate views=0 时 rate/healthy 为 null（不除零、不假成功）', async () => {
  const r = await new PgPanelStore({ pool: poolReturning([{ likes: 0, views: 0 }]) }).likeRate();
  assert.equal(r.rate, null);
  assert.equal(r.healthy, null);
});

test('listAccounts 映射 accounts⨝risk_state（operator vs risk 状态分开）', async () => {
  const store = new PgPanelStore({ pool: poolReturning([
    {
      account_id: 'default', label: 'default', platform: 'xiaohongshu',
      group_label: null, machine_label: null, operator_status: 'paused',
      paused_at: new Date(1000), risk_status: 'warned', risk_quota_level: 'conservative', signal_count: 3,
    },
  ]) });
  const [a] = await store.listAccounts();
  assert.equal(a.accountId, 'default');
  assert.equal(a.operatorStatus, 'paused');
  assert.equal(a.pausedAt, 1000);
  assert.equal(a.riskStatus, 'warned');
  assert.equal(a.riskQuotaLevel, 'conservative');
  assert.equal(a.signalCount, 3);
});

test('getAccount 无行返回 null', async () => {
  const store = new PgPanelStore({ pool: poolReturning([]) });
  assert.equal(await store.getAccount('nope'), null);
});

test('listAccounts 无 risk_state 行时风控字段为 null（账号无风控行）', async () => {
  const store = new PgPanelStore({ pool: poolReturning([
    {
      account_id: 'x', label: null, platform: 'xiaohongshu', group_label: null, machine_label: null,
      operator_status: 'active', paused_at: null, risk_status: null, risk_quota_level: null, signal_count: null,
    },
  ]) });
  const [a] = await store.listAccounts();
  assert.equal(a.riskStatus, null);
  assert.equal(a.riskQuotaLevel, null);
  assert.equal(a.pausedAt, null);
});
