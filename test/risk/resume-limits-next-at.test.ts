import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isWithinActiveWindow,
  nextActiveWindowStartAt,
  nextLocalDayStartAt,
} from '../../src/risk/resume-limits.js';

/** 构造一个「服务器本地」时刻，与被测函数的时区口径一致（它们都用 getHours/getFullYear 等本地 API）。 */
function localAt(y: number, m: number, d: number, h: number, min = 0): number {
  return new Date(y, m - 1, d, h, min, 0, 0).getTime();
}
function minuteOfDay(ms: number): number {
  const d = new Date(ms);
  return d.getHours() * 60 + d.getMinutes();
}

test('nextActiveWindowStartAt: 普通窗口，今日起点已过 → 明日同一时刻', () => {
  const win = { startMin: 9 * 60, endMin: 23 * 60 }; // 09:00–23:00
  const now = localAt(2026, 7, 14, 23, 30); // 窗口外（当日已收工）
  assert.equal(isWithinActiveWindow(minuteOfDay(now), win), false);
  assert.equal(nextActiveWindowStartAt(now, win), localAt(2026, 7, 15, 9));
});

test('nextActiveWindowStartAt: 普通窗口，今日起点未到 → 今日该时刻', () => {
  const win = { startMin: 9 * 60, endMin: 23 * 60 };
  const now = localAt(2026, 7, 14, 2, 0);
  assert.equal(isWithinActiveWindow(minuteOfDay(now), win), false);
  assert.equal(nextActiveWindowStartAt(now, win), localAt(2026, 7, 14, 9));
});

test('nextActiveWindowStartAt: 跨午夜窗口（22:00–06:00），窗口外 → 今日 22:00', () => {
  // 跨午夜窗口只在 end <= now < start 时才判为窗口外，此时今日 startMin 必然仍在未来 —— 这条测试钉死
  // 「+1 天」那一支在跨午夜情形下永不被误触发。
  const win = { startMin: 22 * 60, endMin: 6 * 60 };
  const now = localAt(2026, 7, 14, 7, 0); // 06:00 之后、22:00 之前 = 窗口外
  assert.equal(isWithinActiveWindow(minuteOfDay(now), win), false);
  assert.equal(nextActiveWindowStartAt(now, win), localAt(2026, 7, 14, 22));
});

test('nextActiveWindowStartAt: 跨午夜窗口内（凌晨 3 点）不该被问 —— 但即便问了也不返回过去的时刻', () => {
  const win = { startMin: 22 * 60, endMin: 6 * 60 };
  const now = localAt(2026, 7, 14, 3, 0);
  assert.equal(isWithinActiveWindow(minuteOfDay(now), win), true); // 窗口内
  const at = nextActiveWindowStartAt(now, win);
  assert.ok(at !== undefined && at > now, '绝不返回过去的时刻');
});

test('nextActiveWindowStartAt: 全天不限 → undefined（永不阻塞，无「下一个窗口」可言）', () => {
  const now = localAt(2026, 7, 14, 12);
  assert.equal(nextActiveWindowStartAt(now, { startMin: 0, endMin: 1440 }), undefined);
  assert.equal(nextActiveWindowStartAt(now, { startMin: 600, endMin: 600 }), undefined);
});

test('nextLocalDayStartAt: 下一个**本地**日界（红线：不是上海日界）', () => {
  const now = localAt(2026, 7, 14, 23, 59);
  assert.equal(nextLocalDayStartAt(now), localAt(2026, 7, 15, 0));

  // 续场计数按 localDayKey（getFullYear/getMonth/getDate = 服务器本地）换日，而风控 day 窗口与今日用量按
  // 上海日界。恢复时刻只能按前者算 —— 这里断言本函数确实与本地日界对齐，且严格落在未来。
  const noon = localAt(2026, 7, 14, 12);
  const at = nextLocalDayStartAt(noon);
  assert.ok(at > noon);
  const d = new Date(at);
  assert.equal(d.getHours(), 0);
  assert.equal(d.getMinutes(), 0);
  assert.equal(d.getDate(), 15);
});

test('nextLocalDayStartAt: 跨月边界', () => {
  const now = localAt(2026, 7, 31, 20);
  assert.equal(nextLocalDayStartAt(now), localAt(2026, 8, 1, 0));
});
