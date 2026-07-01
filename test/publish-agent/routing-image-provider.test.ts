import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  RoutingImageProvider,
  normImageProvider,
  isKnownImageProvider,
} from '../../src/publish-agent/image-providers.js';
import type { ImageProvider, ImageResult } from '../../src/publish-agent/image-provider.js';

const silentLogger = { log() {}, warn() {}, error() {} };

/** 记录调用 + 可编程返回的假图片客户端。 */
function fakeProvider(result: ImageResult): ImageProvider & { calls: number } {
  return {
    calls: 0,
    async generate(): Promise<ImageResult> {
      this.calls++;
      return result;
    },
  } as any;
}

describe('normImageProvider', () => {
  test('已知原样、未知/空/脏串归一 dashscope', () => {
    assert.equal(normImageProvider('dashscope'), 'dashscope');
    assert.equal(normImageProvider('volcengine'), 'volcengine');
    assert.equal(normImageProvider('  volcengine '), 'volcengine');
    assert.equal(normImageProvider(''), 'dashscope');
    assert.equal(normImageProvider(null), 'dashscope');
    assert.equal(normImageProvider('openai'), 'dashscope');
    assert.equal(isKnownImageProvider('volcengine'), true);
    assert.equal(isKnownImageProvider('nope'), false);
  });
});

describe('RoutingImageProvider', () => {
  test('按 getProvider 分发到对应厂商客户端', async () => {
    const wan = fakeProvider({ url: 'https://wan/img.png' });
    const seed = fakeProvider({ url: 'https://seed/img.png' });
    let sel = 'dashscope';
    const router = new RoutingImageProvider({
      getProvider: () => sel,
      providers: { dashscope: wan, volcengine: seed },
      logger: silentLogger,
    });

    let r = await router.generate('p');
    assert.equal(r.url, 'https://wan/img.png');
    assert.equal(wan.calls, 1);
    assert.equal(seed.calls, 0);

    sel = 'volcengine';
    r = await router.generate('p');
    assert.equal(r.url, 'https://seed/img.png');
    assert.equal(seed.calls, 1);
    assert.equal(wan.calls, 1); // 万相未被再调
  });

  test('未知/脏串 provider 归一到 dashscope（不 brick）', async () => {
    const wan = fakeProvider({ url: 'https://wan/img.png' });
    const seed = fakeProvider({ url: 'https://seed/img.png' });
    const router = new RoutingImageProvider({
      getProvider: () => 'garbage',
      providers: { dashscope: wan, volcengine: seed },
      logger: silentLogger,
    });
    const r = await router.generate('p');
    assert.equal(r.url, 'https://wan/img.png');
    assert.equal(wan.calls, 1);
    assert.equal(seed.calls, 0);
  });

  test('选中厂商生图失败 → 诚实回该厂商 error，绝不跨厂商顶替', async () => {
    const wan = fakeProvider({ url: 'https://wan/img.png' });
    const seed = fakeProvider({ url: null, error: '即梦-Seedream key 缺失' });
    const router = new RoutingImageProvider({
      getProvider: () => 'volcengine',
      providers: { dashscope: wan, volcengine: seed },
      logger: silentLogger,
    });
    const r = await router.generate('p');
    assert.equal(r.url, null);
    assert.match(r.error!, /Seedream/);
    // 红线：绝不因即梦失败而偷偷改用万相顶替。
    assert.equal(wan.calls, 0);
    assert.equal(seed.calls, 1);
  });

  test('选中厂商未装配 → 诚实 error（防御，绝不静默换厂商）', async () => {
    const wan = fakeProvider({ url: 'https://wan/img.png' });
    const router = new RoutingImageProvider({
      getProvider: () => 'volcengine',
      providers: { dashscope: wan }, // 未装配 volcengine
      logger: silentLogger,
    });
    const r = await router.generate('p');
    assert.equal(r.url, null);
    assert.match(r.error!, /未装配/);
    assert.equal(wan.calls, 0);
  });
});
