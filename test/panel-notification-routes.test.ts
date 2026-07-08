import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startPanelApi } from '../src/panel/panel-server.js';
import { parsePanelUsers } from '../src/panel/auth.js';
import type { PanelConfig, PanelDeps } from '../src/panel/types.js';
import type { GroupRoute, SetGroupRouteResult } from '../src/cache/group-route-store.js';

/**
 * change feishu-per-team-notification-routing：面板路由配置 API 契约
 * （503 未注入 / PUT 校验 + 读回真态 / GET 列表 / GET 机器人所在群）。console 据此渲染，绑定目标为 opaque chat_id（无枚举）。
 */

const silentLogger = { log() {}, warn() {}, error() {} };

function fakeRoutesStore() {
  const rows: GroupRoute[] = [];
  return {
    listRoutes: async (): Promise<GroupRoute[]> => rows.slice(),
    setRoute: async (groupLabel: string, chatId: string | null, updatedBy: string | null): Promise<SetGroupRouteResult> => {
      const key = groupLabel.trim();
      if (!key) return { ok: false, reason: 'invalid_key' };
      const idx = rows.findIndex((r) => r.groupLabel === key);
      const target = (chatId ?? '').trim();
      if (!target) {
        if (idx >= 0) rows.splice(idx, 1);
        return { ok: true, route: null };
      }
      const route: GroupRoute = { groupLabel: key, chatId: target, updatedBy, updatedAt: 0 };
      if (idx >= 0) rows[idx] = route;
      else rows.push(route);
      return { ok: true, route };
    },
  };
}

const baseDeps = {
  edgeServer: { edgeCount: () => 0, onlineEdgeCount: () => 0 },
  eventBus: { onAny: () => () => {} },
  panelStore: {},
  botChatStore: {
    listActive: async () => [{ chatId: 'oc_a', chatName: '客户A群', chatType: 'group', isDefault: true }],
  },
};

function makeConfig(over: Partial<PanelConfig> = {}): PanelConfig {
  return {
    port: 0,
    jwtSecret: 'test-secret',
    users: parsePanelUsers('alice:pw1'),
    jwtTtlSeconds: 3600,
    forbiddenPorts: [8787, 5432, 8788],
    logger: silentLogger,
    ...over,
  };
}

async function login(base: string): Promise<{ authorization: string }> {
  const r = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'alice', password: 'pw1' }),
  });
  const { token } = (await r.json()) as { token: string };
  return { authorization: `Bearer ${token}` };
}

test('notification/routes 未注入 → 503（读写皆是）', async () => {
  const deps = { ...baseDeps } as unknown as PanelDeps; // 无 notificationRoutes
  const h = await startPanelApi(deps, makeConfig());
  assert.equal(h.started, true);
  const base = `http://127.0.0.1:${h.port}`;
  try {
    const auth = await login(base);
    assert.equal((await fetch(`${base}/api/notification/routes`, { headers: auth })).status, 503);
    const put = await fetch(`${base}/api/notification/routes`, {
      method: 'PUT',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ groupLabel: 'teamA', chatId: 'oc_a' }),
    });
    assert.equal(put.status, 503);
  } finally {
    await h.close();
  }
});

test('notification/routes 读写闭环 + bot-chats 列表（绑定目标 opaque chat_id）', async () => {
  const deps = { ...baseDeps, notificationRoutes: fakeRoutesStore() } as unknown as PanelDeps;
  const h = await startPanelApi(deps, makeConfig());
  assert.equal(h.started, true);
  const base = `http://127.0.0.1:${h.port}`;
  try {
    const auth = await login(base);
    const j = { ...auth, 'content-type': 'application/json' };

    // 空 group_label → 400
    const bad = await fetch(`${base}/api/notification/routes`, { method: 'PUT', headers: j, body: JSON.stringify({ groupLabel: '  ', chatId: 'oc_a' }) });
    assert.equal(bad.status, 400);

    // chatId 类型非法 → 400
    const badType = await fetch(`${base}/api/notification/routes`, { method: 'PUT', headers: j, body: JSON.stringify({ groupLabel: 'teamA', chatId: 123 }) });
    assert.equal(badType.status, 400);

    // 正常写 → 200 + 读回真态
    const ok = await fetch(`${base}/api/notification/routes`, { method: 'PUT', headers: j, body: JSON.stringify({ groupLabel: 'teamA', chatId: 'oc_a' }) });
    assert.equal(ok.status, 200);
    const okBody = (await ok.json()) as { route: GroupRoute | null };
    assert.equal(okBody.route?.chatId, 'oc_a');

    // 列表含刚写入
    const list = await fetch(`${base}/api/notification/routes`, { headers: auth });
    const listBody = (await list.json()) as { routes: GroupRoute[] };
    assert.equal(listBody.routes.length, 1);
    assert.equal(listBody.routes[0].groupLabel, 'teamA');

    // 清除（chatId 空）→ route=null，列表空
    const clear = await fetch(`${base}/api/notification/routes`, { method: 'PUT', headers: j, body: JSON.stringify({ groupLabel: 'teamA', chatId: '' }) });
    assert.equal(clear.status, 200);
    assert.equal(((await clear.json()) as { route: GroupRoute | null }).route, null);

    // bot-chats 列表：机器人所在群供下拉
    const chats = await fetch(`${base}/api/bot-chats`, { headers: auth });
    assert.equal(chats.status, 200);
    const chatsBody = (await chats.json()) as { chats: Array<{ chatId: string; isDefault: boolean }> };
    assert.equal(chatsBody.chats[0].chatId, 'oc_a');
    assert.equal(chatsBody.chats[0].isDefault, true);
  } finally {
    await h.close();
  }
});
