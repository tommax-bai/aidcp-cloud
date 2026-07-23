import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { startPanelApi } from '../src/panel/panel-server.js';
import { parsePanelUsers } from '../src/panel/auth.js';
import type { PanelConfig, PanelDeps } from '../src/panel/types.js';
import type { PanelAccount, PanelStoreReader } from '../src/panel/panel-store.js';
import { RiskController } from '../src/risk/index.js';
import { TokenRevocationStore } from '../src/panel/revocation.js';
import { FacebookPublishMediaError } from '../src/publish-agent/facebook-publish-media-store.js';
import { MemoryDelegatedTaskStore } from '../src/delegated-task/store.js';
import { DelegatedTaskService } from '../src/delegated-task/service.js';

const silentLogger = { log() {}, warn() {}, error() {} };

const acct: PanelAccount = {
  accountId: 'default',
  label: 'default',
  nickname: null,
  operatorAlias: null,
  displayName: 'default',
  displayNameSource: 'account_id',
  platform: 'xiaohongshu',
  groupLabel: null,
  machineLabel: null,
  contactInfo: null,
  operatorStatus: 'active',
  pausedAt: null,
  currentDriverTarget: null,
  riskStatus: 'normal',
  riskQuotaLevel: 'normal',
  signalCount: 0,
  personaBound: true,
  needsPersonaSetup: false,
};

const mockPanelStore: PanelStoreReader = {
  todayTotals: async () => ({ like: 10, collect: 2, comment: 1, follow: 0, publish: 1, view: 40, search: 2, comment_like: 0, join_group: 0, dm_reply: 0 }),
  todayTotalsByAccount: async () => [
    { accountId: 'default', totals: { like: 10, collect: 2, comment: 1, follow: 0, publish: 1, view: 40, search: 2, comment_like: 0, join_group: 0, dm_reply: 0 } },
  ],
  todayPublishCount: async () => 1,
  likeRate: async () => ({ likes: 10, views: 40, rate: 0.25, healthy: true }),
  listAccounts: async () => [acct],
  getAccount: async (id) => (id === 'default' ? acct : null),
  publishedHistory: async (_limit, accountId) => [
    {
      id: 1,
      title: 't',
      status: 'published',
      platform: 'xiaohongshu',
      platformPostId: 'p1',
      publishedAt: 123,
      publishMode: 'immediate',
      publishTime: null,
      scheduledAt: null,
      scheduledPlatformId: null,
      accountId: accountId ?? 'default',
      accountLabel: accountId ?? 'default',
      content: '正文全文',
      postUrl: 'https://www.xiaohongshu.com/explore/p1?xsec_token=tok',
      contentVersion: 0,
      images: ['https://aidcp.oss-cn-beijing.aliyuncs.com/publish/default/run1/1.jpeg'],
      imageUrl: 'https://aidcp.oss-cn-beijing.aliyuncs.com/publish/default/run1/1.jpeg',
      imagesAttachedCount: 1,
      imageReferenceAudit: null,
      coverFormAudit: null,
      sourceReference: null,
    },
  ],
  listAlerts: async () => [
    { id: 1, severity: 'P0', type: 'captcha', accountId: 'default', title: '验证码弹出', detail: null, createdAt: 100, resolvedAt: null },
  ],
  listInteractions: async (opts) => [
    { accountId: opts?.accountId ?? 'default', targetId: 'note-1', action: 'like', title: '一篇笔记', url: 'https://www.xiaohongshu.com/explore/note-1?xsec_token=x', interactedAt: 200 },
  ],
};

let dispatchActiveState = true;
const deps = {
  edgeServer: { edgeCount: () => 3, onlineEdgeCount: () => 3 },
  eventBus: { onAny: () => () => {} }, // panel WS attach 需要；返回 unsub
  panelStore: mockPanelStore,
  publishOrchestrator: { getStatus: () => ({ status: 'idle', snapshot: null }) },
  writeApprovalSignal: async (_requestId: string, _approved: boolean) => ({ written: true }),
  commandActions: {
    pause: async (id: string) => ({ accountId: id, status: 'paused' }),
    resume: async (id: string) => ({ accountId: id, status: 'active', resumedEdges: 2 }),
    dispatch: async (id: string, action: 'start' | 'stop') => {
      const want = action === 'start';
      const changed = dispatchActiveState !== want;
      dispatchActiveState = want;
      return { accountId: id, dispatch: want ? ('started' as const) : ('stopped' as const), changed, edgesOnline: 3 };
    },
    dispatchActive: () => dispatchActiveState,
  },
  riskRegistry: { getController: async (id: string) => new RiskController({ accountId: id }) },
} as unknown as PanelDeps;

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

test('自检拒绝保留端口（forbidden_port）', async () => {
  const h = await startPanelApi(deps, makeConfig({ port: 8787 }));
  assert.equal(h.started, false);
  assert.equal(h.reason, 'forbidden_port');
  await h.close();
});

test('环境管理 API 展示资产/账号摘要，旧删除路径保持不可用', async () => {
  const clientUsers = {
    async listAllEnvironments() {
      return [{
        envKey: 'profile-1', environmentName: '环境一', label: '环境一', platform: 'xiaohongshu',
        assignees: [{ userId: 'u1', name: '客户甲' }], assigneeCount: 1, cleanup: null,
        account: { accountId: 'default', label: 'default', nickname: null, operatorAlias: null,
          displayName: 'default', platform: 'xiaohongshu', groupLabel: '一组', riskStatus: 'normal',
          riskQuotaLevel: 'normal' },
        bindingObservedAt: 10, installation: null,
        lifecycle: { state: 'active', requestId: null, requestedBy: null, requestedAt: null,
          resultKind: null, resultError: null, resultAt: null, deletedAt: null },
      }];
    },
    async environmentSummariesByAccount() {
      return { default: { activeCount: 1, deletingCount: 0, onlineCount: 0 } };
    },
  };
  const environmentDeps = { ...deps, clientUsers } as unknown as PanelDeps;
  const h = await startPanelApi(environmentDeps, makeConfig());
  assert.equal(h.started, true);
  const base = `http://127.0.0.1:${h.port}`;
  try {
    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 'pw1' }),
    });
    const { token } = await login.json() as { token: string };
    const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const environments = await fetch(`${base}/api/environments`, { headers: auth });
    assert.equal(environments.status, 200);
    assert.equal(((await environments.json()) as { environments: Array<{ environmentName: string }> })
      .environments[0]?.environmentName, '环境一');
    const accounts = await fetch(`${base}/api/accounts`, { headers: auth });
    assert.deepEqual(((await accounts.json()) as { accounts: Array<{ environmentSummary: unknown }> })
      .accounts[0]?.environmentSummary, { activeCount: 1, deletingCount: 0, onlineCount: 0 });

    const removed = await fetch(`${base}/api/environments/profile-1/deletion`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({ confirmEnvKey: 'profile-1', idempotencyKey: 'idem-1' }),
    });
    assert.equal(removed.status, 404);
  } finally {
    await h.close();
  }
});

test('旧客户端不能再保存 AdsPower API Key', async () => {
  let credentialWrites = 0;
  const modelConfig = {
    async setCredential() {
      credentialWrites += 1;
      return { ok: true as const, provider: 'adspower', field: 'api_key', maskedHint: '***' };
    },
  };
  const h = await startPanelApi({ ...deps, modelConfig } as unknown as PanelDeps, makeConfig());
  assert.equal(h.started, true);
  const base = `http://127.0.0.1:${h.port}`;
  try {
    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 'pw1' }),
    });
    const { token } = await login.json() as { token: string };
    const response = await fetch(`${base}/api/config/credential`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'adspower', field: 'api_key', value: 'legacy-key' }),
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'bad_request', reason: 'unknown_field' });
    assert.equal(credentialWrites, 0);
  } finally {
    await h.close();
  }
});

test('缺 JWT 密钥不启动（missing_secret）', async () => {
  const h = await startPanelApi(deps, makeConfig({ jwtSecret: '' }));
  assert.equal(h.started, false);
  assert.equal(h.reason, 'missing_secret');
  await h.close();
});

test('无用户不启动（no_users）', async () => {
  const h = await startPanelApi(deps, makeConfig({ users: [] }));
  assert.equal(h.started, false);
  assert.equal(h.reason, 'no_users');
  await h.close();
});

test('端口占用非致命（listen_error，不抛出）', async () => {
  const blocker = net.createServer();
  await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', () => r()));
  const busyPort = (blocker.address() as net.AddressInfo).port;
  const h = await startPanelApi(deps, makeConfig({ port: busyPort }));
  assert.equal(h.started, false);
  assert.equal(h.reason, 'listen_error');
  await h.close();
  await new Promise<void>((r) => blocker.close(() => r()));
});

