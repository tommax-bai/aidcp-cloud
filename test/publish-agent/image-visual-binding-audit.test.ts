import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { ImageGeneratorRole } from '../../src/publish-agent/roles/image-generator.js';
import { PipelineContext } from '../../src/publish-agent/pipeline-context.js';
import type { PipelineFields, ImagePlan, TriggerInput } from '../../src/publish-agent/types.js';
import type { ImageGenerateOptions, ImageResult } from '../../src/publish-agent/image-provider.js';
import type { VisualAuditAttempt, VisualReferenceBinding } from '../../src/publish-agent/visual-reference-types.js';
import type { VisualAuditInput } from '../../src/publish-agent/visual-fidelity-auditor.js';

const clock = () => 1700000000000;
const logger = { log() {}, warn() {}, error() {} };

function bindings(): VisualReferenceBinding[] {
  return [0, 1].map((slot) => ({
    slot, mode: 'slot', references: [{ sourceArrayIndex: slot, sourceIndex: slot + 10, url: `https://ref/${slot}.jpg`, role: 'primary' }],
    primarySourceArrayIndex: slot, primarySourceIndex: slot + 10,
  }));
}

function makePlan(): ImagePlan {
  const brief = {
    narrativeMoment: '情绪涌来后自我整理', emotion: '脆弱但不崩溃', emotionIntensity: 0.65,
    action: '缓慢呼吸', environment: '深色访谈空间', facialExpression: '眉眼游离、嘴角克制',
    gazeDirection: '侧视', headAngle: '微侧', bodyLanguage: '肩颈放松', avoid: ['标准商业微笑'],
  };
  return {
    wantImage: true, imagePrompts: ['p0', 'p1'], imageStyle: null, imageCount: 2, fallbackStrategy: 'skip',
    referenceImages: [
      { index: 10, sourceUrl: 'https://ref/0.jpg' },
      { index: 11, sourceUrl: 'https://ref/1.jpg' },
    ],
    referenceBindings: bindings(), visualRoutes: ['generative', 'generative'],
    visualStyleSources: ['reference_analysis', 'reference_analysis'], contentVisualBriefs: [brief, brief], plannedAt: clock(),
  };
}

async function run(
  provider: { generate(prompt: string, style?: string, options?: ImageGenerateOptions): Promise<ImageResult> },
  plan: ImagePlan,
  audit?: (n: number, input: VisualAuditInput) => VisualAuditAttempt,
) {
  let calls = 0;
  const role = new ImageGeneratorRole({
    imageProvider: provider, perImageTimeoutMs: 200, maxImages: 2, concurrency: 2, clock, logger,
    ...(audit ? { visualAuditor: { audit: async (input: VisualAuditInput) => audit(calls++, input) }, auditEnabled: () => true } : {}),
  });
  const ctx = new PipelineContext<PipelineFields>();
  role.register(ctx);
  ctx.write('trigger', { accountId: 'a' } as TriggerInput);
  ctx.write('imagePlan', plan);
  await new Promise((resolve) => setTimeout(resolve, 100));
  return ctx.get('imageDirective')!;
}

