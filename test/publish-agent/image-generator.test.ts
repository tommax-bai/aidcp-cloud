import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ImageGeneratorRole, type ImageGeneratorDeps } from '../../src/publish-agent/roles/image-generator.js';
import { PipelineContext } from '../../src/publish-agent/pipeline-context.js';
import { REFERENCE_IMAGE_MAX_COUNT } from '../../src/publish-agent/reference-image-guidance.js';
import type { PipelineFields, ImagePlan, TriggerInput } from '../../src/publish-agent/types.js';
import type { ImageResult } from '../../src/publish-agent/image-provider.js';
import type { ObjectStore, PutOptions, PutResult } from '../../src/storage/object-store.js';

const clock = () => 1700000000000;
const silentLogger = { log() {}, warn() {}, error() {} };

function plan(prompts: string[]): ImagePlan {
  return { wantImage: prompts.length > 0, imagePrompts: prompts, imageStyle: 'illustration', imageCount: prompts.length, fallbackStrategy: 'skip', plannedAt: clock() };
}
const noPlan: ImagePlan = { wantImage: false, imagePrompts: [], imageStyle: null, imageCount: 0, fallbackStrategy: 'skip', plannedAt: clock() };

function run(provider: ImageGeneratorDeps['imageProvider'], p: ImagePlan, enable = true, waitMs = 60) {
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

  test('reference images are forwarded to provider and surfaced in directive audit fields', async () => {
    const seen: Array<string[] | undefined> = [];
    const referenceImages = [
      { index: 0, sourceUrl: 'https://img.test/source-a.jpg', ossUrl: 'https://oss.test/a.jpg', captureStatus: 'stored' as const, capturedAt: 1 },
      { index: 1, sourceUrl: 'https://img.test/source-b.jpg', captureStatus: 'url_only' as const, capturedAt: 2 },
      { index: 2, sourceUrl: '   ', captureStatus: 'url_only' as const, capturedAt: 3 },
      ...Array.from({ length: 9 }, (_, i) => ({
        index: i + 3,
        sourceUrl: `https://img.test/source-${i + 3}.jpg`,
        captureStatus: 'url_only' as const,
        capturedAt: i + 4,
      })),
    ];
    const expectedImages = [referenceImages[0], referenceImages[1], ...referenceImages.slice(3, 10)];
    const provider = {
      generate: async (_prompt: string, _style?: string, options?: { referenceImages?: string[] }): Promise<ImageResult> => {
        seen.push(options?.referenceImages);
        return { url: 'https://cdn/a.png', referenceStatus: 'unsupported', referenceUsed: false };
      },
    };
    const d = await run(provider, { ...plan(['a']), referenceImages });
    assert.equal(expectedImages.length, REFERENCE_IMAGE_MAX_COUNT);
    assert.deepEqual(seen, [[
      'https://oss.test/a.jpg',
      'https://img.test/source-b.jpg',
      'https://img.test/source-3.jpg',
      'https://img.test/source-4.jpg',
      'https://img.test/source-5.jpg',
      'https://img.test/source-6.jpg',
      'https://img.test/source-7.jpg',
      'https://img.test/source-8.jpg',
      'https://img.test/source-9.jpg',
    ]]);
    assert.deepEqual(d.referenceImages, expectedImages);
    assert.equal(d.referenceImageStatus, 'unsupported');
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

  test('每次图片 provider 尝试都会记录账号/角色用量维度，token 由记账层保持 0', async () => {
    const records: Array<{ accountId: string; provider: string; model: string; ok: boolean }> = [];
    const provider = {
      generate: async (p: string): Promise<ImageResult> => (p === 'bad' ? { url: null, error: 'fail' } : { url: `https://cdn/${p}.png` }),
    };
    const role = new ImageGeneratorRole({
      imageProvider: provider,
      enableImageGeneration: true,
      perImageTimeoutMs: 80,
      maxImages: 3,
      concurrency: 3,
      getProvider: () => 'volcengine',
      getModel: () => 'doubao-seedream-4-5-251128',
      usageRecorder: (r) => records.push(r),
      clock,
      logger: silentLogger,
    });
    const ctx = new PipelineContext<PipelineFields>();
    role.register(ctx);
    ctx.write('trigger', { accountId: 'acct-img' } as unknown as TriggerInput);
    ctx.write('imagePlan', plan(['ok', 'bad']));
    await new Promise((resolve) => setTimeout(resolve, 120));

    assert.deepEqual(records, [
      { accountId: 'acct-img', provider: 'volcengine', model: 'doubao-seedream-4-5-251128', ok: true },
      { accountId: 'acct-img', provider: 'volcengine', model: 'doubao-seedream-4-5-251128', ok: false },
    ]);
  });

  test('图片用量 recorder 异常不得影响生图结果', async () => {
    const provider = { generate: async (p: string): Promise<ImageResult> => ({ url: `https://cdn/${p}.png` }) };
    const role = new ImageGeneratorRole({
      imageProvider: provider,
      enableImageGeneration: true,
      perImageTimeoutMs: 80,
      maxImages: 1,
      concurrency: 1,
      getProvider: () => 'dashscope',
      getModel: () => 'wan2.7-image-pro',
      usageRecorder: () => {
        throw new Error('metrics down');
      },
      clock,
      logger: silentLogger,
    });
    const ctx = new PipelineContext<PipelineFields>();
    role.register(ctx);
    ctx.write('trigger', { accountId: 'acct-img' } as unknown as TriggerInput);
    ctx.write('imagePlan', plan(['ok']));
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.deepEqual(ctx.get('imageDirective')?.imageUrls, ['https://cdn/ok.png']);
  });
});

// ─── OSS 转存（change cloud-oss-storage-integration） ──────────────────────────

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
function okPng(): Response {
  return {
    ok: true,
    status: 200,
    headers: { get: () => 'image/png' },
    arrayBuffer: async () => PNG_BYTES.buffer.slice(PNG_BYTES.byteOffset, PNG_BYTES.byteOffset + PNG_BYTES.byteLength),
  } as unknown as Response;
}
function badResp(): Response {
  return { ok: false, status: 404, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) } as unknown as Response;
}