test('HTTP 集成：version 公开、登录签发 JWT、受保护读接口、404', async () => {
  const h = await startPanelApi(deps, makeConfig());
  assert.equal(h.started, true);
  const base = `http://127.0.0.1:${h.port}`;
  try {
    // /api/version 公开 + 枚举
    const ver = await fetch(`${base}/api/version`);
    assert.equal(ver.status, 200);
    const verBody = (await ver.json()) as { panelApiVersion: number; enums: { riskStatus: string[]; riskAction: string[] } };
    assert.deepEqual(verBody.enums.riskStatus, ['normal', 'warned', 'restricted', 'frozen']);
    assert.ok(verBody.enums.riskAction.includes('search'));

    // 受保护无 token → 401
    assert.equal((await fetch(`${base}/api/me`)).status, 401);

    // 登录
    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 'pw1' }),
    });
    assert.equal(login.status, 200);
    const { token } = (await login.json()) as { token: string };
    const auth = { authorization: `Bearer ${token}` };

    // dashboard summary：asOf 新鲜度 + totals + edgesOnline + likeRate + accounts + 按账号切片 + 告警 + 调度态
    const beforeSummary = Date.now();
    const sum = await fetch(`${base}/api/dashboard/summary`, { headers: auth });
    assert.equal(sum.status, 200);
    const sumBody = (await sum.json()) as {
      asOf: number;
      edgesOnline: number;
      totals: { like: number; search: number; publish: number };
      totalsByAccount: { accountId: string; totals: { like: number; search: number } }[];
      likeRate: { rate: number };
      accounts: unknown[];
      alerts: { severity: string }[];
      attributionPending: boolean;
      dispatchActive: boolean | null;
    };
    // change dashboard-refresh-clarity：asOf = 服务端该次查询当前时刻（数据新鲜度，console 渲染「数据截至」）
    assert.equal(typeof sumBody.asOf, 'number');
    assert.ok(
      sumBody.asOf >= beforeSummary && sumBody.asOf <= Date.now(),
      `asOf 应为服务端处理该请求时刻（got ${sumBody.asOf}）`,
    );
    assert.equal(sumBody.edgesOnline, 3);
    assert.equal(sumBody.totals.like, 10);
    assert.equal(sumBody.totals.search, 2);
    assert.equal(sumBody.totals.publish, 1);
    assert.equal(sumBody.likeRate.rate, 0.25);
    assert.equal(sumBody.accounts.length, 1);
    // V1 task 9.6：归因已流通，去「归因待补」，上真按账号切片
    assert.equal(sumBody.attributionPending, false);
    assert.equal(sumBody.totalsByAccount[0].accountId, 'default');
    assert.equal(sumBody.totalsByAccount[0].totals.like, 10);
    assert.equal(sumBody.totalsByAccount[0].totals.search, 2);
    // V1 task 9.5：真告警
    assert.equal(sumBody.alerts[0].severity, 'P0');
    // V1 task 9.4：调度引擎态
    assert.equal(sumBody.dispatchActive, true);

    // /api/version 暴露告警分级枚举（task 5.4 follow-up）+ 厂商全集 + DTO 字段指纹（console-cloud-panel-hardening #4/#5/#6）
    const ver2 = (await (await fetch(`${base}/api/version`)).json()) as {
      enums: {
        alertSeverity: string[];
        riskAction: string[];
        imageProvider: string[];
        textProvider: string[];
        llmKind: string[];
        effectiveSource: string[];
        personaSource: string[];
        thinkingMode: string[];
      };
      dtoFields: { panelAccount: string[] };
    };
    assert.deepEqual(ver2.enums.alertSeverity, ['P0', 'P1', 'P2', 'P3']);
    assert.ok(ver2.enums.riskAction.includes('comment_like'), 'riskAction live 真值含评论赞（#4 哨兵源）');
    assert.ok(ver2.enums.imageProvider.includes('volcengine'), 'imageProvider 全集含火山（#5 哨兵源）');
    assert.ok(ver2.enums.textProvider.includes('dashscope'), 'textProvider 全集（#6 哨兵源）');
    assert.ok(ver2.dtoFields.panelAccount.includes('accountId'), 'PanelAccount 字段指纹（#6 对拍源）');
    // 配置枚举哨兵源（console-panel-config-enum-fingerprint）：llmKind/effectiveSource 含 vision（曾致 /roles 崩）
    assert.ok(ver2.enums.llmKind.includes('vision'), 'llmKind live 全集含 vision（配置枚举哨兵源）');
    assert.ok(ver2.enums.effectiveSource.includes('vision'), 'effectiveSource live 全集含 vision（配置枚举哨兵源）');
    assert.deepEqual(ver2.enums.personaSource, ['override', 'none'], 'personaSource 全集');
    assert.deepEqual(ver2.enums.thinkingMode, ['default', 'off', 'on'], 'thinkingMode 三态全集');

    // V1 task 9.5：/api/alerts 只读流
    const al = (await (await fetch(`${base}/api/alerts`, { headers: auth })).json()) as { alerts: unknown[] };
    assert.equal(al.alerts.length, 1);

    // V1 task 9.2 / change interaction-feed-enrichment：/api/monitor/interactions（按账号过滤；目标=targetId + 标题/链接）
    const it = (await (
      await fetch(`${base}/api/monitor/interactions?accountId=default`, { headers: auth })
    ).json()) as { interactions: { accountId: string; targetId: string; title?: string; url?: string }[] };
    assert.equal(it.interactions[0].targetId, 'note-1');
    assert.equal(it.interactions[0].accountId, 'default');
    assert.equal(it.interactions[0].title, '一篇笔记');

    // change publish-history-account-and-detail：已发布历史带账号/正文/详情链接 + ?accountId 透传过滤。
    const pubFiltered = (await (
      await fetch(`${base}/api/content/published?accountId=acc-7`, { headers: auth })
    ).json()) as {
      items: { accountId: string; accountLabel: string; content: string; postUrl: string; images: string[]; imagesAttachedCount: number }[];
    };
    assert.equal(pubFiltered.items[0].accountId, 'acc-7', '?accountId 透传到 store');
    assert.equal(pubFiltered.items[0].content, '正文全文', '返回正文全文');
    assert.ok(pubFiltered.items[0].postUrl.includes('xsec_token'), '返回带 token 的详情页链接');
    // 面板展示发布配图（后台内容页详情浮层）：images 全集 + 真实附着张数一并透传。
    assert.equal(pubFiltered.items[0].images.length, 1, '返回配图 URL 列表');
    assert.equal(pubFiltered.items[0].imagesAttachedCount, 1, '返回真实附着张数');

    // accounts 列表 / 详情 / 404
    const accs = (await (await fetch(`${base}/api/accounts`, { headers: auth })).json()) as {
      accounts: unknown[];
    };
    assert.equal(accs.accounts.length, 1);
    assert.equal((await fetch(`${base}/api/accounts/default`, { headers: auth })).status, 200);
    assert.equal((await fetch(`${base}/api/accounts/nope`, { headers: auth })).status, 404);

    // content/published + content/queue + analytics/like-rate
    const pub = (await (await fetch(`${base}/api/content/published`, { headers: auth })).json()) as {
      items: unknown[];
    };
    assert.equal(pub.items.length, 1);
    const queue = (await (await fetch(`${base}/api/content/queue`, { headers: auth })).json()) as {
      status: string;
      lifecycle: { status: string; active: unknown[]; recent: Array<{ status: string; stages: unknown[] }> };
    };
    assert.equal(queue.status, 'idle');
    assert.equal(queue.lifecycle.status, 'idle');
    assert.equal(queue.lifecycle.active.length, 0, '终态发布记录不得进入活跃稿件');
    assert.equal(queue.lifecycle.recent[0].status, 'published');
    assert.equal(queue.lifecycle.recent[0].stages.length, 8, '面板 API 返回八阶段投影');
    const lr = (await (await fetch(`${base}/api/analytics/like-rate`, { headers: auth })).json()) as {
      healthy: boolean;
    };
    assert.equal(lr.healthy, true);

    // 未知受保护路由 → 404
    assert.equal((await fetch(`${base}/api/nope`, { headers: auth })).status, 404);
  } finally {
    await h.close();
  }
});

test('HTTP 写路由：审批返 written 非 published；命令返真实结果；鉴权', async () => {
  const h = await startPanelApi(deps, makeConfig());
  assert.equal(h.started, true);
  const base = `http://127.0.0.1:${h.port}`;
  try {
    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 'pw1' }),
    });
    const { token } = (await login.json()) as { token: string };
    const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

    // 审批：返回 written，绝不 published（红线）
    const ap = await fetch(`${base}/api/publish/req-1/approve`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ approved: true }),
    });
    assert.equal(ap.status, 200);
    const apBody = (await ap.json()) as Record<string, unknown>;
    assert.equal(apBody.written, true);
    assert.equal('published' in apBody, false);

    // 审批缺 approved → 400
    const bad = await fetch(`${base}/api/publish/req-1/approve`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({}),
    });
    assert.equal(bad.status, 400);

    // 命令 pause / resume → 真实结果
    const pb = (await (
      await fetch(`${base}/api/accounts/default/command`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ command: 'pause' }),
      })
    ).json()) as { status: string };
    assert.equal(pb.status, 'paused');

    const rb = (await (
      await fetch(`${base}/api/accounts/default/command`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ command: 'resume' }),
      })
    ).json()) as { resumedEdges: number };
    assert.equal(rb.resumedEdges, 2);

    // 未知命令 → 400
    const unk = await fetch(`${base}/api/accounts/default/command`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ command: 'bogus' }),
    });
    assert.equal(unk.status, 400);

    // 写路由无 token → 401
    const noTok = await fetch(`${base}/api/accounts/default/command`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command: 'pause' }),
    });
    assert.equal(noTok.status, 401);
  } finally {
    await h.close();
  }
});

