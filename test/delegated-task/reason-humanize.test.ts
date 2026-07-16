import { test } from 'node:test';
import assert from 'node:assert/strict';
import { humanizeAttemptReason } from '../../src/delegated-task/reason-humanize.js';

test('humanizeAttemptReason: 已知精确码翻成人话', () => {
  assert.match(humanizeAttemptReason('needs_persona_setup'), /未配置人设/);
  assert.match(humanizeAttemptReason('today_inspiration_unavailable'), /无可用灵感稿源/);
  assert.match(humanizeAttemptReason('candidate_record_missing'), /落库记录缺失/);
});

test('humanizeAttemptReason: 前缀式码保留参数（风控状态值不得丢）', () => {
  const s = humanizeAttemptReason('risk_status(warned)');
  assert.match(s, /风控状态/);
  assert.match(s, /warned/);

  const d = humanizeAttemptReason('risk_denied(status=restricted)');
  assert.match(d, /风控拒绝/);
  assert.match(d, /restricted/);

  const e = humanizeAttemptReason('executor_exception:socket hang up');
  assert.match(e, /执行器异常/);
  assert.match(e, /socket hang up/);
});

test('humanizeAttemptReason: 中文人话句原样透传（不重复加工）', () => {
  const raw = '已有一轮发帖编排在运行中，本次未触发（already_running）';
  assert.equal(humanizeAttemptReason(raw), raw);
});

// 红线（spec「原因人话化必须只翻译已知码、未知码原样透传」）：宁可让运营看见生码，
// 也绝不猜它的意思——美化成一句听着像诊断、实则无证据支撑的话，比不说更坏。
test('humanizeAttemptReason: 未知码原样透传，绝不编造含义', () => {
  assert.equal(humanizeAttemptReason('some_brand_new_code_v2'), 'some_brand_new_code_v2');
  assert.equal(humanizeAttemptReason('Pipeline aborted by content_writer: llm_error'), 'Pipeline aborted by content_writer: llm_error');
});

// 精度上限（spec「失败原因的精度不得超过已落库的证据」）：派发期分步细节从不落库，
// 只能说到「派发阶段」，绝不声称是哪个控件 / 哪条平台文案。
test('humanizeAttemptReason: 派发期失败只说到阶段，不编具体步骤', () => {
  const s = humanizeAttemptReason('candidate_terminal_failed');
  assert.match(s, /派发阶段/);
  assert.doesNotMatch(s, /评论框|输入框|定位|超长|配图/);
});

test('humanizeAttemptReason: 空串 → 空串（由调用方判定「无原因可取」）', () => {
  assert.equal(humanizeAttemptReason(''), '');
  assert.equal(humanizeAttemptReason('   '), '');
});

test('humanizeAttemptReason: 超长文本裁剪后仍保留头尾可辨识片段', () => {
  const long = `Pipeline aborted by content_writer: ${'x'.repeat(300)} ENDMARKER`;
  const out = humanizeAttemptReason(long);
  assert.ok(out.length <= 120, `期望裁到 120 以内，实际 ${out.length}`);
  assert.match(out, /Pipeline aborted by/);
  assert.match(out, /ENDMARKER/);
});

// reason 是各产出点的裸字符串。原型链键（toString / constructor / __proto__）裸下标会拿到 Function
// 并通过 truthy 判定被当成翻译结果返回；声明是 Record<string,string>，typecheck 看不见。
// 后果不是文案难看，是调用方 .replace() 抛错、终态收敛被打断。
test('humanizeAttemptReason: 原型链键不得被当成命中（否则返回 Function、调用方炸）', () => {
  for (const key of ['toString', 'constructor', 'valueOf', 'hasOwnProperty', '__proto__']) {
    const out = humanizeAttemptReason(key);
    assert.equal(typeof out, 'string', `${key} 必须返回 string`);
    assert.equal(out, key, `${key} 未命中白名单 → 应原样透传`);
  }
});
