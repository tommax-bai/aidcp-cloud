import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startPanelApi } from '../src/panel/panel-server.js';
import { parsePanelUsers } from '../src/panel/auth.js';
import type { PanelConfig, PanelDeps, RolePromptView } from '../src/panel/types.js';

const silentLogger = { log() {}, warn() {}, error() {} };

function makeDeps(withPreview = true) {
  const rolePromptPreview = {
    get: (roleId: string): RolePromptView =>
      roleId === 'browse:content_evaluator'
        ? { roleId, prompt: '渲染的 prompt 文本…', available: true, note: '示例占位' }
        : { roleId, prompt: null, available: false, note: '不可预览' },
  };
  const deps = {
    eventBus: { onAny: () => () => {} },
    ...(withPreview ? { rolePromptPreview } : {}),
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

test('prompt 预览路由：401 未鉴权 / 200 含 prompt / 未知角色 404 / PUT 不被接受', async () => {
  const h = await startPanelApi(makeDeps(true), makeConfig());
  const base = `http://127.0.0.1:${h.port}`;
  try {
    const enc = encodeURIComponent('browse:content_evaluator');
    // 401 未鉴权
    assert.equal((await fetch(`${base}/api/roles/${enc}/prompt`)).status, 401);

    const token = await loginToken(base);
    const auth = { authorization: `Bearer ${token}` };

    // 200 含 prompt
    const g = await fetch(`${base}/api/roles/${enc}/prompt`, { headers: auth });
    assert.equal(g.status, 200);
    const view = (await g.json()) as RolePromptView;
    assert.equal(view.available, true);
    assert.ok(view.prompt && view.prompt.length > 0);

    // 未知角色 → 404
    const unknown = await fetch(`${base}/api/roles/${encodeURIComponent('browse:nope')}/prompt`, { headers: auth });
    assert.equal(unknown.status, 404);

    // 只读：PUT 该路径不被接受（走 404 not_found，无写语义）
    const put = await fetch(`${base}/api/roles/${enc}/prompt`, {
      method: 'PUT',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'hack' }),
    });
    assert.equal(put.status, 404);
  } finally {
    await h.close();
  }
});

test('未注入 rolePromptPreview → 503', async () => {
  const h = await startPanelApi(makeDeps(false), makeConfig());
  const base = `http://127.0.0.1:${h.port}`;
  try {
    const token = await loginToken(base);
    const g = await fetch(`${base}/api/roles/${encodeURIComponent('browse:content_evaluator')}/prompt`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(g.status, 503);
  } finally {
    await h.close();
  }
});
