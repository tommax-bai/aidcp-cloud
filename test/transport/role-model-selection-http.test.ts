/**
 * 角色模型解析：跨进程取源往返 + 本地镜像的查表与降级。
 *
 * 这条口的设计决定值得单独钉住：**属主侧把答案算好再送**，而不是把三张配置表送过去。
 * 送表就要求调用方也持有角色目录、复刻四层回落——两侧各写一份，各自编译通过，只有真跑才发现不一致。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InternalHttpClient, InternalHttpServer } from '../../src/transport/internal-http.js';
import {
  ROLE_MODEL_SELECTION_ROUTES,
  PollingRoleModelSelectionMirror,
  RoleModelSelectionHttpClient,
  registerRoleModelSelectionRoutes,
} from '../../src/transport/role-model-selection-http.js';
import type { RoleModelSelectionSnapshot } from '../../src/kernel/role-model-selection-port.js';

const FALLBACK = { provider: 'dashscope', model: 'qwen-plus' };
const silent = { warn() {} };

const SNAPSHOT: RoleModelSelectionSnapshot = {
  fallback: { provider: 'dashscope', model: 'qwen-max' },
  byRole: {
    'publish:TitleCreator': { provider: 'volcengine', model: 'doubao-pro', temperature: 0.8 },
    'publish:QualityScorer': { provider: 'dashscope', model: 'qwen-plus', thinkingMode: 'on' },
  },
};

test('取源往返：预解析快照原样回到取源客户端', async () => {
  const server = new InternalHttpServer();
  registerRoleModelSelectionRoutes(server, { fetchRoleModelSelections: async () => SNAPSHOT });
  const port = await server.listen(0);
  try {
    const client = new RoleModelSelectionHttpClient(new InternalHttpClient(`http://127.0.0.1:${port}`));
    assert.deepEqual(await client.fetchRoleModelSelections(), SNAPSHOT);
  } finally {
    await server.close();
  }
});

test('镜像：登记角色查表命中；未登记角色与不带角色都用 fallback（正常语义，不是降级）', async () => {
  const mirror = new PollingRoleModelSelectionMirror({
    source: { fetchRoleModelSelections: async () => SNAPSHOT },
    fallback: FALLBACK,
    logger: silent,
  });
  await mirror.refreshOnce();
  assert.deepEqual(mirror.forRole('publish:TitleCreator'), {
    provider: 'volcengine',
    model: 'doubao-pro',
    temperature: 0.8,
  });
  assert.deepEqual(mirror.forRole('publish:NotRegistered'), SNAPSHOT.fallback, '未登记 → 全局那一层');
  assert.deepEqual(mirror.forRole(), SNAPSHOT.fallback, '不带角色 → 全局那一层');
});

test('镜像：从未取到过 → 保守默认；刷新失败 → 保留上一份好值并留 warn', async () => {
  let fail = false;
  const warnings: string[] = [];
  const mirror = new PollingRoleModelSelectionMirror({
    source: {
      fetchRoleModelSelections: async () => {
        if (fail) throw new Error('api unreachable');
        return SNAPSHOT;
      },
    },
    fallback: FALLBACK,
    logger: { warn: (...a: unknown[]) => void warnings.push(a.map(String).join(' ')) },
  });
  assert.deepEqual(mirror.forRole('publish:TitleCreator'), FALLBACK, '没取到过就用保守默认，绝不猜');
  await mirror.refreshOnce();
  fail = true;
  await mirror.refreshOnce();
  assert.deepEqual(
    mirror.forRole('publish:TitleCreator'),
    { provider: 'volcengine', model: 'doubao-pro', temperature: 0.8 },
    '陈旧一会儿远好过突然全体回落默认',
  );
  assert.equal(warnings.length, 1, '降级必须吵闹');
});

test('路由名两侧共用同一常量', () => {
  assert.equal(ROLE_MODEL_SELECTION_ROUTES.fetch, 'role-model-selection/fetch');
});
