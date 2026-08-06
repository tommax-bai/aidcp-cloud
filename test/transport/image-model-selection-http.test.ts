/**
 * 图片模型选择：跨进程取源往返 + **本地镜像的降级方向**。
 *
 * 这条口与本批其余四条形状不同：调用点是**同步**的、在热闭包里，所以跨进程形态是
 * 「异步取源 + 同步读本地镜像」两件事。真正要钉的是镜像那三条：
 *   ① 从未取到过 → 保守默认（绝不空串、绝不猜；图片厂商猜错会静默走错供应商）；
 *   ② 刷新失败 → **保留上一份好值**并留 warn（陈旧一会儿远好过突然全体回落默认）；
 *   ③ 取到新值 → 同步读立刻看得见。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InternalHttpClient, InternalHttpServer } from '@automation/transport/internal-http.js';
import {
  IMAGE_MODEL_SELECTION_ROUTES,
  ImageModelSelectionHttpClient,
  PollingImageModelSelectionMirror,
  registerImageModelSelectionRoutes,
} from '@automation/transport/image-model-selection-http.js';
import type { ImageModelSelection } from '@kernel/kernel/image-model-selection-port.js';

const FALLBACK: ImageModelSelection = { imageProvider: 'dashscope', imageModel: 'wanx-v1' };
const silent = { warn() {} };

test('取源往返：属主侧的当前选择原样回到取源客户端', async () => {
  const server = new InternalHttpServer();
  registerImageModelSelectionRoutes(server, {
    fetchImageModelSelection: async () => ({ imageProvider: 'volcengine', imageModel: 'seedream-3' }),
  });
  const port = await server.listen(0);
  try {
    const client = new ImageModelSelectionHttpClient(new InternalHttpClient(`http://127.0.0.1:${port}`));
    assert.deepEqual(await client.fetchImageModelSelection(), {
      imageProvider: 'volcengine',
      imageModel: 'seedream-3',
    });
  } finally {
    await server.close();
  }
});

test('镜像：从未取到过 → 同步读回保守默认，MUST NOT 回空串', async () => {
  const mirror = new PollingImageModelSelectionMirror({
    source: { fetchImageModelSelection: async () => ({ imageProvider: 'volcengine', imageModel: 'x' }) },
    fallback: FALLBACK,
    logger: silent,
  });
  assert.deepEqual(mirror.current(), FALLBACK);
  assert.equal(mirror.loaded(), false);
});

test('镜像：取到新值后同步读立刻看得见', async () => {
  const mirror = new PollingImageModelSelectionMirror({
    source: { fetchImageModelSelection: async () => ({ imageProvider: 'volcengine', imageModel: 'seedream-3' }) },
    fallback: FALLBACK,
    logger: silent,
  });
  await mirror.refreshOnce();
  assert.deepEqual(mirror.current(), { imageProvider: 'volcengine', imageModel: 'seedream-3' });
  assert.equal(mirror.loaded(), true);
});

test('镜像：刷新失败 MUST 保留上一份好值并留 warn，绝不清空回默认', async () => {
  let fail = false;
  const warnings: string[] = [];
  const mirror = new PollingImageModelSelectionMirror({
    source: {
      fetchImageModelSelection: async () => {
        if (fail) throw new Error('api unreachable');
        return { imageProvider: 'volcengine', imageModel: 'seedream-3' };
      },
    },
    fallback: FALLBACK,
    logger: { warn: (...a: unknown[]) => void warnings.push(a.map(String).join(' ')) },
  });
  await mirror.refreshOnce();
  fail = true;
  await mirror.refreshOnce();
  assert.deepEqual(
    mirror.current(),
    { imageProvider: 'volcengine', imageModel: 'seedream-3' },
    '陈旧一会儿远好过突然全体回落默认',
  );
  assert.equal(warnings.length, 1, '降级必须吵闹');
});

test('路由名两侧共用同一常量', () => {
  assert.equal(IMAGE_MODEL_SELECTION_ROUTES.fetch, 'image-model-selection/fetch');
});