/** 记录 put 的内存假 store；可对指定键失败。 */
class FakeStore implements ObjectStore {
  puts: string[] = [];
  failKeys = new Set<string>();
  async put(key: string, _bytes: Buffer, _opts?: PutOptions): Promise<PutResult> {
    if (this.failKeys.has(key)) throw new Error(`put failed for ${key}`);
    this.puts.push(key);
    return { url: `https://oss.test/${key}` };
  }
}

function runOss(
  provider: { generate: (p: string, s?: string) => Promise<ImageResult> },
  p: ImagePlan,
  oss: { ossUploader?: ObjectStore; fetchImpl?: typeof fetch },
  opts: { accountId?: string; waitMs?: number } = {},
) {
  const role = new ImageGeneratorRole({
    imageProvider: provider,
    enableImageGeneration: true,
    perImageTimeoutMs: 200,
    maxImages: 6,
    concurrency: 6,
    idGen: () => 'run1', // 固定运行 token → 键可断言
    clock,
    logger: silentLogger,
    ...oss,
  } satisfies ImageGeneratorDeps);
  const ctx = new PipelineContext<PipelineFields>();
  role.register(ctx);
  // trigger 必须先于 imagePlan 写入（角色 watch imagePlan 激活时读 snapshot().trigger 取 accountId）。
  if (opts.accountId) ctx.write('trigger', { accountId: opts.accountId } as unknown as TriggerInput);
  ctx.write('imagePlan', p);
  return new Promise<NonNullable<PipelineFields['imageDirective']>>((resolve) =>
    setTimeout(() => resolve(ctx.get('imageDirective')!), opts.waitMs ?? 150),
  );
}