test('HTTP 审批驳回：publish-<id> 首写成功后落库为 needs_review', async () => {
  const rejectedIds: number[] = [];
  const rejectDeps = {
    ...(deps as object),
    publishLogStore: {
      rejectPendingApproval: async (id: number) => {
        rejectedIds.push(id);
        return true;
      },
    },
    writeApprovalSignal: async () => ({ written: true }),
  } as unknown as PanelDeps;
  const h = await startPanelApi(rejectDeps, makeConfig());
  assert.equal(h.started, true);
  const base = `http://127.0.0.1:${h.port}`;
  try {
    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 'pw1' }),
    });
    const { token } = (await login.json()) as { token: string };
    const res = await fetch(`${base}/api/publish/publish-86/approve`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ approved: false, contentVersion: 0 }),
    });
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { written: boolean }).written, true);
    assert.deepEqual(rejectedIds, [86]);
  } finally {
    await h.close();
  }
});

test('HTTP 审批：账号离线时拒绝授权且不写审批信号', async () => {
  const signalWrites: Array<{ requestId: string; approved: boolean }> = [];
  const offlineDeps = {
    ...(deps as object),
    preflightApprovePublish: async () => ({ ok: false as const, reason: 'account_offline' as const, accountId: 'default' }),
    writeApprovalSignal: async (requestId: string, approved: boolean) => {
      signalWrites.push({ requestId, approved });
      return { written: true };
    },
  } as unknown as PanelDeps;
  const h = await startPanelApi(offlineDeps, makeConfig());
  assert.equal(h.started, true);
  const base = `http://127.0.0.1:${h.port}`;
  try {
    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 'pw1' }),
    });
    const { token } = (await login.json()) as { token: string };
    const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

    const ap = await fetch(`${base}/api/publish/publish-42/approve`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ approved: true }),
    });
    assert.equal(ap.status, 409);
    const body = (await ap.json()) as { error: string; reason: string; accountId?: string };
    assert.equal(body.reason, 'account_offline');
    assert.equal(body.accountId, 'default');
    assert.equal(signalWrites.length, 0, '离线时不写 approved=true 信号，审批状态保持待审');
  } finally {
    await h.close();
  }
});

test('HTTP 待审草稿编辑 + 授权写时版本预检（edit-note-draft-before-publish）：CAS 拒因映射 / already_decided / version_stale 不写签名', async () => {
  const signalWrites: Array<{ requestId: string; approved: boolean; payload: Record<string, unknown> }> = [];
  const edits: Array<{ recordId: number; editor: string }> = [];
  const draftDeps = {
    ...(deps as object),
    writeApprovalSignal: async (requestId: string, approved: boolean, payload: Record<string, unknown>) => {
      signalWrites.push({ requestId, approved, payload });
      return { written: true };
    },
    publishDraft: {
      edit: async (recordId: number, expectedVersion: number, patch: { title?: string; content?: string }, editor: string) => {
        edits.push({ recordId, editor });
        if (recordId === 99) return { ok: false, reason: 'not_found' as const };
        if (expectedVersion !== 0) return { ok: false, reason: 'version_conflict' as const };
        return { ok: true as const, contentVersion: expectedVersion + 1, title: patch.title ?? '原', content: patch.content ?? '原', metadata: null };
      },
      liveVersion: async (recordId: number) => (recordId === 7 ? 5 : 0),
      hasDecision: async (recordId: number) => recordId === 8,
    },
  } as unknown as PanelDeps;
  const h = await startPanelApi(draftDeps, makeConfig());
  const base = `http://127.0.0.1:${h.port}`;
  try {
    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 'pw1' }),
    });
    const { token } = (await login.json()) as { token: string };
    const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

    // 编辑成功 → 200 回真态（版本自增）+ editor = JWT sub
    const ok = await fetch(`${base}/api/publish/1/draft`, { method: 'PUT', headers: auth, body: JSON.stringify({ expectedVersion: 0, title: '新标题', content: '新正文' }) });
    assert.equal(ok.status, 200);
    assert.equal(((await ok.json()) as { contentVersion: number }).contentVersion, 1);
    assert.equal(edits[0].editor, 'alice', 'editor 取 JWT 主体');

    // 版本冲突 → 409；not_found → 404；空补丁 → 400；坏版本 → 400
    assert.equal((await fetch(`${base}/api/publish/1/draft`, { method: 'PUT', headers: auth, body: JSON.stringify({ expectedVersion: 9, content: 'x' }) })).status, 409);
    assert.equal((await fetch(`${base}/api/publish/99/draft`, { method: 'PUT', headers: auth, body: JSON.stringify({ expectedVersion: 0, content: 'x' }) })).status, 404);
    assert.equal((await fetch(`${base}/api/publish/1/draft`, { method: 'PUT', headers: auth, body: JSON.stringify({ expectedVersion: 0 }) })).status, 400);
    assert.equal((await fetch(`${base}/api/publish/1/draft`, { method: 'PUT', headers: auth, body: JSON.stringify({ content: 'x' }) })).status, 400);

    // 授权在途 → 409 already_decided
    assert.equal((await fetch(`${base}/api/publish/8/draft`, { method: 'PUT', headers: auth, body: JSON.stringify({ expectedVersion: 0, content: 'x' }) })).status, 409);

    // 授权写时版本预检：record 7 live=5；授权带 v3 不符 → 409 version_stale、绝不写签名
    const stale = await fetch(`${base}/api/publish/publish-7/approve`, { method: 'POST', headers: auth, body: JSON.stringify({ approved: true, contentVersion: 3 }) });
    assert.equal(stale.status, 409);
    assert.equal(((await stale.json()) as { error: string }).error, 'version_stale');
    assert.equal(signalWrites.length, 0, '版本不符绝不写签名');

    // 版本一致(v5) → 写签名，payload 带 contentVersion
    const okAp = await fetch(`${base}/api/publish/publish-7/approve`, { method: 'POST', headers: auth, body: JSON.stringify({ approved: true, contentVersion: 5 }) });
    assert.equal(okAp.status, 200);
    assert.equal(signalWrites.length, 1);
    assert.equal(signalWrites[0].payload.contentVersion, 5, '授权版本随签名 payload 落盘');
  } finally {
    await h.close();
  }
});

test('HTTP 待审草稿编辑：images 补丁透传 store + 响应回带删后 images；防注入映射 400（pending-draft-image-delete）', async () => {
  const patches: Array<Record<string, unknown>> = [];
  const draftDeps = {
    ...(deps as object),
    publishDraft: {
      edit: async (_recordId: number, expectedVersion: number, patch: Record<string, unknown>, _editor: string) => {
        patches.push(patch);
        // 模拟 store 的「只删不注入」：含非法 URL → invalid_field。
        if (patch.images !== undefined && (patch.images as string[]).includes('evil')) {
          return { ok: false, reason: 'invalid_field' as const };
        }
        return {
          ok: true as const,
          contentVersion: expectedVersion + 1,
          title: '原',
          content: '原',
          metadata: null,
          images: (patch.images as string[]) ?? ['a', 'b'],
        };
      },
      liveVersion: async () => 0,
      hasDecision: async () => false,
    },
  } as unknown as PanelDeps;
  const h = await startPanelApi(draftDeps, makeConfig());
  const base = `http://127.0.0.1:${h.port}`;
  try {
    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 'pw1' }),
    });
    const { token } = (await login.json()) as { token: string };
    const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

    // 删一张：images 补丁进 store，响应回带删后 images
    const ok = await fetch(`${base}/api/publish/1/draft`, {
      method: 'PUT',
      headers: auth,
      body: JSON.stringify({ expectedVersion: 0, images: ['a', 'c'] }),
    });
    assert.equal(ok.status, 200);
    assert.deepEqual(((await ok.json()) as { images: string[] }).images, ['a', 'c'], '响应回带删后 images');
    assert.deepEqual(patches[0].images, ['a', 'c'], 'images 补丁透传到 store 单写');

    // 防注入：store 拒 invalid_field → 400
    const bad = await fetch(`${base}/api/publish/1/draft`, {
      method: 'PUT',
      headers: auth,
      body: JSON.stringify({ expectedVersion: 0, images: ['a', 'evil'] }),
    });
    assert.equal(bad.status, 400);
    assert.equal(((await bad.json()) as { error: string }).error, 'invalid_field');
  } finally {
    await h.close();
  }
});

test('HTTP 待审草稿编辑：未注入 publishDraft → 503', async () => {
  const h = await startPanelApi(deps, makeConfig());
  const base = `http://127.0.0.1:${h.port}`;
  try {
    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 'pw1' }),
    });
    const { token } = (await login.json()) as { token: string };
    const r = await fetch(`${base}/api/publish/1/draft`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ expectedVersion: 0, content: 'x' }),
    });
    assert.equal(r.status, 503);
  } finally {
    await h.close();
  }
});

