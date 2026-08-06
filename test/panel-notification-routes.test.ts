import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startPanelApi } from '@api/panel/panel-server.js';
import { parsePanelUsers } from '@api/panel/auth.js';
import type { PanelConfig, PanelDeps } from '@api/panel/types.js';
import type { GroupRoute, SetGroupRouteResult } from '@automation/cache/group-route-store.js';

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

test('approval policies keep catalog/group writes and move comment writes to envKey', async () => {
  let accountMode = 'source_rules' as 'source_rules' | 'auto_approve_all';
  let groupDelivery = 'client_and_feishu' as 'client_and_feishu' | 'client_only';
  const environmentWrites: Array<{ envKey: string; mode: typeof accountMode; updatedBy: string | null }> = [];
  const environmentPolicy = (envKey: string) => ({
    envKey,
    mode: accountMode,
    configured: true,
    updatedBy: 'panel:alice',
    updatedAt: 1,
    boundAccountId: null,
  });
  const approvalPolicies = {
    list: async () => ({
      accounts: [{ accountId: 'acc-1', mode: accountMode, configured: true, updatedBy: 'alice', updatedAt: 0 }],
      groups: [{
        groupLabel: 'teamA', delivery: groupDelivery, configured: true, updatedBy: 'alice', updatedAt: 0,
        activeAccountCount: 2, reachableAccountCount: 1,
      }],
    }),
    getEnvironmentCommentPolicy: async () => {
      throw new Error('mutation must return the setter readback without a second read');
    },
    setEnvironmentCommentMode: async (envKey: string, mode: typeof accountMode, updatedBy: string | null) => {
      if (envKey === 'policy-down') {
        return { ok: false as const, reason: 'policy_unavailable' as const };
      }
      environmentWrites.push({ envKey, mode, updatedBy });
      accountMode = mode;
      return { ok: true as const, row: environmentPolicy(envKey) };
    },
    setGroupPublishDelivery: async (groupLabel: string, delivery: typeof groupDelivery, updatedBy: string | null) => {
      groupDelivery = delivery;
      return { ok: true as const, row: { groupLabel, delivery, configured: true, updatedBy, updatedAt: 1 } };
    },
  };
  const h = await startPanelApi({ ...baseDeps, approvalPolicies } as unknown as PanelDeps, makeConfig());
  assert.equal(h.started, true);
  const base = `http://127.0.0.1:${h.port}`;
  try {
    const auth = await login(base);
    const jsonHeaders = { ...auth, 'content-type': 'application/json' };
    const initial = await fetch(`${base}/api/approval-policies`, { headers: auth });
    assert.equal(initial.status, 200);
    const initialBody = await initial.json() as any;
    assert.equal(initialBody.groups[0].reachableAccountCount, 1);

    const removedAccountWrite = await fetch(`${base}/api/approval-policies/account-comment`, {
      method: 'PUT', headers: jsonHeaders, body: JSON.stringify({ accountId: 'acc-1', mode: 'auto_approve_all' }),
    });
    assert.equal(removedAccountWrite.status, 404);
    assert.equal(environmentWrites.length, 0);

    const environmentWrite = await fetch(`${base}/api/environments/env-unbound/comment-approval`, {
      method: 'PUT', headers: jsonHeaders, body: JSON.stringify({ mode: 'auto_approve_all' }),
    });
    assert.equal(environmentWrite.status, 200);
    assert.deepEqual(await environmentWrite.json(), {
      envKey: 'env-unbound',
      commentApproval: environmentPolicy('env-unbound'),
    });
    assert.deepEqual(environmentWrites, [{
      envKey: 'env-unbound',
      mode: 'auto_approve_all',
      updatedBy: 'panel:alice',
    }]);

    const groupWrite = await fetch(`${base}/api/approval-policies/group-publish`, {
      method: 'PUT', headers: jsonHeaders, body: JSON.stringify({ groupLabel: 'teamA', delivery: 'client_only' }),
    });
    assert.equal(groupWrite.status, 200);
    assert.equal((await groupWrite.json() as any).policy.delivery, 'client_only');

    const invalid = await fetch(`${base}/api/environments/env-unbound/comment-approval`, {
      method: 'PUT', headers: jsonHeaders, body: JSON.stringify({ mode: 'trust_client_body' }),
    });
    assert.equal(invalid.status, 400);
    const extraSelector = await fetch(`${base}/api/environments/env-unbound/comment-approval`, {
      method: 'PUT',
      headers: jsonHeaders,
      body: JSON.stringify({ mode: 'source_rules', accountId: 'acc-1' }),
    });
    assert.equal(extraSelector.status, 400);
    assert.equal(environmentWrites.length, 1, '额外选择器 MUST 在触达 authority 前拒绝');

    const policyUnavailable = await fetch(`${base}/api/environments/policy-down/comment-approval`, {
      method: 'PUT',
      headers: jsonHeaders,
      body: JSON.stringify({ mode: 'source_rules' }),
    });
    assert.equal(policyUnavailable.status, 503);
    assert.deepEqual(await policyUnavailable.json(), { error: 'policy_unavailable' });
    assert.equal(environmentWrites.length, 1, 'authority 不可用 MUST NOT 假装写入成功');
  } finally {
    await h.close();
  }
});

test('environment comment approval missing authority returns 503', async () => {
  const h = await startPanelApi({ ...baseDeps } as unknown as PanelDeps, makeConfig());
  assert.equal(h.started, true);
  const base = `http://127.0.0.1:${h.port}`;
  try {
    const auth = await login(base);
    const response = await fetch(`${base}/api/environments/env-1/comment-approval`, {
      method: 'PUT',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'auto_approve_all' }),
    });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'comment_approval_unavailable' });
  } finally {
    await h.close();
  }
});