describe('ImageGeneratorRole — OSS 转存', () => {
  const okFetch = (async () => okPng()) as unknown as typeof fetch;

  test('注入 ossUploader：每张转存为 OSS 稳定 URL（按账号/运行 token/seq 分键）', async () => {
    const store = new FakeStore();
    const provider = { generate: async (p: string) => ({ url: `https://cdn/${p}.png` } as ImageResult) };
    const d = await runOss(provider, plan(['a', 'b']), { ossUploader: store, fetchImpl: okFetch }, { accountId: 'acct7' });
    assert.deepEqual(
      d.imageUrls,
      ['https://oss.test/publish/acct7/run1/0.png', 'https://oss.test/publish/acct7/run1/1.png'],
      '换成 OSS URL、非 provider URL',
    );
    assert.equal(d.imageUrl, 'https://oss.test/publish/acct7/run1/0.png', '封面=首张 OSS URL');
    assert.deepEqual(store.puts, ['publish/acct7/run1/0.png', 'publish/acct7/run1/1.png']);
  });

  test('无 trigger 账号 → 键回落 default', async () => {
    const store = new FakeStore();
    const provider = { generate: async (p: string) => ({ url: `https://cdn/${p}.png` } as ImageResult) };
    const d = await runOss(provider, plan(['a']), { ossUploader: store, fetchImpl: okFetch });
    assert.deepEqual(d.imageUrls, ['https://oss.test/publish/default/run1/0.png']);
  });

  test('某张 PUT 失败 → 该张诚实落空、M=K、其余保序（红线：不伪造）', async () => {
    const store = new FakeStore();
    store.failKeys.add('publish/default/run1/1.png'); // seq 1 = 'b'
    const provider = { generate: async (p: string) => ({ url: `https://cdn/${p}.png` } as ImageResult) };
    const d = await runOss(provider, plan(['a', 'b', 'c']), { ossUploader: store, fetchImpl: okFetch });
    assert.deepEqual(
      d.imageUrls,
      ['https://oss.test/publish/default/run1/0.png', 'https://oss.test/publish/default/run1/2.png'],
      'b 转存失败被丢、a/c 保序',
    );
    assert.equal(d.imageUrls.length, 2, 'M=K 诚实（少一张）');
  });

  test('某张抓字节失败 → 该张诚实落空（不伪造 URL）', async () => {
    const store = new FakeStore();
    const provider = { generate: async (p: string) => ({ url: `https://cdn/${p}` } as ImageResult) };
    const fetchImpl = (async (u: string) => (String(u).includes('bad') ? badResp() : okPng())) as unknown as typeof fetch;
    const d = await runOss(provider, plan(['a', 'bad', 'c']), { ossUploader: store, fetchImpl });
    assert.deepEqual(
      d.imageUrls,
      ['https://oss.test/publish/default/run1/0.png', 'https://oss.test/publish/default/run1/2.png'],
      'bad 抓取失败被丢',
    );
  });

  test('全部转存失败 → M=0 空数组（交下游诚实 failed）', async () => {
    const store = new FakeStore();
    const provider = { generate: async (p: string) => ({ url: `https://cdn/${p}` } as ImageResult) };
    const fetchImpl = (async () => badResp()) as unknown as typeof fetch;
    const d = await runOss(provider, plan(['a', 'b']), { ossUploader: store, fetchImpl });
    assert.deepEqual(d.imageUrls, []);
    assert.equal(d.imageUrl, null);
  });

  test('未注入 ossUploader → 沿用 provider URL（零回归）', async () => {
    const provider = { generate: async (p: string) => ({ url: `https://cdn/${p}.png` } as ImageResult) };
    const d = await runOss(provider, plan(['a', 'b']), {});
    assert.deepEqual(d.imageUrls, ['https://cdn/a.png', 'https://cdn/b.png'], '直接用 provider URL');
  });
});
