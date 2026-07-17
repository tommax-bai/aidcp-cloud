import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startClientAuthApi } from '../src/client-auth/client-auth-server.js';
import type { ClientAuthConfig, ClientAuthDeps } from '../src/client-auth/client-auth-server.js';
import type { ClientUserStore, ClientEnvScopeRow, ClientOffboardView } from '../src/client-auth/client-user-store.js';
import { LoginRateLimiter } from '../src/client-auth/rate-limiter.js';
import { TokenRevocationStore } from '../src/panel/revocation.js';
import { verifyJwt } from '../src/panel/jwt.js';
import { MemoryDelegatedTaskStore } from '../src/delegated-task/store.js';
import { DelegatedTaskService } from '../src/delegated-task/service.js';
import type { CuratedPanelRow } from '../src/cache/curated-content-store.js';

const silentLogger = { log() {}, warn() {}, error() {} };
const CLIENT_SECRET = 'client-secret-xyz';
const PANEL_SECRET = 'panel-secret-abc';

/** 内存假 store，仅实现 client-auth-server 用到的方法。 */
function makeFakeStore(): {
  store: ClientUserStore;
  users: Map<string, { userId: string; key: string; status: 'enabled' | 'disabled' }>;
  scope: Map<string, ClientEnvScopeRow[]>;
  offboards: Map<string, ClientOffboardView>;
  registered: Set<string>;
} {
  const users = new Map<string, { userId: string; key: string; status: 'enabled' | 'disabled' }>();
  const scope = new Map<string, ClientEnvScopeRow[]>();
  const offboards = new Map<string, ClientOffboardView>();
  const registered = new Set<string>();
  const intents = new Map<string, { userId: string; proof: string; expiresAt: number; envKey?: string }>();
  let nextIntent = 1;
  const fake = {
    async verifyLogin(name: string, key: string) {
      const u = users.get(name.trim());
      if (!u || u.status !== 'enabled' || u.key !== key) return { ok: false as const };
      return { ok: true as const, userId: u.userId };
    },
    async isEnabled(userId: string) {
      for (const u of users.values()) if (u.userId === userId) return u.status === 'enabled';
      return false;
    },
    async listEnvScope(userId: string) {
      return scope.get(userId) ?? [];
    },
    async createProvisioningIntent(userId: string) {
      const enabled = [...users.values()].some((user) => user.userId === userId && user.status === 'enabled');
      if (!enabled) return { ok: false as const, reason: 'disabled' as const };
      const intentId = `intent-${nextIntent++}`;
      const proof = `proof-${intentId}`;
      const expiresAt = Date.now() + 600_000;
      intents.set(intentId, { userId, proof, expiresAt });
      return { ok: true as const, intentId, proof, expiresAt };
    },
    async completeProvisioningIntent(userId: string, input: {
      intentId: string; proof: string; envKey: string; label?: string | null; platform?: string | null;
    }) {
      const intent = intents.get(input.intentId);
      if (!intent || intent.userId !== userId || intent.proof !== input.proof) {
        return { ok: false as const, reason: 'invalid_intent' as const };
      }
      if (intent.envKey && intent.envKey !== input.envKey) {
        return { ok: false as const, reason: 'intent_target_mismatch' as const };
      }
      if (intent.envKey === input.envKey) {
        const environment = (scope.get(userId) ?? []).find((item) => item.envKey === input.envKey)!;
        return { ok: true as const, environment, idempotent: true };
      }
      if (registered.has(input.envKey) || [...scope.values()].some((items) => items.some((item) => item.envKey === input.envKey))) {
        return { ok: false as const, reason: 'environment_already_registered' as const };
      }
      registered.add(input.envKey);
      intent.envKey = input.envKey;
      const environment: ClientEnvScopeRow = { envKey: input.envKey, label: input.label ?? null,
        platform: input.platform ?? null, source: 'admin', assignedAt: Date.now() };
      scope.set(userId, [...(scope.get(userId) ?? []), environment]);
      return { ok: true as const, environment, idempotent: false };
    },
    async beginEnvironmentOffboard(userId: string, envKey: string) {
      const owned = (scope.get(userId) ?? []).find((item) => item.envKey === envKey);
      if (!owned) return { ok: false as const, reason: 'not_authorized' as const };
      const offboard: ClientOffboardView = { offboardId: `offboard-${envKey}`, envKey,
        accountId: `account-${envKey}`, state: 'pending_edge', reason: 'environment_unbind',
        requestedAt: 10, purgeDueAt: 20 };
      scope.set(userId, (scope.get(userId) ?? []).filter((item) => item.envKey !== envKey));
      offboards.set(`${userId}:${offboard.offboardId}`, offboard);
      return { ok: true as const, offboard };
    },
    async getOffboard(userId: string, offboardId: string) {
      return offboards.get(`${userId}:${offboardId}`) ?? null;
    },
  };
  return { store: fake as unknown as ClientUserStore, users, scope, offboards, registered };
}