test('HTTP risk 写路由：枚举 kind / override 需 reason / quota / 真态写回（V1 8.4）', async () => {
  const h = await startPanelApi(deps, makeConfig());
  const base = `http://127.0.0.1:${h.port}`;
  try {
    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 'pw1' }),
    });
    const { token } = (await login.json()) as { token: string };
    const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const post = (path: string, body: unknown) =>
      fetch(`${base}${path}`, { method: 'POST', headers: auth, body: JSON.stringify(body) });

    // manual_restrict: normal → restricted, changed
    const r1 = (await (await post('/api/accounts/default/risk/status', { kind: 'manual_restrict' })).json()) as {
      state: { status: string };
      changed: boolean;
    };
    assert.equal(r1.state.status, 'restricted');
    assert.equal(r1.changed, true);

    // manual_freeze → frozen
    const r2 = (await (await post('/api/accounts/default/risk/status', { kind: 'manual_freeze' })).json()) as {
      state: { status: string };
    };
    assert.equal(r2.state.status, 'frozen');

    // override 缺 reason → 400；带 reason → 200
    assert.equal((await post('/api/accounts/default/risk/status', { kind: 'operator_override_recover' })).status, 400);
    assert.equal(
      (await post('/api/accounts/default/risk/status', { kind: 'operator_override_recover', reason: 'manual review' })).status,
      200,
    );

    // 枚举外 kind → 400
    assert.equal((await post('/api/accounts/default/risk/status', { kind: 'light' })).status, 400);

    // quota: aggressive；枚举外 → 400
    const q = (await (await post('/api/accounts/default/risk/quota', { level: 'aggressive' })).json()) as {
      state: { quotaLevel: string };
    };
    assert.equal(q.state.quotaLevel, 'aggressive');
    assert.equal((await post('/api/accounts/default/risk/quota', { level: 'mega' })).status, 400);
  } finally {
    await h.close();
  }
});

test('HTTP dispatch 写路由：start/stop 回报真态 + changed + 真实在线 edge 数（V1 9.4）', async () => {
  const h = await startPanelApi(deps, makeConfig());
  const base = `http://127.0.0.1:${h.port}`;
  try {
    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 'pw1' }),
    });
    const { token } = (await login.json()) as { token: string };
    const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const post = (path: string, body: unknown) =>
      fetch(`${base}${path}`, { method: 'POST', headers: auth, body: JSON.stringify(body) });

    // stop：从 active → stopped, changed=true, 真实在线数
    const s1 = (await (await post('/api/accounts/default/dispatch', { action: 'stop' })).json()) as {
      dispatch: string;
      changed: boolean;
      edgesOnline: number;
    };
    assert.equal(s1.dispatch, 'stopped');
    assert.equal(s1.changed, true);
    assert.equal(s1.edgesOnline, 3);

    // 再 stop：已 stopped, changed=false（诚实：no-op 可辨）
    const s2 = (await (await post('/api/accounts/default/dispatch', { action: 'stop' })).json()) as {
      changed: boolean;
    };
    assert.equal(s2.changed, false);

    // start：回到 started
    const s3 = (await (await post('/api/accounts/default/dispatch', { action: 'start' })).json()) as {
      dispatch: string;
      changed: boolean;
    };
    assert.equal(s3.dispatch, 'started');
    assert.equal(s3.changed, true);

    // 未知 action → 400
    assert.equal((await post('/api/accounts/default/dispatch', { action: 'bogus' })).status, 400);
  } finally {
    await h.close();
  }
});

test('HTTP 精选内容后台管理：未注入 503 / 缺账号=全账号视图 / 读列表+facets / 删与清账号必填 + 账号隔离', async () => {
  // 未注入 curatedContent：精选路由 503，不连累其他接口。
  const noCurated = await startPanelApi(deps, makeConfig());
  try {
    const base = `http://127.0.0.1:${noCurated.port}`;
    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 'pw1' }),
    });
    const { token } = (await login.json()) as { token: string };
    const auth = { authorization: `Bearer ${token}` };
    assert.equal((await fetch(`${base}/api/curated/contents?accountId=acc-1`, { headers: auth })).status, 503);
  } finally {
    await noCurated.close();
  }

  // 注入 curatedContent：完整路径。
  const calls: Array<{ fn: string; args: unknown[] }> = [];
  const curatedMock = {
    listForPanel: async (accountId: string | undefined, opts: unknown) => {
      calls.push({ fn: 'list', args: [accountId, opts] });
      return { items: [{ id: 7, accountId: accountId ?? 'acc-1', contentType: 'image_text', sourceId: 'n-1', title: 'T', body: 'B', author: '甲', sourceUrl: null, topics: [], likeCount: null, collectCount: 5, commentCount: null, countsCapturedAt: null, sourcePublishedAtText: '07-20', sourcePublishedAt: 1_774_118_400_000, sourcePublishedAtPrecision: 'day', sourcePublishedAtStatus: 'parsed', sourcePublishedAtObservedAt: 1_774_174_600_000, botLiked: false, botCollected: true, admitReason: 'collect_floor', firstSeenAt: 1, updatedAt: 2 }], total: 1 };
    },
    facetsForPanel: async (accountId: string | undefined) => {
      calls.push({ fn: 'facets', args: [accountId] });
      return { admitReasons: [{ admitReason: 'collect_floor', count: 1, botActionCount: 0 }], imageTextCount: 1, videoCount: 0, noteCount: 1, commentCount: 0 };
    },
    // 仅本账号本 id 命中删 1，模拟越权（别账号 id）删 0。
    deleteOne: async (accountId: string, id: number) => {
      calls.push({ fn: 'delete', args: [accountId, id] });
      return accountId === 'acc-1' && id === 7 ? 1 : 0;
    },
    clearEmptyBody: async (accountId: string) => {
      calls.push({ fn: 'clear', args: [accountId] });
      return 3;
    },
  };
  const depsWithCurated = { ...(deps as object), curatedContent: curatedMock } as unknown as PanelDeps;
  const h = await startPanelApi(depsWithCurated, makeConfig());
  const base = `http://127.0.0.1:${h.port}`;
  try {
    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 'pw1' }),
    });
    const { token } = (await login.json()) as { token: string };
    const auth = { authorization: `Bearer ${token}` };
    const authJson = { ...auth, 'content-type': 'application/json' };

    // 缺 accountId = 全账号合并视图（200，listForPanel 收 undefined 账号）
    const allAcc = await fetch(`${base}/api/curated/contents`, { headers: auth });
    assert.equal(allAcc.status, 200);
    assert.equal(((await allAcc.json()) as { total: number }).total, 1);
    assert.equal(calls.find((c) => c.fn === 'list')?.args[0], undefined);
    calls.length = 0;

    // 读列表：带类型/原因/分页过滤，回 {items,total}
    const list = (await (
      await fetch(`${base}/api/curated/contents?accountId=acc-1&contentType=image_text&admitReason=collect_floor&limit=20&offset=0`, { headers: auth })
    ).json()) as { items: { id: number; sourcePublishedAtText: string; sourcePublishedAtPrecision: string }[]; total: number };
    assert.equal(list.total, 1);
    assert.equal(list.items[0].id, 7);
    assert.equal(list.items[0].sourcePublishedAtText, '07-20');
    assert.equal(list.items[0].sourcePublishedAtPrecision, 'day');
    const listCall = calls.find((c) => c.fn === 'list');
    assert.deepEqual(listCall?.args[0], 'acc-1');
    assert.deepEqual(listCall?.args[1], { contentType: 'image_text', admitReason: 'collect_floor', limit: 20, offset: 0 });
    calls.length = 0;

    // 旧 contentType=note 兼容为源帖别名，由 store 层解释为 image_text+video。
    await fetch(`${base}/api/curated/contents?accountId=acc-1&contentType=note&limit=20&offset=0`, { headers: auth });
    assert.deepEqual(calls.find((c) => c.fn === 'list')?.args[1], { contentType: 'note', limit: 20, offset: 0 });

    // facets：缺 accountId = 全账号合并统计（200，facetsForPanel 收 undefined 账号）
    const facetsAll = await fetch(`${base}/api/curated/facets`, { headers: auth });
    assert.equal(facetsAll.status, 200);
    assert.equal(calls.find((c) => c.fn === 'facets')?.args[0], undefined);
    const facets = (await (await fetch(`${base}/api/curated/facets?accountId=acc-1`, { headers: auth })).json()) as {
      imageTextCount: number;
      videoCount: number;
      noteCount: number;
    };
    assert.equal(facets.imageTextCount, 1);
    assert.equal(facets.videoCount, 0);
    assert.equal(facets.noteCount, 1);

    // 删单条：本账号本 id → deleted 1
    const del = (await (await fetch(`${base}/api/curated/contents/7?accountId=acc-1`, { method: 'DELETE', headers: auth })).json()) as {
      deleted: number;
    };
    assert.equal(del.deleted, 1);

    // 删单条越权：别账号 id → deleted 0（诚实，不假成功）
    const delCross = (await (await fetch(`${base}/api/curated/contents/999?accountId=acc-1`, { method: 'DELETE', headers: auth })).json()) as {
      deleted: number;
    };
    assert.equal(delCross.deleted, 0);

    // 删单条缺账号 → 400
    assert.equal((await fetch(`${base}/api/curated/contents/7`, { method: 'DELETE', headers: auth })).status, 400);

    // 清空正文壳行：回真实条数 3
    const clr = (await (
      await fetch(`${base}/api/curated/contents/clear-empty`, { method: 'POST', headers: authJson, body: JSON.stringify({ accountId: 'acc-1' }) })
    ).json()) as { deleted: number };
    assert.equal(clr.deleted, 3);

    // 清空缺账号 → 400
    const clrNoAcc = await fetch(`${base}/api/curated/contents/clear-empty`, { method: 'POST', headers: authJson, body: JSON.stringify({}) });
    assert.equal(clrNoAcc.status, 400);
  } finally {
    await h.close();
  }
});

