import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FALLBACK_SLOW_START_TOTAL_DAYS,
  projectClientSlowStartCurve,
  slowStartTotalDaysFor,
  type FacebookSlowStartAuthoredCurve,
} from '../src/client-auth/client-slow-start-curve.js';
import { SLOW_START_TOTAL_DAYS } from '../src/risk/risk-controller.js';

function authored(totalDays: number, rows = totalDays): FacebookSlowStartAuthoredCurve {
  return {
    totalDays,
    dailyCaps: Array.from({ length: rows }, (_, index) => ({
      day: index + 1,
      view: 10 + index,
      like: index,
      comment: index,
      follow: index,
      publish: 0,
      search: index,
      joinGroup: index,
    })),
  };
}

test('曲线：行数与总天数对不上时整体缺席（半张表比没有表更危险）', () => {
  assert.equal(projectClientSlowStartCurve('facebook', authored(10, 7)), null);
  assert.ok(projectClientSlowStartCurve('facebook', authored(10)), '自洽时正常下发');
});

test('曲线：平台判据与既有 Facebook 环境准入同源，认 fb 别名、不认未知平台', () => {
  assert.ok(projectClientSlowStartCurve('fb', authored(7)), 'fb 别名同样是 Facebook 环境');
  assert.equal(projectClientSlowStartCurve('xiaohongshu', authored(7)), null);
  assert.equal(projectClientSlowStartCurve(null, authored(7)), null, '平台未确认 ⇒ 不下发');
  assert.equal(projectClientSlowStartCurve('tiktok', authored(7)), null, '未登记平台 ⇒ 不下发、不抛');
});

test('总天数：Facebook 取后台配置，其余情况取回落值且该值与风控侧同源', () => {
  assert.equal(slowStartTotalDaysFor('facebook', authored(10)), 10);
  assert.equal(slowStartTotalDaysFor('facebook', null), FALLBACK_SLOW_START_TOTAL_DAYS);
  assert.equal(slowStartTotalDaysFor('xiaohongshu', authored(10)), FALLBACK_SLOW_START_TOTAL_DAYS);
  // 按引用断言：两处各写一份 7 是刻意的（分属不同服务），但它们必须相等——
  // 靠人记得同步就是那种「改了一处、另一处安静地继续报旧天数」的漂移。
  assert.equal(FALLBACK_SLOW_START_TOTAL_DAYS, SLOW_START_TOTAL_DAYS);
});
