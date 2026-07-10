import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeDwellMs,
  computeThinkMs,
  computeFeedFloorMs,
  tempoForStatus,
  tempoForQuotaLevel,
  effectiveTempo,
  fatigueMultiplier,
  DWELL_FLOOR_MS,
  FEED_FLOOR,
  type PacingFloorProvider,
} from '../src/risk/index.js';

test('tempo 随风控状态单调放慢：normal < warned < restricted', () => {
  assert.ok(tempoForStatus('normal') < tempoForStatus('warned'));
  assert.ok(tempoForStatus('warned') < tempoForStatus('restricted'));
  assert.equal(tempoForStatus('normal'), 1.0);
});

test('computeDwellMs：长内容停留 > 短内容（同状态同模式）', () => {
  const base = { mode: 'read' as const, status: 'normal' as const, progress: 0.3 };
  const short = computeDwellMs({ textLen: 50, ...base });
  const long = computeDwellMs({ textLen: 3000, ...base });
  assert.ok(long > short, `long(${long}) 应 > short(${short})`);
});

test('computeDwellMs：始终不低于感知下限（治秒退）', () => {
  const dwell = computeDwellMs({ textLen: 0, mode: 'glance', status: 'normal', progress: 0.3 });
  assert.ok(dwell >= DWELL_FLOOR_MS.min, `dwell(${dwell}) 应 ≥ floor(${DWELL_FLOOR_MS.min})`);
});

test('computeDwellMs：glance 模式短于 read 模式（同内容）', () => {
  const common = { textLen: 3000, status: 'normal' as const, progress: 0.3 };
  const glance = computeDwellMs({ mode: 'glance', ...common });
  const read = computeDwellMs({ mode: 'read', ...common });
  assert.ok(glance < read, `glance(${glance}) 应 < read(${read})`);
});

test('computeDwellMs：风控状态降级时中心值单调放大（同内容）', () => {
  const common = { textLen: 1500, mode: 'read' as const, progress: 0.3 };
  const normal = computeDwellMs({ status: 'normal', ...common });
  const warned = computeDwellMs({ status: 'warned', ...common });
  const restricted = computeDwellMs({ status: 'restricted', ...common });
  assert.ok(normal < warned && warned < restricted, `${normal} < ${warned} < ${restricted}`);
});

test('computeDwellMs：上限截断（超长文不超过 cap）', () => {
  const dwell = computeDwellMs({ textLen: 1_000_000, mode: 'read', status: 'restricted', progress: 1 });
  assert.ok(dwell <= 90_000, `dwell(${dwell}) 应 ≤ cap`);
});

test('computeDwellMs：正文阅读/扫读使用后台配置夹点', () => {
  const pacing: PacingFloorProvider = {
    floorFor: (op) => (op === 'content_read' ? { minMs: 10_000, maxMs: 12_000 } : { minMs: 2500, maxMs: 5000 }),
  };
  const dwell = computeDwellMs({ textLen: 0, mode: 'read', status: 'normal', progress: 0.3, pacing });
  assert.equal(dwell, 10_000);
});

test('computeThinkMs：状态降级单调放大', () => {
  const normal = computeThinkMs({ status: 'normal', progress: 0.3 });
  const warned = computeThinkMs({ status: 'warned', progress: 0.3 });
  assert.ok(warned > normal, `warned(${warned}) 应 > normal(${normal})`);
});

test('computeThinkMs：熟悉内容折扣至约 1/3、非零下限、非熟悉为全量', () => {
  const full = computeThinkMs({ status: 'normal', progress: 0.4 });
  const familiar = computeThinkMs({ status: 'normal', progress: 0.4, familiar: true });
  assert.ok(familiar < full, `familiar(${familiar}) 应 < full(${full})`);
  // 约 1/3（允许下限夹取带来的偏差）
  assert.ok(familiar <= Math.round(full / 3) + 1 && familiar >= 150, `familiar(${familiar}) 应约为 full/3 且 ≥ 下限 150`);
  // 非零下限：即便深度疲劳后段，熟悉折扣也不退化为 0
  const familiarLate = computeThinkMs({ status: 'normal', progress: 0.99, familiar: true });
  assert.ok(familiarLate >= 150, `熟悉折扣仍应 ≥ 非零下限，实得 ${familiarLate}`);
});

test('computeDwellMs：不受 familiar 影响（笔记停留不折扣）', () => {
  const a = computeDwellMs({ textLen: 600, imgCount: 2, mode: 'read', status: 'normal', progress: 0.4 });
  // dwell 无 familiar 入参；同输入恒等，确保熟悉折扣未波及停留（治秒退红线）
  const b = computeDwellMs({ textLen: 600, imgCount: 2, mode: 'read', status: 'normal', progress: 0.4 });
  assert.equal(a, b);
  assert.ok(a >= DWELL_FLOOR_MS.min);
});

test('fatigueMultiplier：热身略慢、中段 1.0、后段放大', () => {
  assert.ok(fatigueMultiplier(0.05) > 1.0); // 热身
  assert.equal(fatigueMultiplier(0.4), 1.0); // 自然
  assert.ok(fatigueMultiplier(0.95) > 1.0); // 疲劳
  assert.ok(fatigueMultiplier(0.95) > fatigueMultiplier(0.75)); // 后段越走越慢
});

// ======== feed-scroll-card-floor：按新卡数的翻页停留兜底 ========

test('computeFeedFloorMs：无新卡（0）→ 0（返回未刷新不加延迟）', () => {
  assert.equal(computeFeedFloorMs({ newCount: 0, status: 'normal', progress: 0.3 }), 0);
  assert.equal(computeFeedFloorMs({ newCount: -3, status: 'normal', progress: 0.3 }), 0);
});

