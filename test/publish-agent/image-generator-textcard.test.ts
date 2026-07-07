import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ImageGeneratorRole, type ImageGeneratorDeps } from '../../src/publish-agent/roles/image-generator.js';
import { PipelineContext } from '../../src/publish-agent/pipeline-context.js';
import type { PipelineFields, ImagePlan, TriggerInput, CoverCardCopy } from '../../src/publish-agent/types.js';
import type { ImageResult } from '../../src/publish-agent/image-provider.js';
import type { ObjectStore, PutOptions, PutResult } from '../../src/storage/object-store.js';
import type { TextCardRenderer, TextCardRenderResult } from '../../src/render/text-card.js';

const clock = () => 1700000000000;
const silentLogger = { log() {}, warn() {}, error() {} };

const CARD: CoverCardCopy = { title: '五个坑一次讲透', bullets: ['先看配置', '再查权限'], tags: ['避坑'] };

function okPng(): Response {
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  return {
    ok: true,
    status: 200,
    headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? 'image/png' : null) },
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  } as unknown as Response;
}

class FakeStore implements ObjectStore {
  puts: string[] = [];
  async put(key: string, _bytes: Buffer, _opts?: PutOptions): Promise<PutResult> {
    this.puts.push(key);
    return { url: `https://oss.test/${key}` };
  }
}

const RENDER_META = { themeKey: 'p1-editorial-none', paletteKey: 'p1', layoutKey: 'editorial', titleFontSize: 116, titleLineCount: 1, truncated: false, sanitized: false, reductions: [] };

function okRenderer(calls?: { seeds: Array<{ accountId: string; postKey: string }> }): TextCardRenderer {
  return {
    render: async (_copy, seed) => {
      calls?.seeds.push(seed);
      return { ok: true, png: Buffer.from('fake-png-bytes'), meta: RENDER_META } as TextCardRenderResult;
    },
  };
}

function textCardPlan(prompts: string[]): ImagePlan {
  return {
    wantImage: true,
    imagePrompts: prompts,
    imageStyle: null,
    imageCount: prompts.length,
    fallbackStrategy: 'skip',
    coverForm: 'text_card',
    coverCard: CARD,
    coverGate: { sensedForm: 'text_card', sensedSource: 'vision', gateReason: 'ok' },
    plannedAt: clock(),
  };
}

function run(
  provider: { generate: (p: string, s?: string, o?: unknown) => Promise<ImageResult> },
  p: ImagePlan,
  extras: Partial<ImageGeneratorDeps> & { store?: FakeStore } = {},
  opts: { waitMs?: number; sourceId?: string } = {},
) {
  const store = extras.store ?? new FakeStore();
  const role = new ImageGeneratorRole({
    imageProvider: provider,
    enableImageGeneration: true,
    perImageTimeoutMs: 200,
    renderTimeoutMs: extras.renderTimeoutMs ?? 100,
    maxImages: 6,
    concurrency: 6,
    idGen: () => 'run1',
    ossUploader: store,
    fetchImpl: (async () => okPng()) as unknown as typeof fetch,
    clock,
    logger: silentLogger,
    ...extras,
  } as ImageGeneratorDeps);
  const ctx = new PipelineContext<PipelineFields>();
  role.register(ctx);
  ctx.write('trigger', {
    accountId: 'acct1',
    generateInput: { referenceNote: { sourceId: opts.sourceId ?? 'note-9' } },
  } as unknown as TriggerInput);
  ctx.write('imagePlan', p);
  return new Promise<{ d: NonNullable<PipelineFields['imageDirective']>; store: FakeStore }>((resolve) =>
    setTimeout(() => resolve({ d: ctx.get('imageDirective')!, store }), opts.waitMs ?? 300),
  );
}

