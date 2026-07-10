import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_FB_DAILY_ONLINE_MINUTES, effectiveDailyMaxMinutes } from '../src/risk/resume-limits.js';

// change account-nurture-discipline-spine §4.2：FB 每日在线时长预算。全局每日时长阈值是全局单例、不分平台；
// 全局未设(0=不限)时 FB 账号回落非零安全日窗（养号「每天在线 0.5-6h」），其它平台维持历史「不限」。

test('全局显式设值 → 以全局为准（运营意图优先，覆盖平台默认）', () => {
  assert.equal(effectiveDailyMaxMinutes(120, 'facebook'), 120);
  assert.equal(effectiveDailyMaxMinutes(120, 'xiaohongshu'), 120);
  assert.equal(effectiveDailyMaxMinutes(120, undefined), 120);
});

test('全局未设(0) + Facebook → 回落 FB 非零默认日窗', () => {
  assert.equal(effectiveDailyMaxMinutes(0, 'facebook'), DEFAULT_FB_DAILY_ONLINE_MINUTES);
  assert.ok(DEFAULT_FB_DAILY_ONLINE_MINUTES > 0 && DEFAULT_FB_DAILY_ONLINE_MINUTES <= 360);
});

test('全局未设(0) + 小红书/未知平台 → 0（不限，历史行为零回归）', () => {
  assert.equal(effectiveDailyMaxMinutes(0, 'xiaohongshu'), 0);
  assert.equal(effectiveDailyMaxMinutes(0, undefined), 0);
});

test('FB 自定义默认被采用；负值被夹到 0', () => {
  assert.equal(effectiveDailyMaxMinutes(0, 'facebook', 90), 90);
  assert.equal(effectiveDailyMaxMinutes(0, 'facebook', -5), 0);
});