test('computeFeedFloorMs：按新卡数线性缩放（3–4 张≈1.3–1.8s，normal/中段）', () => {
  const base = { status: 'normal' as const, progress: 0.3 }; // fatigue=1.0
  const three = computeFeedFloorMs({ newCount: 3, ...base });
  const four = computeFeedFloorMs({ newCount: 4, ...base });
  assert.equal(three, FEED_FLOOR.perCardMs * 3); // 1350
  assert.equal(four, FEED_FLOOR.perCardMs * 4);  // 1800
  assert.ok(four > three);
});

test('computeFeedFloorMs：整屏换新封顶 capMs', () => {
  const big = computeFeedFloorMs({ newCount: 30, status: 'normal', progress: 0.3 });
  assert.equal(big, FEED_FLOOR.capMs);
  // 单调不降且不超过封顶
  const mid = computeFeedFloorMs({ newCount: 8, status: 'normal', progress: 0.3 });
  assert.ok(mid <= FEED_FLOOR.capMs && mid >= computeFeedFloorMs({ newCount: 3, status: 'normal', progress: 0.3 }));
});

test('computeFeedFloorMs：Feed卡片阅读使用后台配置的每卡值与封顶', () => {
  const pacing: PacingFloorProvider = {
    floorFor: (op) => (op === 'feed_card_read' ? { minMs: 1000, maxMs: 2500 } : { minMs: 1500, maxMs: 4000 }),
  };
  assert.equal(computeFeedFloorMs({ newCount: 2, status: 'normal', progress: 0.3, pacing }), 2000);
  assert.equal(computeFeedFloorMs({ newCount: 5, status: 'normal', progress: 0.3, pacing }), 2500);
});

test('computeFeedFloorMs：风控降级放大（warned > normal，同新卡数、未封顶）', () => {
  const normal = computeFeedFloorMs({ newCount: 3, status: 'normal', progress: 0.3 });
  const warned = computeFeedFloorMs({ newCount: 3, status: 'warned', progress: 0.3 });
  assert.ok(warned > normal, `warned(${warned}) 应 > normal(${normal})`);
});

test('computeFeedFloorMs：会话后段疲劳放大（同新卡数、未封顶）', () => {
  const mid = computeFeedFloorMs({ newCount: 2, status: 'normal', progress: 0.3 }); // fatigue=1.0
  const late = computeFeedFloorMs({ newCount: 2, status: 'normal', progress: 0.95 }); // fatigue>1
  assert.ok(late > mid, `late(${late}) 应 > mid(${mid})`);
});

// ======== pacing-tempo-follows-quota-level：配额档接进节奏 ========

test('tempoForQuotaLevel / effectiveTempo：保守放慢、激进不提速、与 status 取更慢者', () => {
  assert.equal(tempoForQuotaLevel('conservative'), 1.3);
  assert.equal(tempoForQuotaLevel('normal'), 1.0);
  assert.equal(tempoForQuotaLevel('aggressive'), 1.0);
  assert.equal(effectiveTempo('normal', 'conservative'), 1.3, '配额档主导（status normal）');
  assert.equal(effectiveTempo('normal', 'aggressive'), 1.0, '激进不提速');
  assert.equal(effectiveTempo('restricted', 'conservative'), 1.6, 'status 主导（更慢者）');
  assert.equal(effectiveTempo('warned', 'conservative'), 1.3, '相等取 1.3');
  assert.equal(effectiveTempo('normal', 'normal'), tempoForStatus('normal'), '默认退化为 tempoForStatus（零回归）');
});

test('computeDwellMs/computeThinkMs：conservative 放慢、aggressive 不提速（status normal）', () => {
  const base = { textLen: 500, mode: 'read' as const, status: 'normal' as const, progress: 0.4 };
  const dNormal = computeDwellMs({ ...base, quotaLevel: 'normal' });
  const dConservative = computeDwellMs({ ...base, quotaLevel: 'conservative' });
  const dAggressive = computeDwellMs({ ...base, quotaLevel: 'aggressive' });
  assert.ok(dConservative > dNormal, `保守应放慢 dwell（${dConservative} > ${dNormal}）`);
  assert.equal(dAggressive, dNormal, '激进不提速：dwell 与 normal 相同');

  const tNormal = computeThinkMs({ status: 'normal', quotaLevel: 'normal', progress: 0.4 });
  const tConservative = computeThinkMs({ status: 'normal', quotaLevel: 'conservative', progress: 0.4 });
  assert.ok(tConservative > tNormal, `保守应放慢 think（${tConservative} > ${tNormal}）`);
});

test('computeDwellMs：status 更差时配额档不再改变（被更大 status-tempo 盖过）', () => {
  const base = { textLen: 500, mode: 'read' as const, status: 'restricted' as const, progress: 0.4 };
  const dNormal = computeDwellMs({ ...base, quotaLevel: 'normal' });
  const dConservative = computeDwellMs({ ...base, quotaLevel: 'conservative' });
  assert.equal(dConservative, dNormal, 'restricted(1.6) 已 > conservative(1.3)，配额档不再叠加');
});

test('缺省 quotaLevel（不传）→ 退化为 tempoForStatus（向后兼容零回归）', () => {
  const without = computeDwellMs({ textLen: 500, mode: 'read', status: 'normal', progress: 0.4 });
  const withNormal = computeDwellMs({ textLen: 500, mode: 'read', status: 'normal', quotaLevel: 'normal', progress: 0.4 });
  assert.equal(without, withNormal, '不传 quotaLevel 与传 normal 一致');
});
