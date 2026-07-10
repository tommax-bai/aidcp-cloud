import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPacingSnapshot,
  clampFloorRange,
  tempoForStatus,
  BUILTIN_FLOOR,
  OP_MIN_FLOOR,
  CAP_MS,
  PACING_OPS,
  maxFloorForOp,
  type PacingFloorProvider,
} from '../src/risk/pacing.js';
import { IDLE_NUDGE_MIN_MS } from '../src/risk/resume-limits.js';
import type { PacingOp, PacingFloorPayload } from '../src/comm/protocol.js';

const builtinProvider: PacingFloorProvider = {
  floorFor: (op: PacingOp): PacingFloorPayload => ({ ...BUILTIN_FLOOR[op] }),
};

test('buildPacingSnapshot：正常 → tempo=tempoForStatus + 四类操作 floor 全带', () => {
  const snap = buildPacingSnapshot('normal', 'normal', builtinProvider);
  assert.ok(snap, '应返回快照');
  assert.equal(snap!.tempo, tempoForStatus('normal'));
  assert.equal(snap!.tempo, 1.0, 'normal tempo 逐位等于 1.0（钉死「现役恒 1.0 ≈ 尚未生效」）');
  for (const op of PACING_OPS) {
    assert.deepEqual(snap!.opFloorsMs[op], { minMs: BUILTIN_FLOOR[op].minMs, maxMs: BUILTIN_FLOOR[op].maxMs }, `${op} floor 应在快照内`);
  }
});

test('buildPacingSnapshot：tempo 随风控档单调放慢', () => {
  assert.equal(buildPacingSnapshot('warned', 'normal', builtinProvider)!.tempo, tempoForStatus('warned'));
  assert.ok(buildPacingSnapshot('restricted', 'normal', builtinProvider)!.tempo > buildPacingSnapshot('normal', 'normal', builtinProvider)!.tempo);
});

test('buildPacingSnapshot：conservative 配额档即便风控 normal 也放慢 tempo=1.3（quota→tempo）', () => {
  assert.equal(buildPacingSnapshot('normal', 'conservative', builtinProvider)!.tempo, 1.3, '保守账号 status normal 下 tempo 取配额档 1.3');
  assert.equal(buildPacingSnapshot('normal', 'aggressive', builtinProvider)!.tempo, 1.0, '激进只多做不提速：tempo 仍 1.0');
  assert.equal(buildPacingSnapshot('restricted', 'conservative', builtinProvider)!.tempo, 1.6, 'status 更差时取更慢者 1.6（盖过配额档）');
});

test('buildPacingSnapshot：provider 抛错 → 返回 undefined（total 函数，绝不 brick 握手）', () => {
  const throwing: PacingFloorProvider = {
    floorFor: () => {
      throw new Error('store down');
    },
  };
  const snap = buildPacingSnapshot('normal', 'normal', throwing);
  assert.equal(snap, undefined, 'provider 抛错必须回退 undefined、省略 pacing 字段');
});

test('buildPacingSnapshot：provider 漏夹的越界值 → 快照防御性二次夹（非零 ≤CAP）', () => {
  const leaky: PacingFloorProvider = {
    floorFor: (): PacingFloorPayload => ({ minMs: 0, maxMs: 999999 }),
  };
  const snap = buildPacingSnapshot('normal', 'normal', leaky)!;
  for (const op of PACING_OPS) {
    const f = snap.opFloorsMs[op]!;
    assert.ok(f.minMs >= OP_MIN_FLOOR[op] && f.minMs > 0, `${op} 快照 min 恒 ≥ 非零下限`);
    assert.ok(f.maxMs <= maxFloorForOp(op), `${op} 快照 max 恒 ≤ 类别 CAP`);
  }
});

test('clampFloorRange：0→下限、超界→CAP、越序→抬 max、合法→原样', () => {
  assert.deepEqual(clampFloorRange('action', 0, 0), { minMs: OP_MIN_FLOOR.action, maxMs: OP_MIN_FLOOR.action });
  assert.deepEqual(clampFloorRange('scroll', 999999, 999999), { minMs: CAP_MS, maxMs: CAP_MS });
  assert.deepEqual(clampFloorRange('content_read', 999999, 999999), { minMs: 90_000, maxMs: 90_000 });
  const ord = clampFloorRange('detail_dwell', 5000, 2000);
  assert.ok(ord.maxMs >= ord.minMs);
  assert.deepEqual(clampFloorRange('card_gap', 3000, 7000), { minMs: 3000, maxMs: 7000 });
});

test('看门狗 lockstep 不变量（tripwire）：CAP_MS ≪ IDLE_NUDGE_MIN_MS —— 任何 op 兜底恒不误触 idle 看门狗', () => {
  assert.ok(
    CAP_MS < IDLE_NUDGE_MIN_MS,
    `操作兜底 floor 上限 CAP_MS(${CAP_MS}) 必须严格小于空闲看门狗轻推下限 IDLE_NUDGE_MIN_MS(${IDLE_NUDGE_MIN_MS})——` +
      `否则单次前台最小间隔等待可能逼近/触发 idle 看门狗杀会话。下调 IDLE_NUDGE_MIN_MS 或上调 CAP_MS 前须守此关系。`,
  );
  // 结构性余量：CAP 应远小于（≤ 1/10）下限，避免叠加抖动后逼近。
  assert.ok(CAP_MS * 10 <= IDLE_NUDGE_MIN_MS, 'CAP_MS 应 ≤ IDLE_NUDGE_MIN_MS 的 1/10（结构性安全余量）');
});

test('每 op 防呆下限 < 内置默认 min < 内置默认 max ≤ CAP（配置区间自洽）', () => {
  for (const op of PACING_OPS) {
    assert.ok(OP_MIN_FLOOR[op] > 0, `${op} 防呆下限须 > 0`);
    assert.ok(OP_MIN_FLOOR[op] <= BUILTIN_FLOOR[op].minMs, `${op} 内置 min 须 ≥ 防呆下限`);
    assert.ok(BUILTIN_FLOOR[op].minMs < BUILTIN_FLOOR[op].maxMs, `${op} 内置区间须有展宽`);
    assert.ok(BUILTIN_FLOOR[op].maxMs <= maxFloorForOp(op), `${op} 内置 max 须 ≤ 类别 CAP`);
    assert.ok(maxFloorForOp(op) < IDLE_NUDGE_MIN_MS, `${op} 类别 CAP 须低于 idle 轻推下限`);
    // 内置默认满足 facade 的 1.5× 最小展宽（自身也是合法配置）。
    assert.ok(BUILTIN_FLOOR[op].maxMs >= BUILTIN_FLOOR[op].minMs * 1.5, `${op} 内置默认须满足 1.5× 最小展宽`);
  }
});
