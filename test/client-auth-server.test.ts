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
import { CuratedContentUnavailableError } from '../src/cache/curated-content-store.js';
import type { UiSlowStartPayload } from '../src/comm/protocol.js';
import type { PendingPublishPreview } from '../src/publish-agent/publish-log-store.js';

const silentLogger = { log() {}, warn() {}, error() {} };
const CLIENT_SECRET = 'client-secret-xyz';
const PANEL_SECRET = 'panel-secret-abc';

// 真实平台账号 id（24-hex）——**故意与 envKey 'p1' 不同**：本 bug 的整个成因就是「拿 8 字符环境编号当 24-hex
// 账号 id 查库」。夹具里两者必须取不同的值，否则这些测试什么都证明不了（这正是旧夹具把错误契约固化的地方）。
const ACCT_P1 = '63e2ff0500000000260049ce';

/** 内存假 store，仅实现 client-auth-server 用到的方法。 */
function makeFakeStore(): {
  store: ClientUserStore;
  users: Map<string, { userId: string; key: string; status: 'enabled' | 'disabled' }>;
  scope: Map<string, ClientEnvScopeRow[]>;
  offboards: Map<string, ClientOffboardView>;
  registered: Set<string>;
  /** envKey → 绑定的真实平台账号 id（change curated-envkey-account-binding）。 */
  bindings: Map<string, string>;
  /** envKey → 环境级慢启动起点。 */
  slowStarts: Map<string, number | null>;
  slowStartWrites: { envKey: string; enabled: boolean }[];
} {
  const users = new Map<string, { userId: string; key: string; status: 'enabled' | 'disabled' }>();
  const scope = new Map<string, ClientEnvScopeRow[]>();
  const offboards = new Map<string, ClientOffboardView>();
  const registered = new Set<string>();
  const bindings = new Map<string, string>();
  const slowStarts = new Map<string, number | null>();
  const slowStartWrites: { envKey: string; enabled: boolean }[] = [];
  const intents = new Map<string, { userId: string; proof: string; expiresAt: number; envKey?: string }>();
  let nextIntent = 1;

  // owner(envKey)：哪个客户归属了这个环境（0-或-1，与真 store 的 client_env_scope source='admin' 唯一索引一致）。
  const ownerOf = (envKey: string): string | null => {
    for (const [uid, rows] of scope.entries()) if (rows.some((r) => r.envKey === envKey)) return uid;
    return null;
  };
  // D5 跨客户争用：该账号是否绑在归属**不同客户**的另一个环境上（无主环境不参与，与真 store 一致）。
  const contendedAcrossCustomers = (accountId: string, userId: string): boolean => {
    for (const [envKey, boundAccount] of bindings.entries()) {
      if (boundAccount !== accountId) continue;
      const owner = ownerOf(envKey);
      if (owner !== null && owner !== userId) return true;
    }
    return false;
  };
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
    // 环境→账号绑定解析（change curated-envkey-account-binding，正向判别式）。
    async resolveBoundAccountForEnv(userId: string, envKey: string) {
      const key = (envKey ?? '').trim();
      const owned = (scope.get(userId) ?? []).some((item) => item.envKey === key);
      if (!key || !owned) return { ok: false as const, reason: 'environment_not_owned' as const };
      const bound = bindings.get(key);
      if (!bound) return { ok: false as const, reason: 'binding_unknown' as const };
      if (contendedAcrossCustomers(bound, userId)) return { ok: false as const, reason: 'binding_conflict' as const };
      return { ok: true as const, accountId: bound };
    },
    async getEnvironmentSlowStart(userId: string, envKey: string) {
      const key = (envKey ?? '').trim();
      const owned = (scope.get(userId) ?? []).some((item) => item.envKey === key);
      if (!key || !owned) return { ok: false as const, reason: 'environment_not_owned' as const };
      const since = slowStarts.get(key) ?? null;
      const bound = bindings.get(key);
      if (!bound) return { ok: true as const, envKey: key, slowStartSince: since, binding: 'binding_unknown' as const };
      const duplicates = [...bindings.values()].filter((accountId) => accountId === bound).length;
      if (duplicates > 1 || contendedAcrossCustomers(bound, userId)) {
        return { ok: true as const, envKey: key, slowStartSince: since, binding: 'binding_conflict' as const };
      }
      return { ok: true as const, envKey: key, slowStartSince: since, binding: 'bound' as const, accountId: bound };
    },
    async setEnvironmentSlowStart(userId: string, envKey: string, enabled: boolean, now: number) {
      const owned = (scope.get(userId) ?? []).some((item) => item.envKey === envKey);
      if (!owned) return { ok: false as const, reason: 'environment_not_owned' as const };
      slowStartWrites.push({ envKey, enabled });
      slowStarts.set(envKey, enabled ? now : null);
      return this.getEnvironmentSlowStart(userId, envKey);
    },
    // 反向：某账号是否可被该客户经其某环境触达（供任务动作归属判定）。同源争用闸。
    async isAccountReachableByUser(userId: string, accountId: string) {
      const acct = (accountId ?? '').trim();
      if (!acct) return { ok: false as const, reason: 'environment_not_owned' as const };
      if (contendedAcrossCustomers(acct, userId)) return { ok: false as const, reason: 'binding_conflict' as const };
      const ownedBound = (scope.get(userId) ?? []).some((item) => bindings.get(item.envKey) === acct);
      if (ownedBound) return { ok: true as const, accountId: acct };
      return { ok: false as const, reason: 'environment_not_owned' as const };
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
      slowStartEnabled?: boolean;
    }) {
      const intent = intents.get(input.intentId);
      if (!intent || intent.userId !== userId || intent.proof !== input.proof) {
        return { ok: false as const, reason: 'invalid_intent' as const };
      }
      if (intent.envKey && intent.envKey !== input.envKey) {
        return { ok: false as const, reason: 'intent_target_mismatch' as const };
      }
      if (input.slowStartEnabled === true && input.platform !== 'facebook') {
        return { ok: false as const, reason: 'invalid_environment' as const };
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
      slowStarts.set(input.envKey, input.slowStartEnabled === true ? Date.now() : null);
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
  return { store: fake as unknown as ClientUserStore, users, scope, offboards, registered, bindings, slowStarts, slowStartWrites };
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
        envKey: 'fresh-env-1', label: '新环境', platform: 'facebook', slowStartEnabled: true });
      const completed = await fetch(`${base}/environment-provisioning/complete`, {
        method: 'POST', headers, body: completionBody,
      });
      assert.equal(completed.status, 201);
      assert.equal(((await completed.json()) as { data: { idempotent: boolean } }).data.idempotent, false);
      assert.deepEqual((fx.scope.get('user-a') ?? []).map((item) => item.envKey), ['fresh-env-1']);
      assert.equal(typeof fx.slowStarts.get('fresh-env-1'), 'number');

      fx.slowStarts.set('fresh-env-1', null);
      const retried = await fetch(`${base}/environment-provisioning/complete`, {
        method: 'POST', headers, body: completionBody,
      });
      assert.equal(retried.status, 200);
      assert.equal(((await retried.json()) as { data: { idempotent: boolean } }).data.idempotent, true);
      assert.equal((fx.scope.get('user-a') ?? []).length, 1);
      assert.equal(fx.slowStarts.get('fresh-env-1'), null, '幂等重试不得重新开启已被运营关闭的慢启动');

      const legacyIntent = (await (await fetch(`${base}/environment-provisioning/intents`, {
        method: 'POST', headers, body: '{}',
      })).json()) as { data: { intentId: string; proof: string } };
      const legacy = await fetch(`${base}/environment-provisioning/complete`, {
        method: 'POST', headers, body: JSON.stringify({ intentId: legacyIntent.data.intentId,
          proof: legacyIntent.data.proof, envKey: 'fresh-env-legacy', label: '', platform: 'facebook' }),
      });
      assert.equal(legacy.status, 201);
      assert.equal(fx.slowStarts.get('fresh-env-legacy'), null, '旧客户端省略字段时保持关闭');

      const xhsIntent = (await (await fetch(`${base}/environment-provisioning/intents`, {
        method: 'POST', headers, body: '{}',
      })).json()) as { data: { intentId: string; proof: string } };
      const xhs = await fetch(`${base}/environment-provisioning/complete`, {
        method: 'POST', headers, body: JSON.stringify({ intentId: xhsIntent.data.intentId,
          proof: xhsIntent.data.proof, envKey: 'fresh-env-xhs', label: '', platform: 'xiaohongshu',
          slowStartEnabled: true }),
      });
      assert.equal(xhs.status, 400);
      assert.equal(fx.registered.has('fresh-env-xhs'), false);

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
  // 环境 p1 绑定真实账号 ACCT_P1（≠ envKey）；任务读写一律以绑定账号落库/查询。
  fx.bindings.set('p1', ACCT_P1);
  const taskStore = new MemoryDelegatedTaskStore();
  const delegatedTasks = new DelegatedTaskService({
    store: taskStore,
    listAccounts: async () => [
      { accountId: ACCT_P1, nickname: '小萝北', platform: 'xiaohongshu', status: 'active' },
      { accountId: 'acct-other', nickname: '别人的账号', platform: 'xiaohongshu', status: 'active' },
    ],
  });
  await withServer(
    {
      store: fx.store, revocation: new TokenRevocationStore(), rateLimiter: new LoginRateLimiter(), delegatedTasks,
      // D5 活体佐证：绑定账号此刻活在环境 p1 上（resolveEdgeIdForAccount(ACCT_P1) === 'ads-p1'）。
      resolveEdgeIdForAccount: (accountId) => (accountId === ACCT_P1 ? 'ads-p1' : null),
    },
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
      // 任务落在**绑定账号**上，绝不是 envKey——旧夹具把两者写成同一个值，正是本 bug 被固化的地方。
      assert.equal(receipt.task.accountId, ACCT_P1);
      assert.notEqual(receipt.task.accountId, 'p1');
      assert.equal(receipt.task.source, 'edge');

      const confirmed = await fetch(`${base}/delegated-tasks/${receipt.task.id}/confirm`, {
        method: 'POST', headers, body: JSON.stringify({ version: receipt.task.version }),
      });
      assert.equal(confirmed.status, 200);
      const listed = await fetch(`${base}/delegated-tasks?envKey=p1`, { headers });
      const listBody = await listed.json() as { tasks: Array<{ id: string; accountId: string }> };
      assert.deepEqual(listBody.tasks.map((task) => [task.id, task.accountId]), [[receipt.task.id, ACCT_P1]]);
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
  fx.bindings.set('p1', ACCT_P1);
  const row = (overrides: Partial<CuratedPanelRow> = {}): CuratedPanelRow => ({
    id: 7,
    accountId: ACCT_P1,
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
    async listForClient(accountId: string, options: { creationStatus: 'uncreated' | 'created' | 'creatable' | 'all'; limit: number; offset: number }) {
      reads.push({ kind: 'list', accountId, options });
      return { items: [row()], total: 1 };
    },
    async getOneForAccount(id: number, accountId: string) {
      reads.push({ kind: 'detail', accountId, id });
      return id === 7 && accountId === ACCT_P1 ? row() : null;
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

      const legacy = await fetch(`${base}/curated-contents?envKey=p1&mode=creatable&limit=12&offset=24`, { headers });
      assert.equal(legacy.status, 200);
      assert.deepEqual(reads[0], {
        kind: 'list',
        accountId: ACCT_P1,
        options: { creationStatus: 'creatable', limit: 12, offset: 24 },
      }, '旧筛选值必须精确保留原可创作集合');
      const invalid = await fetch(`${base}/curated-contents?envKey=p1&mode=unknown`, { headers });
      assert.equal(invalid.status, 400);
      assert.equal(reads.length, 1, '未知筛选值必须在触达 store 前明确拒绝');

      const listed = await fetch(`${base}/curated-contents?envKey=p1&mode=uncreated&limit=12&offset=24`, { headers });
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
      // 传给 store 的账号参数 MUST 是**绑定账号**、MUST NOT 是请求里的 envKey——这是本 bug 的直接反例。
      assert.deepEqual(reads[1], {
        kind: 'list',
        accountId: ACCT_P1,
        options: { creationStatus: 'uncreated', limit: 12, offset: 24 },
      });
      assert.notEqual(reads[1].accountId, 'p1', 'store 收到的绝不能是 envKey');

      assert.equal((await fetch(`${base}/curated-contents?envKey=p1&mode=created&limit=1&offset=0`, { headers })).status, 200);
      assert.equal((await fetch(`${base}/curated-contents?envKey=p1&mode=all&limit=1&offset=0`, { headers })).status, 200);
      assert.deepEqual(reads.slice(2, 4), [
        { kind: 'list', accountId: ACCT_P1, options: { creationStatus: 'created', limit: 1, offset: 0 } },
        { kind: 'list', accountId: ACCT_P1, options: { creationStatus: 'all', limit: 1, offset: 0 } },
      ]);
      assert.deepEqual(draftCountReads, [ACCT_P1, ACCT_P1, ACCT_P1, ACCT_P1], '兼容值与三种新筛选的汇总都只能读取已授权账号的绑定账号，绝不是 envKey');

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
  fx.bindings.set('p1', ACCT_P1);
  const baseRow: CuratedPanelRow = {
    id: 7,
    accountId: ACCT_P1,
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
    async getOneForAccount(id: number, accountId: string) { return accountId === ACCT_P1 ? rows.get(id) ?? null : null; },
  };
  const taskStore = new MemoryDelegatedTaskStore();
  const delegatedTasks = new DelegatedTaskService({
    store: taskStore,
    listAccounts: async () => [{ accountId: ACCT_P1, nickname: '小萝北', platform: 'xiaohongshu', status: 'active' }],
  });
  await withServer(
    {
      store: fx.store,
      revocation: new TokenRevocationStore(),
      rateLimiter: new LoginRateLimiter(),
      curatedContent,
      delegatedTasks,
      // D5 活体佐证：绑定账号此刻活在环境 p1 上。
      resolveEdgeIdForAccount: (accountId) => (accountId === ACCT_P1 ? 'ads-p1' : null),
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

      // 「只用服务端快照」仍须成立——但改由服务端任务行证明，不再靠回包自证。任务落在绑定账号（≠ envKey）上。
      const [textStored] = await taskStore.list({ accountId: ACCT_P1, limit: 20 });
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
      const stored = await taskStore.list({ accountId: ACCT_P1, limit: 20 });
      const imageStored = stored.find((t) => t.sourceConstraints.curatedId === 8)!;
      assert.deepEqual(imageStored.sourceConstraints.referenceImages, baseRow.referenceImages);
      assert.equal(stored.length, 2, '拒绝路径不得创建任务');
    },
  );
});

// ── 绑定解析：诚实失败、绝不 200-空；离线读可用、离线写拒绝（change curated-envkey-account-binding）─────

/** 建一个已登录、拥有环境 p1 的客户端会话，返回 base + headers。 */
async function loggedIn(fx: ReturnType<typeof makeFakeStore>, deps: ClientAuthDeps, base: string) {
  const login = await (await fetch(`${base}/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'acme', key: 'ck_secret' }),
  })).json() as { token: string };
  void fx; void deps;
  return { authorization: `Bearer ${login.token}`, 'content-type': 'application/json' };
}

test('绑定未知与跨客户争用互相可区分，且都绝不呈现为 200-空', async () => {
  const fx = makeFakeStore();
  fx.users.set('acme', { userId: 'u1', key: 'ck_secret', status: 'enabled' });
  // u1 拥有 p1（未绑定）与 p3（绑定被 u2 的 p2 争用）。
  fx.scope.set('u1', [
    { envKey: 'p1', label: 'a', platform: 'xiaohongshu', source: 'admin', assignedAt: 0 },
    { envKey: 'p3', label: 'c', platform: 'xiaohongshu', source: 'admin', assignedAt: 0 },
  ]);
  fx.scope.set('u2', [{ envKey: 'p2', label: 'b', platform: 'xiaohongshu', source: 'admin', assignedAt: 0 }]);
  fx.bindings.set('p2', ACCT_P1);
  fx.bindings.set('p3', ACCT_P1); // 与 p2 同账号但归属不同客户 → 争用
  let listForClientCalls = 0;
  const curatedContent = {
    async listForClient() { listForClientCalls += 1; return { items: [], total: 0 }; },
    async getOneForAccount() { return null; },
  };
  await withServer(
    { store: fx.store, revocation: new TokenRevocationStore(), rateLimiter: new LoginRateLimiter(), curatedContent },
    baseConfig(0),
    async (base) => {
      const headers = await loggedIn(fx, {} as ClientAuthDeps, base);
      const unknown = await fetch(`${base}/curated-contents?envKey=p1`, { headers });
      assert.equal(unknown.status, 409);
      assert.equal((await unknown.json() as { error: string }).error, 'binding_unknown');
      const conflict = await fetch(`${base}/curated-contents?envKey=p3`, { headers });
      assert.equal(conflict.status, 409);
      assert.equal((await conflict.json() as { error: string }).error, 'binding_conflict');
      // 两者码不同（安全事件不被埋进日常噪声），且都绝不触达 store、绝不 200-空。
      assert.equal(listForClientCalls, 0, '不可解析绝不触达精选 store，更不回 200-空');
    },
  );
});

test('缺表(42P01)→ 503 curated_content_unavailable，读路径绝不空池', async () => {
  const fx = makeFakeStore();
  fx.users.set('acme', { userId: 'u1', key: 'ck_secret', status: 'enabled' });
  fx.scope.set('u1', [{ envKey: 'p1', label: 'a', platform: 'xiaohongshu', source: 'admin', assignedAt: 0 }]);
  fx.bindings.set('p1', ACCT_P1);
  const curatedContent = {
    async listForClient(): Promise<never> { throw new CuratedContentUnavailableError('listForClient'); },
    async getOneForAccount(): Promise<never> { throw new CuratedContentUnavailableError('getOneForAccount'); },
  };
  await withServer(
    { store: fx.store, revocation: new TokenRevocationStore(), rateLimiter: new LoginRateLimiter(), curatedContent },
    baseConfig(0),
    async (base) => {
      const headers = await loggedIn(fx, {} as ClientAuthDeps, base);
      const list = await fetch(`${base}/curated-contents?envKey=p1`, { headers });
      assert.equal(list.status, 503);
      assert.equal((await list.json() as { error: string }).error, 'curated_content_unavailable');
      const detail = await fetch(`${base}/curated-contents/7?envKey=p1`, { headers });
      assert.equal(detail.status, 503);
    },
  );
});

test('浏览器离线时精选洗稿可按持久绑定创建，通用发布委托仍诚实拒绝', async () => {
  const fx = makeFakeStore();
  fx.users.set('acme', { userId: 'u1', key: 'ck_secret', status: 'enabled' });
  fx.scope.set('u1', [{ envKey: 'p1', label: 'a', platform: 'xiaohongshu', source: 'admin', assignedAt: 0 }]);
  fx.bindings.set('p1', ACCT_P1);
  const detailRow = { id: 7, accountId: ACCT_P1, contentType: 'image_text', sourceId: 'n7', title: 't',
    body: 'b', author: '', sourceUrl: '', topics: [], likeCount: null, collectCount: 0, commentCount: 0,
    countsCapturedAt: null, botLiked: false, botCollected: false, admitReason: 'x', firstSeenAt: 1, updatedAt: 2,
    referenceImages: [] } as unknown as CuratedPanelRow;
  const curatedContent = {
    async listForClient() { return { items: [detailRow], total: 1 }; },
    async getOneForAccount(id: number, accountId: string) { return id === 7 && accountId === ACCT_P1 ? detailRow : null; },
  };
  const taskStore = new MemoryDelegatedTaskStore();
  const delegatedTasks = new DelegatedTaskService({
    store: taskStore,
    listAccounts: async () => [{ accountId: ACCT_P1, nickname: 'n', platform: 'xiaohongshu', status: 'active' }],
  });
  await withServer(
    {
      store: fx.store, revocation: new TokenRevocationStore(), rateLimiter: new LoginRateLimiter(),
      curatedContent, delegatedTasks,
      // 边缘完全离线：resolveEdgeIdForAccount 恒 null → 活体佐证不成立。
      resolveEdgeIdForAccount: () => null,
    },
    baseConfig(0),
    async (base) => {
      const headers = await loggedIn(fx, {} as ClientAuthDeps, base);
      // 读：list + detail 均正常返回（边缘离线不影响读——绝不把活体前置抄到读路由上）。
      assert.equal((await fetch(`${base}/curated-contents?envKey=p1`, { headers })).status, 200);
      assert.equal((await fetch(`${base}/curated-contents/7?envKey=p1`, { headers })).status, 200);
      assert.equal((await fetch(`${base}/delegated-tasks?envKey=p1`, { headers })).status, 200);
      // 精选洗稿只排队云端生成必审候选稿，不需要浏览器在线。
      const createPost = await fetch(`${base}/curated-contents/7/create-post`, {
        method: 'POST', headers, body: JSON.stringify({ envKey: 'p1', useReferenceImages: false }),
      });
      assert.equal(createPost.status, 201);
      const createBody = await createPost.json() as {
        triggered: boolean; created: boolean; task: { id: string; status: string; version: number };
      };
      assert.deepEqual(createBody, { triggered: true, created: true, task: { id: createBody.task.id, status: 'queued', version: 2 } });
      const [rewriteTask] = await taskStore.list({ accountId: ACCT_P1, limit: 20 });
      assert.equal(rewriteTask.accountId, ACCT_P1);
      assert.equal(rewriteTask.approvalMode, 'review');
      assert.equal(rewriteTask.sourceConstraints.curatedId, 7);

      // 通用发布委托不在本 change 的放宽范围内，离线仍拒绝且不新增第二条任务。
      const draft = await fetch(`${base}/delegated-tasks/draft`, {
        method: 'POST', headers, body: JSON.stringify({
          envKey: 'p1', action: 'publish_post', targetSuccessCount: 1, maxAttempts: 2,
          deadlineAt: Date.now() + 60_000, executionWindow: { mode: 'immediate' },
          sourceConstraints: {}, targetConstraints: {}, approvalMode: 'review', priority: 'normal',
        }),
      });
      assert.equal(draft.status, 409);
      assert.equal((await draft.json() as { error: string }).error, 'binding_unverified');
      assert.equal((await taskStore.list({ accountId: ACCT_P1, limit: 20 })).length, 1, '通用离线委托不得新增任务');
    },
  );
});

// ── 环境级慢启动读写：未绑定可配置；有唯一账号时追加 controller 生效投影 ─────────

/**
 * controller 投影假体。环境写由 store 完成；这里只记录有唯一当前账号时读取了哪个 controller。
 */
function makeSlowStartDep(opts: {
  viewNull?: boolean;
} = {}): { dep: NonNullable<ClientAuthDeps['slowStart']>; views: string[] } {
  const views: string[] = [];
  const dayQuotas: Record<string, number> = { view: 20, like: 8, comment: 3, follow: 2, publish: 1 };
  const viewFor = (enabled: boolean): UiSlowStartPayload => enabled
    ? { state: 'active', day: 1, totalDays: 7, since: 1_700_000_000_000, binding: true, eligible: true }
    : { state: 'off', totalDays: 7, eligible: true };
  const dep = {
    async viewForAccount(accountId: string) {
      views.push(accountId);
      if (opts.viewNull) return null;
      return { slowStart: viewFor(true), dayQuotas };
    },
  };
  return { dep, views };
}

/** 建一个拥有环境 p1 的已登录客户（p2 归属他人 u2，用于非所有者 fail-closed）。 */
function ownerOfP1(): ReturnType<typeof makeFakeStore> {
  const fx = makeFakeStore();
  fx.users.set('acme', { userId: 'u1', key: 'ck_secret', status: 'enabled' });
  fx.scope.set('u1', [{ envKey: 'p1', label: 'a', platform: 'facebook', source: 'admin', assignedAt: 0 }]);
  fx.scope.set('u2', [{ envKey: 'p2', label: 'b', platform: 'facebook', source: 'admin', assignedAt: 0 }]);
  return fx;
}

test('慢启动写：边缘离线 + 有唯一绑定 → 写环境成功并用当前账号 controller 返回生效真态', async () => {
  const fx = ownerOfP1();
  fx.bindings.set('p1', ACCT_P1);
  const { dep, views } = makeSlowStartDep();
  await withServer(
    // resolveEdgeIdForAccount 恒 null = 边缘完全离线（含从未启动）；写路由**不该**碰它 → 仍成功。
    { store: fx.store, revocation: new TokenRevocationStore(), rateLimiter: new LoginRateLimiter(), slowStart: dep, resolveEdgeIdForAccount: () => null },
    baseConfig(0),
    async (base) => {
      const headers = await loggedIn(fx, {} as ClientAuthDeps, base);
      const res = await fetch(`${base}/environments/p1/slow-start`, { method: 'PUT', headers, body: JSON.stringify({ enabled: true }) });
      assert.equal(res.status, 200);
      const body = await res.json() as { data: { envKey: string; slowStart: UiSlowStartPayload; dayQuotas: Record<string, number> } };
      assert.equal(body.data.envKey, 'p1');
      assert.equal(body.data.slowStart.state, 'active');
      assert.ok(body.data.dayQuotas && typeof body.data.dayQuotas === 'object');
      assert.deepEqual(fx.slowStartWrites, [{ envKey: 'p1', enabled: true }], '写目标必须是环境');
      assert.deepEqual(views, [ACCT_P1], '绑定只用于读取实际 controller 投影');
    },
  );
});

test('慢启动写：环境无绑定也能预设，回包保留 active 配置且不编造配额', async () => {
  const fx = ownerOfP1(); // p1 归属 u1，但 fx.bindings 未设 → 无绑定
  const { dep, views } = makeSlowStartDep();
  await withServer(
    { store: fx.store, revocation: new TokenRevocationStore(), rateLimiter: new LoginRateLimiter(), slowStart: dep },
    baseConfig(0),
    async (base) => {
      const headers = await loggedIn(fx, {} as ClientAuthDeps, base);
      const res = await fetch(`${base}/environments/p1/slow-start`, { method: 'PUT', headers, body: JSON.stringify({ enabled: true }) });
      assert.equal(res.status, 200);
      const body = await res.json() as { data: { slowStart: UiSlowStartPayload; dayQuotas?: unknown } };
      assert.equal(body.data.slowStart.state, 'active');
      assert.equal(body.data.slowStart.ineligibleReason, 'binding_unknown');
      assert.equal('dayQuotas' in body.data, false);
      assert.deepEqual(fx.slowStartWrites, [{ envKey: 'p1', enabled: true }]);
      assert.equal(views.length, 0);
    },
  );
});

test('慢启动写：环境配置写查询失败 → 503，且 MUST NOT 是 binding_unknown', async () => {
  const fx = ownerOfP1();
  (fx.store as unknown as { setEnvironmentSlowStart: unknown }).setEnvironmentSlowStart =
    async () => ({ ok: false as const, reason: 'binding_unavailable' as const });
  const { dep } = makeSlowStartDep();
  await withServer(
    { store: fx.store, revocation: new TokenRevocationStore(), rateLimiter: new LoginRateLimiter(), slowStart: dep },
    baseConfig(0),
    async (base) => {
      const headers = await loggedIn(fx, {} as ClientAuthDeps, base);
      const res = await fetch(`${base}/environments/p1/slow-start`, { method: 'PUT', headers, body: JSON.stringify({ enabled: true }) });
      assert.equal(res.status, 503, '查不成 ≠ 没绑定');
      assert.notEqual((await res.json() as { error: string }).error, 'binding_unknown');
      assert.equal(fx.slowStartWrites.length, 0);
    },
  );
});

test('慢启动写：请求体夹带 accountId / since / quotaLevel 一律整块拒（422，不写入）', async () => {
  const fx = ownerOfP1();
  fx.bindings.set('p1', ACCT_P1);
  const { dep } = makeSlowStartDep();
  await withServer(
    { store: fx.store, revocation: new TokenRevocationStore(), rateLimiter: new LoginRateLimiter(), slowStart: dep },
    baseConfig(0),
    async (base) => {
      const headers = await loggedIn(fx, {} as ClientAuthDeps, base);
      for (const extra of [{ accountId: ACCT_P1 }, { since: 1 }, { quotaLevel: 'aggressive' }]) {
        const res = await fetch(`${base}/environments/p1/slow-start`, {
          method: 'PUT', headers, body: JSON.stringify({ enabled: true, ...extra }),
        });
        assert.equal(res.status, 422, `夹带 ${Object.keys(extra)[0]} 必须整块拒`);
        assert.equal((await res.json() as { error: string }).error, 'validation_failed');
      }
      assert.equal(fx.slowStartWrites.length, 0, '任何夹带都不写入');
    },
  );
});

test('慢启动写：非所有者 fail-closed（403）且不泄露账号身份', async () => {
  const fx = ownerOfP1();
  fx.bindings.set('p2', ACCT_P1); // p2 归属 u2、且有绑定——但 u1 不拥有它
  const { dep } = makeSlowStartDep();
  await withServer(
    { store: fx.store, revocation: new TokenRevocationStore(), rateLimiter: new LoginRateLimiter(), slowStart: dep },
    baseConfig(0),
    async (base) => {
      const headers = await loggedIn(fx, {} as ClientAuthDeps, base);
      const res = await fetch(`${base}/environments/p2/slow-start`, { method: 'PUT', headers, body: JSON.stringify({ enabled: true }) });
      assert.equal(res.status, 403);
      const text = await res.text();
      assert.doesNotMatch(text, new RegExp(ACCT_P1), '回包绝不泄露账号身份');
      assert.equal(fx.slowStartWrites.length, 0);
    },
  );
});

test('慢启动写：{enabled:false} 只写环境，回执无「已保存/待下发边缘」二态', async () => {
  const fx = ownerOfP1();
  fx.bindings.set('p1', ACCT_P1);
  const { dep } = makeSlowStartDep();
  await withServer(
    { store: fx.store, revocation: new TokenRevocationStore(), rateLimiter: new LoginRateLimiter(), slowStart: dep },
    baseConfig(0),
    async (base) => {
      const headers = await loggedIn(fx, {} as ClientAuthDeps, base);
      const res = await fetch(`${base}/environments/p1/slow-start`, { method: 'PUT', headers, body: JSON.stringify({ enabled: false }) });
      assert.equal(res.status, 200);
      assert.deepEqual(fx.slowStartWrites, [{ envKey: 'p1', enabled: false }]);
      const body = await res.json() as { data: Record<string, unknown> };
      // data 仅 envKey / slowStart / dayQuotas——慢启动执行体在云端、写入成功即已生效，绝无「待下发边缘」态。
      assert.deepEqual(Object.keys(body.data).sort(), ['dayQuotas', 'envKey', 'slowStart']);
      const flat = JSON.stringify(body);
      for (const banned of ['saved', 'applied', 'edgeDelivery', 'enqueued', 'deferred', '待下发', '已保存', '待应用']) {
        assert.doesNotMatch(flat, new RegExp(banned), `回执绝不含二态措辞 ${banned}`);
      }
    },
  );
});

test('慢启动读：从未连接的环境读到真态，回包无 accountId', async () => {
  const fx = ownerOfP1();
  fx.bindings.set('p1', ACCT_P1);
  const { dep, views } = makeSlowStartDep();
  await withServer(
    // 读路由**不该**碰 resolveEdgeIdForAccount（活体佐证只对不可逆写）；恒 null 佐证读与边缘在线无关。
    { store: fx.store, revocation: new TokenRevocationStore(), rateLimiter: new LoginRateLimiter(), slowStart: dep, resolveEdgeIdForAccount: () => null },
    baseConfig(0),
    async (base) => {
      const headers = await loggedIn(fx, {} as ClientAuthDeps, base);
      const res = await fetch(`${base}/environments/p1/slow-start`, { headers });
      assert.equal(res.status, 200);
      const text = await res.text();
      assert.doesNotMatch(text, new RegExp(ACCT_P1), '读回包 MUST NOT 含 accountId');
      const body = JSON.parse(text) as { data: { envKey: string; slowStart: UiSlowStartPayload; dayQuotas: Record<string, number> } };
      assert.equal(body.data.envKey, 'p1');
      assert.equal(body.data.slowStart.state, 'active');
      assert.ok(body.data.dayQuotas);
      assert.deepEqual(views, [ACCT_P1]);
    },
  );
});

test('慢启动读：未绑定环境保留配置态，不编造 binding/dayQuotas', async () => {
  const fx = ownerOfP1();
  fx.slowStarts.set('p1', 1_700_000_000_000);
  const { dep, views } = makeSlowStartDep();
  await withServer(
    { store: fx.store, revocation: new TokenRevocationStore(), rateLimiter: new LoginRateLimiter(), slowStart: dep },
    baseConfig(0),
    async (base) => {
      const headers = await loggedIn(fx, {} as ClientAuthDeps, base);
      const res = await fetch(`${base}/environments/p1/slow-start`, { headers });
      assert.equal(res.status, 200);
      const body = await res.json() as { data: { envKey: string; slowStart: Record<string, unknown>; dayQuotas?: unknown } };
      assert.equal(body.data.slowStart.state, 'graduated');
      assert.equal(body.data.slowStart.since, 1_700_000_000_000);
      assert.equal(body.data.slowStart.ineligibleReason, 'binding_unknown');
      assert.equal('binding' in body.data.slowStart, false);
      assert.equal('dayQuotas' in body.data, false);
      assert.equal(views.length, 0, '没绑定 → 不取 controller（无账号可取）');
    },
  );
});

test('慢启动读：非所有者 fail-closed（403）且不泄露账号身份', async () => {
  const fx = ownerOfP1();
  fx.bindings.set('p2', ACCT_P1);
  const { dep } = makeSlowStartDep();
  await withServer(
    { store: fx.store, revocation: new TokenRevocationStore(), rateLimiter: new LoginRateLimiter(), slowStart: dep },
    baseConfig(0),
    async (base) => {
      const headers = await loggedIn(fx, {} as ClientAuthDeps, base);
      const res = await fetch(`${base}/environments/p2/slow-start`, { headers });
      assert.equal(res.status, 403);
      assert.doesNotMatch(await res.text(), new RegExp(ACCT_P1));
    },
  );
});

test('慢启动读：环境配置查询失败 → 503，MUST NOT 降级为 binding_unknown 或空投影', async () => {
  const fx = ownerOfP1();
  (fx.store as unknown as { getEnvironmentSlowStart: unknown }).getEnvironmentSlowStart =
    async () => ({ ok: false as const, reason: 'binding_unavailable' as const });
  const { dep } = makeSlowStartDep();
  await withServer(
    { store: fx.store, revocation: new TokenRevocationStore(), rateLimiter: new LoginRateLimiter(), slowStart: dep },
    baseConfig(0),
    async (base) => {
      const headers = await loggedIn(fx, {} as ClientAuthDeps, base);
      const res = await fetch(`${base}/environments/p1/slow-start`, { headers });
      assert.equal(res.status, 503);
      assert.notEqual((await res.json() as { error: string }).error, 'binding_unknown');
    },
  );
});

test('慢启动读：controller 取用失败（viewForAccount 返回 null）→ 503，不返回看似正常的空投影', async () => {
  const fx = ownerOfP1();
  fx.bindings.set('p1', ACCT_P1);
  const { dep } = makeSlowStartDep({ viewNull: true });
  await withServer(
    { store: fx.store, revocation: new TokenRevocationStore(), rateLimiter: new LoginRateLimiter(), slowStart: dep },
    baseConfig(0),
    async (base) => {
      const headers = await loggedIn(fx, {} as ClientAuthDeps, base);
      const res = await fetch(`${base}/environments/p1/slow-start`, { headers });
      assert.equal(res.status, 503);
    },
  );
});

test('待审批稿列表按环境持久绑定分页，并只返回客户最小投影', async () => {
  const fx = ownerOfP1();
  fx.bindings.set('p1', ACCT_P1);
  const calls: unknown[] = [];
  const item: PendingPublishPreview = {
    id: 42,
    accountId: ACCT_P1,
    platform: 'xiaohongshu',
    kind: 'rewrite',
    title: '工程 Wiki 的下一步是 Agent Memory',
    content: `完整正文${'很长'.repeat(100)}`,
    topics: ['Agent Memory'],
    images: ['https://img/cover.jpg'],
    contentVersion: 3,
    updatedAt: 1_721_277_200_000,
    publishMode: 'immediate',
    publishTime: null,
    imageReferenceAudit: { requestedCount: 1, usableCount: 1, generatedCount: 1, status: 'used' },
  };
  const pendingDrafts = {
    async listPendingPublishPreviewsForAccount(accountId: string, options: { limit: number; offset: number }) {
      calls.push({ accountId, options });
      return { items: [item], total: 25 };
    },
    async pendingPublishPreviewForAccountRecord() { return null; },
  };

  await withServer(
    { store: fx.store, revocation: new TokenRevocationStore(), rateLimiter: new LoginRateLimiter(), pendingDrafts },
    baseConfig(0),
    async (base) => {
      const headers = await loggedIn(fx, {} as ClientAuthDeps, base);
      const response = await fetch(`${base}/publish-drafts?envKey=p1&limit=12&offset=12`, { headers });
      assert.equal(response.status, 200);
      const body = await response.json() as { items: Record<string, unknown>[]; total: number; limit: number; offset: number };
      assert.deepEqual(calls, [{ accountId: ACCT_P1, options: { limit: 12, offset: 12 } }]);
      assert.equal(body.total, 25);
      assert.equal(body.limit, 12);
      assert.equal(body.offset, 12);
      assert.deepEqual(Object.keys(body.items[0]).sort(), [
        'contentPreview', 'contentVersion', 'id', 'images', 'kind', 'platform',
        'publishMode', 'publishTime', 'title', 'topics', 'updatedAt',
      ]);
      assert.equal(String(body.items[0].contentPreview).endsWith('…'), true);
      const wire = JSON.stringify(body);
      assert.equal(wire.includes(ACCT_P1), false);
      assert.equal(wire.includes('imageReferenceAudit'), false);
      assert.equal(wire.includes('完整正文很长很长很长很长很长很长很长很长很长很长'), true);
      assert.equal(wire.includes(item.content), false, '列表不得返回完整正文');
    },
  );
});

test('待审批稿详情按账号和记录联合取数，缺失诚实返回 404', async () => {
  const fx = ownerOfP1();
  fx.bindings.set('p1', ACCT_P1);
  const calls: unknown[] = [];
  const item: PendingPublishPreview = {
    id: 42,
    accountId: ACCT_P1,
    platform: 'xiaohongshu',
    kind: 'generated',
    title: '待审批标题',
    content: '完整正文',
    topics: [],
    images: [],
    contentVersion: 1,
    updatedAt: 1_721_277_200_000,
    publishMode: 'scheduled',
    publishTime: 1_721_284_400_000,
  };
  const pendingDrafts = {
    async listPendingPublishPreviewsForAccount() { return { items: [], total: 0 }; },
    async pendingPublishPreviewForAccountRecord(accountId: string, id: number) {
      calls.push({ accountId, id });
      return id === 42 ? item : null;
    },
  };

  await withServer(
    { store: fx.store, revocation: new TokenRevocationStore(), rateLimiter: new LoginRateLimiter(), pendingDrafts },
    baseConfig(0),
    async (base) => {
      const headers = await loggedIn(fx, {} as ClientAuthDeps, base);
      const found = await fetch(`${base}/publish-drafts/42?envKey=p1`, { headers });
      assert.equal(found.status, 200);
      const foundBody = await found.json() as { item: Record<string, unknown> };
      assert.equal(foundBody.item.content, '完整正文');
      assert.equal('accountId' in foundBody.item, false);

      const missing = await fetch(`${base}/publish-drafts/99?envKey=p1`, { headers });
      assert.equal(missing.status, 404);
      assert.deepEqual(calls, [
        { accountId: ACCT_P1, id: 42 },
        { accountId: ACCT_P1, id: 99 },
      ]);
    },
  );
});

test('待审批稿读取遇到未知绑定时 fail-closed，绝不触达稿件 store 或返回空池', async () => {
  const fx = ownerOfP1();
  let calls = 0;
  const pendingDrafts = {
    async listPendingPublishPreviewsForAccount() { calls += 1; return { items: [], total: 0 }; },
    async pendingPublishPreviewForAccountRecord() { calls += 1; return null; },
  };
  await withServer(
    { store: fx.store, revocation: new TokenRevocationStore(), rateLimiter: new LoginRateLimiter(), pendingDrafts },
    baseConfig(0),
    async (base) => {
      const headers = await loggedIn(fx, {} as ClientAuthDeps, base);
      const list = await fetch(`${base}/publish-drafts?envKey=p1`, { headers });
      assert.equal(list.status, 409);
      assert.equal((await list.json() as { error: string }).error, 'binding_unknown');
      const detail = await fetch(`${base}/publish-drafts/42?envKey=p1`, { headers });
      assert.equal(detail.status, 409);
      assert.equal(calls, 0);
    },
  );
});