test('HTTP 分组标签写路由：未注入 503 / 成功回真态 / 清空 / 404 / 退役拒 / 坏类型 / 鉴权（editable-account-group-label）', async () => {
  // 未注入 accountAttr → 503（不连累其他接口）
  const noAttr = await startPanelApi(deps, makeConfig());
  try {
    const base = `http://127.0.0.1:${noAttr.port}`;
    const token = await loginToken(base);
    const r = await fetch(`${base}/api/accounts/acc-1/group-label`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ groupLabel: '矩阵A' }),
    });
    assert.equal(r.status, 503);
  } finally {
    await noAttr.close();
  }

  // 注入 accountAttr（内存 map 模拟已存在账号 acc-1）：契约同 PgAccountStore.setGroupLabel
  const rows = new Map<string, string | null>([['acc-1', null]]);
  const accountAttr = {
    setGroupLabel: async (accountId: string, label: string | null) => {
      if (accountId === 'default') return { ok: false as const, reason: 'retired_account' as const };
      if (!rows.has(accountId)) return { ok: false as const, reason: 'account_not_found' as const };
      const clean = (label ?? '').trim();
      const value = clean === '' ? null : clean;
      rows.set(accountId, value);
      return { ok: true as const, groupLabel: value };
    },
  };
  const depsAttr = { ...(deps as object), accountAttr } as unknown as PanelDeps;
  const h = await startPanelApi(depsAttr, makeConfig());
  const base = `http://127.0.0.1:${h.port}`;
  try {
    const token = await loginToken(base);
    const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const put = (id: string, body: unknown) =>
      fetch(`${base}/api/accounts/${id}/group-label`, { method: 'PUT', headers: auth, body: JSON.stringify(body) });

    // 成功：回写后真态
    const ok = (await (await put('acc-1', { groupLabel: '  矩阵A  ' })).json()) as { accountId: string; groupLabel: string | null };
    assert.equal(ok.accountId, 'acc-1');
    assert.equal(ok.groupLabel, '矩阵A');

    // 清空：空串 → NULL（分组清除）
    const cleared = (await (await put('acc-1', { groupLabel: '' })).json()) as { groupLabel: string | null };
    assert.equal(cleared.groupLabel, null);

    // 不存在账号 → 404 可区分
    assert.equal((await put('ghost', { groupLabel: '矩阵B' })).status, 404);

    // 退役保留账号 → 400（reason retired_account），绝不静默成功
    const retired = await put('default', { groupLabel: '矩阵C' });
    assert.equal(retired.status, 400);
    assert.equal(((await retired.json()) as { reason: string }).reason, 'retired_account');

    // 坏类型（groupLabel 非 string/null）→ 400（路由层拒，不触及 store）
    assert.equal((await put('acc-1', { groupLabel: 123 })).status, 400);

    // 无 token → 401
    const noTok = await fetch(`${base}/api/accounts/acc-1/group-label`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ groupLabel: '矩阵A' }),
    });
    assert.equal(noTok.status, 401);
  } finally {
    await h.close();
  }
});

test('HTTP 联系方式写路由：未注入 503 / verbatim 回真态 / 清空 / 404 / 退役拒 / 坏类型 / 鉴权（account-group-chat-injection → generalize-contact-info）', async () => {
  // 未注入 accountAttr（无 setContactInfo）→ 503
  const noAttr = await startPanelApi(deps, makeConfig());
  try {
    const base = `http://127.0.0.1:${noAttr.port}`;
    const token = await loginToken(base);
    const r = await fetch(`${base}/api/accounts/acc-1/contact-info`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ contactInfo: '加群码' }),
    });
    assert.equal(r.status, 503);
  } finally {
    await noAttr.close();
  }

  // 注入 accountAttr.setContactInfo（内存 map；契约同 PgAccountStore.setContactInfo：verbatim，仅判空清空）
  const rows = new Map<string, string | null>([['acc-1', null]]);
  const accountAttr = {
    setGroupLabel: async () => ({ ok: true as const, groupLabel: null }),
    setContactInfo: async (accountId: string, info: string | null) => {
      if (accountId === 'default') return { ok: false as const, reason: 'retired_account' as const };
      if (!rows.has(accountId)) return { ok: false as const, reason: 'account_not_found' as const };
      const raw = info ?? '';
      const value = raw.trim() === '' ? null : raw; // verbatim：非空原样存
      rows.set(accountId, value);
      return { ok: true as const, contactInfo: value };
    },
  };
  const depsAttr = { ...(deps as object), accountAttr } as unknown as PanelDeps;
  const h = await startPanelApi(depsAttr, makeConfig());
  const base = `http://127.0.0.1:${h.port}`;
  try {
    const token = await loginToken(base);
    const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const put = (id: string, body: unknown) =>
      fetch(`${base}/api/accounts/${id}/contact-info`, { method: 'PUT', headers: auth, body: JSON.stringify(body) });

    // 成功：verbatim 回真态——首尾空白 / emoji / 换行原样保留（不 trim、不截断）
    const raw = '  2【长按复制】加群🐶🍅\n第二行 :/#f  ';
    const ok = (await (await put('acc-1', { contactInfo: raw })).json()) as {
      accountId: string;
      contactInfo: string | null;
    };
    assert.equal(ok.accountId, 'acc-1');
    assert.equal(ok.contactInfo, raw); // 逐字节一致

    // 清空：空串 → NULL
    const cleared = (await (await put('acc-1', { contactInfo: '' })).json()) as { contactInfo: string | null };
    assert.equal(cleared.contactInfo, null);

    // 不存在账号 → 404
    assert.equal((await put('ghost', { contactInfo: '加群码' })).status, 404);

    // 退役保留账号 → 400 reason retired_account
    const retired = await put('default', { contactInfo: '加群码' });
    assert.equal(retired.status, 400);
    assert.equal(((await retired.json()) as { reason: string }).reason, 'retired_account');

    // 坏类型 → 400（路由层拒，不触及 store）
    const bad = await put('acc-1', { contactInfo: 123 });
    assert.equal(bad.status, 400);
    assert.equal(((await bad.json()) as { reason: string }).reason, 'invalid_contact_info');

    // 无 token → 401
    const noTok = await fetch(`${base}/api/accounts/acc-1/contact-info`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ contactInfo: '加群码' }),
    });
    assert.equal(noTok.status, 401);

    // 过渡期回退：旧路径 /group-chat-info + 旧 DTO 字段 groupChatInfo 仍受理，回真态含 contactInfo（滚动升级不断线）
    const legacy = (await (
      await fetch(`${base}/api/accounts/acc-1/group-chat-info`, {
        method: 'PUT',
        headers: auth,
        body: JSON.stringify({ groupChatInfo: 'legacy-value' }),
      })
    ).json()) as { accountId: string; contactInfo: string | null };
    assert.equal(legacy.accountId, 'acc-1');
    assert.equal(legacy.contactInfo, 'legacy-value');
  } finally {
    await h.close();
  }
});

async function loginToken(base: string): Promise<string> {
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'alice', password: 'pw1' }),
  });
  return ((await login.json()) as { token: string }).token;
}

