import test from 'node:test';
import assert from 'node:assert/strict';
import { roleWriteStatus, categoryWriteStatus } from '../src/panel/panel-server.js';

/**
 * 三态不得压成一态：**没能探活**必须与「模型不合法」「目标不存在」逐一可分。
 * 压扁的写法（一个三元表达式）读起来和正确写法几乎一样，所以这里逐值断言，
 * 而不是只测「大概返回 4xx」。
 */

test('角色写：没能探活 → 503，不是 400', () => {
  assert.equal(roleWriteStatus('probe_unavailable'), 503);
  assert.notEqual(roleWriteStatus('probe_unavailable'), roleWriteStatus('model_invalid'));
});

test('角色写：目标不存在 → 404；输入类问题 → 400', () => {
  assert.equal(roleWriteStatus('unknown_role'), 404);
  for (const reason of [
    'model_invalid',
    'provider_key_missing',
    'model_not_configurable',
    'temperature_not_tunable',
    'temperature_out_of_range',
    'thinking_mode_invalid',
  ] as const) {
    assert.equal(roleWriteStatus(reason), 400, `${reason} 应是输入类 400`);
  }
});

test('分类写：三档与角色写同口径', () => {
  assert.equal(categoryWriteStatus('unknown_category'), 404);
  assert.equal(categoryWriteStatus('probe_unavailable'), 503);
  for (const reason of [
    'model_invalid',
    'provider_key_missing',
    'category_not_configurable',
    'thinking_mode_invalid',
  ] as const) {
    assert.equal(categoryWriteStatus(reason), 400, `${reason} 应是输入类 400`);
  }
});

test('「没能探活」与「密钥缺失」不是同一档：前者是后端故障、后者要人去配密钥', () => {
  assert.notEqual(
    roleWriteStatus('probe_unavailable'),
    roleWriteStatus('provider_key_missing'),
  );
});
