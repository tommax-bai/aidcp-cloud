import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ImageGeneratorRole } from '../../src/publish-agent/roles/image-generator.js';
import { PipelineContext } from '../../src/publish-agent/pipeline-context.js';
import type { PipelineFields, ImagePlan } from '../../src/publish-agent/types.js';
import type { ImageResult } from '../../src/publish-agent/image-provider.js';

const clock = () => 1700000000000;
const silentLogger = { log() {}, warn() {}, error() {} };

function plan(prompts: string[]): ImagePlan {
  return { wantImage: prompts.length > 0, imagePrompts: prompts, imageStyle: 'illustration', imageCount: prompts.length, fallbackStrategy: 'skip', plannedAt: clock() };
}
const noPlan: ImagePlan = { wantImage: false, imagePrompts: [], imageStyle: null, imageCount: 0, fallbackStrategy: 'skip', plannedAt: clock() };

function run(provider: { generate: (p: string, s?: string) => Promise<ImageResult> }, p: ImagePlan, enable = true, waitMs = 60) {
  const role = new ImageGeneratorRole({
    imageProvider: provider,
    enableImageGeneration: enable,
    // 测试用短每图超时，避免真等；总闸随之短。
    perImageTimeoutMs: 40,
    maxImages: 6,
    concurrency: 6,
    clock,
    logger: silentLogger,
  });
  const ctx = new PipelineContext<PipelineFields>();
  role.register(ctx);
  ctx.write('imagePlan', p);
  return new Promise<NonNullable<PipelineFields['imageDirective']>>((resolve) =>
    setTimeout(() => resolve(ctx.get('imageDirective')!), waitMs),
  );
}

describe('ImageGeneratorRole（并行多图）', () => {
  test('N 张全成功 → imageUrls 保序、imageUrl=首张', async () => {
    const provider = { generate: async (p: string) => ({ url: `https://cdn/${p}.png` } as ImageResult) };
    const d = await run(provider, plan(['a', 'b', 'c']));
    assert.deepEqual(d.imageUrls, ['https://cdn/a.png', 'https://cdn/b.png', 'https://cdn/c.png'], '保序');
    assert.equal(d.imageUrl, 'https://cdn/a.png', '封面派生=首张');
  });

  test('部分成功 M=2/3：失败那张不进数组、其余保序（红线）', async () => {
    const provider = {
      generate: async (p: string): Promise<ImageResult> => (p === 'b' ? { url: null, error: 'fail' } : { url: `https://cdn/${p}.png` }),
    };
    const d = await run(provider, plan(['a', 'b', 'c']));
    assert.deepEqual(d.imageUrls, ['https://cdn/a.png', 'https://cdn/c.png'], 'b 失败被丢弃，a/c 保序');
    assert.equal(d.imageUrl, 'https://cdn/a.png');
  });

  test('某张超时只丢该张、不影响其余（不 hang、不清零）', async () => {
    const provider = {
      generate: (p: string): Promise<ImageResult> =>
        p === 'slow'
          ? new Promise((resolve) => setTimeout(() => resolve({ url: 'https://cdn/slow.png' }), 10_000)) // 远超每图 40ms 超时
          : Promise.resolve({ url: `https://cdn/${p}.png` }),
    };
    const d = await run(provider, plan(['a', 'slow', 'c']), true, 200);
    assert.deepEqual(d.imageUrls, ['https://cdn/a.png', 'https://cdn/c.png'], 'slow 超时被丢，a/c 保留');
  });

  test('全失败 M=0 → 空 imageUrls（交下游诚实 failed）', async () => {
    const provider = { generate: async (): Promise<ImageResult> => ({ url: null, error: 'fail' }) };
    const d = await run(provider, plan(['a', 'b']));
    assert.deepEqual(d.imageUrls, []);
    assert.equal(d.imageUrl, null);
  });

  test('绝不伪造：失败张 url=null，不复用别张 URL（红线）', async () => {
    const seen: string[] = [];
    const provider = {
      generate: async (p: string): Promise<ImageResult> => {
        seen.push(p);
        return p === 'a' ? { url: 'https://cdn/a.png' } : { url: null };
      },
    };
    const d = await run(provider, plan(['a', 'b']));
    assert.deepEqual(d.imageUrls, ['https://cdn/a.png'], 'b 失败不复用 a 的 URL');
  });

  test('计划不配图 → 不调图源、空 directive', async () => {
    let called = false;
    const provider = { generate: async () => { called = true; return { url: 'x' } as ImageResult; } };
    const d = await run(provider, noPlan);
    assert.deepEqual(d.imageUrls, []);
    assert.equal(called, false, '不配图计划不得调用图源');
  });

  test('enableImageGeneration=false → 空 directive、不调图源', async () => {
    let called = false;
    const provider = { generate: async () => { called = true; return { url: 'x' } as ImageResult; } };
    const d = await run(provider, plan(['a']), false);
    assert.deepEqual(d.imageUrls, []);
    assert.equal(called, false);
  });
});