test('HTTP Facebook 发帖素材池：未注入 503 / 批量上传解析 / 排序与状态写路由', async () => {
  const noMedia = await startPanelApi(deps, makeConfig());
  try {
    const base = `http://127.0.0.1:${noMedia.port}`;
    const auth = { authorization: `Bearer ${await loginToken(base)}` };
    const r = await fetch(`${base}/api/accounts/fb-1/facebook-publish-media`, { headers: auth });
    assert.equal(r.status, 503);
    assert.equal(((await r.json()) as { error: string }).error, 'facebook_publish_media_unavailable');
  } finally {
    await noMedia.close();
  }

  const calls: Array<{ fn: string; accountId: string; payload?: unknown }> = [];
  const mediaView = () => ({
    accountId: 'fb-1',
    statusCounts: { available: 1, reserved: 0, used: 0, disabled: 0, deleted: 0, quarantine: 0 },
    sets: [
      {
        id: 10,
        accountId: 'fb-1',
        status: 'available',
        captionHint: null,
        sortOrder: 1,
        reservedBy: null,
        reservedAt: null,
        usedByPublishLogId: null,
        lastError: null,
        createdAt: '2026-07-12T00:00:00.000Z',
        updatedAt: '2026-07-12T00:00:00.000Z',
        images: [
          {
            id: 100,
            setId: 10,
            url: 'https://example.com/fb-1/one.png',
            objectKey: 'facebook-publish-media/fb-1/one.png',
            filename: 'one.png',
            contentType: 'image/png',
            byteSize: 4,
            sha256: 'hash',
            sortOrder: 1,
            duplicateOfImageId: null,
            createdAt: '2026-07-12T00:00:00.000Z',
          },
        ],
      },
    ],
  });
  const facebookPublishMedia = {
    list: async (accountId: string) => {
      calls.push({ fn: 'list', accountId });
      return mediaView();
    },
    upload: async (accountId: string, files: Array<{ filename: string; contentType?: string | null; bytes: Buffer }>) => {
      calls.push({
        fn: 'upload',
        accountId,
        payload: files.map((file) => ({ filename: file.filename, contentType: file.contentType, bytes: [...file.bytes] })),
      });
      return {
        results: files.map((file) => ({ ok: true as const, filename: file.filename, duplicate: false, set: mediaView().sets[0] })),
        view: mediaView(),
      };
    },
    reorder: async (accountId: string, orderedSetIds: number[]) => {
      calls.push({ fn: 'reorder', accountId, payload: orderedSetIds });
      return mediaView();
    },
    updateSet: async (accountId: string, setId: number, patch: unknown) => {
      calls.push({ fn: 'updateSet', accountId, payload: { setId, patch } });
      return { ...mediaView().sets[0], id: setId };
    },
    deleteSet: async (accountId: string, setId: number) => {
      calls.push({ fn: 'deleteSet', accountId, payload: { setId } });
      return { ...mediaView().sets[0], id: setId, status: 'deleted' };
    },
  };
  const h = await startPanelApi({ ...(deps as object), facebookPublishMedia } as unknown as PanelDeps, makeConfig());
  try {
    const base = `http://127.0.0.1:${h.port}`;
    const token = await loginToken(base);
    const auth = { authorization: `Bearer ${token}` };
    const authJson = { ...auth, 'content-type': 'application/json' };

    const list = await fetch(`${base}/api/accounts/fb-1/facebook-publish-media`, { headers: auth });
    assert.equal(list.status, 200);
    assert.equal(((await list.json()) as { sets: unknown[] }).sets.length, 1);

    const upload = await fetch(`${base}/api/accounts/fb-1/facebook-publish-media/upload`, {
      method: 'POST',
      headers: authJson,
      body: JSON.stringify({
        files: [
          {
            filename: 'one.png',
            contentType: 'image/png',
            dataBase64: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'),
          },
          {
            filename: 'two.jpg',
            contentType: 'image/jpeg',
            dataBase64: `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff]).toString('base64')}`,
          },
        ],
      }),
    });
    assert.equal(upload.status, 200);
    assert.deepEqual(calls.find((call) => call.fn === 'upload'), {
      fn: 'upload',
      accountId: 'fb-1',
      payload: [
        { filename: 'one.png', contentType: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47] },
        { filename: 'two.jpg', contentType: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
      ],
    });

    const badUpload = await fetch(`${base}/api/accounts/fb-1/facebook-publish-media/upload`, {
      method: 'POST',
      headers: authJson,
      body: JSON.stringify({ files: [] }),
    });
    assert.equal(badUpload.status, 400);
    assert.equal(((await badUpload.json()) as { reason: string }).reason, 'no_files');

    assert.equal(
      (await fetch(`${base}/api/accounts/fb-1/facebook-publish-media/reorder`, {
        method: 'PUT',
        headers: authJson,
        body: JSON.stringify({ orderedSetIds: [10] }),
      })).status,
      200,
    );
    assert.equal(
      (await fetch(`${base}/api/accounts/fb-1/facebook-publish-media/sets/10`, {
        method: 'PATCH',
        headers: authJson,
        body: JSON.stringify({ status: 'disabled' }),
      })).status,
      200,
    );
    assert.equal(
      (await fetch(`${base}/api/accounts/fb-1/facebook-publish-media/sets/10`, {
        method: 'DELETE',
        headers: auth,
      })).status,
      200,
    );
  } finally {
    await h.close();
  }
});

test('HTTP Facebook 发帖素材池：素材依赖拒绝时响应带 reason', async () => {
  const facebookPublishMedia = {
    list: async () => {
      throw new FacebookPublishMediaError('non_facebook_account');
    },
    upload: async () => ({ results: [], view: { accountId: 'fb-1', sets: [], statusCounts: {} } }),
    reorder: async () => ({ accountId: 'fb-1', sets: [], statusCounts: {} }),
    updateSet: async () => null,
    deleteSet: async () => null,
  };
  const h = await startPanelApi({ ...(deps as object), facebookPublishMedia } as unknown as PanelDeps, makeConfig());
  try {
    const base = `http://127.0.0.1:${h.port}`;
    const auth = { authorization: `Bearer ${await loginToken(base)}` };
    const r = await fetch(`${base}/api/accounts/default/facebook-publish-media`, { headers: auth });
    assert.equal(r.status, 409);
    assert.deepEqual(await r.json(), { error: 'non_facebook_account', reason: 'non_facebook_account' });
  } finally {
    await h.close();
  }
});

type SummaryByAccount = {
  totalsByAccount: { accountId: string; totals: Record<string, number>; quotas?: Record<string, number>; saturated?: string[] }[];
};

test('summary 按账号带 day 上限 + 饱和标记（change decouple-quota-hit-from-risk）', async () => {
  const h = await startPanelApi(deps, makeConfig());
  const base = `http://127.0.0.1:${h.port}`;
  try {
    const auth = { authorization: `Bearer ${await loginToken(base)}` };
    const sum = (await (await fetch(`${base}/api/dashboard/summary`, { headers: auth })).json()) as SummaryByAccount;
    const entry = sum.totalsByAccount[0];
    // 默认 controller = normal 档 → effectiveQuotas().day 为 normal 每日配额
    assert.equal(entry.quotas?.like, 50);
    assert.equal(entry.quotas?.search, 10);
    assert.equal(entry.quotas?.view, 150);
    assert.equal(entry.quotas?.publish, 1);
    // 用量 publish=1 >= cap 1 → 饱和标红；like=10 < 50 → 不饱和
    assert.ok(entry.saturated?.includes('publish'), 'publish 撞当日上限应标饱和');
    assert.ok(!entry.saturated?.includes('like'), 'like 未到上限不应标饱和');
    assert.ok(!entry.saturated?.includes('search'), 'search 用量 2 未到上限 10 不应标饱和');
  } finally {
    await h.close();
  }
});

test('summary 上限随风控态收敛：restricted 账号互动上限为 0，且组合只读不改风控态', async () => {
  const restricted = new RiskController({ accountId: 'r' });
  await restricted.applySignal({ kind: 'confirmed' }); // normal → restricted（平台硬信号）
  assert.equal(restricted.getState().status, 'restricted');
  const depsR = { ...(deps as object), riskRegistry: { getController: async () => restricted } } as unknown as PanelDeps;
  const h = await startPanelApi(depsR, makeConfig());
  const base = `http://127.0.0.1:${h.port}`;
  try {
    const auth = { authorization: `Bearer ${await loginToken(base)}` };
    const sum = (await (await fetch(`${base}/api/dashboard/summary`, { headers: auth })).json()) as SummaryByAccount;
    const entry = sum.totalsByAccount[0];
    assert.equal(entry.quotas?.like, 0, 'restricted 互动上限如实为 0');
    assert.ok((entry.quotas?.view ?? 0) > 0, 'restricted 浏览仍有额度');
    // 只读：拉 summary 绝不改风控态
    assert.equal(restricted.getState().status, 'restricted', '组合只读、不触发状态迁移');
  } finally {
    await h.close();
  }
});

// AC-ALERT-2 + AC-ALERT-3（change alert-resolution-by-id）：
// 告警手动解决路由契约（401/400/503/200 诚实透传）+ 红线隔离（只经 alertStore，绝不触风控单写）。
test('HTTP 告警手动解决：401/400/503/200 诚实 + 只经 alertStore、不触风控', async () => {
  // 无 token → 401（JWT 中间件，先于路由）
  const noAuthH = await startPanelApi(deps, makeConfig());
  try {
    const base = `http://127.0.0.1:${noAuthH.port}`;
    assert.equal((await fetch(`${base}/api/alerts/1/resolve`, { method: 'POST' })).status, 401);
  } finally {
    await noAuthH.close();
  }

  // 未注入 alertStore（base deps 无）→ 有效 id 也 503（面板故障不连累闭环的既有降级）
  const noStoreH = await startPanelApi(deps, makeConfig());
  try {
    const base = `http://127.0.0.1:${noStoreH.port}`;
    const auth = { authorization: `Bearer ${await loginToken(base)}` };
    const r503 = await fetch(`${base}/api/alerts/9/resolve`, { method: 'POST', headers: auth });
    assert.equal(r503.status, 503);
    assert.equal(((await r503.json()) as { error: string }).error, 'alerts_unavailable');
  } finally {
    await noStoreH.close();
  }

  // 注入 fake alertStore + spy riskRegistry（断言解决绝不触风控单写）
  const resolveCalls: number[] = [];
  let riskTouched = false;
  const alertStore = {
    resolveById: async (id: number) => {
      resolveCalls.push(id);
      return id === 42 ? 1 : 0; // 42=未解决→1；其它=不存在/已解决→0
    },
  };
  const depsAlert = {
    ...(deps as object),
    alertStore,
    riskRegistry: {
      getController: async (id: string) => {
        riskTouched = true;
        return new RiskController({ accountId: id });
      },
    },
  } as unknown as PanelDeps;
  const h = await startPanelApi(depsAlert, makeConfig());
  try {
    const base = `http://127.0.0.1:${h.port}`;
    const auth = { authorization: `Bearer ${await loginToken(base)}` };

    // 非整数 id → 400 invalid_id（请求形状先于存储可用性；不调存储）
    const bad = await fetch(`${base}/api/alerts/abc/resolve`, { method: 'POST', headers: auth });
    assert.equal(bad.status, 400);
    assert.equal(((await bad.json()) as { reason: string }).reason, 'invalid_id');
    // ≤0 id → 400
    assert.equal((await fetch(`${base}/api/alerts/0/resolve`, { method: 'POST', headers: auth })).status, 400);

    // 解决未解决告警 → 200 {resolved:1}
    const ok = await fetch(`${base}/api/alerts/42/resolve`, { method: 'POST', headers: auth });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { resolved: 1 });

    // 解决不存在/已解决 → 200 {resolved:0}（诚实透传，非假成功）
    const gone = await fetch(`${base}/api/alerts/7/resolve`, { method: 'POST', headers: auth });
    assert.equal(gone.status, 200);
    assert.deepEqual(await gone.json(), { resolved: 0 });

    // 红线：解决只经 alertStore.resolveById，绝不触风控 controller（不 applySignal/setQuotaLevel/写 risk_state）。
    // 面板 edgeServer dep 结构上无 resume 能力，故亦无从 resumeEdge。
    assert.deepEqual(resolveCalls, [42, 7]);
    assert.equal(riskTouched, false, '手动解决绝不触风控 controller');
  } finally {
    await h.close();
  }
});

