import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SimplePlanner, parsePlanSteps } from '@automation/planner/index.js';
import type { LlmClient } from '@content/llm/index.js';

test('规则命中：点赞 → 单步 click', async () => {
  const planner = new SimplePlanner();
  const plan = await planner.plan({ goal: '给这条笔记点赞' });
  assert.equal(plan.reason, 'rule_matched');
  assert.equal(plan.steps.length, 1);
  assert.equal(plan.steps[0].actionId, 'note.like_button');
  assert.equal(plan.steps[0].op, 'click');
});

test('规则命中：搜索 → input + click 两步，提取关键词', async () => {
  const planner = new SimplePlanner();
  const plan = await planner.plan({ goal: '搜索 露营装备' });
  assert.equal(plan.steps.length, 2);
  assert.equal(plan.steps[0].op, 'input');
  assert.equal(plan.steps[0].value, '露营装备');
  assert.equal(plan.steps[1].op, 'click');
});

test('未命中规则且无 LLM → 空步骤', async () => {
  const planner = new SimplePlanner();
  const plan = await planner.plan({ goal: '做一些很奇怪的事情' });
  assert.equal(plan.steps.length, 0);
  assert.equal(plan.reason, 'no_rule_no_llm');
});

test('LLM 兜底：解析模型返回的 JSON 步骤', async () => {
  const fakeLlm: LlmClient = {
    complete: async () =>
      '这是计划：[{"actionId":"x.btn","op":"click","goal":"点 X"},{"actionId":"y.in","op":"input","goal":"填 Y","value":"hi"}]',
  };
  const planner = new SimplePlanner({ llm: fakeLlm });
  const plan = await planner.plan({ goal: '完成某复杂操作' });
  assert.equal(plan.reason, 'llm_planned');
  assert.equal(plan.steps.length, 2);
  assert.equal(plan.steps[1].value, 'hi');
});

test('parsePlanSteps 过滤非法 op / 缺字段', () => {
  const steps = parsePlanSteps(
    '[{"actionId":"a","op":"click","goal":"ok"},{"actionId":"b","op":"teleport","goal":"bad"},{"op":"click","goal":"no id"}]',
  );
  assert.equal(steps.length, 1);
  assert.equal(steps[0].actionId, 'a');
});

test('parsePlanSteps 容忍非 JSON 文本 → 空数组', () => {
  assert.deepEqual(parsePlanSteps('对不起我不知道'), []);
});
