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
  cleanupGrants: Map<string, { edgeId: string; jtiHash: string; expiresAt: number; used: boolean }>;
} {
  const users = new Map<string, { userId: string; key: string; status: 'enabled' | 'disabled' }>();
  const scope = new Map<string, ClientEnvScopeRow[]>();
  const offboards = new Map<string, ClientOffboardView>();
  const registered = new Set<string>();
  const bindings = new Map<string, string>();
  const slowStarts = new Map<string, number | null>();
  const slowStartWrites: { envKey: string; enabled: boolean }[] = [];
  const cleanupGrants = new Map<string, { edgeId: string; jtiHash: string; expiresAt: number; used: boolean }>();
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
    async resolveOperatorAliasAccountForEnv(userId: string, envKey: string) {
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
    async registerOffboardCleanupGrant(input: {
      userId: string; offboardId: string; edgeId: string; jtiHash: string; expiresAt: number;
    }) {
      if (!offboards.has(`${input.userId}:${input.offboardId}`)) return false;
      cleanupGrants.set(`${input.userId}:${input.offboardId}`, {
        edgeId: input.edgeId, jtiHash: input.jtiHash, expiresAt: input.expiresAt, used: false,
      });
      return true;
    },
    async consumeOffboardCleanupGrant(input: {
      userId: string; offboardId: string; envKey: string; accountId: string; edgeId: string; jtiHash: string;
    }) {
      const offboard = offboards.get(`${input.userId}:${input.offboardId}`);
      const grant = cleanupGrants.get(`${input.userId}:${input.offboardId}`);
      if (!offboard || !grant) return { ok: false as const, reason: 'not_found' as const };
      if (grant.used) return { ok: false as const, reason: 'already_used' as const };
      if (grant.expiresAt <= Date.now()) return { ok: false as const, reason: 'expired' as const };
      if (grant.edgeId !== input.edgeId || grant.jtiHash !== input.jtiHash
        || offboard.envKey !== input.envKey || offboard.accountId !== input.accountId) {
        return { ok: false as const, reason: 'scope_mismatch' as const };
      }
      grant.used = true;
      return { ok: true as const, offboard, edgeId: input.edgeId };
    },
  };
  return {
    store: fake as unknown as ClientUserStore,
    users,
    scope,
    offboards,
    registered,
    bindings,
    slowStarts,
    slowStartWrites,
    cleanupGrants,
  };
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

test('egress: 无令牌返回 nginx 最近连接 IP、证据响应头、CORS 与 no-store', async () => {
  const fx = makeFakeStore();
  await withServer(
    { store: fx.store, revocation: new TokenRevocationStore(), rateLimiter: new LoginRateLimiter() },
    baseConfig(0),
    async (base) => {
      const r = await fetch(`${base}/egress`, {
        // 首段模拟上游代理/客户端自带前缀；最右段模拟 nginx $proxy_add_x_forwarded_for 追加的真实连接端。
        headers: { 'x-forwarded-for': '198.51.100.23, 203.0.113.45' },
      });
      assert.equal(r.status, 200);
      assert.equal(r.headers.get('cache-control'), 'no-store');
      assert.equal(r.headers.get('access-control-allow-origin'), '*');
      assert.match(r.headers.get('access-control-expose-headers') ?? '', /x-aidcp-egress-ip/);
      assert.equal(r.headers.get('x-aidcp-egress-ip'), '203.0.113.45');
      assert.ok(r.headers.get('x-aidcp-request-id'));
      const body = (await r.json()) as { ip: string; checkedAt: string; requestId: string };
      assert.equal(body.ip, '203.0.113.45');
      assert.equal(body.requestId, r.headers.get('x-aidcp-request-id'));
      assert.ok(Number.isFinite(Date.parse(body.checkedAt)));
    },
  );
});

test('egress: 非法转发头回退 socket 地址且 OPTIONS 可无凭据预检', async () => {
  const fx = makeFakeStore();
  await withServer(
    { store: fx.store, revocation: new TokenRevocationStore(), rateLimiter: new LoginRateLimiter() },
    baseConfig(0),
    async (base) => {
      const r = await fetch(`${base}/egress`, { headers: { 'x-forwarded-for': 'not-an-ip' } });
      assert.equal(r.status, 200);
      assert.equal(((await r.json()) as { ip: string }).ip, '127.0.0.1');

      const preflight = await fetch(`${base}/egress`, { method: 'OPTIONS' });
      assert.equal(preflight.status, 204);
      assert.equal(preflight.headers.get('access-control-allow-origin'), '*');
      assert.equal(preflight.headers.get('cache-control'), 'no-store');
    },
  );
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

test('环境删除维护只走 customer-auth HTTP，停用/撤销普通会话后仍按目标客户轮询、认领和回执', async () => {
  const fx = makeFakeStore();
  fx.users.set('acme', { userId: 'u1', key: 'ck_secret', status: 'enabled' });
  const calls: Array<Record<string, unknown>> = [];
  const maintenanceStore = fx.store as unknown as {
    observeAndListEnvironmentMaintenance(
      userId: string, installationId: string, environments: Array<Record<string, unknown>>,
    ): Promise<Array<Record<string, unknown>>>;
    claimEnvironmentDeletion(
      userId: string, requestId: string, version: number, installationId: string,
    ): Promise<Record<string, unknown>>;
    completeEnvironmentDeletion(
      userId: string, requestId: string, version: number, installationId: string, input: Record<string, unknown>,
    ): Promise<Record<string, unknown>>;
  };
  maintenanceStore.observeAndListEnvironmentMaintenance = async (userId, installationId, environments) => {
    calls.push({ kind: 'poll', userId, installationId, environments });
    return [{ requestId: 'request-1', version: 1, envKey: 'p1', environmentName: '环境一', platform: 'xiaohongshu',
      state: 'waiting_edge', cleanupReady: true, cleanupReason: 'ready' }];
  };
  maintenanceStore.claimEnvironmentDeletion = async (userId, requestId, version, installationId) => {
    calls.push({ kind: 'claim', userId, requestId, version, installationId });
    return { ok: true, requestId, version, envKey: 'p1', environmentName: '环境一', platform: 'xiaohongshu',
      state: 'deleting', idempotent: false };
  };
  maintenanceStore.completeEnvironmentDeletion = async (userId, requestId, version, installationId, input) => {
    calls.push({ kind: 'result', userId, requestId, version, installationId, input });
    return { ok: true, requestId, envKey: 'p1', state: 'deleted', idempotent: false };
  };
  const revocation = new TokenRevocationStore();
  await withServer(
    { store: fx.store, revocation, rateLimiter: new LoginRateLimiter() },
    baseConfig(0),
    async (base) => {
      const login = await (await fetch(`${base}/login`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'acme', key: 'ck_secret' }),
      })).json() as { token: string };
      const verified = verifyJwt(login.token, CLIENT_SECRET);
      assert.equal(verified.valid, true);
      if (verified.valid) revocation.revoke(verified.payload.jti, verified.payload.exp);
      fx.users.get('acme')!.status = 'disabled';
      const headers = { authorization: `Bearer ${login.token}`, 'content-type': 'application/json' };

      const poll = await fetch(`${base}/environment-maintenance/poll`, {
        method: 'POST', headers,
        body: JSON.stringify({ installationId: 'installation-1', environments: [{
          envKey: 'p1', environmentName: '环境一', accountId: 'must-not-pass',
        }] }),
      });
      assert.equal(poll.status, 200);
      const pollBody = await poll.json() as { deletions: Array<{ envKey: string }> };
      assert.deepEqual(pollBody.deletions.map((item) => item.envKey), ['p1']);

      const claim = await fetch(`${base}/environment-maintenance/deletions/request-1/claim`, {
        method: 'POST', headers, body: JSON.stringify({ installationId: 'installation-1', version: 1 }),
      });
      assert.equal(claim.status, 200);
      const result = await fetch(`${base}/environment-maintenance/deletions/request-1/result`, {
        method: 'PUT', headers: { ...headers, 'idempotency-key': 'result-1' },
        body: JSON.stringify({ installationId: 'installation-1', version: 1,
          status: 'succeeded', resultKind: 'deleted' }),
      });
      assert.equal(result.status, 200);
    },
  );
  assert.deepEqual(calls.map((call) => call.kind), ['poll', 'claim', 'result']);
  assert.equal(calls.every((call) => call.userId === 'u1'), true);
  assert.deepEqual(calls[0]?.environments, [{ envKey: 'p1', environmentName: '环境一' }]);
});

