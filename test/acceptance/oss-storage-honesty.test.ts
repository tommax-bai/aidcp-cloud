/**
 * 验收用例 AC-OSS-* — 配图 OSS 转存诚实降级（云端侧）
 *
 * 守护点（系统红线「绝不静默假成功」在 OSS 转存链路的落地）：
 *   ① OSS 转存（抓字节 / PUT 任一）失败 → 该张诚实落空，MUST NOT 伪造/占位 URL、MUST NOT 假成功。
 *   ② 注入 OSS 后某张转存失败 → 该张不进最终数组（M=K），且最终数组 MUST NOT 含 provider 临时 URL
 *      （不静默回退 provider URL——那会把「审批超 TTL 掉图」的病根又带回来）。
 *   ③ 未配置/未注入 OSS → 与集成前完全一致（零回归），直接用 provider URL。
 *   ④ OSS 上传出口 MUST 在底层 client.put 真成功后才返回 URL（put 抛错即向上抛，绝不返回假 URL）。
 *
 * 环境层级：离线 / 逻辑级（注入内存假 store + 假 fetch，无外部依赖、脱真实 OSS）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  relocateImageToStore,
  type ObjectStore,
  type PutOptions,
  type PutResult,
} from '../../src/storage/object-store.js';
import { OssObjectStore, type OssPutClient } from '../../src/storage/oss-object-store.js';
import { ImageGeneratorRole } from '../../src/publish-agent/roles/image-generator.js';
import { PipelineContext } from '../../src/publish-agent/pipeline-context.js';
import type { PipelineFields, ImagePlan } from '../../src/publish-agent/types.js';
import type { ImageResult } from '../../src/publish-agent/image-provider.js';

const silent = { log() {}, warn() {}, error() {} };
const clock = () => 1700000000000;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

class FakeStore implements ObjectStore {
  failKeys = new Set<string>();
  puts: string[] = [];
  async put(key: string, _b: Buffer, _o?: PutOptions): Promise<PutResult> {
    if (this.failKeys.has(key)) throw new Error('put failed');
    this.puts.push(key);
    return { url: `https://oss.test/${key}` };
  }
}
function resp(bytes: Uint8Array | null, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 500,
    headers: { get: () => 'image/png' },
    arrayBuffer: async () => (bytes ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) : new ArrayBuffer(0)),
  } as unknown as Response;
}
const okFetch = (async () => resp(PNG)) as unknown as typeof fetch;

function plan(prompts: string[]): ImagePlan {
  return { wantImage: true, imagePrompts: prompts, imageStyle: 'illustration', imageCount: prompts.length, fallbackStrategy: 'skip', plannedAt: clock() };
}
function runGen(oss: { ossUploader?: ObjectStore; fetchImpl?: typeof fetch }, prompts: string[]) {
  const role = new ImageGeneratorRole({
    imageProvider: { generate: async (p: string) => ({ url: `https://provider-temp/${p}.png` } as ImageResult) },
    enableImageGeneration: true,
    perImageTimeoutMs: 200,
    maxImages: 6,
    concurrency: 6,
    idGen: () => 'run',
    clock,
    logger: silent,
    ...oss,
  });
  const ctx = new PipelineContext<PipelineFields>();
  role.register(ctx);
  ctx.write('imagePlan', plan(prompts));
  return new Promise<NonNullable<PipelineFields['imageDirective']>>((r) =>
    setTimeout(() => r(ctx.get('imageDirective')!), 150),
  );
}

describe('AC-OSS 配图 OSS 转存诚实降级（cloud）', () => {
  it('AC-OSS-01 抓字节失败 → relocate 返回 null（绝不伪造 URL）', async () => {
    const store = new FakeStore();
    const url = await relocateImageToStore('https://cdn/x', 'k', {
      store,
      fetchImpl: (async () => resp(null, false)) as unknown as typeof fetch,
      logger: silent,
    });
    assert.equal(url, null);
    assert.equal(store.puts.length, 0, 'PUT 未发生');
  });

  it('AC-OSS-02 PUT 失败 → relocate 返回 null（绝不伪造 URL）', async () => {
    const store = new FakeStore();
    store.failKeys.add('k.png');
    const url = await relocateImageToStore('https://cdn/x', 'k', { store, fetchImpl: okFetch, logger: silent });
    assert.equal(url, null);
  });

  it('AC-OSS-03 注入 OSS 后某张失败 → M=K 且数组不含 provider 临时 URL（不静默回退）', async () => {
    const store = new FakeStore();
    store.failKeys.add('publish/default/run/1.png'); // seq 1 失败
    const d = await runGen({ ossUploader: store, fetchImpl: okFetch }, ['a', 'b', 'c']);
    assert.equal(d.imageUrls.length, 2, 'M=K：失败那张不入数组');
    for (const u of d.imageUrls) {
      assert.ok(u.startsWith('https://oss.test/'), `只含 OSS URL：${u}`);
      assert.ok(!u.includes('provider-temp'), 'MUST NOT 回退 provider 临时 URL（会掉图）');
    }
  });

  it('AC-OSS-04 全部转存失败 → 空数组（交下游诚实 failed，绝不伪造）', async () => {
    const store = new FakeStore();
    const d = await runGen({ ossUploader: store, fetchImpl: (async () => resp(null, false)) as unknown as typeof fetch }, ['a', 'b']);
    assert.deepEqual(d.imageUrls, []);
    assert.equal(d.imageUrl, null);
  });

  it('AC-OSS-05 未注入 OSS → 零回归，直接用 provider URL', async () => {
    const d = await runGen({}, ['a', 'b']);
    assert.deepEqual(d.imageUrls, ['https://provider-temp/a.png', 'https://provider-temp/b.png']);
  });

  it('AC-OSS-06 OSS 出口：底层 put 抛错即向上抛（绝不返回假 URL）', async () => {
    const client: OssPutClient = { async put() { throw new Error('oss down'); } };
    const store = new OssObjectStore({ client, bucket: 'aidcp', region: 'oss-cn-beijing', logger: silent });
    await assert.rejects(() => store.put('k.png', Buffer.from(PNG)), /oss down/, '失败不吞、不假成功');
  });
});