test('HTTP 存在性校验 + requestId 白名单：幽灵账号 404、路径穿越 requestId 400（console-cloud-panel-hardening #28/#29）', async () => {
  const h = await startPanelApi(deps, makeConfig());
  assert.equal(h.started, true);
  const base = `http://127.0.0.1:${h.port}`;
  try {
    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 'pw1' }),
    });
    const { token } = (await login.json()) as { token: string };
    const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

    // #28：对不存在账号 'ghost' 的 pause/resume/风控写 → 404 account_not_found。
    // 反例保证：mock commandActions.pause/riskRegistry.getController 对任意 id 都成功，若未前置校验会误返 200。
    const pauseGhost = await fetch(`${base}/api/accounts/ghost/command`, {
      method: 'POST', headers: auth, body: JSON.stringify({ command: 'pause' }),
    });
    assert.equal(pauseGhost.status, 404);
    assert.equal(((await pauseGhost.json()) as { error: string }).error, 'account_not_found');

    assert.equal(
      (await fetch(`${base}/api/accounts/ghost/command`, {
        method: 'POST', headers: auth, body: JSON.stringify({ command: 'resume' }),
      })).status,
      404,
    );
    assert.equal(
      (await fetch(`${base}/api/accounts/ghost/risk/status`, {
        method: 'POST', headers: auth, body: JSON.stringify({ kind: 'manual_restrict' }),
      })).status,
      404,
    );
    assert.equal(
      (await fetch(`${base}/api/accounts/ghost/risk/quota`, {
        method: 'POST', headers: auth, body: JSON.stringify({ level: 'conservative' }),
      })).status,
      404,
    );

    // 存在的账号 'default' 仍正常（回归保证：校验不误伤合法账号）。
    assert.equal(
      (await fetch(`${base}/api/accounts/default/command`, {
        method: 'POST', headers: auth, body: JSON.stringify({ command: 'pause' }),
      })).status,
      200,
    );

    // #29：审批 requestId 含路径穿越（decode 后为 ../../tmp/pwn）→ 400 invalid_request_id，不进任何文件写。
    const traversal = await fetch(`${base}/api/publish/%2e%2e%2f%2e%2e%2ftmp%2fpwn/approve`, {
      method: 'POST', headers: auth, body: JSON.stringify({ approved: true }),
    });
    assert.equal(traversal.status, 400);
    assert.equal(((await traversal.json()) as { reason?: string }).reason, 'invalid_request_id');

    // 合法 publish-<n> requestId 仍放行（回归保证）。
    assert.equal(
      (await fetch(`${base}/api/publish/publish-42/approve`, {
        method: 'POST', headers: auth, body: JSON.stringify({ approved: true }),
      })).status,
      200,
    );
  } finally {
    await h.close();
  }
});

test('HTTP auth 续签 + 登出撤销（console-cloud-panel-hardening #24/#26）', async () => {
  const revocation = new TokenRevocationStore();
  const h = await startPanelApi({ ...deps, revocation } as unknown as PanelDeps, makeConfig());
  assert.equal(h.started, true);
  const base = `http://127.0.0.1:${h.port}`;
  try {
    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 'pw1' }),
    });
    const { token } = (await login.json()) as { token: string };
    const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

    // #24 续签：换发一枚不同的新 token，且新 token 可用（活跃不被踢）
    const ref = await fetch(`${base}/api/auth/refresh`, { method: 'POST', headers: auth });
    assert.equal(ref.status, 200);
    const { token: fresh } = (await ref.json()) as { token: string };
    assert.notEqual(fresh, token);
    assert.equal(
      (await fetch(`${base}/api/me`, { headers: { authorization: `Bearer ${fresh}` } })).status,
      200,
    );

    // #26 登出：拉黑当前 token 的 jti → 该 token 立即失效（401 revoked），不再等自然过期
    assert.equal((await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: auth })).status, 200);
    const after = await fetch(`${base}/api/me`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(after.status, 401);
    assert.equal(((await after.json()) as { reason?: string }).reason, 'revoked');
  } finally {
    await h.close();
  }
});

test('HTTP Facebook group metadata filters, facets, and import validation', async () => {
  let listOptions: unknown = null;
  let importedInputs: unknown = null;
  let scopeWrite: unknown = null;
  const groupDeps = {
    ...deps,
    facebookGroupTargets: {
      listTargets: async (options: unknown) => {
        listOptions = options;
        return {
          total: 1,
          items: [
            {
              groupUrl: 'https://www.facebook.com/groups/group-a',
              groupName: 'Group A',
              region: '河南区域',
              park: '同文1工业区',
              direction: '机械和电气',
              joinGating: 'unknown',
              priority: 0,
              enabled: true,
              importBatch: 'batch-1',
              createdAt: '2026-07-09T00:00:00.000Z',
              updatedAt: '2026-07-09T00:00:00.000Z',
              accountGroupLabels: ['华东组', '招聘组'],
              accountId: null,
              membershipStatus: null,
              joinedAt: null,
              lastAttemptAt: null,
              lastReason: null,
              lastCommentedAt: null,
              commentsTotal: 0,
            },
          ],
        };
      },
      listFacets: async () => ({
        regions: [{ region: '河南区域', parks: ['同文1工业区'] }],
        directions: ['机械和电气'],
        accountGroupLabels: ['华东组', '招聘组'],
        unscopedTargetCount: 2,
      }),
      importTargets: async (inputs: unknown, importBatch: string | null, options: unknown) => {
        importedInputs = { inputs, importBatch, options };
        return { imported: 1, updated: 0, duplicate: 0, invalid: 0, rows: [] };
      },
      replaceTargetScopes: async (groupUrls: string[], accountGroupLabels: string[], updatedBy: string) => {
        scopeWrite = { groupUrls, accountGroupLabels, updatedBy };
        return {
          ok: true as const,
          items: groupUrls.map((groupUrl) => ({
            groupUrl,
            accountGroupLabels,
            updatedAt: '2026-07-22T08:00:00.000Z',
            updatedBy,
          })),
        };
      },
      setEnabled: async () => null,
      accountProgress: async () => [],
      listAssignments: async () => [],
      reclaimStaleAssignments: async () => 0,
    },
  } as unknown as PanelDeps;
  const h = await startPanelApi(groupDeps, makeConfig());
  assert.equal(h.started, true);
  const base = `http://127.0.0.1:${h.port}`;
  try {
    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 'pw1' }),
    });
    const { token } = (await login.json()) as { token: string };
    const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

    const list = await fetch(
      `${base}/api/facebook/groups?enabled=true&status=joined&region=${encodeURIComponent('河南区域')}&park=${encodeURIComponent('同文1工业区')}&direction=${encodeURIComponent('机械和电气')}&accountGroupLabel=${encodeURIComponent('华东组')}`,
      { headers: auth },
    );
    assert.equal(list.status, 200);
    assert.deepEqual(listOptions, {
      limit: 100,
      offset: 0,
      status: 'joined',
      enabled: true,
      region: '河南区域',
      park: '同文1工业区',
      direction: '机械和电气',
      accountGroupLabel: '华东组',
    });

    const facets = await fetch(`${base}/api/facebook/groups/facets`, { headers: auth });
    assert.equal(facets.status, 200);
    assert.deepEqual(await facets.json(), {
      regions: [{ region: '河南区域', parks: ['同文1工业区'] }],
      directions: ['机械和电气'],
      accountGroupLabels: ['华东组', '招聘组'],
      unscopedTargetCount: 2,
    });

    const imported = await fetch(`${base}/api/facebook/groups/import`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        importBatch: 'batch-1',
        accountGroupLabels: ['华东组', '招聘组'],
        items: [
          {
            url: 'https://www.facebook.com/groups/group-a?ref=share',
            region: '河南区域',
            park: '同文1工业区',
            direction: '机械和电气',
          },
        ],
      }),
    });
    assert.equal(imported.status, 200);
    assert.deepEqual(importedInputs, {
      importBatch: 'batch-1',
      inputs: [
        {
          url: 'https://www.facebook.com/groups/group-a?ref=share',
          name: null,
          region: '河南区域',
          park: '同文1工业区',
          direction: '机械和电气',
        },
      ],
      options: { accountGroupLabels: ['华东组', '招聘组'], updatedBy: 'alice' },
    });

    const scoped = await fetch(`${base}/api/facebook/groups/scopes`, {
      method: 'PUT',
      headers: auth,
      body: JSON.stringify({
        groupUrls: ['https://www.facebook.com/groups/group-a'],
        accountGroupLabels: ['华东组', '招聘组'],
      }),
    });
    assert.equal(scoped.status, 200);
    assert.deepEqual(scopeWrite, {
      groupUrls: ['https://www.facebook.com/groups/group-a'],
      accountGroupLabels: ['华东组', '招聘组'],
      updatedBy: 'alice',
    });
    assert.deepEqual(await scoped.json(), {
      items: [{
        groupUrl: 'https://www.facebook.com/groups/group-a',
        accountGroupLabels: ['华东组', '招聘组'],
        updatedAt: '2026-07-22T08:00:00.000Z',
        updatedBy: 'alice',
      }],
    });

    const bad = await fetch(`${base}/api/facebook/groups/import`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ items: [{ url: 'https://www.facebook.com/groups/group-a', region: 123 }] }),
    });
    assert.equal(bad.status, 400);

    const badScopes = await fetch(`${base}/api/facebook/groups/scopes`, {
      method: 'PUT', headers: auth,
      body: JSON.stringify({ groupUrls: [], accountGroupLabels: ['华东组'] }),
    });
    assert.deepEqual(await badScopes.json(), { error: 'bad_request', reason: 'no_targets' });
  } finally {
    await h.close();
  }
});

