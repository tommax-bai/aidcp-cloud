import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPacingConfigPanel } from '../src/config/pacing-config-facade.js';
import type { PacingConfigStore, PacingConfigRow } from '../src/config/pacing-config-store.js';
import { BUILTIN_FLOOR, CAP_MS, PACING_OPS, clampFloorRange } from '../src/risk/pacing.js';
import type { PacingOp, PacingFloorPayload } from '../src/comm/protocol.js';

/** 内存假 store：实现 facade 用到的 floorFor / getRow / set，记录 set 调用。库值经 clampFloorRange 模拟读出口夹逼。 */
function fakeStore() {
  const rows = new Map<PacingOp, PacingConfigRow>();
  const setCalls: Array<{ op: PacingOp; minMs: number; maxMs: number }> = [];
  const store = {
    floorFor: (op: PacingOp): PacingFloorPayload => {
      const r = rows.get(op);
      const rawMin = r?.minMs ?? BUILTIN_FLOOR[op].minMs;
      const rawMax = r?.maxMs ?? BUILTIN_FLOOR[op].maxMs;
      return clampFloorRange(op, rawMin, rawMax);
    },
    getRow: (op: PacingOp) => rows.get(op),
    set: async (op: PacingOp, patch: { minMs: number; maxMs: number }, by: string) => {
      setCalls.push({ op, ...patch });
      const row: PacingConfigRow = { operation: op, minMs: patch.minMs, maxMs: patch.maxMs, updatedAt: '2026-07-04T01:00:00.000Z', updatedBy: by };
      rows.set(op, row);
      return row;
    },
  } as unknown as PacingConfigStore;
  return { store, rows, setCalls };
}

test('catalog：四类操作全列出、生效值 = 读出口夹逼后、overridden 区分覆盖/默认', async () => {
  const { store, rows } = fakeStore();
  rows.set('action', { operation: 'action', minMs: 2000, maxMs: 5000, updatedAt: 't', updatedBy: 'alice' });
  const panel = createPacingConfigPanel({ store });
  const view = panel.getCatalog();
  assert.equal(view.pacing.length, PACING_OPS.length);
  const action = view.pacing.find((p) => p.operation === 'action')!;
  assert.deepEqual({ minMs: action.minMs, maxMs: action.maxMs }, { minMs: 2000, maxMs: 5000 });
  assert.equal(action.overridden, true);
  assert.equal(action.updatedBy, 'alice');
  const scroll = view.pacing.find((p) => p.operation === 'scroll')!;
  assert.equal(scroll.overridden, false, '未覆盖 → overridden=false（显示内置默认）');
  assert.equal(scroll.updatedBy, null);
});

test('合法写：非负整数 + min≤max + 展宽 ≥1.5× + ≤CAP → 落库 + 回真态', async () => {
  const { store, setCalls } = fakeStore();
  const panel = createPacingConfigPanel({ store });
  const res = await panel.setPacing({ operation: 'action', minMs: 2000, maxMs: 5000 }, 'alice');
  assert.ok(res.ok);
  assert.equal(setCalls.length, 1);
  if (res.ok) {
    const action = res.view.pacing.find((p) => p.operation === 'action')!;
    assert.equal(action.overridden, true);
  }
});

test('未知 operation → unknown_operation、不落库', async () => {
  const { store, setCalls } = fakeStore();
  const panel = createPacingConfigPanel({ store });
  const res = await panel.setPacing({ operation: 'bogus' as PacingOp, minMs: 2000, maxMs: 5000 }, 'alice');
  assert.deepEqual(res, { ok: false, reason: 'unknown_operation' });
  assert.equal(setCalls.length, 0);
});

test('负数 min → invalid_value、整块拒不落库', async () => {
  const { store, setCalls } = fakeStore();
  const panel = createPacingConfigPanel({ store });
  const res = await panel.setPacing({ operation: 'action', minMs: -1, maxMs: 5000 }, 'alice');
  assert.deepEqual(res, { ok: false, reason: 'invalid_value' });
  assert.equal(setCalls.length, 0);
});

test('非整数 → invalid_value', async () => {
  const { store } = fakeStore();
  const panel = createPacingConfigPanel({ store });
  const res = await panel.setPacing({ operation: 'action', minMs: 1500.5, maxMs: 5000 }, 'alice');
  assert.deepEqual(res, { ok: false, reason: 'invalid_value' });
});

test('展宽不足（max < min×1.5）→ invalid_value（防指纹分布退化尖峰）', async () => {
  const { store, setCalls } = fakeStore();
  const panel = createPacingConfigPanel({ store });
  const res = await panel.setPacing({ operation: 'action', minMs: 2000, maxMs: 2500 }, 'alice'); // 2500 < 3000
  assert.deepEqual(res, { ok: false, reason: 'invalid_value' });
  assert.equal(setCalls.length, 0);
});

test('零展宽（min == max）→ invalid_value', async () => {
  const { store } = fakeStore();
  const panel = createPacingConfigPanel({ store });
  const res = await panel.setPacing({ operation: 'scroll', minMs: 1000, maxMs: 1000 }, 'alice');
  assert.deepEqual(res, { ok: false, reason: 'invalid_value' });
});

test('超 CAP → invalid_value', async () => {
  const { store } = fakeStore();
  const panel = createPacingConfigPanel({ store });
  const res = await panel.setPacing({ operation: 'card_gap', minMs: 3000, maxMs: CAP_MS + 1 }, 'alice');
  assert.deepEqual(res, { ok: false, reason: 'invalid_value' });
});

test('两值都缺 → no_valid_fields', async () => {
  const { store } = fakeStore();
  const panel = createPacingConfigPanel({ store });
  const res = await panel.setPacing({ operation: 'action', minMs: undefined as never, maxMs: undefined as never }, 'alice');
  assert.deepEqual(res, { ok: false, reason: 'no_valid_fields' });
});

test('单值缺（只给 min）→ invalid_value（区间须两端齐备）', async () => {
  const { store } = fakeStore();
  const panel = createPacingConfigPanel({ store });
  const res = await panel.setPacing({ operation: 'action', minMs: 2000, maxMs: undefined as never }, 'alice');
  assert.deepEqual(res, { ok: false, reason: 'invalid_value' });
});

test('minMs=0（合法非负）过表单、但生效值经读出口 clamp ≥ 非零下限（红线：配置抬不穿零延迟）', async () => {
  const { store } = fakeStore();
  const panel = createPacingConfigPanel({ store });
  // min=0 展宽足够（max=2000 ≥ 0×1.5 且 > 0），facade 接受；生效值经 clamp 抬回非零防呆下限。
  const res = await panel.setPacing({ operation: 'action', minMs: 0, maxMs: 2000 }, 'alice');
  assert.ok(res.ok, 'min=0 且展宽合法应过表单');
  if (res.ok) {
    const action = res.view.pacing.find((p) => p.operation === 'action')!;
    assert.ok(action.minMs > 0, '生效 min 经读出口 clamp 恒 > 0（绝不零延迟）');
  }
});
