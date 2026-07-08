import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHotLeadConfigPanel } from '../src/config/hot-lead-config-facade.js';
import { DEFAULT_HOT_LEAD_GATE_CONFIG } from '../src/hot-lead/heat-velocity.js';
import type { HotLeadConfigStore, HotLeadConfigRow } from '../src/config/hot-lead-config-store.js';

/** 内存 store 桩：实现 facade 用到的 getGateConfig/getRow/set，语义仿 PG 实现（覆盖优先、逐项回落默认）。 */
class StubStore {
  private row: HotLeadConfigRow | null = null;
  getGateConfig() {
    return {
      maxAgeHours: this.row?.postAgeMaxHours ?? DEFAULT_HOT_LEAD_GATE_CONFIG.maxAgeHours,
      velocityMin: this.row?.velocityMin ?? DEFAULT_HOT_LEAD_GATE_CONFIG.velocityMin,
      minLikeFloor: this.row?.minLikeFloor ?? DEFAULT_HOT_LEAD_GATE_CONFIG.minLikeFloor,
      floorHours: DEFAULT_HOT_LEAD_GATE_CONFIG.floorHours,
    };
  }
  getRow() {
    return this.row ?? undefined;
  }
  async set(patch: { postAgeMaxHours?: number; velocityMin?: number; minLikeFloor?: number }, updatedBy: string) {
    this.row = {
      postAgeMaxHours: patch.postAgeMaxHours ?? this.row?.postAgeMaxHours ?? null,
      velocityMin: patch.velocityMin ?? this.row?.velocityMin ?? null,
      minLikeFloor: patch.minLikeFloor ?? this.row?.minLikeFloor ?? null,
      updatedAt: '2026-07-08T00:00:00.000Z',
      updatedBy,
    };
    return this.row;
  }
}

function panel() {
  return createHotLeadConfigPanel({ store: new StubStore() as unknown as HotLeadConfigStore });
}

test('缺行回显写死默认、overridden=false', () => {
  const view = panel().getView();
  assert.equal(view.postAgeMaxHours, DEFAULT_HOT_LEAD_GATE_CONFIG.maxAgeHours);
  assert.equal(view.velocityMin, DEFAULT_HOT_LEAD_GATE_CONFIG.velocityMin);
  assert.equal(view.minLikeFloor, DEFAULT_HOT_LEAD_GATE_CONFIG.minLikeFloor);
  assert.equal(view.overridden, false);
});

test('合法写入 → 热加载回真态、overridden=true', async () => {
  const p = panel();
  const r = await p.set({ postAgeMaxHours: 24, velocityMin: 500, minLikeFloor: 1000 }, 'admin');
  assert.equal(r.ok, true);
  const view = p.getView();
  assert.equal(view.postAgeMaxHours, 24);
  assert.equal(view.velocityMin, 500);
  assert.equal(view.minLikeFloor, 1000);
  assert.equal(view.overridden, true);
  assert.equal(view.updatedBy, 'admin');
});

test('无字段 → no_valid_fields', async () => {
  const r = await panel().set({}, 'admin');
  assert.equal(r.ok, false);
  assert.equal((r as { reason: string }).reason, 'no_valid_fields');
});

test('非法值（0/负/非整）整块拒、不落库', async () => {
  const p = panel();
  for (const bad of [0, -1, 1.5, Number.NaN]) {
    const r = await p.set({ velocityMin: bad }, 'admin');
    assert.equal(r.ok, false);
    assert.equal((r as { reason: string }).reason, 'invalid_value');
  }
  assert.equal(p.getView().overridden, false); // 一次都没落库
});

test('部分字段合法写入，其余保持默认', async () => {
  const p = panel();
  await p.set({ postAgeMaxHours: 12 }, 'admin');
  const view = p.getView();
  assert.equal(view.postAgeMaxHours, 12);
  assert.equal(view.velocityMin, DEFAULT_HOT_LEAD_GATE_CONFIG.velocityMin); // 未传 → 回落默认
});