describe('ImageGeneratorRole — 文字卡封面分支（change textcard-cover-form）', () => {
  test('渲染成功 → 0 号槽为渲染卡 OSS URL、内页照走 provider、audit=rendered 带主题键', async () => {
    const providerPrompts: string[] = [];
    const provider = {
      generate: async (p: string) => {
        providerPrompts.push(p);
        return { url: `https://cdn/${p}.png` } as ImageResult;
      },
    };
    const seeds = { seeds: [] as Array<{ accountId: string; postKey: string }> };
    const { d, store } = await run(provider, textCardPlan(['cover-gen', 'inner-1']), {
      getTextCardRenderer: () => okRenderer(seeds),
    });
    assert.equal(d.imageUrls[0], 'https://oss.test/publish/acct1/run1/0.png', '0 号槽=渲染卡直传 URL');
    assert.equal(d.imageUrls[1], 'https://oss.test/publish/acct1/run1/1.png', '内页照常生成+转存、seq 不移位');
    assert.deepEqual(providerPrompts, ['inner-1'], '0 号生成式提示词未走 provider（槽被渲染结果替换）');
    assert.equal(d.coverFormAudit?.renderStatus, 'rendered');
    assert.equal(d.coverFormAudit?.coverForm, 'text_card');
    assert.equal(d.coverFormAudit?.renderMeta?.themeKey, RENDER_META.themeKey);
    assert.deepEqual(seeds.seeds, [{ accountId: 'acct1', postKey: 'note-9' }], '种子=账号+来源标识（重试恒定，不含随机 token）');
    assert.ok(store.puts.includes('publish/acct1/run1/0.png'), '渲染字节直传 0 号键');
  });

  test('渲染失败（ok:false）→ 0 号立即回落生成式提示词、audit=render_failed_generative', async () => {
    const providerPrompts: string[] = [];
    const provider = {
      generate: async (p: string) => {
        providerPrompts.push(p);
        return { url: `https://cdn/${p}.png` } as ImageResult;
      },
    };
    const badRenderer: TextCardRenderer = { render: async () => ({ ok: false, reason: 'invalid_copy' }) };
    const { d } = await run(provider, textCardPlan(['cover-gen', 'inner-1']), {
      getTextCardRenderer: () => badRenderer,
    });
    assert.ok(providerPrompts.includes('cover-gen'), '0 号回落生成式提示词走 provider');
    assert.equal(d.imageUrls.length, 2, '双张齐全（0 号来自生成式兜底）');
    assert.equal(d.coverFormAudit?.renderStatus, 'render_failed_generative');
    assert.equal(d.coverFormAudit?.renderMeta, undefined, '降级不带渲染主题元数据（诚实）');
  });

  test('渲染超时 → 独立内层闸结算、0 号兜底生成式仍享完整每图槽', async () => {
    const hangingRenderer: TextCardRenderer = {
      render: () => new Promise(() => {}), // 永不结算 → 吃满 renderTimeoutMs
    };
    const provider = { generate: async (p: string) => ({ url: `https://cdn/${p}.png` } as ImageResult) };
    const { d } = await run(
      provider,
      textCardPlan(['cover-gen']),
      { getTextCardRenderer: () => hangingRenderer, renderTimeoutMs: 30 },
      { waitMs: 400 },
    );
    assert.equal(d.imageUrls.length, 1, '渲染超时后 0 号生成式兜底成功');
    assert.equal(d.coverFormAudit?.renderStatus, 'render_failed_generative');
  });

  test('渲染出口返回 null（工厂失败）→ 诚实降级生成式', async () => {
    const provider = { generate: async (p: string) => ({ url: `https://cdn/${p}.png` } as ImageResult) };
    const { d } = await run(provider, textCardPlan(['cover-gen']), { getTextCardRenderer: () => null });
    assert.equal(d.imageUrls.length, 1);
    assert.equal(d.coverFormAudit?.renderStatus, 'render_failed_generative');
  });

  test('渲染与生成式双失败 → render_failed_none、沿既有 M<N 保序语义', async () => {
    const provider = {
      generate: async (p: string) =>
        (p === 'cover-gen' ? { url: null, error: 'provider down' } : { url: `https://cdn/${p}.png` }) as ImageResult,
    };
    const badRenderer: TextCardRenderer = { render: async () => ({ ok: false, reason: 'render_failed' }) };
    const { d } = await run(provider, textCardPlan(['cover-gen', 'inner-1']), {
      getTextCardRenderer: () => badRenderer,
    });
    assert.equal(d.imageUrls.length, 1, '0 号诚实落空、内页保留');
    assert.equal(d.coverFormAudit?.renderStatus, 'render_failed_none');
  });

  test('OSS 直传失败 → 0 号回落生成式（不伪造 URL）', async () => {
    class FailingCoverStore extends FakeStore {
      override async put(key: string, bytes: Buffer, opts?: PutOptions): Promise<PutResult> {
        if (key === 'publish/acct1/run1/0.png' && bytes.toString() === 'fake-png-bytes') {
          throw new Error('oss down for rendered cover');
        }
        return super.put(key, bytes, opts);
      }
    }
    const provider = { generate: async (p: string) => ({ url: `https://cdn/${p}.png` } as ImageResult) };
    const { d } = await run(provider, textCardPlan(['cover-gen']), {
      getTextCardRenderer: () => okRenderer(),
      store: new FailingCoverStore(),
    });
    assert.equal(d.imageUrls.length, 1, '0 号生成式兜底顶上');
    assert.equal(d.coverFormAudit?.renderStatus, 'render_failed_generative');
  });

  test('生成式决策/旧计划（无 coverGate）→ 不产 coverFormAudit（零回归面）', async () => {
    const provider = { generate: async (p: string) => ({ url: `https://cdn/${p}.png` } as ImageResult) };
    const legacyPlan: ImagePlan = {
      wantImage: true,
      imagePrompts: ['a'],
      imageStyle: null,
      imageCount: 1,
      fallbackStrategy: 'skip',
      plannedAt: clock(),
    };
    const { d } = await run(provider, legacyPlan, { getTextCardRenderer: () => okRenderer() });
    assert.equal(d.coverFormAudit, undefined, '旧计划无盖章 → 无审计字段，directive 形状与现版一致');
  });

  test('决策 generative（coverGate 带 flag_off）→ audit=not_attempted、渲染器零调用', async () => {
    let rendered = 0;
    const countingRenderer: TextCardRenderer = {
      render: async () => {
        rendered++;
        return { ok: true, png: Buffer.from('x'), meta: RENDER_META };
      },
    };
    const provider = { generate: async (p: string) => ({ url: `https://cdn/${p}.png` } as ImageResult) };
    const generativePlan: ImagePlan = {
      ...textCardPlan(['a']),
      coverForm: 'generative',
      coverCard: null,
      coverGate: { sensedForm: 'unknown', sensedSource: 'none', gateReason: 'flag_off' },
    };
    const { d } = await run(provider, generativePlan, { getTextCardRenderer: () => countingRenderer });
    assert.equal(rendered, 0, '生成式决策不碰渲染器');
    assert.equal(d.coverFormAudit?.renderStatus, 'not_attempted');
    assert.equal(d.coverFormAudit?.coverForm, 'generative');
  });
});
