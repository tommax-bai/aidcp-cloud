import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startPanelApi } from '../src/panel/panel-server.js';
import { parsePanelUsers } from '../src/panel/auth.js';
import type { PanelConfig, PanelDeps, RoleConfigCatalogView } from '../src/panel/types.js';

const silentLogger = { log() {}, warn() {}, error() {} };

function makeDeps(withRoleConfig = true) {
  const view: RoleConfigCatalogView = {
    roles: [
      { roleId: 'browse:comment_composer', displayName: '评论文案撰写', group: 'browse', category: 'browse_compose', llmKind: 'text', tunableTemperature: true, effectiveModel: 'qwen-turbo', effectiveProvider: 'dashscope', effectiveSource: 'default', modelOverridden: false, temperatureOverride: null, effectiveThinkingMode: 'default', thinkingModeOverride: null, thinkingModeSource: 'default', thinkingOnAvailable: false, updatedAt: null, updatedBy: null },
      { roleId: 'publish:ImageGenerator', displayName: '配图生成执行', group: 'publish', category: 'image', llmKind: 'image', tunableTemperature: false, effectiveModel: 'wan2.7-image-pro', effectiveProvider: 'dashscope', effectiveSource: 'image', modelOverridden: false, temperatureOverride: null, effectiveThinkingMode: 'default', thinkingModeOverride: null, thinkingModeSource: 'default', thinkingOnAvailable: false, updatedAt: null, updatedBy: null },
    ],
  };
  const roleConfig = {
    getCatalog: () => view,
    setRoleConfig: async (roleId: string, patch: { model?: string | null }) => {
      if (roleId === 'browse:nope') return { ok: false as const, reason: 'unknown_role' as const };
      if (patch.model === 'bad') return { ok: false as const, reason: 'model_invalid' as const };
      return { ok: true as const, view };
    },
  };
  const deps = {
    eventBus: { onAny: () => () => {} },
    ...(withRoleConfig ? { roleConfig } : {}),
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

test('roles 路由：401 未鉴权 / GET 白名单 / PUT 回真态 / 未知角色 404 / 无效模型 400', async () => {
  const h = await startPanelApi(makeDeps(true), makeConfig());
  const base = `http://127.0.0.1:${h.port}`;
  try {
    assert.equal((await fetch(`${base}/api/roles`)).status, 401);

    const token = await loginToken(base);
    const auth = { authorization: `Bearer ${token}` };

    const g = await fetch(`${base}/api/roles`, { headers: auth });
    assert.equal(g.status, 200);
    const view = (await g.json()) as RoleConfigCatalogView;
    assert.ok(view.roles.some((r) => r.roleId === 'browse:comment_composer'));
    assert.ok(view.roles.some((r) => r.llmKind === 'image'));

    const enc = encodeURIComponent('browse:comment_composer');
    const ok = await fetch(`${base}/api/roles/${enc}/config`, {
      method: 'PUT',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'qwen-max', temperature: 0.7 }),
    });
    assert.equal(ok.status, 200);

    // 全空请求体 → 400（不静默忽略）
    const empty = await fetch(`${base}/api/roles/${enc}/config`, {
      method: 'PUT',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(empty.status, 400);

    // 未知角色 → 404
    const unknown = await fetch(`${base}/api/roles/${encodeURIComponent('browse:nope')}/config`, {
      method: 'PUT',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'qwen-max' }),
    });
    assert.equal(unknown.status, 404);

    // 探活失败 → 400 model_invalid
    const bad = await fetch(`${base}/api/roles/${enc}/config`, {
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

test('未注入 roleConfig → /api/roles 503', async () => {
  const h = await startPanelApi(makeDeps(false), makeConfig());
  const base = `http://127.0.0.1:${h.port}`;
  try {
    const token = await loginToken(base);
    const g = await fetch(`${base}/api/roles`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(g.status, 503);
  } finally {
    await h.close();
  }
});
