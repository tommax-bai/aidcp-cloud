import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDeAiRewritePrompt } from '../../src/publish-agent/prompts.js';

// change llm-role-review-remediation:重写产物逐字成为发布正文,prompt 必须显式约束只输出正文。
test('去 AI 味重写 prompt：显式约束只输出正文本身', () => {
  const p = buildDeAiRewritePrompt('正文内容', ['首先', '总之']);
  assert.ok(p.includes('只输出重写后的正文本身'), '缺少输出约束（前言会逐字进入发布正文）');
  assert.ok(p.includes('首先、总之'), 'flagged 词表照常注入');
  assert.ok(p.includes('正文内容'), '原文照常注入');
  assert.ok(p.includes('保持输入正文的原语言') && p.includes('不得翻译或切换语言'), '重写不得把已确定语言转换成翻译腔');
  assert.ok(p.includes('口吻') && !p.includes('口吾'), '「口吾」笔误已修正');
});
