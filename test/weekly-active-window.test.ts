/**
 * change weekly-active-window：「可活跃时间」周历掩码纯函数（risk/session-limits.ts）单测。
 * 校验：掩码合法性、周一起头的天索引、按 天×小时 查格、缺失/非法 → 全天活跃（零回归）。
 * 用 new Date(年,月,日,时) 构造**本地时间**（与生产判定同口径）。2026-06-29 为周一。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  WEEK_ACTIVE_MASK_LEN,
  isValidWeekActiveMask,
  mondayBasedDayIndex,
  isWeekActiveAt,
  msUntilNextActive,
} from '../src/risk/session-limits.js';

/** 工作日（周一–周五）09:00–22:00 活跃的 168 掩码（测试夹具）。 */
function workdayMask(): string {
  let s = '';
  for (let d = 0; d < 7; d++) for (let h = 0; h < 24; h++) s += d <= 4 && h >= 9 && h < 22 ? '1' : '0';
  return s;
}

test('WEEK_ACTIVE_MASK_LEN = 168（7×24）', () => {
  assert.equal(WEEK_ACTIVE_MASK_LEN, 168);
});

test('isValidWeekActiveMask：仅 168 长的 0/1 串合法', () => {
  assert.equal(isValidWeekActiveMask('1'.repeat(168)), true);
  assert.equal(isValidWeekActiveMask('0'.repeat(168)), true);
  assert.equal(isValidWeekActiveMask('1'.repeat(167)), false, '短一位非法');
  assert.equal(isValidWeekActiveMask('1'.repeat(169)), false, '长一位非法');
  assert.equal(isValidWeekActiveMask('2'.repeat(168)), false, '非 0/1 非法');
  assert.equal(isValidWeekActiveMask(''), false);
  assert.equal(isValidWeekActiveMask(null), false);
  assert.equal(isValidWeekActiveMask(undefined), false);
  assert.equal(isValidWeekActiveMask(123), false);
});

test('mondayBasedDayIndex：周一=0 … 周日=6', () => {
  assert.equal(mondayBasedDayIndex(new Date(2026, 5, 29, 12)), 0, '2026-06-29 周一=0');
  assert.equal(mondayBasedDayIndex(new Date(2026, 5, 30, 12)), 1, '2026-06-30 周二=1');
  assert.equal(mondayBasedDayIndex(new Date(2026, 6, 4, 12)), 5, '2026-07-04 周六=5');
  assert.equal(mondayBasedDayIndex(new Date(2026, 5, 28, 12)), 6, '2026-06-28 周日=6');
});

test('isWeekActiveAt：掩码缺失 / 非法 → 全天活跃（true，零回归）', () => {
  const d = new Date(2026, 5, 29, 3); // 周一 03:00
  assert.equal(isWeekActiveAt(null, d), true);
  assert.equal(isWeekActiveAt(undefined, d), true);
  assert.equal(isWeekActiveAt('bad', d), true);
  assert.equal(isWeekActiveAt('1'.repeat(167), d), true, '长度非法也回落全天活跃');
});

test('isWeekActiveAt：全 0 掩码 → 处处休眠', () => {
  assert.equal(isWeekActiveAt('0'.repeat(168), new Date(2026, 5, 29, 10)), false);
  assert.equal(isWeekActiveAt('0'.repeat(168), new Date(2026, 5, 28, 23)), false);
});

test('isWeekActiveAt：按 周一起头 × 小时 精确查格', () => {
  // 只点亮「周一 09:00」一格：idx = 0*24 + 9 = 9
  const monday9 = '0'.repeat(9) + '1' + '0'.repeat(158);
  assert.equal(monday9.length, 168);
  assert.equal(isWeekActiveAt(monday9, new Date(2026, 5, 29, 9)), true, '周一09点活跃');
  assert.equal(isWeekActiveAt(monday9, new Date(2026, 5, 29, 10)), false, '周一10点休眠');
  assert.equal(isWeekActiveAt(monday9, new Date(2026, 5, 30, 9)), false, '周二09点休眠');

  // 只点亮「周日 23:00」一格：idx = 6*24 + 23 = 167（末位）
  const sunday23 = '0'.repeat(167) + '1';
  assert.equal(isWeekActiveAt(sunday23, new Date(2026, 5, 28, 23)), true, '周日23点活跃');
  assert.equal(isWeekActiveAt(sunday23, new Date(2026, 5, 28, 22)), false, '周日22点休眠');
});

test('msUntilNextActive：缺 / 非法掩码 → null（全天活跃，无需唤醒）', () => {
  assert.equal(msUntilNextActive(null, new Date(2026, 5, 29, 3).getTime()), null);
  assert.equal(msUntilNextActive(undefined, 123), null);
  assert.equal(msUntilNextActive('bad', 123), null);
});

test('msUntilNextActive：当前已活跃 → null（不该在活跃时排唤醒）', () => {
  assert.equal(msUntilNextActive('1'.repeat(168), new Date(2026, 5, 29, 9, 30).getTime()), null);
  assert.equal(msUntilNextActive(workdayMask(), new Date(2026, 5, 29, 10, 15).getTime()), null, '周一10:15 活跃');
});

test('msUntilNextActive：整周全休眠 → null（永不唤醒，尊重运营关停）', () => {
  assert.equal(msUntilNextActive('0'.repeat(168), new Date(2026, 5, 29, 9, 30).getTime()), null);
});

test('msUntilNextActive：当前休眠、本日稍后活跃 → 距下一活跃整点毫秒', () => {
  // 工作日 09-22；周一 08:30 休眠 → 下一活跃 09:00 → 30min
  assert.equal(msUntilNextActive(workdayMask(), new Date(2026, 5, 29, 8, 30, 0).getTime()), 30 * 60_000);
  // 周一 22:10 休眠 → 下一活跃 = 周二 09:00 → 10h50min
  assert.equal(msUntilNextActive(workdayMask(), new Date(2026, 5, 29, 22, 10, 0).getTime()), (10 * 60 + 50) * 60_000);
});

test('msUntilNextActive：跨天找次日活跃（周日深夜 → 周一 09:00）', () => {
  // 周日全休眠；周日 2026-06-28 23:00 → 下一活跃 = 周一 09:00 → 10h
  assert.equal(msUntilNextActive(workdayMask(), new Date(2026, 5, 28, 23, 0, 0).getTime()), 10 * 60 * 60_000);
});

test('isWeekActiveAt：典型「工作日 09-22」掩码', () => {
  // 周一~周五 09:00-21:59 活跃，其余休眠
  let mask = '';
  for (let day = 0; day < 7; day++) {
    for (let hour = 0; hour < 24; hour++) {
      const active = day <= 4 && hour >= 9 && hour < 22;
      mask += active ? '1' : '0';
    }
  }
  assert.equal(mask.length, 168);
  assert.equal(isWeekActiveAt(mask, new Date(2026, 5, 29, 9)), true, '周一09点活跃');
  assert.equal(isWeekActiveAt(mask, new Date(2026, 5, 29, 21)), true, '周一21点活跃');
  assert.equal(isWeekActiveAt(mask, new Date(2026, 5, 29, 22)), false, '周一22点休眠');
  assert.equal(isWeekActiveAt(mask, new Date(2026, 5, 29, 8)), false, '周一08点休眠');
  assert.equal(isWeekActiveAt(mask, new Date(2026, 6, 4, 12)), false, '周六12点休眠');
  assert.equal(isWeekActiveAt(mask, new Date(2026, 5, 28, 12)), false, '周日12点休眠');
});
