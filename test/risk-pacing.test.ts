import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeDwellMs,
  computeThinkMs,
  tempoForStatus,
  fatigueMultiplier,
  buildPacingDefaults,
  DWELL_FLOOR_MS,
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

test('computeThinkMs：状态降级单调放大', () => {
  const normal = computeThinkMs({ status: 'normal', progress: 0.3 });
  const warned = computeThinkMs({ status: 'warned', progress: 0.3 });
  assert.ok(warned > normal, `warned(${warned}) 应 > normal(${normal})`);
});

test('fatigueMultiplier：热身略慢、中段 1.0、后段放大', () => {
  assert.ok(fatigueMultiplier(0.05) > 1.0); // 热身
  assert.equal(fatigueMultiplier(0.4), 1.0); // 自然
  assert.ok(fatigueMultiplier(0.95) > 1.0); // 疲劳
  assert.ok(fatigueMultiplier(0.95) > fatigueMultiplier(0.75)); // 后段越走越慢
});

test('buildPacingDefaults：仅含 tempo 与 dwellFloorMs（不含内容系数）', () => {
  const defaults = buildPacingDefaults('warned');
  assert.equal(defaults.tempo, tempoForStatus('warned'));
  assert.deepEqual(defaults.dwellFloorMs, { min: DWELL_FLOOR_MS.min, max: DWELL_FLOOR_MS.max });
  assert.deepEqual(Object.keys(defaults).sort(), ['dwellFloorMs', 'tempo']);
});
