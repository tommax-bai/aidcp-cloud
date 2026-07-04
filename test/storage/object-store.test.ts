import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  sniffImageType,
  relocateImageToStore,
  type ObjectStore,
  type PutOptions,
  type PutResult,
} from '../../src/storage/object-store.js';
import { OssObjectStore, type OssPutClient } from '../../src/storage/oss-object-store.js';

const silentLogger = { log() {}, warn() {}, error() {} };

// ─── 假件 ────────────────────────────────────────────────────────────────────

/** 记录每次 put 的内存假 store。 */
class FakeStore implements ObjectStore {
  puts: Array<{ key: string; bytes: Buffer; opts?: PutOptions }> = [];
  failKeys = new Set<string>();
  async put(key: string, bytes: Buffer, opts?: PutOptions): Promise<PutResult> {
    if (this.failKeys.has(key)) throw new Error(`put failed for ${key}`);
    this.puts.push({ key, bytes, opts });
    return { url: `https://oss.test/${key}` };
  }
}

/** 构造一个最小 Response 假件。 */
function fakeResp(
  bytes: Uint8Array | null,
  opts: { ok?: boolean; status?: number; contentType?: string } = {},
): Response {
  return {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    headers: {
      get: (k: string) => (k.toLowerCase() === 'content-type' ? opts.contentType ?? null : null),
    },
    arrayBuffer: async () =>
      bytes ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) : new ArrayBuffer(0),
  } as unknown as Response;
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 1, 2]);
const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 2]);

// ─── sniffImageType ───────────────────────────────────────────────────────────

describe('sniffImageType（magic-byte 判类型）', () => {
  test('PNG/JPG/WEBP/GIF magic 正确判定', () => {
    assert.deepEqual(sniffImageType(PNG), { ext: 'png', contentType: 'image/png' });
    assert.deepEqual(sniffImageType(JPG), { ext: 'jpg', contentType: 'image/jpeg' });
    assert.deepEqual(sniffImageType(WEBP), { ext: 'webp', contentType: 'image/webp' });
    assert.deepEqual(sniffImageType(GIF), { ext: 'gif', contentType: 'image/gif' });
  });

  test('magic 判不出 → 回退 image/* 响应头', () => {
    const unknown = new Uint8Array([0, 1, 2, 3, 4, 5]);
    assert.deepEqual(sniffImageType(unknown, 'image/webp'), { ext: 'webp', contentType: 'image/webp' });
    assert.deepEqual(sniffImageType(unknown, 'image/jpeg; charset=binary'), { ext: 'jpg', contentType: 'image/jpeg' });
  });

  test('magic + 头都判不出 → 兜底 jpg（不因类型未知丢真实字节）', () => {
    const unknown = new Uint8Array([0, 1, 2, 3, 4, 5]);
    assert.deepEqual(sniffImageType(unknown), { ext: 'jpg', contentType: 'image/jpeg' });
    assert.deepEqual(sniffImageType(unknown, 'text/html'), { ext: 'jpg', contentType: 'image/jpeg' });
  });
});

// ─── OssObjectStore.put ───────────────────────────────────────────────────────

describe('OssObjectStore.put（公读 ACL + 公网 URL）', () => {
  test('put 成功 → 返回公网 endpoint 稳定 URL、带公读 ACL + Content-Type', async () => {
    const calls: Array<{ name: string; options?: { headers?: Record<string, string> } }> = [];
    const client: OssPutClient = {
      async put(name, _file, options) {
        calls.push({ name, options });
        return { name };
      },
    };
    const store = new OssObjectStore({ client, bucket: 'aidcp', region: 'oss-cn-beijing', logger: silentLogger });
    const { url } = await store.put('publish/acct/run/0.png', Buffer.from(PNG), { contentType: 'image/png' });
    assert.equal(url, 'https://aidcp.oss-cn-beijing.aliyuncs.com/publish/acct/run/0.png', '公网稳定 URL');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options?.headers?.['x-oss-object-acl'], 'public-read', '公读 ACL');
    assert.equal(calls[0].options?.headers?.['Content-Type'], 'image/png', '内容类型');
  });

  test('内网 region 上传，但返回 URL 仍用公网 endpoint', async () => {
    const client: OssPutClient = { async put(name) { return { name }; } };
    const store = new OssObjectStore({ client, bucket: 'aidcp', region: 'oss-cn-beijing-internal', logger: silentLogger });
    const { url } = await store.put('k.jpg', Buffer.from(JPG));
    assert.equal(url, 'https://aidcp.oss-cn-beijing.aliyuncs.com/k.jpg', 'URL 去掉 -internal → 公网');
  });

  test('put 抛错向上传播（供上层诚实落空，不吞错假成功）', async () => {
    const client: OssPutClient = { async put() { throw new Error('oss down'); } };
    const store = new OssObjectStore({ client, bucket: 'aidcp', region: 'oss-cn-beijing', logger: silentLogger });
    await assert.rejects(() => store.put('k.png', Buffer.from(PNG)), /oss down/);
  });
});