test('HTTP account automation catalog and Facebook join config endpoint keep the platform-specific contract', async () => {
  const FULL_MASK = '1'.repeat(168);
  const writes: unknown[] = [];
  const joinView = {
    enabled: true,
    dailyCap: 2,
    effectiveDailyCap: 1,
    weekMask: null,
    weekMaskSource: 'content' as const,
    effectiveWeekMask: FULL_MASK,
    accountGroupLabel: '华东组',
    scopedTargetCount: 3,
    scopeReady: true,
    recentResult: {
      outcome: 'joined', reason: null,
      groupUrl: 'https://www.facebook.com/groups/group-a',
      createdAt: '2026-07-22T08:00:00.000Z',
    },
    updatedAt: '2026-07-22T07:00:00.000Z',
    updatedBy: 'alice',
  };
  const h = await startPanelApi({
    ...deps,
    contentSchedule: {
      getGlobalView: () => ({ contentActiveMask: FULL_MASK, overridden: true, updatedAt: null, updatedBy: null }),
      listCatalog: async () => [
        { accountId: 'fb-1', platform: 'facebook', availableActions: [{ action: 'join_group', allowedModes: [], maxDailyCap: 10 }], joinGroupAutomation: joinView },
        { accountId: 'xhs-1', platform: 'xiaohongshu', availableActions: [] },
      ] as never,
      setGlobal: async () => ({ ok: false as const, reason: 'invalid_value' as const }),
      setAccount: async () => ({ ok: false as const, reason: 'invalid_value' as const }),
      setJoinGroupAutomation: async (accountId: string, patch: unknown, updatedBy: string) => {
        writes.push({ accountId, patch, updatedBy });
        if (accountId === 'missing') return { ok: false as const, reason: 'account_not_found' as const };
        if (accountId !== 'fb-1') return { ok: false as const, reason: 'unsupported_automation_action' as const };
        if (Object.keys(patch as object).length === 0) return { ok: false as const, reason: 'no_valid_fields' as const };
        return { ok: true as const, joinGroupAutomation: joinView };
      },
    },
  } as PanelDeps, makeConfig());
  assert.equal(h.started, true);
  const base = `http://127.0.0.1:${h.port}`;
  try {
    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 'pw1' }),
    });
    const { token } = (await login.json()) as { token: string };
    const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

    const catalog = await fetch(`${base}/api/content-schedule`, { headers: auth });
    assert.equal(catalog.status, 200);
    const catalogBody = (await catalog.json()) as { rows: Array<Record<string, unknown>> };
    assert.deepEqual(catalogBody.rows[0].joinGroupAutomation, joinView);
    assert.equal('joinGroupAutomation' in catalogBody.rows[1], false, '非 Facebook 行不投影 join 配置');

    const saved = await fetch(`${base}/api/content-schedule/fb-1/join-group`, {
      method: 'PUT', headers: auth,
      body: JSON.stringify({ enabled: true, dailyCap: 2, weekMask: null }),
    });
    assert.equal(saved.status, 200);
    assert.deepEqual(await saved.json(), { joinGroupAutomation: joinView });
    assert.deepEqual(writes[0], {
      accountId: 'fb-1',
      patch: { enabled: true, dailyCap: 2, weekMask: null },
      updatedBy: 'alice',
    });

    const unsupported = await fetch(`${base}/api/content-schedule/xhs-1/join-group`, {
      method: 'PUT', headers: auth, body: JSON.stringify({ enabled: true }),
    });
    assert.equal(unsupported.status, 400);
    assert.deepEqual(await unsupported.json(), { error: 'bad_request', reason: 'unsupported_automation_action' });

    const missing = await fetch(`${base}/api/content-schedule/missing/join-group`, {
      method: 'PUT', headers: auth, body: JSON.stringify({ enabled: true }),
    });
    assert.equal(missing.status, 404);

    const invalid = await fetch(`${base}/api/content-schedule/fb-1/join-group`, {
      method: 'PUT', headers: auth, body: JSON.stringify({ dailyCap: '2' }),
    });
    assert.equal(invalid.status, 400);
    assert.deepEqual(await invalid.json(), { error: 'bad_request', reason: 'invalid_value' });

    const empty = await fetch(`${base}/api/content-schedule/fb-1/join-group`, {
      method: 'PUT', headers: auth, body: JSON.stringify({}),
    });
    assert.equal(empty.status, 400);
    assert.deepEqual(await empty.json(), { error: 'bad_request', reason: 'no_valid_fields' });
  } finally {
    await h.close();
  }
});

test('HTTP DelegatedTask API: console draft auto-queues (no confirm card), control ops require version, never executes at draft time', async () => {
  const taskStore = new MemoryDelegatedTaskStore();
  const delegatedTasks = new DelegatedTaskService({
    store: taskStore,
    listAccounts: async () => [{ accountId: 'default', nickname: '晚风', platform: 'xiaohongshu' }],
  });
  const h = await startPanelApi({ ...deps, delegatedTasks } as PanelDeps, makeConfig());
  assert.equal(h.started, true);
  const base = `http://127.0.0.1:${h.port}`;
  try {
    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 'pw1' }),
    });
    const { token } = (await login.json()) as { token: string };
    const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const draftResponse = await fetch(`${base}/api/delegated-tasks/draft`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({
        accountId: 'default', action: 'comment_batch', targetSuccessCount: 3, maxAttempts: 5,
        deadlineAt: Date.now() + 86_400_000, executionWindow: { mode: 'immediate' },
        sourceConstraints: {}, targetConstraints: {}, approvalMode: 'review', priority: 'normal', sourceRef: 'panel-test-1',
      }),
    });
    assert.equal(draftResponse.status, 201);
    const draft = (await draftResponse.json()) as { task: { id: string; version: number; status: string; progress: { attemptCount: number } } };
    // console 精确入口直接确认入队（不出确认卡）；入队 ≠ 执行——worker 未跑，attemptCount 仍为 0。
    assert.equal(draft.task.status, 'queued');
    assert.equal(draft.task.progress.attemptCount, 0, '直接入队不得执行任何一次尝试');

    // 控制操作仍需正确 version：陈旧 version 的 cancel → 409。
    const stale = await fetch(`${base}/api/delegated-tasks/${draft.task.id}/cancel`, {
      method: 'POST', headers: auth, body: JSON.stringify({ version: draft.task.version + 1 }),
    });
    assert.equal(stale.status, 409);

    const list = await fetch(`${base}/api/delegated-tasks?accountId=default`, { headers: auth });
    assert.equal(list.status, 200);
    assert.match(JSON.stringify(await list.json()), new RegExp(draft.task.id));

    const createQueued = async (action: 'publish_post' | 'comment_batch', sourceRef: string) => {
      const response = await fetch(`${base}/api/delegated-tasks/draft`, {
        method: 'POST', headers: auth,
        body: JSON.stringify({
          accountId: 'default', action, targetSuccessCount: 1, maxAttempts: 2,
          deadlineAt: Date.now() + 86_400_000, executionWindow: { mode: 'immediate' },
          sourceConstraints: action === 'publish_post' ? { title: '排队发布稿' } : {},
          targetConstraints: {}, approvalMode: 'review', priority: 'normal', sourceRef,
        }),
      });
      assert.equal(response.status, 201);
      return (await response.json()) as { task: { id: string; action: string; status: string } };
    };
    const queuedPublish = await createQueued('publish_post', 'panel-filter-publish');
    await createQueued('comment_batch', 'panel-filter-newer-comment');

    const filtered = await fetch(
      `${base}/api/delegated-tasks?actionFamily=publish&statuses=queued,planning,deferred&limit=1`,
      { headers: auth },
    );
    assert.equal(filtered.status, 200);
    const filteredBody = (await filtered.json()) as { tasks: Array<{ id: string; action: string; status: string }> };
    assert.deepEqual(filteredBody.tasks.map((task) => task.id), [queuedPublish.task.id]);
    assert.equal(filteredBody.tasks[0].action, 'publish_post');
    assert.equal(filteredBody.tasks[0].status, 'queued');

    const invalidFilter = await fetch(`${base}/api/delegated-tasks?actionFamily=publish&statuses=bogus`, { headers: auth });
    assert.equal(invalidFilter.status, 400);
    assert.deepEqual(await invalidFilter.json(), { error: 'bad_request', reason: 'invalid_task_status' });

    const cancelled = await fetch(`${base}/api/delegated-tasks/${draft.task.id}/cancel`, {
      method: 'POST', headers: auth, body: JSON.stringify({ version: draft.task.version }),
    });
    assert.equal(cancelled.status, 200);
    assert.equal(((await cancelled.json()) as { task: { status: string } }).task.status, 'cancelled');
  } finally {
    await h.close();
  }
});