test('POST /persona-auto-fill/runs 只收已确认人设，拒绝目标选择器/自动策略并按客户幂等', async () => {
  const fx = makeFakeStore();
  fx.users.set('acme', { userId: 'u1', key: 'ck_secret', status: 'enabled' });
  const selectedSoul = `identity:\n  name: "旅行模板"\n  role: "旅行分享者"\n  background: "关注周末出游"\n  tone: "亲切"\nwriting_language: "zh-CN"\ninterests:\n  primary:\n    - "旅行"\n  secondary: []\n  seed_keywords:\n    - "周末出游"\n`;
  const calls: Array<{ userId: string; idempotencyKey: string; soulYaml: string }> = [];
  const seen = new Set<string>();
  const personaAutoFill = {
    async createRun(input: { userId: string; idempotencyKey: string; soulYaml: string }) {
      calls.push(input);
      const key = `${input.userId}:${input.idempotencyKey}`;
      const idempotent = seen.has(key);
      seen.add(key);
      return {
        run: { runId: 'run-public-1', userId: input.userId, idempotencyKey: input.idempotencyKey,
          platform: 'facebook' as const, strategy: 'selected_persona_v1' as const,
          writingLanguage: 'zh-CN' as const, soulYaml: input.soulYaml, state: 'running' as const },
        idempotent,
      };
    },
  };
  await withServer(
    { store: fx.store, revocation: new TokenRevocationStore(), rateLimiter: new LoginRateLimiter(), personaAutoFill },
    baseConfig(0),
    async (base) => {
      const headers = await loggedIn(fx, {} as ClientAuthDeps, base);
      const missingKey = await fetch(`${base}/persona-auto-fill/runs`, {
        method: 'POST', headers,
        body: JSON.stringify({ platform: 'facebook', soulYaml: selectedSoul }),
      });
      assert.equal(missingKey.status, 400);
      const leakedSelector = await fetch(`${base}/persona-auto-fill/runs`, {
        method: 'POST', headers: { ...headers, 'idempotency-key': 'batch-1' },
        body: JSON.stringify({ platform: 'facebook', soulYaml: selectedSoul, accountId: 'secret-account' }),
      });
      assert.equal(leakedSelector.status, 422);

      const oldAutoIntent = await fetch(`${base}/persona-auto-fill/runs`, {
        method: 'POST', headers: { ...headers, 'idempotency-key': 'batch-old' },
        body: JSON.stringify({ platform: 'facebook', strategy: 'facebook_auto_v1', writingLanguage: 'zh-CN' }),
      });
      assert.equal(oldAutoIntent.status, 422);

      const invalidPersona = await fetch(`${base}/persona-auto-fill/runs`, {
        method: 'POST', headers: { ...headers, 'idempotency-key': 'batch-invalid' },
        body: JSON.stringify({ platform: 'facebook', soulYaml: 'identity: {}' }),
      });
      assert.equal(invalidPersona.status, 422);

      const issue = () => fetch(`${base}/persona-auto-fill/runs`, {
        method: 'POST', headers: { ...headers, 'idempotency-key': 'batch-1' },
        body: JSON.stringify({ platform: 'facebook', soulYaml: selectedSoul }),
      });
      const first = await issue();
      assert.equal(first.status, 201);
      const firstBody = await first.json() as Record<string, unknown>;
      const retry = await issue();
      assert.equal(retry.status, 200);
      const retryBody = await retry.json() as Record<string, unknown>;
      assert.equal(JSON.stringify(firstBody).includes('secret-account'), false);
      assert.equal(JSON.stringify(retryBody).includes('accountId'), false);
      assert.deepEqual(calls.map((call) => call.userId), ['u1', 'u1']);
      assert.deepEqual(new Set(calls.map((call) => call.soulYaml)), new Set([selectedSoul]));
    },
  );
});

test('control-bootstrap 只为已归属且已绑定环境返回最小账号引导', async () => {
  const fx = makeFakeStore();
  fx.users.set('acme', { userId: 'u1', key: 'ck_secret', status: 'enabled' });
  fx.scope.set('u1', [{ envKey: 'p1', label: 'owned', platform: 'xiaohongshu', source: 'admin', assignedAt: 0 }]);
  fx.bindings.set('p1', ACCT_P1);
  await withServer(
    { store: fx.store, revocation: new TokenRevocationStore(), rateLimiter: new LoginRateLimiter() },
    baseConfig(0),
    async (base) => {
      const headers = await loggedIn(fx, {} as ClientAuthDeps, base);
      const response = await fetch(`${base}/environments/p1/control-bootstrap`, { headers });
      assert.equal(response.status, 200);
      const body = await response.json() as { data: Record<string, unknown> };
      assert.deepEqual(body.data, { envKey: 'p1', accountId: ACCT_P1 });
      assert.deepEqual(Object.keys(body.data).sort(), ['accountId', 'envKey']);
    },
  );
});

