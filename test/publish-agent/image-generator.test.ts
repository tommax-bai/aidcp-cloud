import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ImageGeneratorRole } from '../../src/publish-agent/roles/image-generator.js';
import { PipelineContext } from '../../src/publish-agent/pipeline-context.js';
import type { PipelineFields, ImagePlan } from '../../src/publish-agent/types.js';

const clock = () => 1700000000000;
const silentLogger = { log() {}, warn() {}, error() {} };

const wantPlan: ImagePlan = { wantImage: true, imagePrompt: 'p', imageStyle: 'illustration', imageCount: 1, fallbackStrategy: 'skip', plannedAt: clock() };
const noPlan: ImagePlan = { wantImage: false, imagePrompt: null, imageStyle: null, imageCount: 0, fallbackStrategy: 'skip', plannedAt: clock() };

function run(provider: any, plan: ImagePlan, enable = true) {
  const role = new ImageGeneratorRole({ imageProvider: provider, enableImageGeneration: enable, clock, logger: silentLogger });
  const ctx = new PipelineContext<PipelineFields>();
  role.register(ctx);
  ctx.write('imagePlan', plan);
  return new Promise<NonNullable<PipelineFields['imageDirective']>>((resolve) =>
    setTimeout(() => resolve(ctx.get('imageDirective')!), 40),
  );
}

describe('ImageGeneratorRole', () => {
  test('计划配图 + 生图成功 → imageUrl 有值', async () => {
    let called = false;
    const provider = { generate: async () => { called = true; return { url: 'https://cdn/x.png', taskId: 't' }; } };
    const d = await run(provider, wantPlan);
    assert.equal(d.imageUrl, 'https://cdn/x.png');
    assert.equal(called, true);
  });

  test('生图失败（url=null）→ 诚实回 imageUrl:null，绝不伪造（红线）', async () => {
    const provider = { generate: async () => ({ url: null, error: 'fail' }) };
    const d = await run(provider, wantPlan);
    assert.equal(d.imageUrl, null);
  });

  test('计划不配图 → 不调图源、直接空 directive', async () => {
    let called = false;
    const provider = { generate: async () => { called = true; return { url: 'x' }; } };
    const d = await run(provider, noPlan);
    assert.equal(d.imageUrl, null);
    assert.equal(called, false, '不配图计划不得调用图源');
  });

  test('enableImageGeneration=false → 空 directive、不调图源', async () => {
    let called = false;
    const provider = { generate: async () => { called = true; return { url: 'x' }; } };
    const d = await run(provider, wantPlan, false);
    assert.equal(d.imageUrl, null);
    assert.equal(called, false);
  });
});
