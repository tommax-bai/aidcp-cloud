import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePanelUsers } from '../src/panel/auth.js';
import { startPanelApi } from '../src/panel/panel-server.js';
import type { PanelConfig, PanelDeps } from '../src/panel/types.js';
// api 属主配置/查询面在桶拆分后不再经 automation 桶（src/interactions/index.ts）再导出，
// 直接从各自具体 api 文件导入。
import {
  buildInteractionPermissionOverview,
  INTERACTION_PERMISSION_DEFINITIONS,
  type InteractionPermissionOverview,
} from '../src/interactions/interaction-panel-permissions.js';
import { parseInteractionPanelGrants } from '../src/interactions/interaction-internal-api.js';

const silentLogger = { log() {}, warn() {}, error() {} };

function makeConfig(): PanelConfig {
  return {
    port: 0,
    jwtSecret: 'test-secret',
    users: parsePanelUsers('ops:pw1,admin:pw2'),
    jwtTtlSeconds: 3600,
    forbiddenPorts: [8787, 5432, 8788],
    logger: silentLogger,
  };
}

async function loginToken(base: string): Promise<string> {
  const response = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'pw2' }),
  });
  return ((await response.json()) as { token: string }).token;
}

test('权限概览固定六项，只展示有效后台用户且不泄漏凭据或失效 actor', () => {
  const users = parsePanelUsers('ops:ops-secret,admin:admin-secret,admin:duplicate-secret');
  const grants = parseInteractionPanelGrants(JSON.stringify({
    admin: [
      'interaction.config.view',
      'interaction.config.edit',
      'interaction.config.publish',
      'interaction.config.preview',
      'interaction.dm.view_full',
      'interaction.audit.view',
    ],
    ops: ['interaction.config.view', 'interaction.config.preview'],
    retired: ['interaction.config.publish'],
  }));

  const view = buildInteractionPermissionOverview(users, grants);
  assert.deepEqual(view.permissions.map((item) => item.key), INTERACTION_PERMISSION_DEFINITIONS.map((item) => item.key));
  assert.equal(view.permissions.length, 6);
  assert.deepEqual(view.permissions.find((item) => item.key === 'interaction.config.view')?.users, ['admin', 'ops']);
  assert.deepEqual(view.permissions.find((item) => item.key === 'interaction.config.publish')?.users, ['admin']);
  const raw = JSON.stringify(view);
  assert.ok(!raw.includes('retired'));
  assert.ok(!raw.includes('secret'));
  assert.ok(view.permissions.every((item) => item.name && item.description));
});

test('空或无效 grants 诚实返回六项空用户列表', () => {
  const users = parsePanelUsers('admin:pw');
  for (const raw of [undefined, '{bad json']) {
    const view = buildInteractionPermissionOverview(users, parseInteractionPanelGrants(raw));
    assert.equal(view.permissions.length, 6);
    assert.ok(view.permissions.every((item) => item.users.length === 0));
  }
});

test('权限概览端点受 JWT 保护、只读，未注入时返回 503', async () => {
  const overview: InteractionPermissionOverview = buildInteractionPermissionOverview(
    makeConfig().users,
    parseInteractionPanelGrants('{"admin":["interaction.config.view"]}'),
  );
  const deps = {
    eventBus: { onAny: () => () => {} },
    interactionPermissions: { getView: () => overview },
  } as unknown as PanelDeps;
  const handle = await startPanelApi(deps, makeConfig());
  assert.equal(handle.started, true);
  const base = `http://127.0.0.1:${handle.port}`;
  try {
    assert.equal((await fetch(`${base}/api/config/interaction-permissions`)).status, 401);
    const token = await loginToken(base);
    const auth = { authorization: `Bearer ${token}` };
    const response = await fetch(`${base}/api/config/interaction-permissions`, { headers: auth });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), overview);
    assert.equal((await fetch(`${base}/api/config/interaction-permissions`, { method: 'PUT', headers: auth })).status, 404);
  } finally {
    await handle.close();
  }

  const unavailable = await startPanelApi({ eventBus: { onAny: () => () => {} } } as unknown as PanelDeps, makeConfig());
  const unavailableBase = `http://127.0.0.1:${unavailable.port}`;
  try {
    const token = await loginToken(unavailableBase);
    const response = await fetch(`${unavailableBase}/api/config/interaction-permissions`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(response.status, 503);
    assert.equal(((await response.json()) as { error: string }).error, 'interaction_permissions_unavailable');
  } finally {
    await unavailable.close();
  }
});