test('operator-alias: 已归属绑定环境可设置别名，空内容清除并返回系统回落名', async () => {
  const fx = makeFakeStore();
  fx.users.set('acme', { userId: 'u1', key: 'ck_secret', status: 'enabled' });
  fx.scope.set('u1', [{ envKey: 'p1', label: 'owned', platform: 'facebook', source: 'admin', assignedAt: 0 }]);
  fx.bindings.set('p1', ACCT_P1);
  const writes: Array<string | null> = [];
  const operatorAlias = {
    async setForAccount(accountId: string, alias: string | null) {
      assert.equal(accountId, ACCT_P1, '客户端不得提交或替换账号键');
      writes.push(alias);
      return alias
        ? { ok: true as const, operatorAlias: alias, display: { name: alias, source: 'operator_alias' as const } }
        : { ok: true as const, operatorAlias: null, display: { name: 'Tianxing Bai', source: 'platform_nickname' as const } };
    },
  };
  await withServer(
    { store: fx.store, revocation: new TokenRevocationStore(), rateLimiter: new LoginRateLimiter(), operatorAlias },
    baseConfig(0),
    async (base) => {
      const headers = await loggedIn(fx, {} as ClientAuthDeps, base);
      const set = await fetch(`${base}/environments/p1/operator-alias`, {
        method: 'PUT', headers, body: JSON.stringify({ alias: '  Tianxing Bai1  ' }),
      });
      assert.equal(set.status, 200);
      assert.deepEqual((await set.json() as { data: unknown }).data, {
        envKey: 'p1', operatorAlias: 'Tianxing Bai1',
        displayName: 'Tianxing Bai1', displayNameSource: 'operator_alias',
      });
      const clear = await fetch(`${base}/environments/p1/operator-alias`, {
        method: 'PUT', headers, body: JSON.stringify({ alias: '   ' }),
      });
      assert.equal(clear.status, 200);
      assert.deepEqual((await clear.json() as { data: unknown }).data, {
        envKey: 'p1', operatorAlias: null,
        displayName: 'Tianxing Bai', displayNameSource: 'platform_nickname',
      });
      assert.deepEqual(writes, ['Tianxing Bai1', null]);
    },
  );
});

test('operator-alias: 越权、未绑定、账号缺失、无效输入与写失败均诚实拒绝', async () => {
  const fx = makeFakeStore();
  fx.users.set('acme', { userId: 'u1', key: 'ck_secret', status: 'enabled' });
  fx.scope.set('u1', [
    { envKey: 'unbound', label: null, platform: 'facebook', source: 'admin', assignedAt: 0 },
    { envKey: 'missing', label: null, platform: 'facebook', source: 'admin', assignedAt: 0 },
    { envKey: 'write-fails', label: null, platform: 'facebook', source: 'admin', assignedAt: 0 },
  ]);
  fx.bindings.set('missing', 'missing-account');
  fx.bindings.set('write-fails', ACCT_P1);
  const originalResolve = fx.store.resolveOperatorAliasAccountForEnv.bind(fx.store);
  fx.store.resolveOperatorAliasAccountForEnv = async (userId, envKey) => envKey === 'missing'
    ? { ok: false as const, reason: 'account_not_found' as const }
    : originalResolve(userId, envKey);
  await withServer(
    {
      store: fx.store, revocation: new TokenRevocationStore(), rateLimiter: new LoginRateLimiter(),
      operatorAlias: { async setForAccount() { throw new Error('database_down'); } },
    },
    baseConfig(0),
    async (base) => {
      const headers = await loggedIn(fx, {} as ClientAuthDeps, base);
      for (const [envKey, status, error] of [
        ['not-owned', 403, 'environment_not_owned'],
        ['unbound', 409, 'binding_unknown'],
        ['missing', 409, 'account_not_found'],
      ] as const) {
        const response = await fetch(`${base}/environments/${envKey}/operator-alias`, {
          method: 'PUT', headers, body: JSON.stringify({ alias: 'name' }),
        });
        assert.equal(response.status, status, envKey);
        assert.deepEqual(await response.json(), { error });
      }
      const invalid = await fetch(`${base}/environments/write-fails/operator-alias`, {
        method: 'PUT', headers, body: JSON.stringify({ alias: 123 }),
      });
      assert.equal(invalid.status, 422);
      const failed = await fetch(`${base}/environments/write-fails/operator-alias`, {
        method: 'PUT', headers, body: JSON.stringify({ alias: 'name' }),
      });
      assert.equal(failed.status, 503);
      assert.deepEqual(await failed.json(), { error: 'operator_alias_write_failed' });
    },
  );
});

test('control-bootstrap 对越权、未绑定与跨客户冲突保持可区分 fail-closed', async () => {
  const fx = makeFakeStore();
  fx.users.set('acme', { userId: 'u1', key: 'ck_secret', status: 'enabled' });
  fx.scope.set('u1', [
    { envKey: 'unknown', label: null, platform: 'facebook', source: 'admin', assignedAt: 0 },
    { envKey: 'contended', label: null, platform: 'facebook', source: 'admin', assignedAt: 0 },
  ]);
  fx.scope.set('u2', [{ envKey: 'other-owner', label: null, platform: 'facebook', source: 'admin', assignedAt: 0 }]);
  fx.bindings.set('contended', ACCT_P1);
  fx.bindings.set('other-owner', ACCT_P1);
  await withServer(
    { store: fx.store, revocation: new TokenRevocationStore(), rateLimiter: new LoginRateLimiter() },
    baseConfig(0),
    async (base) => {
      const headers = await loggedIn(fx, {} as ClientAuthDeps, base);
      for (const [envKey, status, error] of [
        ['not-owned', 403, 'environment_not_owned'],
        ['unknown', 409, 'binding_unknown'],
        ['contended', 409, 'binding_conflict'],
      ] as const) {
        const response = await fetch(`${base}/environments/${envKey}/control-bootstrap`, { headers });
        assert.equal(response.status, status, envKey);
        assert.deepEqual(await response.json(), { error });
      }
    },
  );
});

