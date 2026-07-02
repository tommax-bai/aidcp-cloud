import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startPanelApi } from '../src/panel/panel-server.js';
import { parsePanelUsers } from '../src/panel/auth.js';
import type { PanelConfig, PanelDeps, CategoryConfigCatalogView } from '../src/panel/types.js';

const silentLogger = { log() {}, warn() {}, error() {} };

function makeDeps(withCategoryConfig = true) {
  const view: CategoryConfigCatalogView = {
    categories: [
      { categoryId: 'browse_judge', displayName: '浏览 · 判定类', order: 1, effectiveModel: 'qwen-turbo', effectiveProvider: 'dashscope', modelOverridden: false, effectiveThinkingMode: 'default', thinkingModeOverridden: false, thinkingOnAvailable: false, updatedAt: null, updatedBy: null },
    ],
  };
  const categoryConfig = {
    getCatalog: () => view,
    setCategoryConfig: async (categoryId: string, patch: { model?: string | null }) => {
      if (categoryId === 'nope_category') return { ok: false as const, reason: 'unknown_category' as const };
      if (categoryId === 'image') return { ok: false as const, reason: 'category_not_configurable' as const };
      if (patch.model === 'bad') return { ok: false as const, reason: 'model_invalid' as const };
      return { ok: true as const, view };
    },
  };
  const deps = {
    eventBus: { onAny: () => () => {} },
    ...(withCategoryConfig ? { categoryConfig } : {}),
  } as unknown as PanelDeps;
  return deps;
}

function makeConfig(): PanelConfig {
  return {
    port: 0,
    jwtSecret: 'test-secret',
    users: parsePanelUsers('alice:pw1'),
    jwtTtlSeconds: 3600,
    forbiddenPorts: [8787, 5432, 8788],
    logger: silentLogger,
  };
}

async function loginToken(base: string): Promise<string> {
  const r = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'alice', password: 'pw1' }),
  });
  return ((await r.json()) as { token: string }).token;
}

test('categories 路由：401 未鉴权 / GET 白名单 / PUT 回真态 / 未知分类 404 / 不可配 400 / 无效模型 400', async () => {
  const h = await startPanelApi(makeDeps(true), makeConfig());
  const base = `http://127.0.0.1:${h.port}`;
  try {
    assert.equal((await fetch(`${base}/api/categories`)).status, 401);

    const token = await loginToken(base);
    const auth = { authorization: `Bearer ${token}` };

    const g = await fetch(`${base}/api/categories`, { headers: auth });
    assert.equal(g.status, 200);
    const view = (await g.json()) as CategoryConfigCatalogView;
    assert.ok(view.categories.some((c) => c.categoryId === 'browse_judge'));

    const enc = encodeURIComponent('browse_judge');
    const ok = await fetch(`${base}/api/categories/${enc}/config`, {
      method: 'PUT',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'qwen-plus' }),
    });
    assert.equal(ok.status, 200);

    // 清除覆盖：model:null 合法
    const clear = await fetch(`${base}/api/categories/${enc}/config`, {
      method: 'PUT',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ model: null }),
    });
    assert.equal(clear.status, 200);

    // 非 string/null 的 model 类型 → 400
    const badType = await fetch(`${base}/api/categories/${enc}/config`, {
      method: 'PUT',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 123 }),
    });
    assert.equal(badType.status, 400);

    // 未知分类 → 404
    const unknown = await fetch(`${base}/api/categories/${encodeURIComponent('nope_category')}/config`, {
      method: 'PUT',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'qwen-max' }),
    });
    assert.equal(unknown.status, 404);

    // 纯图像分类不可配 → 400
    const notConf = await fetch(`${base}/api/categories/${encodeURIComponent('image')}/config`, {
      method: 'PUT',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'qwen-max' }),
    });
    assert.equal(notConf.status, 400);

    // 探活失败 → 400 model_invalid
    const bad = await fetch(`${base}/api/categories/${enc}/config`, {
      method: 'PUT',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'bad' }),
    });
    assert.equal(bad.status, 400);
    assert.equal(((await bad.json()) as { error: string }).error, 'model_invalid');
  } finally {
    await h.close();
  }
});

test('未注入 categoryConfig → /api/categories 503', async () => {
  const h = await startPanelApi(makeDeps(false), makeConfig());
  const base = `http://127.0.0.1:${h.port}`;
  try {
    const token = await loginToken(base);
    const g = await fetch(`${base}/api/categories`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(g.status, 503);
  } finally {
    await h.close();
  }
});
