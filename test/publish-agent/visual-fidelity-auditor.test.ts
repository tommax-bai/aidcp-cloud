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

  test('模型报错/脏 JSON 诚实 unverified，绝不假 pass', async () => {
    const down: VisionLlmClient = { chatVision: async () => { throw new Error('vision down'); } };
    assert.equal((await createVisualFidelityAuditor({ vision: down }).audit({ accountId: 'a', referenceUrl: 'r', generatedUrl: 'g' })).status, 'unverified');
    const dirty: VisionLlmClient = { chatVision: async () => '{}' };
    assert.equal((await createVisualFidelityAuditor({ vision: dirty }).audit({ accountId: 'a', referenceUrl: 'r', generatedUrl: 'g' })).status, 'unverified');
  });
});