function baseConfig(port: number, overrides: Partial<ClientAuthConfig> = {}): ClientAuthConfig {
  return {
    port,
    jwtSecret: CLIENT_SECRET,
    panelJwtSecret: PANEL_SECRET,
    jwtTtlSeconds: 900,
    forbiddenPorts: [],
    logger: silentLogger,
    ...overrides,
  };
}

async function withServer(
  deps: ClientAuthDeps,
  config: ClientAuthConfig,
  fn: (base: string) => Promise<void>,
): Promise<void> {
  const h = await startClientAuthApi(deps, config);
  assert.equal(h.started, true, `server should start: ${h.reason ?? ''}`);
  try {
    await fn(`http://127.0.0.1:${h.port}`);
  } finally {
    await h.close();
  }
}

test('N1: 客户密钥与面板相同则拒启(secret_collision)', async () => {
  const { store } = makeFakeStore();
  const h = await startClientAuthApi(
    { store, revocation: new TokenRevocationStore(), rateLimiter: new LoginRateLimiter() },
    baseConfig(0, { jwtSecret: PANEL_SECRET }), // 故意与面板相同
  );
  assert.equal(h.started, false);
  assert.equal(h.reason, 'secret_collision');
});

test('登录成功签发客户令牌;该令牌无法用面板密钥验签(N1 隔离)', async () => {
  const fx = makeFakeStore();
  fx.users.set('acme', { userId: 'u1', key: 'ck_secret', status: 'enabled' });
  await withServer(
    { store: fx.store, revocation: new TokenRevocationStore(), rateLimiter: new LoginRateLimiter() },
    baseConfig(0),
    async (base) => {
      const r = await fetch(`${base}/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'acme', key: 'ck_secret' }),
      });
      assert.equal(r.status, 200);
      const { token } = (await r.json()) as { token: string };
      assert.ok(token);
      // 客户令牌用客户密钥能验签
      assert.equal(verifyJwt(token, CLIENT_SECRET).valid, true);
      // 但用面板密钥验签必然失败 —— 密钥即边界
      const asPanel = verifyJwt(token, PANEL_SECRET);
      assert.equal(asPanel.valid, false);
    },
  );
});

test('错误凭据统一 401 invalid_credentials(不可区分)', async () => {
  const fx = makeFakeStore();
  fx.users.set('acme', { userId: 'u1', key: 'ck_secret', status: 'enabled' });
  await withServer(
    { store: fx.store, revocation: new TokenRevocationStore(), rateLimiter: new LoginRateLimiter() },
    baseConfig(0),
    async (base) => {
      const wrongKey = await fetch(`${base}/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'acme', key: 'ck_wrong' }),
      });
      assert.equal(wrongKey.status, 401);
      const noUser = await fetch(`${base}/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'ghost', key: 'ck_whatever' }),
      });
      assert.equal(noUser.status, 401);
      assert.deepEqual(await wrongKey.json(), await noUser.json()); // 同 body,不可区分
    },
  );
});

test('/my-environments 只返回本客户归属(N2 权威过滤)', async () => {
  const fx = makeFakeStore();
  fx.users.set('acme', { userId: 'u1', key: 'ck_secret', status: 'enabled' });
  fx.scope.set('u1', [{ envKey: 'p1', label: '甜辣阿May', platform: 'xiaohongshu', source: 'admin', assignedAt: 0 }]);
  await withServer(
    { store: fx.store, revocation: new TokenRevocationStore(), rateLimiter: new LoginRateLimiter() },
    baseConfig(0),
    async (base) => {
      const login = await (
        await fetch(`${base}/login`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'acme', key: 'ck_secret' }),
        })
      ).json();
      const token = (login as { token: string }).token;
      const r = await fetch(`${base}/my-environments`, { headers: { authorization: `Bearer ${token}` } });
      assert.equal(r.status, 200);
      const { environments } = (await r.json()) as { environments: { envKey: string }[] };
      assert.deepEqual(environments.map((e) => e.envKey), ['p1']);
      // 无令牌 → 401
      const anon = await fetch(`${base}/my-environments`);
      assert.equal(anon.status, 401);
    },
  );
});

test('官方新建 intent 可原子完成当前客户归属，重试幂等且旧 attach 仍拒绝', async () => {
  const fx = makeFakeStore();
  fx.users.set('alice', { userId: 'user-a', key: 'ck_alice', status: 'enabled' });
  await withServer(
    { store: fx.store, revocation: new TokenRevocationStore(), rateLimiter: new LoginRateLimiter() },
    baseConfig(0),
    async (base) => {
      const login = await (await fetch(`${base}/login`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'alice', key: 'ck_alice' }) })).json() as { token: string };
      const headers = { authorization: `Bearer ${login.token}`, 'content-type': 'application/json' };
      const issued = await fetch(`${base}/environment-provisioning/intents`, {
        method: 'POST', headers, body: '{}',
      });
      assert.equal(issued.status, 201);
      const intent = (await issued.json()) as { data: { intentId: string; proof: string } };
      const completionBody = JSON.stringify({ intentId: intent.data.intentId, proof: intent.data.proof,
        envKey: 'fresh-env-1', label: '新环境', platform: 'facebook' });
      const completed = await fetch(`${base}/environment-provisioning/complete`, {
        method: 'POST', headers, body: completionBody,
      });
      assert.equal(completed.status, 201);
      assert.equal(((await completed.json()) as { data: { idempotent: boolean } }).data.idempotent, false);
      assert.deepEqual((fx.scope.get('user-a') ?? []).map((item) => item.envKey), ['fresh-env-1']);

      const retried = await fetch(`${base}/environment-provisioning/complete`, {
        method: 'POST', headers, body: completionBody,
      });
      assert.equal(retried.status, 200);
      assert.equal(((await retried.json()) as { data: { idempotent: boolean } }).data.idempotent, true);
      assert.equal((fx.scope.get('user-a') ?? []).length, 1);

      const attach = await fetch(`${base}/environments`, {
        method: 'POST', headers, body: JSON.stringify({ envKey: 'arbitrary-existing-env' }),
      });
      assert.equal(attach.status, 403);
      assert.deepEqual(await attach.json(), { error: 'forbidden', reason: 'environment_assignment_admin_only' });
    },
  );
});

test('创建完成不能认领已登记环境，也不能把同一 intent 换到第二个 envKey', async () => {
  const fx = makeFakeStore();
  fx.users.set('alice', { userId: 'user-a', key: 'ck_alice', status: 'enabled' });
  fx.registered.add('existing-env');
  await withServer(
    { store: fx.store, revocation: new TokenRevocationStore(), rateLimiter: new LoginRateLimiter() },
    baseConfig(0),
    async (base) => {
      const login = await (await fetch(`${base}/login`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'alice', key: 'ck_alice' }) })).json() as { token: string };
      const headers = { authorization: `Bearer ${login.token}`, 'content-type': 'application/json' };
      const intent = (await (await fetch(`${base}/environment-provisioning/intents`, {
        method: 'POST', headers, body: '{}',
      })).json()) as { data: { intentId: string; proof: string } };
      const existing = await fetch(`${base}/environment-provisioning/complete`, { method: 'POST', headers,
        body: JSON.stringify({ intentId: intent.data.intentId, proof: intent.data.proof,
          envKey: 'existing-env', label: '', platform: 'xiaohongshu' }) });
      assert.equal(existing.status, 409);
      assert.equal(((await existing.json()) as { error: string }).error, 'environment_already_registered');
      assert.deepEqual(fx.scope.get('user-a'), undefined);

      const freshIntent = (await (await fetch(`${base}/environment-provisioning/intents`, {
        method: 'POST', headers, body: '{}',
      })).json()) as { data: { intentId: string; proof: string } };
      const first = await fetch(`${base}/environment-provisioning/complete`, { method: 'POST', headers,
        body: JSON.stringify({ intentId: freshIntent.data.intentId, proof: freshIntent.data.proof,
          envKey: 'fresh-a', label: '', platform: 'xiaohongshu' }) });
      assert.equal(first.status, 201);
      const switched = await fetch(`${base}/environment-provisioning/complete`, { method: 'POST', headers,
        body: JSON.stringify({ intentId: freshIntent.data.intentId, proof: freshIntent.data.proof,
          envKey: 'fresh-b', label: '', platform: 'xiaohongshu' }) });
      assert.equal(switched.status, 409);
      assert.equal(((await switched.json()) as { error: string }).error, 'intent_target_mismatch');
      assert.deepEqual((fx.scope.get('user-a') ?? []).map((item) => item.envKey), ['fresh-a']);
    },
  );
});

test('N3: 登录后被停用,下次请求即 401 disabled', async () => {
  const fx = makeFakeStore();
  fx.users.set('acme', { userId: 'u1', key: 'ck_secret', status: 'enabled' });
  await withServer(
    { store: fx.store, revocation: new TokenRevocationStore(), rateLimiter: new LoginRateLimiter() },
    baseConfig(0),
    async (base) => {
      const login = await (
        await fetch(`${base}/login`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'acme', key: 'ck_secret' }),
        })
      ).json();
      const token = (login as { token: string }).token;
      // 停用
      fx.users.set('acme', { userId: 'u1', key: 'ck_secret', status: 'disabled' });
      const r = await fetch(`${base}/my-environments`, { headers: { authorization: `Bearer ${token}` } });
      assert.equal(r.status, 401);
      assert.equal(((await r.json()) as { reason: string }).reason, 'disabled');
    },
  );
});

test('客户 A 不得通过 POST /environments attach 或读取客户 B 的环境', async () => {
  const fx = makeFakeStore();
  fx.users.set('alice', { userId: 'user-a', key: 'ck_alice', status: 'enabled' });
  fx.users.set('bob', { userId: 'user-b', key: 'ck_bob', status: 'enabled' });
  fx.scope.set('user-b', [{ envKey: 'env-b', label: 'Bob 环境', platform: 'wechat_channels', source: 'admin', assignedAt: 0 }]);
  await withServer(
    { store: fx.store, revocation: new TokenRevocationStore(), rateLimiter: new LoginRateLimiter() },
    baseConfig(0),
    async (base) => {
      const login = await (
        await fetch(`${base}/login`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'alice', key: 'ck_alice' }),
        })
      ).json();
      const token = (login as { token: string }).token;
      const add = await fetch(`${base}/environments`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ envKey: 'env-b', label: '伪造环境', platform: 'wechat_channels' }),
      });
      assert.equal(add.status, 403);
      assert.deepEqual(await add.json(), { error: 'forbidden', reason: 'environment_assignment_admin_only' });
      const r = await fetch(`${base}/my-environments`, { headers: { authorization: `Bearer ${token}` } });
      const { environments } = (await r.json()) as { environments: { envKey: string }[] };
      assert.deepEqual(environments, []);
      assert.deepEqual(fx.scope.get('user-a'), undefined);
      assert.deepEqual(fx.scope.get('user-b')?.map((e) => e.envKey), ['env-b']);
    },
  );
});

test('客户只能解绑自己的环境，且响应可轮询 pending/offline 清理真态', async () => {
  const fx = makeFakeStore();
  fx.users.set('alice', { userId: 'user-a', key: 'ck_alice', status: 'enabled' });
  fx.users.set('bob', { userId: 'user-b', key: 'ck_bob', status: 'enabled' });
  fx.scope.set('user-b', [{ envKey: 'env-b', label: 'Bob 环境', platform: 'wechat_channels', source: 'admin', assignedAt: 0 }]);
  const dispatched: string[] = [];
  await withServer({ store: fx.store, revocation: new TokenRevocationStore(), rateLimiter: new LoginRateLimiter(),
    onOffboardCreated: async (offboard) => { dispatched.push(offboard.offboardId); } }, baseConfig(0), async (base) => {
    const login = async (name: string, key: string): Promise<string> => {
      const response = await fetch(`${base}/login`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, key }) });
      return ((await response.json()) as { token: string }).token;
    };
    const alice = await login('alice', 'ck_alice');
    const bob = await login('bob', 'ck_bob');
    assert.equal((await fetch(`${base}/environments/env-b`, { method: 'DELETE',
      headers: { authorization: `Bearer ${alice}` } })).status, 404);
    const removed = await fetch(`${base}/environments/env-b`, { method: 'DELETE',
      headers: { authorization: `Bearer ${bob}` } });
    assert.equal(removed.status, 202);
    const body = await removed.json() as { data: ClientOffboardView; meta: { requestId: string; asOf: number } };
    assert.equal(body.data.state, 'pending_edge');
    assert.equal(body.data.envKey, 'env-b');
    assert.equal(body.data.accountId, 'account-env-b');
    assert.equal(typeof body.meta.requestId, 'string');
    assert.equal(typeof body.meta.asOf, 'number');
    assert.deepEqual(dispatched, ['offboard-env-b']);
    const status = await fetch(`${base}/offboarding/offboard-env-b`, {
      headers: { authorization: `Bearer ${bob}` },
    });
    assert.equal(status.status, 200);
    assert.equal(((await status.json()) as { data: ClientOffboardView }).data.state, 'pending_edge');
  });
});

test('Edge delegated-task routes bind every read/write to the customer-owned environment', async () => {
  const fx = makeFakeStore();
  fx.users.set('acme', { userId: 'u1', key: 'ck_secret', status: 'enabled' });
  fx.scope.set('u1', [{ envKey: 'p1', label: '小萝北', platform: 'xiaohongshu', source: 'admin', assignedAt: 0 }]);
  const taskStore = new MemoryDelegatedTaskStore();
  const delegatedTasks = new DelegatedTaskService({
    store: taskStore,
    listAccounts: async () => [
      { accountId: 'p1', nickname: '小萝北', platform: 'xiaohongshu', status: 'active' },
      { accountId: 'p2', nickname: '别人的账号', platform: 'xiaohongshu', status: 'active' },
    ],
  });
  await withServer(
    { store: fx.store, revocation: new TokenRevocationStore(), rateLimiter: new LoginRateLimiter(), delegatedTasks },
    baseConfig(0),
    async (base) => {
      const login = await (
        await fetch(`${base}/login`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'acme', key: 'ck_secret' }),
        })
      ).json();
      const token = (login as { token: string }).token;
      const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
      const rejected = await fetch(`${base}/delegated-tasks/draft`, {
        method: 'POST', headers, body: JSON.stringify({ envKey: 'p2', action: 'publish_post' }),
      });
      assert.equal(rejected.status, 403);

      const created = await fetch(`${base}/delegated-tasks/draft`, {
        method: 'POST', headers, body: JSON.stringify({
          envKey: 'p1', action: 'comment_batch', targetSuccessCount: 2, maxAttempts: 4,
          deadlineAt: Date.now() + 60_000, executionWindow: { mode: 'immediate' },
          sourceConstraints: {}, targetConstraints: {}, approvalMode: 'review', priority: 'normal',
        }),
      });
      assert.equal(created.status, 201);
      const receipt = await created.json() as { task: { id: string; accountId: string; source: string; version: number } };
      assert.equal(receipt.task.accountId, 'p1');
      assert.equal(receipt.task.source, 'edge');

      const confirmed = await fetch(`${base}/delegated-tasks/${receipt.task.id}/confirm`, {
        method: 'POST', headers, body: JSON.stringify({ version: receipt.task.version }),
      });
      assert.equal(confirmed.status, 200);
      const listed = await fetch(`${base}/delegated-tasks?envKey=p1`, { headers });
      const listBody = await listed.json() as { tasks: Array<{ id: string; accountId: string }> };
      assert.deepEqual(listBody.tasks.map((task) => [task.id, task.accountId]), [[receipt.task.id, 'p1']]);
      assert.equal((await fetch(`${base}/delegated-tasks?envKey=p2`, { headers })).status, 403);
    },
  );
});

test('登录限流:连续失败后 429', async () => {
  const fx = makeFakeStore();
  fx.users.set('acme', { userId: 'u1', key: 'ck_secret', status: 'enabled' });
  await withServer(
    { store: fx.store, revocation: new TokenRevocationStore(), rateLimiter: new LoginRateLimiter({ max: 2, windowMs: 60_000 }) },
    baseConfig(0),
    async (base) => {
      const bad = () =>
        fetch(`${base}/login`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'acme', key: 'ck_wrong' }),
        });
      assert.equal((await bad()).status, 401);
      assert.equal((await bad()).status, 401);
      assert.equal((await bad()).status, 429); // 达 max 后限流
    },
  );
});

test('interaction customer API is invoked only after JWT verification and enabled-user recheck', async () => {
  const fx = makeFakeStore();
  fx.users.set('acme', { userId: 'u1', key: 'ck_secret', status: 'enabled' });
  const actors: string[] = [];
  const interactionApi = {
    async handle(_req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, userId: string) {
      actors.push(userId);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: { envKey: 'env-a', accountId: 'acct-a' }, meta: { requestId: 'r1', asOf: 1 } }));
      return true;
    },
  };
  await withServer(
    { store: fx.store, revocation: new TokenRevocationStore(), rateLimiter: new LoginRateLimiter(), interactionApi },
    baseConfig(0),
    async (base) => {
      const anonymous = await fetch(`${base}/environments/env-a/interactions`);
      assert.equal(anonymous.status, 401);
      assert.deepEqual(actors, []);
      const login = await (await fetch(`${base}/login`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'acme', key: 'ck_secret' }) })).json() as { token: string };
      const accepted = await fetch(`${base}/environments/env-a/interactions`, {
        headers: { authorization: `Bearer ${login.token}` },
      });
      assert.equal(accepted.status, 200);
      assert.deepEqual(actors, ['u1']);
      fx.users.set('acme', { userId: 'u1', key: 'ck_secret', status: 'disabled' });
      const disabled = await fetch(`${base}/environments/env-a/interactions`, {
        headers: { authorization: `Bearer ${login.token}` },
      });
      assert.equal(disabled.status, 401);
      assert.deepEqual(actors, ['u1']);
    },
  );
});

test('客户灵感库按环境归属隔离、最小披露，并在归属撤销后即时拒绝', async () => {
  const fx = makeFakeStore();
  fx.users.set('acme', { userId: 'u1', key: 'ck_secret', status: 'enabled' });
  fx.scope.set('u1', [{ envKey: 'p1', label: '小萝北', platform: 'xiaohongshu', source: 'admin', assignedAt: 0 }]);
  const row = (overrides: Partial<CuratedPanelRow> = {}): CuratedPanelRow => ({
    id: 7,
    accountId: 'p1',
    contentType: 'image_text',
    sourceId: 'note-7',
    title: '值得参考的标题',
    body: '这是一段值得参考的正文',
    author: '作者甲',
    sourceUrl: 'https://example.test/note-7',
    topics: ['效率'],
    likeCount: null,
    collectCount: 0,
    commentCount: 3,
    countsCapturedAt: null,
    botLiked: false,
    botCollected: true,
    admitReason: 'internal-only-reason',
    firstSeenAt: 10,
    updatedAt: 20,
    referenceImages: [{
      index: 0,
      sourceUrl: 'https://img.test/source.jpg',
      ossUrl: 'https://img.test/stored.jpg',
      captureStatus: 'stored',
      capturedAt: 11,
      formGuess: { form: 'photo', confidence: 0.9, detectedAt: 12, detectedFor: 11, model: 'internal-model' },
    }],
    ...overrides,
  });
  const reads: Array<{ kind: string; accountId: string; id?: number; options?: unknown }> = [];
  const draftCountReads: string[] = [];
  const curatedContent = {
    async listForClient(accountId: string, options: { creatableOnly: boolean; limit: number; offset: number }) {
      reads.push({ kind: 'list', accountId, options });
      return { items: [row()], total: 1 };
    },
    async getOneForAccount(id: number, accountId: string) {
      reads.push({ kind: 'detail', accountId, id });
      return id === 7 && accountId === 'p1' ? row() : null;
    },
  };
  await withServer(
    {
      store: fx.store,
      revocation: new TokenRevocationStore(),
      rateLimiter: new LoginRateLimiter(),
      curatedContent,
      referenceDraftCountForAccount: async (accountId) => {
        draftCountReads.push(accountId);
        return 7;
      },
    },
    baseConfig(0),
    async (base) => {
      const login = await (await fetch(`${base}/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'acme', key: 'ck_secret' }),
      })).json() as { token: string };
      const headers = { authorization: `Bearer ${login.token}` };

      assert.equal((await fetch(`${base}/curated-contents?envKey=p2` , { headers })).status, 403);
      assert.equal(reads.length, 0, '未归属环境不得触达精选 store');

      const listed = await fetch(`${base}/curated-contents?envKey=p1&mode=creatable&limit=12&offset=24`, { headers });
      assert.equal(listed.status, 200);
      const listBody = await listed.json() as { items: Array<Record<string, unknown>>; total: number; referenceDraftCount: number; limit: number; offset: number };
      assert.equal(listBody.total, 1);
      assert.equal(listBody.referenceDraftCount, 7);
      assert.equal(listBody.limit, 12);
      assert.equal(listBody.offset, 24);
      assert.equal(listBody.items[0].likeCount, null);
      assert.equal(listBody.items[0].collectCount, 0);
      assert.equal(listBody.items[0].body, undefined, '列表只回正文摘要');
      assert.equal(typeof listBody.items[0].bodyPreview, 'string');
      assert.equal(listBody.items[0].accountId, undefined);
      assert.equal(listBody.items[0].admitReason, undefined);
      const image = (listBody.items[0].referenceImages as Array<Record<string, unknown>>)[0];
      assert.equal(image.formGuess, undefined, '客户 DTO 不泄漏模型内部诊断');
      assert.deepEqual(reads[0], {
        kind: 'list',
        accountId: 'p1',
        options: { creatableOnly: true, limit: 12, offset: 24 },
      });
      assert.deepEqual(draftCountReads, ['p1'], '成稿汇总只能读取已授权的当前账号');

      const detail = await fetch(`${base}/curated-contents/7?envKey=p1`, { headers });
      assert.equal(detail.status, 200);
      assert.equal(((await detail.json()) as { item: { body: string } }).item.body, '这是一段值得参考的正文');
      assert.equal((await fetch(`${base}/curated-contents/99?envKey=p1`, { headers })).status, 404);

      fx.scope.set('u1', []);
      assert.equal((await fetch(`${base}/curated-contents/7?envKey=p1`, { headers })).status, 403);
      assert.equal(reads.filter((read) => read.kind === 'detail').length, 2, '撤权后不得再触达单行 store');
    },
  );
});