describe('ImageGenerator slot binding + visual audit', () => {
  test('每槽只传自己的主参考，并把角色传给 provider', async () => {
    const seen: Array<{ prompt: string; options?: ImageGenerateOptions }> = [];
    const provider = { generate: async (prompt: string, _style?: string, options?: ImageGenerateOptions) => {
      seen.push({ prompt, options });
      return { url: `https://out/${prompt}.jpg`, referenceStatus: 'used' as const };
    } };
    const out = await run(provider, makePlan());
    assert.deepEqual(seen.map((x) => x.options?.referenceImages), [['https://ref/0.jpg'], ['https://ref/1.jpg']]);
    assert.deepEqual(seen.map((x) => x.options?.referenceRoles?.[0].role), ['primary', 'primary']);
    assert.equal(out.visualReferenceAudit?.bindingMode, 'slot');
    assert.deepEqual(out.visualReferenceAudit?.slots.map((s) => s.binding.primarySourceIndex), [10, 11]);
  });

  test('首次失败会带审核指导重生成，第二次通过保留输出和两次审计', async () => {
    const prompts: string[] = [];
    const provider = { generate: async (prompt: string) => { prompts.push(prompt); return { url: `https://out/${prompts.length}.jpg`, referenceStatus: 'used' as const }; } };
    const attempts: VisualAuditAttempt[] = [
      { status: 'failed', reason: '构图偏差', retryGuidance: '把主体移回画面中央', auditedAt: 1 },
      { status: 'passed', reason: '已修正', auditedAt: 2 },
    ];
    const one: ImagePlan = { ...makePlan(), imagePrompts: ['p0'], imageCount: 1, referenceBindings: bindings().slice(0, 1), visualRoutes: ['generative'], visualStyleSources: ['reference_analysis'] };
    const out = await run(provider, one, (n) => attempts[n]);
    assert.equal(prompts.length, 2);
    assert.match(prompts[1], /把主体移回画面中央/);
    assert.equal(out.imageUrls.length, 1);
    assert.equal(out.visualReferenceAudit?.slots[0].finalStatus, 'passed');
    assert.equal(out.visualReferenceAudit?.slots[0].attempts.length, 2);
  });

  test('正文视觉 brief 传入审计并写入逐槽 metadata', async () => {
    const one: ImagePlan = {
      ...makePlan(), imagePrompts: ['p0'], imageCount: 1, referenceBindings: bindings().slice(0, 1),
      visualRoutes: ['generative'], visualStyleSources: ['reference_analysis'], contentVisualBriefs: makePlan().contentVisualBriefs?.slice(0, 1),
    };
    let seen: VisualAuditInput['contentVisualBrief'];
    const out = await run(
      { generate: async () => ({ url: 'https://out/x.jpg', referenceStatus: 'used' as const }) },
      one,
      (_n, input) => {
        seen = input.contentVisualBrief;
        return { status: 'passed', reason: 'ok', auditedAt: 1 };
      },
    );
    assert.equal(seen?.facialExpression, '眉眼游离、嘴角克制');
    assert.equal(out.visualReferenceAudit?.slots[0].contentVisualBrief?.emotion, '脆弱但不崩溃');
  });

  test('两次失败丢弃该槽；模型不可用则保留但标 unverified', async () => {
    const one: ImagePlan = { ...makePlan(), imagePrompts: ['p0'], imageCount: 1, referenceBindings: bindings().slice(0, 1), visualRoutes: ['generative'], visualStyleSources: ['reference_analysis'] };
    const provider = { generate: async () => ({ url: 'https://out/x.jpg', referenceStatus: 'used' as const }) };
    const failed = await run(provider, one, () => ({ status: 'failed', reason: '仍偏差', auditedAt: 1 }));
    assert.deepEqual(failed.imageUrls, []);
    assert.equal(failed.visualReferenceAudit?.slots[0].finalStatus, 'discarded');

    const unverified = await run(provider, one, () => ({ status: 'unverified', reason: 'vision down', auditedAt: 1 }));
    assert.deepEqual(unverified.imageUrls, ['https://out/x.jpg']);
    assert.equal(unverified.visualReferenceAudit?.slots[0].finalStatus, 'unverified');
  });

  test('首次已失败后第二次审计 unverified → 丢槽，未知结果不得覆盖已知风险', async () => {
    const one: ImagePlan = {
      ...makePlan(), imagePrompts: ['p0'], imageCount: 1, referenceBindings: bindings().slice(0, 1),
      visualRoutes: ['generative'], visualStyleSources: ['reference_analysis'], contentVisualBriefs: makePlan().contentVisualBriefs?.slice(0, 1),
    };
    const attempts: VisualAuditAttempt[] = [
      {
        status: 'failed', reason: '可识别真人', auditedAt: 1,
        risks: { recognizableRealPerson: true, garbledText: false, watermark: false, copiedText: false, originalityRisk: 'high' },
      },
      { status: 'unverified', reason: 'vision timeout', auditedAt: 2 },
    ];
    const out = await run(
      { generate: async () => ({ url: 'https://out/x.jpg', referenceStatus: 'used' as const }) },
      one,
      (n) => attempts[n],
    );
    assert.deepEqual(out.imageUrls, []);
    assert.deepEqual(out.visualReferenceAudit?.slots[0].attempts.map((item) => item.status), ['failed', 'unverified']);
    assert.equal(out.visualReferenceAudit?.slots[0].finalStatus, 'discarded');
  });

  test('审计开但逐槽绑定尚未启用时，使用旧参考组最后一张作主参考而非静默跳过', async () => {
    const plan = { ...makePlan(), referenceBindings: undefined, visualRoutes: undefined, visualStyleSources: undefined };
    const references: string[] = [];
    const out = await run(
      { generate: async () => ({ url: 'https://out/legacy.jpg', referenceStatus: 'used' as const }) },
      plan,
      (_n, input) => {
        references.push(input.referenceUrl);
        return { status: 'passed', reason: 'ok', auditedAt: 1 };
      },
    );
    assert.deepEqual(references, ['https://ref/1.jpg', 'https://ref/1.jpg']);
    assert.equal(out.visualReferenceAudit?.bindingMode, 'legacy_all');
    assert.deepEqual(out.visualReferenceAudit?.slots.map((slot) => slot.finalStatus), ['passed', 'passed']);
  });
});