test('control-bootstrap 在绑定存储不可用和无客户 token 时拒绝', async () => {
  const fx = makeFakeStore();
  fx.users.set('acme', { userId: 'u1', key: 'ck_secret', status: 'enabled' });
  const unavailableStore = {
    ...(fx.store as unknown as Record<string, unknown>),
    async resolveBoundAccountForEnv() { return { ok: false as const, reason: 'binding_unavailable' as const }; },
  } as unknown as ClientUserStore;
  await withServer(
    { store: unavailableStore, revocation: new TokenRevocationStore(), rateLimiter: new LoginRateLimiter() },
    baseConfig(0),
    async (base) => {
      const headers = await loggedIn(fx, {} as ClientAuthDeps, base);
      const unavailable = await fetch(`${base}/environments/p1/control-bootstrap`, { headers });
      assert.equal(unavailable.status, 503);
      assert.deepEqual(await unavailable.json(), { error: 'binding_unavailable' });
      const anonymous = await fetch(`${base}/environments/p1/control-bootstrap`);
      assert.equal(anonymous.status, 401);
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

test('offboard cleanup grant is edge-bound, use-once and never authorizes another environment', async () => {
  const fx = makeFakeStore();
  fx.users.set('bob', { userId: 'user-b', key: 'ck_bob', status: 'enabled' });
  fx.scope.set('user-b', [
    { envKey: 'env-b', label: 'Bob 环境', platform: 'wechat_channels', source: 'admin', assignedAt: 0 },
  ]);
  await withServer(
    { store: fx.store, revocation: new TokenRevocationStore(), rateLimiter: new LoginRateLimiter() },
    baseConfig(0),
    async (base) => {
      const login = await fetch(`${base}/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'bob', key: 'ck_bob' }),
      });
      const token = ((await login.json()) as { token: string }).token;
      const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
      const removed = await fetch(`${base}/environments/env-b`, {
        method: 'DELETE', headers, body: JSON.stringify({ edgeId: 'ads-env-b' }),
      });
      assert.equal(removed.status, 202);
      const receipt = (await removed.json()) as { data: ClientOffboardView & {
        cleanupGrant: string; cleanupGrantExpiresAt: number; cleanupEdgeId: string;
      } };
      assert.equal(receipt.data.cleanupEdgeId, 'ads-env-b');
      assert.ok(receipt.data.cleanupGrantExpiresAt > Date.now());
      assert.equal(typeof receipt.data.cleanupGrant, 'string');

      const mismatched = await fetch(`${base}/offboarding/${receipt.data.offboardId}/cleanup-bootstrap`, {
        method: 'POST', headers,
        body: JSON.stringify({ cleanupGrant: receipt.data.cleanupGrant, edgeId: 'ads-other' }),
      });
      assert.equal(mismatched.status, 403);

      const bootstrap = await fetch(`${base}/offboarding/${receipt.data.offboardId}/cleanup-bootstrap`, {
        method: 'POST', headers,
        body: JSON.stringify({ cleanupGrant: receipt.data.cleanupGrant, edgeId: 'ads-env-b' }),
      });
      assert.equal(bootstrap.status, 200);
      assert.deepEqual((await bootstrap.json() as { data: Record<string, unknown> }).data, {
        mode: 'restricted_cleanup',
        offboardId: receipt.data.offboardId,
        envKey: 'env-b',
        accountId: 'account-env-b',
        edgeId: 'ads-env-b',
      });

      const replay = await fetch(`${base}/offboarding/${receipt.data.offboardId}/cleanup-bootstrap`, {
        method: 'POST', headers,
        body: JSON.stringify({ cleanupGrant: receipt.data.cleanupGrant, edgeId: 'ads-env-b' }),
      });
      assert.equal(replay.status, 409);
      assert.deepEqual(await replay.json(), { error: 'cleanup_grant_already_used' });
    },
  );
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
          source: 'operator_action', sourceConstraints: {}, targetConstraints: {}, approvalMode: 'review', priority: 'normal',
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
    sourcePublishedAtText: '07-20',
    sourcePublishedAt: Date.parse('2026-07-19T16:00:00.000Z'),
    sourcePublishedAtPrecision: 'day',
    sourcePublishedAtStatus: 'parsed',
    sourcePublishedAtObservedAt: Date.parse('2026-07-21T07:30:00.000Z'),
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
      assert.equal(listBody.items[0].sourcePublishedAtText, '07-20');
      assert.equal(listBody.items[0].sourcePublishedAt, Date.parse('2026-07-19T16:00:00.000Z'));
      assert.equal(listBody.items[0].sourcePublishedAtPrecision, 'day');
      assert.equal(listBody.items[0].sourcePublishedAtStatus, 'parsed');
      assert.equal(listBody.items[0].sourcePublishedAtObservedAt, Date.parse('2026-07-21T07:30:00.000Z'));
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
      const detailBody = (await detail.json()) as { item: Record<string, unknown> };
      assert.equal(detailBody.item.body, '这是一段值得参考的正文');
      assert.equal(detailBody.item.sourcePublishedAtText, '07-20');
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
      assert.equal(textStored.source, 'operator_action');
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

function makeEnvironmentRiskDep(options: {
  status?: 'normal' | 'warned' | 'restricted' | 'frozen';
  platform?: string;
  resumedEdges?: number;
  accept?: boolean;
} = {}) {
  const status = options.status ?? 'restricted';
  const calls: Array<Record<string, unknown>> = [];
  let resumed = 0;
  const dep: NonNullable<ClientAuthDeps['environmentRisk']> = {
    platformForAccount(accountId) {
      calls.push({ action: 'platform', accountId });
      return options.platform ?? 'facebook';
    },
    async viewForAccount(accountId) {
      calls.push({ action: 'view', accountId });
      return { status, statusSince: 1000, updatedAt: 2000 };
    },
    async recoverRestrictedForAccount(accountId, reason) {
      calls.push({ action: 'recover', accountId, reason });
      const accepted = options.accept ?? (status === 'restricted' || status === 'normal');
      return {
        accepted,
        ...(accepted ? {} : { refusal: 'state_not_restricted' as const }),
        statusBefore: status,
        state: {
          status: status === 'restricted' && accepted ? 'normal' : status,
          statusSince: status === 'restricted' && accepted ? 3000 : 1000,
          updatedAt: 3000,
        },
        changed: status === 'restricted' && accepted,
      };
    },
    resumeEdgesForAccount(accountId) {
      calls.push({ action: 'resume', accountId });
      resumed += 1;
      return options.resumedEdges ?? 2;
    },
  };
  return { dep, calls, resumedCount: () => resumed };
}

test('环境风险读：离线仍返回 Cloud restricted 真态且 DTO 不含 accountId', async () => {
  const fx = ownerOfP1();
  fx.bindings.set('p1', ACCT_P1);
  const risk = makeEnvironmentRiskDep();
  await withServer(
    { store: fx.store, revocation: new TokenRevocationStore(), rateLimiter: new LoginRateLimiter(), environmentRisk: risk.dep },
    baseConfig(0),
    async (base) => {
      const headers = await loggedIn(fx, {} as ClientAuthDeps, base);
      const res = await fetch(`${base}/environments/p1/risk-state`, { headers });
      assert.equal(res.status, 200);
      const text = await res.text();
      assert.doesNotMatch(text, new RegExp(ACCT_P1));
      const body = JSON.parse(text) as { data: Record<string, unknown> };
      assert.deepEqual(Object.keys(body.data).sort(), ['envKey', 'status', 'statusSince', 'updatedAt']);
      assert.equal(body.data.status, 'restricted');
      assert.deepEqual(risk.calls.filter((c) => c.action === 'view'), [{ action: 'view', accountId: ACCT_P1 }]);
    },
  );
});

test('环境风险读：非所有者与非 Facebook 平台均 fail-closed', async () => {
  const fx = ownerOfP1();
  fx.bindings.set('p1', ACCT_P1);
  const risk = makeEnvironmentRiskDep({ platform: 'wechat_channels' });
  await withServer(
    { store: fx.store, revocation: new TokenRevocationStore(), rateLimiter: new LoginRateLimiter(), environmentRisk: risk.dep },
    baseConfig(0),
    async (base) => {
      const headers = await loggedIn(fx, {} as ClientAuthDeps, base);
      const notOwned = await fetch(`${base}/environments/p2/risk-state`, { headers });
      assert.equal(notOwned.status, 403);
      assert.doesNotMatch(await notOwned.text(), new RegExp(ACCT_P1));
      const unsupported = await fetch(`${base}/environments/p1/risk-state`, { headers });
      assert.equal(unsupported.status, 409);
      assert.equal((await unsupported.json() as { error: string }).error, 'unsupported_platform');
      assert.equal(risk.calls.some((c) => c.action === 'view'), false);
    },
  );
});

test('环境风险恢复：restricted 写后 normal、Cloud 生成理由并回真实 resumedEdges', async () => {
  const fx = ownerOfP1();
  fx.bindings.set('p1', ACCT_P1);
  const risk = makeEnvironmentRiskDep({ resumedEdges: 3 });
  await withServer(
    { store: fx.store, revocation: new TokenRevocationStore(), rateLimiter: new LoginRateLimiter(), environmentRisk: risk.dep },
    baseConfig(0),
    async (base) => {
      const headers = await loggedIn(fx, {} as ClientAuthDeps, base);
      const res = await fetch(`${base}/environments/p1/risk-state/recover`, {
        method: 'POST', headers, body: JSON.stringify({}),
      });
      assert.equal(res.status, 200);
      const text = await res.text();
      assert.doesNotMatch(text, new RegExp(ACCT_P1));
      const body = JSON.parse(text) as { data: Record<string, unknown> };
      assert.deepEqual(Object.keys(body.data).sort(), ['changed', 'envKey', 'resumedEdges', 'status', 'statusSince', 'updatedAt']);
      assert.equal(body.data.status, 'normal');
      assert.equal(body.data.changed, true);
      assert.equal(body.data.resumedEdges, 3);
      const recover = risk.calls.find((c) => c.action === 'recover');
      assert.equal(recover?.accountId, ACCT_P1);
      assert.match(String(recover?.reason), /user=u1:env=p1/);
      assert.equal(risk.resumedCount(), 1);
    },
  );
});

// ── 小红书客户发布队列：环境精确隔离、最小披露与版本化取消 ────────────────

async function createQueuedPublishTask(
  delegatedTasks: DelegatedTaskService,
  sourceRef: string,
): Promise<{ id: string; version: number }> {
  const result = await delegatedTasks.createDraft({
    accountId: ACCT_P1,
    action: 'publish_post',
    targetSuccessCount: 1,
    maxAttempts: 2,
    deadlineAt: Date.now() + 60_000,
    executionWindow: { mode: 'immediate' },
    sourceConstraints: { title: `queue-${sourceRef}` },
    targetConstraints: {},
    approvalMode: 'review',
    priority: 'normal',
    source: 'api',
    sourceRef,
  });
  assert.equal(result.task.status, 'queued');
  return { id: result.task.id, version: result.task.version };
}

test('客户发布队列读只服务精确归属的小红书环境且不回 accountId', async () => {
  const fx = ownerOfP1();
  fx.bindings.set('p1', ACCT_P1);
  let platform = 'xiaohongshu';
  const viewed: string[] = [];
  await withServer(
    {
      store: fx.store,
      revocation: new TokenRevocationStore(),
      rateLimiter: new LoginRateLimiter(),
      publishQueue: {
        platformForAccount: () => platform,
        async viewForAccount(accountId) {
          viewed.push(accountId);
          return {
            summary: { inProgress: 2, waitingForYou: 1, cancellable: 1 },
            tasks: [],
            active: [],
            recent: [],
          };
        },
      },
    },
    baseConfig(0),
    async (base) => {
      const headers = await loggedIn(fx, {} as ClientAuthDeps, base);
      const ok = await fetch(`${base}/environments/p1/publish-queue`, { headers });
      assert.equal(ok.status, 200);
      const text = await ok.text();
      assert.doesNotMatch(text, new RegExp(ACCT_P1));
      assert.deepEqual((JSON.parse(text) as { data: Record<string, unknown> }).data, {
        envKey: 'p1',
        summary: { inProgress: 2, waitingForYou: 1, cancellable: 1 },
        tasks: [],
        active: [],
        recent: [],
      });
      assert.deepEqual(viewed, [ACCT_P1]);

      assert.equal((await fetch(`${base}/environments/p2/publish-queue`, { headers })).status, 403);
      platform = 'facebook';
      const unsupported = await fetch(`${base}/environments/p1/publish-queue`, { headers });
      assert.equal(unsupported.status, 409);
      assert.equal((await unsupported.json() as { error: string }).error, 'unsupported_platform');
      assert.deepEqual(viewed, [ACCT_P1], '非小红书不得触发队列读取');
    },
  );
});

test('客户发布队列取消要求精确环境和版本，并区分立即取消与安全收口', async () => {
  const fx = ownerOfP1();
  fx.bindings.set('p1', ACCT_P1);
  const taskStore = new MemoryDelegatedTaskStore();
  const delegatedTasks = new DelegatedTaskService({
    store: taskStore,
    listAccounts: async () => [{
      accountId: ACCT_P1,
      displayName: '小萝北',
      platform: 'xiaohongshu',
      status: 'active',
    }],
  });
  const publishQueue: NonNullable<ClientAuthDeps['publishQueue']> = {
    platformForAccount: () => 'xiaohongshu',
    async viewForAccount() {
      return { summary: { inProgress: 0, waitingForYou: 0, cancellable: 0 }, tasks: [], active: [], recent: [] };
    },
  };
  const immediate = await createQueuedPublishTask(delegatedTasks, 'immediate');
  const planning = await createQueuedPublishTask(delegatedTasks, 'planning');
  const claimed = await taskStore.claimNext({ workerId: 'test-worker', leaseMs: 60_000 });
  assert.equal(claimed?.id, immediate.id);
  // claimNext 按创建时间稳定排序；把真正 planning 的 id 交给路由，另一条保持 queued。
  const planningId = claimed!.id;
  const queuedId = planning.id;
  const queuedVersion = (await delegatedTasks.get(queuedId)).version;
  const planningVersion = (await delegatedTasks.get(planningId)).version;

  await withServer(
    {
      store: fx.store,
      revocation: new TokenRevocationStore(),
      rateLimiter: new LoginRateLimiter(),
      delegatedTasks,
      publishQueue,
    },
    baseConfig(0),
    async (base) => {
      const headers = await loggedIn(fx, {} as ClientAuthDeps, base);
      const wrongVersion = await fetch(
        `${base}/environments/p1/publish-queue/tasks/${encodeURIComponent(queuedId)}/cancel`,
        { method: 'POST', headers, body: JSON.stringify({ version: queuedVersion - 1 }) },
      );
      assert.equal(wrongVersion.status, 409);
      assert.equal((await wrongVersion.json() as { error: string }).error, 'version_conflict');
      assert.equal((await delegatedTasks.get(queuedId)).status, 'queued', '版本冲突不得自动重试写入');

      const cancelled = await fetch(
        `${base}/environments/p1/publish-queue/tasks/${encodeURIComponent(queuedId)}/cancel`,
        { method: 'POST', headers, body: JSON.stringify({ version: queuedVersion }) },
      );
      assert.equal(cancelled.status, 200);
      const cancelledText = await cancelled.text();
      assert.doesNotMatch(cancelledText, new RegExp(ACCT_P1));
      assert.deepEqual((JSON.parse(cancelledText) as { data: Record<string, unknown> }).data, {
        id: queuedId,
        status: 'cancelled',
        cancelRequested: false,
        version: queuedVersion + 1,
        terminal: true,
      });

      const stopping = await fetch(
        `${base}/environments/p1/publish-queue/tasks/${encodeURIComponent(planningId)}/cancel`,
        { method: 'POST', headers, body: JSON.stringify({ version: planningVersion }) },
      );
      assert.equal(stopping.status, 200);
      const stoppingBody = (await stopping.json()) as { data: Record<string, unknown> };
      assert.deepEqual(stoppingBody.data, {
        id: planningId,
        status: 'planning',
        cancelRequested: true,
        version: planningVersion + 1,
        terminal: false,
      });

      const missingVersion = await fetch(
        `${base}/environments/p1/publish-queue/tasks/${encodeURIComponent(planningId)}/cancel`,
        { method: 'POST', headers, body: JSON.stringify({}) },
      );
      assert.equal(missingVersion.status, 400);
      assert.equal((await missingVersion.json() as { error: string }).error, 'bad_request');
    },
  );
});

test('环境风险恢复：normal 幂等；warned/frozen 拒绝且不恢复 edge', async () => {
  for (const status of ['normal', 'warned', 'frozen'] as const) {
    const fx = ownerOfP1();
    fx.bindings.set('p1', ACCT_P1);
    const risk = makeEnvironmentRiskDep({ status });
    await withServer(
      { store: fx.store, revocation: new TokenRevocationStore(), rateLimiter: new LoginRateLimiter(), environmentRisk: risk.dep },
      baseConfig(0),
      async (base) => {
        const headers = await loggedIn(fx, {} as ClientAuthDeps, base);
        const res = await fetch(`${base}/environments/p1/risk-state/recover`, {
          method: 'POST', headers, body: JSON.stringify({}),
        });
        assert.equal(res.status, status === 'normal' ? 200 : 409, status);
        assert.equal(risk.resumedCount(), status === 'normal' ? 1 : 0, status);
      },
    );
  }
});

test('环境风险恢复：任何客户端选择器都在绑定解析前整块拒绝', async () => {
  const fx = ownerOfP1();
  fx.bindings.set('p1', ACCT_P1);
  const risk = makeEnvironmentRiskDep();
  await withServer(
    { store: fx.store, revocation: new TokenRevocationStore(), rateLimiter: new LoginRateLimiter(), environmentRisk: risk.dep },
    baseConfig(0),
    async (base) => {
      const headers = await loggedIn(fx, {} as ClientAuthDeps, base);
      for (const extra of [
        { accountId: ACCT_P1 }, { kind: 'operator_override_recover' }, { status: 'normal' }, { reason: 'trust me' },
      ]) {
        const res = await fetch(`${base}/environments/p1/risk-state/recover`, {
          method: 'POST', headers, body: JSON.stringify(extra),
        });
        assert.equal(res.status, 422, Object.keys(extra)[0]);
      }
      assert.equal(risk.calls.length, 0, '坏 body 不得触发平台检查、绑定账号取态或恢复');
    },
  );
});

test('环境首页概览：引擎和浏览器均离线仍按持久绑定读取，且响应不泄露 accountId', async () => {
  const fx = ownerOfP1();
  fx.bindings.set('p1', ACCT_P1);
  const reads: string[] = [];
  const dailyUsage = { asOf: 1_721_277_200_000, totals: { view: 17, publish: 1 } };
  await withServer(
    {
      store: fx.store,
      revocation: new TokenRevocationStore(),
      rateLimiter: new LoginRateLimiter(),
      resolveEdgeIdForAccount: () => null,
      environmentOverview: {
        async viewForAccount(accountId) {
          reads.push(accountId);
          return {
            dailyUsage,
            currentPublishState: { state: 'submitted', code: '#42', title: '在途笔记', at: 1_721_277_100_000 },
            lastPublished: { title: '上一篇笔记', at: 1_721_200_000_000 },
          };
        },
      },
    },
    baseConfig(0),
    async (base) => {
      const headers = await loggedIn(fx, {} as ClientAuthDeps, base);
      const response = await fetch(`${base}/environments/p1/overview`, { headers });
      assert.equal(response.status, 200);
      const text = await response.text();
      assert.doesNotMatch(text, new RegExp(ACCT_P1), '客户 DTO 不得泄露绑定账号标识');
      const body = JSON.parse(text) as { data: Record<string, unknown>; meta: { asOf: number } };
      assert.equal(body.data.envKey, 'p1');
      assert.deepEqual(body.data.dailyUsage, dailyUsage);
      assert.deepEqual(body.data.currentPublishState, {
        state: 'submitted', code: '#42', title: '在途笔记', at: 1_721_277_100_000,
      });
      assert.deepEqual(body.data.lastPublished, { title: '上一篇笔记', at: 1_721_200_000_000 });
      assert.equal(typeof body.meta.asOf, 'number');
      assert.deepEqual(reads, [ACCT_P1], '概览读取只使用 Cloud 解析出的绑定账号');
    },
  );
});

test('环境首页概览：非所有者 fail-closed，且 overview provider 不被触达', async () => {
  const fx = ownerOfP1();
  fx.bindings.set('p2', ACCT_P1);
  let reads = 0;
  await withServer(
    {
      store: fx.store,
      revocation: new TokenRevocationStore(),
      rateLimiter: new LoginRateLimiter(),
      environmentOverview: {
        async viewForAccount() {
          reads += 1;
          return null;
        },
      },
    },
    baseConfig(0),
    async (base) => {
      const headers = await loggedIn(fx, {} as ClientAuthDeps, base);
      const response = await fetch(`${base}/environments/p2/overview`, { headers });
      assert.equal(response.status, 403);
      assert.doesNotMatch(await response.text(), new RegExp(ACCT_P1));
      assert.equal(reads, 0);
    },
  );
});

test('环境首页概览：Cloud 聚合失败返回 503，不降级成空计数或从未发布', async () => {
  const fx = ownerOfP1();
  fx.bindings.set('p1', ACCT_P1);
  await withServer(
    {
      store: fx.store,
      revocation: new TokenRevocationStore(),
      rateLimiter: new LoginRateLimiter(),
      environmentOverview: { viewForAccount: async () => null },
    },
    baseConfig(0),
    async (base) => {
      const headers = await loggedIn(fx, {} as ClientAuthDeps, base);
      const response = await fetch(`${base}/environments/p1/overview`, { headers });
      assert.equal(response.status, 503);
      const body = await response.json() as Record<string, unknown>;
      assert.equal(body.error, 'environment_overview_unavailable');
      assert.equal('data' in body, false);
    },
  );
});

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

test('排期占用按环境绑定账号读取且只返回时间戳投影', async () => {
  const fx = ownerOfP1();
  fx.bindings.set('p1', ACCT_P1);
  const calls: string[] = [];
  const first = Date.parse('2026-07-21T08:15:00+08:00');
  const second = Date.parse('2026-07-21T12:00:00+08:00');
  const publishSchedule = {
    async listOccupiedScheduledTimesForAccount(accountId: string) {
      calls.push(accountId);
      return [first, Number.NaN, second];
    },
  };

  await withServer(
    { store: fx.store, revocation: new TokenRevocationStore(), rateLimiter: new LoginRateLimiter(), publishSchedule },
    baseConfig(0),
    async (base) => {
      const headers = await loggedIn(fx, {} as ClientAuthDeps, base);
      const response = await fetch(`${base}/publish-schedule/occupied-hours?envKey=p1`, { headers });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { occupiedTimes: [first, second] });
      assert.deepEqual(calls, [ACCT_P1]);
    },
  );
});

test('排期占用未知绑定 fail-closed，缺能力时独立返回不可用', async () => {
  const fx = ownerOfP1();
  let calls = 0;
  const publishSchedule = {
    async listOccupiedScheduledTimesForAccount() { calls += 1; return []; },
  };

  await withServer(
    { store: fx.store, revocation: new TokenRevocationStore(), rateLimiter: new LoginRateLimiter(), publishSchedule },
    baseConfig(0),
    async (base) => {
      const headers = await loggedIn(fx, {} as ClientAuthDeps, base);
      const unknown = await fetch(`${base}/publish-schedule/occupied-hours?envKey=p1`, { headers });
      assert.equal(unknown.status, 409);
      assert.equal((await unknown.json() as { error: string }).error, 'binding_unknown');
      assert.equal(calls, 0);
    },
  );

  fx.bindings.set('p1', ACCT_P1);
  await withServer(
    { store: fx.store, revocation: new TokenRevocationStore(), rateLimiter: new LoginRateLimiter() },
    baseConfig(0),
    async (base) => {
      const headers = await loggedIn(fx, {} as ClientAuthDeps, base);
      const unavailable = await fetch(`${base}/publish-schedule/occupied-hours?envKey=p1`, { headers });
      assert.equal(unavailable.status, 503);
      assert.equal((await unavailable.json() as { error: string }).error, 'publish_schedule_unavailable');
    },
  );
});

test('环境级人设 API 在 core 离线时按绑定账号读、生成、保存且不泄露 accountId', async () => {
  const fx = ownerOfP1();
  fx.bindings.set('p1', ACCT_P1);
  const calls: Array<Record<string, unknown>> = [];
  const summary = {
    name: '阿柚', role: '数据标注内容分享者', background: '数据标注从业者', tone: '亲切接地气',
    writingLanguage: 'zh-CN' as const, primaryInterests: ['数据标注'], secondaryInterests: ['AI 工具'],
    seedKeywords: ['数据标注兼职'], likeAffinity: 'normal' as const,
  };
  const persona: NonNullable<ClientAuthDeps['persona']> = {
    platformForAccount(accountId) {
      calls.push({ kind: 'platform', accountId });
      return 'facebook';
    },
    async get(accountId) {
      calls.push({ kind: 'get', accountId });
      return {
        ok: true,
        view: {
          state: 'configured',
          persona: { soulYaml: 'soul-current', summary, updatedAt: '2026-07-20T00:00:00.000Z' },
        },
      };
    },
    async generate(input) {
      calls.push({ kind: 'generate', ...input });
      return { ok: true, soulYaml: 'soul-draft', identitySummary: '阿柚·数据标注内容分享者', summary };
    },
    async persist(accountId, soulYaml, updatedBy) {
      calls.push({ kind: 'persist', accountId, soulYaml, updatedBy });
      return {
        ok: true,
        view: {
          state: 'configured',
          persona: { soulYaml, summary, updatedAt: '2026-07-20T01:00:00.000Z' },
        },
        firstPostOnboarding: false,
      };
    },
  };

  await withServer(
    { store: fx.store, revocation: new TokenRevocationStore(), rateLimiter: new LoginRateLimiter(), persona },
    baseConfig(0),
    async (base) => {
      const headers = await loggedIn(fx, {} as ClientAuthDeps, base);
      const read = await fetch(`${base}/environments/p1/persona`, { headers });
      assert.equal(read.status, 200);
      const readBody = await read.json() as { data: Record<string, unknown> };
      assert.equal(readBody.data.envKey, 'p1');
      assert.equal(readBody.data.state, 'configured');
      assert.equal(JSON.stringify(readBody).includes(ACCT_P1), false);

      const draft = await fetch(`${base}/environments/p1/persona/draft`, {
        method: 'POST',
        headers: { ...headers, 'idempotency-key': 'offline-persona-1' },
        body: JSON.stringify({ keywordSelections: ['数据标注', 'like_affinity:normal'], writingLanguage: 'zh-CN' }),
      });
      assert.equal(draft.status, 200);
      const draftBody = await draft.json() as { data: { envKey: string; draft: { soulYaml: string } } };
      assert.equal(draftBody.data.envKey, 'p1');
      assert.equal(draftBody.data.draft.soulYaml, 'soul-draft');
      assert.equal(JSON.stringify(draftBody).includes(ACCT_P1), false);

      const save = await fetch(`${base}/environments/p1/persona`, {
        method: 'PUT', headers, body: JSON.stringify({ soulYaml: 'soul-draft' }),
      });
      assert.equal(save.status, 200);
      const saveBody = await save.json() as { data: Record<string, unknown> };
      assert.equal(saveBody.data.envKey, 'p1');
      assert.equal(saveBody.data.state, 'configured');
      assert.equal(JSON.stringify(saveBody).includes(ACCT_P1), false);
    },
  );

  assert.deepEqual(calls.map((call) => call.kind), ['get', 'platform', 'generate', 'persist']);
  assert.equal(calls.every((call) => call.accountId === ACCT_P1), true);
});

test('环境级人设 API 严格拒绝账号选择器并区分未绑定、非所有者与真实 missing', async () => {
  const fx = ownerOfP1();
  fx.scope.set('u1', [
    ...(fx.scope.get('u1') ?? []),
    { envKey: 'p2', label: '未识别', platform: 'facebook', source: 'admin', assignedAt: 1 },
  ]);
  fx.bindings.set('p1', ACCT_P1);
  let serviceCalls = 0;
  const persona: NonNullable<ClientAuthDeps['persona']> = {
    platformForAccount: () => 'facebook',
    async get() {
      serviceCalls += 1;
      return { ok: true, view: { state: 'missing', persona: null } };
    },
    async generate() {
      serviceCalls += 1;
      return { ok: false, reason: 'generation_failed' };
    },
    async persist() {
      serviceCalls += 1;
      return { ok: false, reason: 'persona_invalid' };
    },
  };

  await withServer(
    { store: fx.store, revocation: new TokenRevocationStore(), rateLimiter: new LoginRateLimiter(), persona },
    baseConfig(0),
    async (base) => {
      const headers = await loggedIn(fx, {} as ClientAuthDeps, base);
      const missing = await fetch(`${base}/environments/p1/persona`, { headers });
      assert.equal(missing.status, 200);
      assert.deepEqual((await missing.json() as { data: unknown }).data, {
        envKey: 'p1', state: 'missing', persona: null,
      });

      const unknown = await fetch(`${base}/environments/p2/persona`, { headers });
      assert.equal(unknown.status, 409);
      assert.equal((await unknown.json() as { error: string }).error, 'binding_unknown');

      const foreign = await fetch(`${base}/environments/not-owned/persona`, { headers });
      assert.equal(foreign.status, 403);
      assert.equal((await foreign.json() as { error: string }).error, 'environment_not_owned');

      const injectedDraft = await fetch(`${base}/environments/p1/persona/draft`, {
        method: 'POST',
        headers: { ...headers, 'idempotency-key': 'offline-persona-2' },
        body: JSON.stringify({ keywordSelections: ['数据标注'], writingLanguage: 'zh-CN', accountId: 'victim' }),
      });
      assert.equal(injectedDraft.status, 422);

      const injectedSave = await fetch(`${base}/environments/p1/persona`, {
        method: 'PUT', headers, body: JSON.stringify({ soulYaml: 'x', accountId: 'victim' }),
      });
      assert.equal(injectedSave.status, 422);

      const unsupportedMethod = await fetch(`${base}/environments/p1/persona`, { method: 'DELETE', headers });
      assert.equal(unsupportedMethod.status, 405);
    },
  );
  assert.equal(serviceCalls, 1, 'only the authoritative missing read reaches the persona service');
});

test('/my-environments 返回绑定与人设权威投影但不泄露 accountId', async () => {
  const fx = ownerOfP1();
  fx.bindings.set('p1', ACCT_P1);
  const persona: NonNullable<ClientAuthDeps['persona']> = {
    platformForAccount: () => 'facebook',
    async get(accountId) {
      assert.equal(accountId, ACCT_P1);
      return {
        ok: true,
        view: {
          state: 'configured',
          persona: {
            soulYaml: 'soul-current',
            summary: {
              name: '阿柚', role: '内容分享者', background: '从业者', tone: '亲切', writingLanguage: 'zh-CN',
              primaryInterests: [], secondaryInterests: [], seedKeywords: [], likeAffinity: 'normal',
            },
            updatedAt: '2026-07-20T00:00:00.000Z',
          },
        },
      };
    },
    async generate() { return { ok: false, reason: 'unavailable' }; },
    async persist() { return { ok: false, reason: 'persist_failed' }; },
  };
  await withServer(
    { store: fx.store, revocation: new TokenRevocationStore(), rateLimiter: new LoginRateLimiter(), persona },
    baseConfig(0),
    async (base) => {
      const headers = await loggedIn(fx, {} as ClientAuthDeps, base);
      const response = await fetch(`${base}/my-environments`, { headers });
      assert.equal(response.status, 200);
      const body = await response.json() as { environments: Array<Record<string, unknown>> };
      assert.deepEqual(body.environments, [{
        envKey: 'p1', label: 'a', platform: 'facebook',
        bindingState: 'bound', personaState: 'configured', personaBound: true,
      }]);
      assert.equal(JSON.stringify(body).includes(ACCT_P1), false);
      assert.equal(JSON.stringify(body).includes('accountId'), false);
    },
  );
});

test('客户待审写在浏览器/core 缺席时按 env 绑定复用领域方法并返回受理真态', async () => {
  const fx = ownerOfP1();
  fx.bindings.set('p1', ACCT_P1);
  const calls: Array<Record<string, unknown>> = [];
  const publishDraftActions: NonNullable<ClientAuthDeps['publishDraftActions']> = {
    async approve(payload, accountId, actor) {
      calls.push({ kind: 'approve', payload, accountId, actor });
      return {
        requestId: payload.requestId,
        ok: true,
        state: payload.approved ? 'approved' : 'rejected',
        currentVersion: payload.contentVersion,
      };
    },
    async removeImage(payload, accountId, actor) {
      calls.push({ kind: 'remove', payload, accountId, actor });
      return { requestId: payload.requestId, ok: true, images: ['https://img/2.jpg'], contentVersion: 4 };
    },
  };
  await withServer(
    { store: fx.store, revocation: new TokenRevocationStore(), rateLimiter: new LoginRateLimiter(), publishDraftActions },
    baseConfig(0),
    async (base) => {
      const headers = await loggedIn(fx, {} as ClientAuthDeps, base);
      const approval = await fetch(`${base}/environments/p1/publish/approval`, {
        method: 'POST', headers,
        body: JSON.stringify({ requestId: 'publish-42', approved: true, contentVersion: 3 }),
      });
      assert.equal(approval.status, 200);
      const approvalBody = await approval.json() as { data: Record<string, unknown> };
      assert.equal(approvalBody.data.receipt, 'accepted_pending_execution');
      assert.equal(approvalBody.data.state, 'approved');
      assert.equal(JSON.stringify(approvalBody).includes(ACCT_P1), false);

      const remove = await fetch(`${base}/environments/p1/publish/draft-image-remove`, {
        method: 'POST', headers,
        body: JSON.stringify({ requestId: 'publish-42', contentVersion: 3, imageUrl: 'https://img/1.jpg' }),
      });
      assert.equal(remove.status, 200);
      const removeBody = await remove.json() as { data: Record<string, unknown> };
      assert.deepEqual(removeBody.data.images, ['https://img/2.jpg']);
      assert.equal(removeBody.data.contentVersion, 4);

      const injected = await fetch(`${base}/environments/p1/publish/approval`, {
        method: 'POST', headers,
        body: JSON.stringify({ requestId: 'publish-42', approved: true, contentVersion: 3, accountId: 'victim' }),
      });
      assert.equal(injected.status, 422);
      const foreign = await fetch(`${base}/environments/not-owned/publish/draft-image-remove`, {
        method: 'POST', headers,
        body: JSON.stringify({ requestId: 'publish-42', contentVersion: 3, imageUrl: 'https://img/1.jpg' }),
      });
      assert.equal(foreign.status, 403);
    },
  );
  assert.deepEqual(calls.map((call) => call.kind), ['approve', 'remove']);
  assert.equal(calls.every((call) => call.accountId === ACCT_P1), true);
  assert.equal(calls.every((call) => call.actor === 'client-auth:u1:p1'), true);
});