test('客户参考创作只用服务端精选快照，图文/文字模式排队回执诚实', async () => {
  const fx = makeFakeStore();
  fx.users.set('acme', { userId: 'u1', key: 'ck_secret', status: 'enabled' });
  fx.scope.set('u1', [{ envKey: 'p1', label: '小萝北', platform: 'xiaohongshu', source: 'admin', assignedAt: 0 }]);
  const baseRow: CuratedPanelRow = {
    id: 7,
    accountId: 'p1',
    contentType: 'image_text',
    sourceId: 'server-note',
    title: '服务端标题',
    body: '服务端正文',
    author: '服务端作者',
    sourceUrl: 'https://example.test/server-note',
    topics: ['服务端话题'],
    likeCount: 1,
    collectCount: 2,
    commentCount: 3,
    countsCapturedAt: 1,
    botLiked: false,
    botCollected: true,
    admitReason: 'high_quality',
    firstSeenAt: 1,
    updatedAt: 2,
    // 真实行必带服务端内部诊断：formGuess（判图模型名/厂商）+ visualAnalysis（视觉模型与风格描述）。
    // 空 fixture 会让「不泄漏」断言空过——本 change 的 create-post 回包泄漏正是这样漏掉的。
    referenceImages: [{
      index: 0,
      sourceUrl: 'https://img.test/server.jpg',
      captureStatus: 'url_only',
      capturedAt: 1,
      formGuess: { form: 'photo', confidence: 0.87, detectedAt: 3, detectedFor: 1, model: 'internal-vision-model', provider: 'internal-vendor' },
    }],
    visualAnalysis: {
      status: 'analyzed',
      schemaVersion: '1',
      cacheKey: 'internal-cache-key',
      provider: 'internal-vendor',
      model: 'internal-vision-model',
      analyzedAt: 4,
      sourceCount: 1,
      error: '内部风格描述（绝不外泄）',
    },
  } as unknown as CuratedPanelRow;
  const rows = new Map<number, CuratedPanelRow>([
    [7, baseRow],
    [8, { ...baseRow, id: 8, sourceId: 'server-note-8' }],
    [9, { ...baseRow, id: 9, contentType: 'video' }],
    [10, { ...baseRow, id: 10, body: '  ' }],
    [11, { ...baseRow, id: 11, referenceImages: [] }],
  ]);
  const curatedContent = {
    async listForClient() { return { items: [], total: 0 }; },
    async getOneForAccount(id: number, accountId: string) { return accountId === 'p1' ? rows.get(id) ?? null : null; },
  };
  const taskStore = new MemoryDelegatedTaskStore();
  const delegatedTasks = new DelegatedTaskService({
    store: taskStore,
    listAccounts: async () => [{ accountId: 'p1', nickname: '小萝北', platform: 'xiaohongshu', status: 'active' }],
  });
  await withServer(
    {
      store: fx.store,
      revocation: new TokenRevocationStore(),
      rateLimiter: new LoginRateLimiter(),
      curatedContent,
      delegatedTasks,
    },
    baseConfig(0),
    async (base) => {
      const login = await (await fetch(`${base}/login`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'acme', key: 'ck_secret' }),
      })).json() as { token: string };
      const headers = { authorization: `Bearer ${login.token}`, 'content-type': 'application/json' };
      const create = (id: number, body: Record<string, unknown>) => fetch(`${base}/curated-contents/${id}/create-post`, {
        method: 'POST', headers, body: JSON.stringify(body),
      });

      assert.equal((await create(7, { envKey: 'p2', useReferenceImages: false })).status, 403);
      assert.equal((await create(7, { envKey: 'p1' })).status, 400);
      assert.deepEqual(await (await create(9, { envKey: 'p1', useReferenceImages: false })).json(), {
        triggered: false, reason: 'image_text_only',
      });
      assert.deepEqual(await (await create(10, { envKey: 'p1', useReferenceImages: false })).json(), {
        triggered: false, reason: 'empty_body',
      });
      assert.deepEqual(await (await create(11, { envKey: 'p1', useReferenceImages: true })).json(), {
        triggered: false, reason: 'reference_images_unavailable',
      });

      const textReceipt = await create(7, {
        envKey: 'p1',
        useReferenceImages: false,
        body: '客户端伪造正文',
        referenceImages: ['https://evil.test/image.jpg'],
        accountId: 'p2',
      });
      assert.equal(textReceipt.status, 201);
      // 回包只是排队回执：客户拿到的字段必须收口，绝不含 sourceConstraints / confirmation。
      const textBody = (await textReceipt.json()) as Record<string, unknown>;
      assert.deepEqual(Object.keys(textBody).sort(), ['created', 'task', 'triggered']);
      const textTask = textBody.task as Record<string, unknown>;
      assert.deepEqual(Object.keys(textTask).sort(), ['id', 'status', 'version']);
      assert.equal(textTask.status, 'queued');
      assert.equal(textBody.created, true);

      // 「只用服务端快照」仍须成立——但改由服务端任务行证明，不再靠回包自证。
      const [textStored] = await taskStore.list({ accountId: 'p1', limit: 20 });
      assert.equal(textStored.source, 'edge');
      assert.equal(textStored.sourceConstraints.body, '服务端正文', '客户端伪造正文必须被忽略');
      assert.equal(textStored.sourceConstraints.useReferenceImages, false);
      assert.equal(textStored.sourceConstraints.referenceImages, undefined);

      const imageReceipt = await create(8, { envKey: 'p1', useReferenceImages: true });
      assert.equal(imageReceipt.status, 201);
      const imageBody = (await imageReceipt.json()) as Record<string, unknown>;
      assert.deepEqual(Object.keys(imageBody).sort(), ['created', 'task', 'triggered']);
      assert.equal((imageBody.task as Record<string, unknown>).status, 'queued');

      // 内部视觉诊断绝不出现在客户域的任何一层（整包序列化后全文查，防新增字段再开口子）。
      const imageWire = JSON.stringify(imageBody);
      for (const secret of ['internal-vision-model', 'internal-vendor', 'internal-cache-key', 'formGuess', 'visualAnalysis', '内部风格描述']) {
        assert.equal(imageWire.includes(secret), false, `客户回包泄漏内部诊断：${secret}`);
      }

      // 服务端任务行仍须带上完整参考图快照（下游 referenceNote 要用），只是不外泄。
      const stored = await taskStore.list({ accountId: 'p1', limit: 20 });
      const imageStored = stored.find((t) => t.sourceConstraints.curatedId === 8)!;
      assert.deepEqual(imageStored.sourceConstraints.referenceImages, baseRow.referenceImages);
      assert.equal(stored.length, 2, '拒绝路径不得创建任务');
    },
  );
});
