import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { VisionLlmClient } from '../../src/llm/vision.js';
import { createVisualFidelityAuditor } from '../../src/publish-agent/visual-fidelity-auditor.js';

function payload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    scores: { form: 0.9, subject: 0.85, composition: 0.8, color: 0.82, style: 0.79 },
    risks: { recognizableRealPerson: false, garbledText: false, watermark: false, copiedText: false, originalityRisk: 'low' },
    reason: '结构和抽象风格保持，未见硬风险', retryGuidance: '加强主次关系', ...overrides,
  });
}

describe('VisualFidelityAuditor', () => {
  test('五项过阈且无硬风险才通过', async () => {
    const vision: VisionLlmClient = { chatVision: async () => payload() };
    const auditor = createVisualFidelityAuditor({ vision, minScore: 0.7, clock: () => 7 });
    const out = await auditor.audit({ accountId: 'a', referenceUrl: 'https://r', generatedUrl: 'https://g' });
    assert.equal(out.status, 'passed');
    assert.equal(out.scores?.composition, 0.8);
    assert.equal(out.auditedAt, 7);
  });

  test('乱码/水印/逐字复制等硬风险直接失败', async () => {
    const vision: VisionLlmClient = { chatVision: async () => payload({
      risks: { recognizableRealPerson: false, garbledText: true, watermark: false, copiedText: false, originalityRisk: 'low' },
    }) };
    const out = await createVisualFidelityAuditor({ vision }).audit({ accountId: 'a', referenceUrl: 'https://r', generatedUrl: 'https://g' });
    assert.equal(out.status, 'failed');
    assert.equal(out.risks?.garbledText, true);
  });

  test('有正文视觉 brief 时要求 contentAlignment，人物表演不符即使参考风格合格也失败', async () => {
    let prompt = '';
    const vision: VisionLlmClient = { chatVision: async (messages) => {
      const content = messages[0].content;
      prompt = Array.isArray(content) && content[0]?.type === 'text' ? content[0].text : '';
      return payload({ scores: { form: 0.9, subject: 0.85, composition: 0.8, color: 0.82, style: 0.79, contentAlignment: 0.42 } });
    } };
    const out = await createVisualFidelityAuditor({ vision, minScore: 0.7 }).audit({
      accountId: 'a', referenceUrl: 'https://r', generatedUrl: 'https://g',
      contentVisualBrief: {
        narrativeMoment: '情绪涌来后自我整理', emotion: '脆弱但不崩溃', emotionIntensity: 0.65,
        action: '缓慢呼吸', environment: '安静室内', facialExpression: '眉眼游离、嘴角克制',
        gazeDirection: '侧视', headAngle: '微侧', bodyLanguage: '肩颈放松', avoid: ['标准商业微笑'],
      },
    });
    assert.equal(out.status, 'failed');
    assert.equal(out.scores?.contentAlignment, 0.42);
    assert.match(prompt, /人物表演与叙事语义最高优先级/);
    assert.match(prompt, /标准商业微笑/);
  });

  test('有正文视觉 brief 但响应缺 contentAlignment → 诚实 unverified', async () => {
    const vision: VisionLlmClient = { chatVision: async () => payload() };
    const out = await createVisualFidelityAuditor({ vision }).audit({
      accountId: 'a', referenceUrl: 'r', generatedUrl: 'g',
      contentVisualBrief: {
        narrativeMoment: '转折', emotion: '克制', emotionIntensity: 0.5, action: '停顿', environment: '室内', avoid: [],
      },
    });
    assert.equal(out.status, 'unverified');
  });

  test('模型报错/脏 JSON 诚实 unverified，绝不假 pass', async () => {
    const down: VisionLlmClient = { chatVision: async () => { throw new Error('vision down'); } };
    assert.equal((await createVisualFidelityAuditor({ vision: down }).audit({ accountId: 'a', referenceUrl: 'r', generatedUrl: 'g' })).status, 'unverified');
    const dirty: VisionLlmClient = { chatVision: async () => '{}' };
    assert.equal((await createVisualFidelityAuditor({ vision: dirty }).audit({ accountId: 'a', referenceUrl: 'r', generatedUrl: 'g' })).status, 'unverified');
  });
});