// ─── relocateImageToStore ─────────────────────────────────────────────────────

describe('relocateImageToStore（抓字节 → 转存；失败诚实落空）', () => {
  test('成功：抓 PNG → put 到 <keyBase>.png → 返回 store URL', async () => {
    const store = new FakeStore();
    const fetchImpl = (async () => fakeResp(PNG, { contentType: 'image/png' })) as unknown as typeof fetch;
    const url = await relocateImageToStore('https://cdn/x', 'publish/acct/run/0', { store, fetchImpl, logger: silentLogger });
    assert.equal(url, 'https://oss.test/publish/acct/run/0.png');
    assert.equal(store.puts.length, 1);
    assert.equal(store.puts[0].key, 'publish/acct/run/0.png', '扩展名按嗅探追加');
    assert.equal(store.puts[0].opts?.contentType, 'image/png');
  });

  test('抓源图 HTTP 非 2xx → null（诚实落空，不 put）', async () => {
    const store = new FakeStore();
    const fetchImpl = (async () => fakeResp(null, { ok: false, status: 404 })) as unknown as typeof fetch;
    const url = await relocateImageToStore('https://cdn/dead', 'k', { store, fetchImpl, logger: silentLogger });
    assert.equal(url, null);
    assert.equal(store.puts.length, 0, 'PUT 未发生');
  });

  test('抓字节抛异常 → null（不伪造 URL）', async () => {
    const store = new FakeStore();
    const fetchImpl = (async () => { throw new Error('network'); }) as unknown as typeof fetch;
    const url = await relocateImageToStore('https://cdn/x', 'k', { store, fetchImpl, logger: silentLogger });
    assert.equal(url, null);
  });

  test('源字节为空 → null', async () => {
    const store = new FakeStore();
    const fetchImpl = (async () => fakeResp(new Uint8Array([]))) as unknown as typeof fetch;
    const url = await relocateImageToStore('https://cdn/empty', 'k', { store, fetchImpl, logger: silentLogger });
    assert.equal(url, null);
  });

  test('PUT OSS 失败 → null（诚实落空，不伪造 URL）', async () => {
    const store = new FakeStore();
    store.failKeys.add('k.png');
    const fetchImpl = (async () => fakeResp(PNG)) as unknown as typeof fetch;
    const url = await relocateImageToStore('https://cdn/x', 'k', { store, fetchImpl, logger: silentLogger });
    assert.equal(url, null);
  });

  test('PUT 挂起 → timeoutMs 兜底返回 null（上传段也受总超时约束，不干等）', async () => {
    // 永不 resolve 的 put，模拟 OSS 上传卡死；relocate 必须在 timeoutMs 内诚实落空。
    const store: ObjectStore = { put: () => new Promise<PutResult>(() => {}) };
    const fetchImpl = (async () => fakeResp(PNG)) as unknown as typeof fetch;
    const start = Date.now();
    const url = await relocateImageToStore('https://cdn/x', 'k', { store, fetchImpl, logger: silentLogger, timeoutMs: 40 });
    assert.equal(url, null);
    assert.ok(Date.now() - start < 1000, `在 timeoutMs 内返回（实测 ${Date.now() - start}ms）`);
  });
});
