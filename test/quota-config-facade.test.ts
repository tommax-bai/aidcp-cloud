import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createQuotaConfigPanel } from '../src/config/quota-config-facade.js';
import type { QuotaConfigStore, QuotaConfigRow } from '../src/config/quota-config-store.js';
import { deriveWindowQuotas, QUOTA_MAX } from '../src/risk/quotas.js';
import { RISK_ACTIONS, RISK_QUOTA_LEVELS, type RiskAction, type RiskQuotaLevel, type WindowQuotas } from '../src/risk/types.js';

/** 内存假 store：实现 facade 用到的 windowQuotasFor / getRow / set，记录 set 调用。 */
function fakeStore() {
  const rows = new Map<string, QuotaConfigRow>();
  const setCalls: Array<{ tier: string; action: string }> = [];
  const store = {
    windowQuotasFor: (level: RiskQuotaLevel): WindowQuotas => {
      const derived = deriveWindowQuotas(level);
      const out = { minute: { ...derived.minute }, hour: { ...derived.hour }, day: { ...derived.day } };
      for (const a of RISK_ACTIONS) {
        const r = rows.get(`${level} ${a}`);
        if (r) { out.day[a] = r.daily; out.minute[a] = r.perMinute; out.hour[a] = r.perHour; }
      }
      return out;
    },
    getRow: (tier: RiskQuotaLevel, action: RiskAction) => rows.get(`${tier} ${action}`),
    set: async (tier: RiskQuotaLevel, action: RiskAction, patch: { daily?: number; perMinute?: number; perHour?: number }, by: string) => {
      setCalls.push({ tier, action });
      const prev = rows.get(`${tier} ${action}`);
      const d = deriveWindowQuotas(tier);
      const row: QuotaConfigRow = {
        tier, action,
        daily: patch.daily ?? prev?.daily ?? d.day[action],
        perMinute: patch.perMinute ?? prev?.perMinute ?? d.minute[action],
        perHour: patch.perHour ?? prev?.perHour ?? d.hour[action],
        updatedAt: '2026-06-24T01:00:00.000Z', updatedBy: by,
      };
      rows.set(`${tier} ${action}`, row);
      return row;
    },
  } as unknown as QuotaConfigStore;
  return { store, rows, setCalls };
}

test('getCatalog：3 档 × 7 动作 全覆盖 + 空库显示派生默认 + overridden=false', async () => {
  const { store } = fakeStore();
  const panel = createQuotaConfigPanel({ store });
  const view = await panel.getCatalog();
  assert.equal(view.quotas.length, RISK_QUOTA_LEVELS.length * RISK_ACTIONS.length);
  const cl = view.quotas.find((q) => q.tier === 'conservative' && q.action === 'like')!;
  assert.equal(cl.daily, deriveWindowQuotas('conservative').day.like);
  assert.equal(cl.overridden, false);
});

test('setQuota 合法 → 落库 + 回真态目录(overridden=true) + 仅写 quota_config(不碰风控状态)', async () => {
  const { store, setCalls } = fakeStore();
  const panel = createQuotaConfigPanel({ store });
  const r = await panel.setQuota({ tier: 'normal', action: 'like', daily: 60, perMinute: 5 }, 'bob');
  assert.equal(r.ok, true);
  assert.deepEqual(setCalls, [{ tier: 'normal', action: 'like' }]); // 只动 quota_config
  const row = (r as { ok: true; view: { quotas: Array<{ tier: string; action: string; daily: number; overridden: boolean }> } }).view.quotas.find((q) => q.tier === 'normal' && q.action === 'like')!;
  assert.equal(row.daily, 60);
  assert.equal(row.overridden, true);
});

test('未知档位 → unknown_tier，绝不落库', async () => {
  const { store, setCalls } = fakeStore();
  const panel = createQuotaConfigPanel({ store });
  const r = await panel.setQuota({ tier: 'nope' as never, action: 'like', daily: 5 }, 'a');
  assert.deepEqual(r, { ok: false, reason: 'unknown_tier' });
  assert.equal(setCalls.length, 0);
});

test('未知动作 → unknown_action，绝不落库', async () => {
  const { store, setCalls } = fakeStore();
  const panel = createQuotaConfigPanel({ store });
  const r = await panel.setQuota({ tier: 'normal', action: 'nope' as never, daily: 5 }, 'a');
  assert.equal((r as { reason: string }).reason, 'unknown_action');
  assert.equal(setCalls.length, 0);
});

test('非法数字（负 / 非整 / 超上限）→ invalid_value，整块拒不落库', async () => {
  const { store, setCalls } = fakeStore();
  const panel = createQuotaConfigPanel({ store });
  for (const bad of [-1, 1.5, QUOTA_MAX + 1]) {
    const r = await panel.setQuota({ tier: 'normal', action: 'like', daily: bad }, 'a');
    assert.equal((r as { reason: string }).reason, 'invalid_value', `值 ${bad} 应拒`);
  }
  assert.equal(setCalls.length, 0);
});

test('无任何窗口值 → no_valid_fields', async () => {
  const { store } = fakeStore();
  const panel = createQuotaConfigPanel({ store });
  const r = await panel.setQuota({ tier: 'normal', action: 'like' }, 'a');
  assert.equal((r as { reason: string }).reason, 'no_valid_fields');
});

test('0 是合法值（= 该动作该窗口禁止）', async () => {
  const { store } = fakeStore();
  const panel = createQuotaConfigPanel({ store });
  const r = await panel.setQuota({ tier: 'conservative', action: 'comment', daily: 0 }, 'a');
  assert.equal(r.ok, true);
});
