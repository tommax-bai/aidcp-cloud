import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startClientAuthApi } from '../src/client-auth/client-auth-server.js';
import type {
  ClientAuthConfig,
  ClientAuthDeps,
  ClientEnvironmentRiskRecoveryOutcome,
} from '../src/client-auth/client-auth-server.js';
import type {
  ClientUserStore,
  ClientEnvScopeRow,
  ClientOffboardView,
  EnvironmentProxyAuthorityRecord,
  EnvironmentProxyAuthorityValue,
} from '../src/client-auth/client-user-store.js';
import { LoginRateLimiter } from '../src/client-auth/rate-limiter.js';
import { TokenRevocationStore } from '../src/panel/revocation.js';
import { verifyJwt } from '../src/panel/jwt.js';
import { MemoryDelegatedTaskStore } from '../src/delegated-task/store.js';
import { DelegatedTaskService } from '../src/delegated-task/service.js';
import type { CuratedPanelRow } from '../src/cache/curated-content-store.js';
import { CuratedContentUnavailableError } from '../src/cache/curated-content-store.js';
import type { UiDailyUsagePayload, UiSlowStartPayload } from '../src/comm/protocol.js';
import type { PendingPublishPreview } from '../src/publish-agent/publish-log-store.js';
import type { DraftRefinementJob } from '../src/publish-agent/draft-refinement.js';
import type { ClientEnvironmentScheduleView } from '../src/client-auth/client-environment-schedule.js';
import {
  FACEBOOK_RULE_RUNTIME_DEFINITION_ID,
  FACEBOOK_RULE_RUNTIME_DEFINITION_VERSION,
} from '../src/kernel/facebook-rule-mode-types.js';
import type { FacebookOperationPolicyView } from '../src/config/facebook-operation-policy-store.js';

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
  /** envKey → 环境权威平台覆盖（change environment-level-rule-mode-and-approval）。 */
  envPlatforms: Map<string, string | null>;
  /** envKey → 环境级慢启动起点。 */
  slowStarts: Map<string, number | null>;
  /** 创建当刻落库的环境规则模式 / 审批覆盖（change environment-level-rule-mode-and-approval）。 */
  provisionedRuleModes: Map<string, boolean>;
  provisionedOperationPolicies: Map<string, {
    baseMode: 'persona' | 'rule' | 'consumption';
    effectiveMode: null;
    policyRevision: number;
    slowStart: { state: 'active' | 'off' };
    blocker: null;
  }>;
  provisionedApprovalModes: Map<string, string>;
  slowStartWrites: { envKey: string; enabled: boolean }[];
  proxyAuthorities: Map<string, EnvironmentProxyAuthorityRecord>;
  cleanupGrants: Map<string, { edgeId: string; jtiHash: string; expiresAt: number; used: boolean }>;
} {
  const users = new Map<string, { userId: string; key: string; status: 'enabled' | 'disabled' }>();
  const scope = new Map<string, ClientEnvScopeRow[]>();
  const offboards = new Map<string, ClientOffboardView>();
  const registered = new Set<string>();
  const bindings = new Map<string, string>();
  /** envKey → 环境权威平台覆盖（未设即取 client_env_scope 行上的 platform）。 */
  const envPlatforms = new Map<string, string | null>();
  const slowStarts = new Map<string, number | null>();
  /** 创建当刻写下的两项环境配置（change environment-level-rule-mode-and-approval）。 */
  const provisionedRuleModes = new Map<string, boolean>();
  const provisionedOperationPolicies = new Map<string, {
    baseMode: 'persona' | 'rule' | 'consumption';
    effectiveMode: null;
    policyRevision: number;
    slowStart: { state: 'active' | 'off' };
    blocker: null;
  }>();
  const provisionedApprovalModes = new Map<string, string>();
  const slowStartWrites: { envKey: string; enabled: boolean }[] = [];
  const proxyAuthorities = new Map<string, EnvironmentProxyAuthorityRecord>();
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
    /**
     * 环境级配置定位（change environment-level-rule-mode-and-approval）：只核 ownership 与
     * **环境自己的平台**，不要求存在账号绑定；绑定三态如实带出。
     */
    async getOwnedEnvironment(userId: string, envKey: string) {
      const key = (envKey ?? '').trim();
      const row = (scope.get(userId) ?? []).find((item) => item.envKey === key);
      if (!key || !row) return { ok: false as const, reason: 'environment_not_owned' as const };
      const platform = envPlatforms.has(key) ? envPlatforms.get(key)! : (row.platform ?? null);
      const bound = bindings.get(key);
      if (!bound) return { ok: true as const, envKey: key, platform, binding: 'binding_unknown' as const };
      const duplicates = [...bindings.values()].filter((accountId) => accountId === bound).length;
      if (duplicates > 1 || contendedAcrossCustomers(bound, userId)) {
        return { ok: true as const, envKey: key, platform, binding: 'binding_conflict' as const };
      }
      return { ok: true as const, envKey: key, platform, binding: 'bound' as const, accountId: bound };
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
    async readEnvironmentProxyAuthority(userId: string, envKey: string) {
      const owned = (scope.get(userId) ?? []).some((item) => item.envKey === envKey);
      if (!owned) return { ok: false as const, reason: 'environment_not_owned' as const };
      const record = proxyAuthorities.get(envKey);
      return record
        ? { ok: true as const, record }
        : { ok: false as const, reason: 'uninitialized' as const };
    },
    async writeEnvironmentProxyAuthority(userId: string, envKey: string, input: {
      expectedRevision: number | null;
      authority: EnvironmentProxyAuthorityValue;
      source: 'edge_edit' | 'local_migration';
    }) {
      const owned = (scope.get(userId) ?? []).some((item) => item.envKey === envKey);
      if (!owned) return { ok: false as const, reason: 'environment_not_owned' as const };
      const current = proxyAuthorities.get(envKey);
      if ((!current && input.expectedRevision !== null) ||
          (current && input.expectedRevision !== current.revision)) {
        return {
          ok: false as const,
          reason: 'proxy_authority_conflict' as const,
          ...(current ? { currentRevision: current.revision } : {}),
        };
      }
      const record: EnvironmentProxyAuthorityRecord = {
        envKey,
        authority: input.authority,
        revision: (current?.revision ?? 0) + 1,
        source: input.source,
        updatedAt: Date.now(),
      };
      proxyAuthorities.set(envKey, record);
      return { ok: true as const, record };
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
      slowStartEnabled?: boolean; facebookRuleModeEnabled?: boolean; commentApprovalMode?: string;
      facebookOperationMode?: 'persona' | 'slow_start' | 'rule' | 'consumption';
      proxyAuthority: EnvironmentProxyAuthorityValue;
    }) {
      const intent = intents.get(input.intentId);
      if (!intent || intent.userId !== userId || intent.proof !== input.proof) {
        return { ok: false as const, reason: 'invalid_intent' as const };
      }
      if (intent.envKey && intent.envKey !== input.envKey) {
        return { ok: false as const, reason: 'intent_target_mismatch' as const };
      }
      // 三条创建意图闸与真 store 同口径（change environment-level-rule-mode-and-approval）。
      const facebookOnlyIntent = input.facebookOperationMode !== undefined
        || input.slowStartEnabled === true
        || input.facebookRuleModeEnabled === true
        || input.commentApprovalMode !== undefined;
      if (facebookOnlyIntent && input.platform !== 'facebook') {
        return { ok: false as const, reason: 'invalid_environment' as const };
      }
      if (
        (input.facebookOperationMode !== undefined
          && (input.slowStartEnabled !== undefined || input.facebookRuleModeEnabled !== undefined))
        || (input.slowStartEnabled === true && input.facebookRuleModeEnabled === true)
      ) {
        return { ok: false as const, reason: 'conflicting_run_mode' as const };
      }
      const resolvedMode = input.facebookOperationMode
        ?? (input.slowStartEnabled === true
          ? 'slow_start'
          : input.facebookRuleModeEnabled === true
            ? 'rule'
            : 'persona');
      if (intent.envKey === input.envKey) {
        const existingAuthority = proxyAuthorities.get(input.envKey);
        if (!existingAuthority ||
            JSON.stringify(existingAuthority.authority) !== JSON.stringify(input.proxyAuthority)) {
          return { ok: false as const, reason: 'proxy_authority_mismatch' as const };
        }
        const environment = (scope.get(userId) ?? []).find((item) => item.envKey === input.envKey)!;
        const current = provisionedOperationPolicies.get(input.envKey);
        const currentMode = slowStarts.get(input.envKey) != null ? 'slow_start' : current?.baseMode;
        if (current && currentMode !== resolvedMode) {
          return {
            ok: false as const,
            reason: 'intent_operation_mode_mismatch' as const,
            currentFacebookOperationPolicy: current,
          };
        }
        return {
          ok: true as const,
          environment,
          idempotent: true,
          ...(current ? { facebookOperationPolicy: current } : {}),
        };
      }
      if (registered.has(input.envKey) || [...scope.values()].some((items) => items.some((item) => item.envKey === input.envKey))) {
        return { ok: false as const, reason: 'environment_already_registered' as const };
      }
      registered.add(input.envKey);
      intent.envKey = input.envKey;
      const environment: ClientEnvScopeRow = { envKey: input.envKey, label: input.label ?? null,
        platform: input.platform ?? null, source: 'admin', assignedAt: Date.now() };
      scope.set(userId, [...(scope.get(userId) ?? []), environment]);
      slowStarts.set(input.envKey, resolvedMode === 'slow_start' ? Date.now() : null);
      if (input.platform === 'facebook') {
        provisionedOperationPolicies.set(input.envKey, {
          baseMode: resolvedMode === 'slow_start'
            ? 'persona'
            : resolvedMode,
          effectiveMode: null,
          policyRevision: provisionedOperationPolicies.size + 1,
          slowStart: {
            state: resolvedMode === 'slow_start' ? 'active' : 'off',
          },
          blocker: null,
        });
      }
      if (input.facebookRuleModeEnabled === true) provisionedRuleModes.set(input.envKey, true);
      if (input.commentApprovalMode !== undefined) {
        provisionedApprovalModes.set(input.envKey, input.commentApprovalMode);
      }
      proxyAuthorities.set(input.envKey, {
        envKey: input.envKey,
        authority: input.proxyAuthority,
        revision: 1,
        source: 'provisioning',
        updatedAt: Date.now(),
      });
      return {
        ok: true as const,
        environment,
        idempotent: false,
        ...(provisionedOperationPolicies.get(input.envKey)
          ? { facebookOperationPolicy: provisionedOperationPolicies.get(input.envKey)! }
          : {}),
      };
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
    envPlatforms,
    slowStarts,
    provisionedRuleModes,
    provisionedOperationPolicies,
    provisionedApprovalModes,
    slowStartWrites,
    proxyAuthorities,
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

test('proxy authority exact routes enforce ownership and CAS without leaking credentials to roster/errors', async () => {
  const fx = makeFakeStore();
  fx.users.set('alice', { userId: 'u1', key: 'ck_alice', status: 'enabled' });
  fx.users.set('bob', { userId: 'u2', key: 'ck_bob', status: 'enabled' });
  fx.scope.set('u1', [{ envKey: 'p1', label: 'Alice env', platform: 'facebook', source: 'admin', assignedAt: 0 }]);
  fx.scope.set('u2', [{ envKey: 'p2', label: 'Bob env', platform: 'facebook', source: 'admin', assignedAt: 0 }]);
  await withServer(
    { store: fx.store, revocation: new TokenRevocationStore(), rateLimiter: new LoginRateLimiter() },
    baseConfig(0),
    async (base) => {
      const login = await (await fetch(`${base}/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'alice', key: 'ck_alice' }),
      })).json() as { token: string };
      const headers = { authorization: `Bearer ${login.token}`, 'content-type': 'application/json' };
      const credential = {
        state: 'configured',
        proxyType: 'socks5',
        proxyHost: 'proxy.example',
        proxyPort: 1080,
        proxyUser: 'alice-proxy',
        proxyPassword: 'secret-proxy-password',
      };

      const created = await fetch(`${base}/environments/p1/proxy-authority`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ expectedRevision: null, source: 'edge_edit', authority: credential }),
      });
      assert.equal(created.status, 200);
      const createdBody = await created.json() as { data: EnvironmentProxyAuthorityRecord };
      assert.equal(createdBody.data.revision, 1);
      assert.deepEqual(createdBody.data.authority, credential);

      const read = await fetch(`${base}/environments/p1/proxy-authority`, { headers });
      assert.equal(read.status, 200);
      assert.deepEqual((await read.json() as { data: EnvironmentProxyAuthorityRecord }).data.authority, credential);

      const rosterText = await (await fetch(`${base}/my-environments`, { headers })).text();
      assert.doesNotMatch(rosterText, /alice-proxy|secret-proxy-password/);

      const stale = await fetch(`${base}/environments/p1/proxy-authority`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          expectedRevision: 99,
          source: 'edge_edit',
          authority: { state: 'no_proxy' },
        }),
      });
      assert.equal(stale.status, 409);
      const staleText = await stale.text();
      assert.match(staleText, /proxy_authority_conflict/);
      assert.match(staleText, /"currentRevision":1/);
      assert.doesNotMatch(staleText, /alice-proxy|secret-proxy-password/);

      const foreign = await fetch(`${base}/environments/p2/proxy-authority`, { headers });
      assert.equal(foreign.status, 404);
      assert.deepEqual(await foreign.json(), { error: 'environment_not_owned' });

      const cleared = await fetch(`${base}/environments/p1/proxy-authority`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ expectedRevision: 1, source: 'edge_edit', authority: { state: 'no_proxy' } }),
      });
      assert.equal(cleared.status, 200);
      const clearedBody = await cleared.json() as { data: EnvironmentProxyAuthorityRecord };
      assert.equal(clearedBody.data.revision, 2);
      assert.deepEqual(clearedBody.data.authority, { state: 'no_proxy' });
    },
  );
});

test('旧 environment-maintenance poll/claim/result 已退役且不再调用客户存储', async () => {
  const fx = makeFakeStore();
  fx.users.set('acme', { userId: 'u1', key: 'ck_secret', status: 'enabled' });
  const revocation = new TokenRevocationStore();
  await withServer(
    { store: fx.store, revocation, rateLimiter: new LoginRateLimiter() },
    baseConfig(0),
    async (base) => {
      const login = await (await fetch(`${base}/login`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'acme', key: 'ck_secret' }),
      })).json() as { token: string };
      const headers = { authorization: `Bearer ${login.token}`, 'content-type': 'application/json' };

      const poll = await fetch(`${base}/environment-maintenance/poll`, {
        method: 'POST', headers,
        body: JSON.stringify({ installationId: 'installation-1', environments: [{
          envKey: 'p1', environmentName: '环境一', accountId: 'must-not-pass',
        }] }),
      });
      assert.equal(poll.status, 404);

      const claim = await fetch(`${base}/environment-maintenance/deletions/request-1/claim`, {
        method: 'POST', headers, body: JSON.stringify({ installationId: 'installation-1', version: 1 }),
      });
      assert.equal(claim.status, 404);
      const result = await fetch(`${base}/environment-maintenance/deletions/request-1/result`, {
        method: 'PUT', headers: { ...headers, 'idempotency-key': 'result-1' },
        body: JSON.stringify({ installationId: 'installation-1', version: 1,
          status: 'succeeded', resultKind: 'deleted' }),
      });
      assert.equal(result.status, 404);
    },
  );
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
        envKey: 'fresh-env-1', label: '新环境', platform: 'facebook', slowStartEnabled: true,
        proxyAuthority: { state: 'no_proxy' } });
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
      assert.equal(retried.status, 409);
      assert.equal(
        ((await retried.json()) as { error: string }).error,
        'intent_operation_mode_mismatch',
      );
      assert.equal((fx.scope.get('user-a') ?? []).length, 1);
      assert.equal(fx.slowStarts.get('fresh-env-1'), null, '冲突重试不得重新开启已被运营关闭的慢启动');

      const legacyIntent = (await (await fetch(`${base}/environment-provisioning/intents`, {
        method: 'POST', headers, body: '{}',
      })).json()) as { data: { intentId: string; proof: string } };
      const legacy = await fetch(`${base}/environment-provisioning/complete`, {
        method: 'POST', headers, body: JSON.stringify({ intentId: legacyIntent.data.intentId,
          proof: legacyIntent.data.proof, envKey: 'fresh-env-legacy', label: '', platform: 'facebook',
          proxyAuthority: { state: 'no_proxy' } }),
      });
      assert.equal(legacy.status, 201);
      assert.equal(fx.slowStarts.get('fresh-env-legacy'), null, '旧客户端省略字段时保持关闭');

      const xhsIntent = (await (await fetch(`${base}/environment-provisioning/intents`, {
        method: 'POST', headers, body: '{}',
      })).json()) as { data: { intentId: string; proof: string } };
      const xhs = await fetch(`${base}/environment-provisioning/complete`, {
        method: 'POST', headers, body: JSON.stringify({ intentId: xhsIntent.data.intentId,
          proof: xhsIntent.data.proof, envKey: 'fresh-env-xhs', label: '', platform: 'xiaohongshu',
          slowStartEnabled: true, proxyAuthority: { state: 'no_proxy' } }),
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

/**
 * change environment-level-rule-mode-and-approval —— 归属完成接口的线上契约扩展。
 * 白名单只多两个可选键；平台门禁、枚举合法与互斥都在注册环境前判定。
 */
test('归属完成：两个新可选字段落到环境上；白名单外的键、非法枚举与互斥意图整请求拒绝', async () => {
  const fx = makeFakeStore();
  fx.users.set('alice', { userId: 'user-a', key: 'ck_alice', status: 'enabled' });
  await withServer(
    { store: fx.store, revocation: new TokenRevocationStore(), rateLimiter: new LoginRateLimiter() },
    baseConfig(0),
    async (base) => {
      const login = await (await fetch(`${base}/login`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'alice', key: 'ck_alice' }) })).json() as { token: string };
      const headers = { authorization: `Bearer ${login.token}`, 'content-type': 'application/json' };
      const newIntent = async () => (await (await fetch(`${base}/environment-provisioning/intents`, {
        method: 'POST', headers, body: '{}',
      })).json()) as { data: { intentId: string; proof: string } };

      // 规则 + 免审：都落到环境上，慢启动保持关闭（三选一互斥的「规则」分支）。
      const ruleIntent = await newIntent();
      const ruleRun = await fetch(`${base}/environment-provisioning/complete`, {
        method: 'POST', headers, body: JSON.stringify({
          intentId: ruleIntent.data.intentId, proof: ruleIntent.data.proof,
          envKey: 'fb-rule', label: '', platform: 'facebook',
          facebookRuleModeEnabled: true, commentApprovalMode: 'auto_approve_all',
          proxyAuthority: { state: 'no_proxy' },
        }),
      });
      assert.equal(ruleRun.status, 201);
      assert.equal(fx.provisionedRuleModes.get('fb-rule'), true);
      assert.equal(fx.provisionedApprovalModes.get('fb-rule'), 'auto_approve_all');
      assert.equal(fx.slowStarts.get('fb-rule'), null, '选规则时 MUST NOT 同时开慢启动');

      // 互斥：同时提交慢启动与规则模式 → 整请求拒绝，环境不登记。
      const clash = await newIntent();
      const clashed = await fetch(`${base}/environment-provisioning/complete`, {
        method: 'POST', headers, body: JSON.stringify({
          intentId: clash.data.intentId, proof: clash.data.proof,
          envKey: 'fb-clash', label: '', platform: 'facebook',
          slowStartEnabled: true, facebookRuleModeEnabled: true,
          proxyAuthority: { state: 'no_proxy' },
        }),
      });
      assert.equal(clashed.status, 400);
      assert.equal(((await clashed.json()) as { error: string }).error, 'conflicting_run_mode');
      assert.equal(fx.registered.has('fb-clash'), false);

      // 非 Facebook 平台携带任一新字段 → 注册前拒绝。
      for (const extra of [{ facebookRuleModeEnabled: true }, { commentApprovalMode: 'auto_approve_all' }]) {
        const intent = await newIntent();
        const res = await fetch(`${base}/environment-provisioning/complete`, {
          method: 'POST', headers, body: JSON.stringify({
            intentId: intent.data.intentId, proof: intent.data.proof,
            envKey: 'xhs-reject', label: '', platform: 'xiaohongshu',
            ...extra, proxyAuthority: { state: 'no_proxy' },
          }),
        });
        assert.equal(res.status, 400);
        assert.equal(fx.registered.has('xhs-reject'), false);
      }

      // 非法枚举 / 非布尔 / 白名单之外的键：一律整块拒绝且不写入。
      const badBodies: Record<string, unknown>[] = [
        { commentApprovalMode: 'auto_approve' },
        { facebookRuleModeEnabled: 'true' },
        { commentApprovalMode: 'auto_approve_all', accountId: 'acct-1' },
      ];
      for (const extra of badBodies) {
        const intent = await newIntent();
        const res = await fetch(`${base}/environment-provisioning/complete`, {
          method: 'POST', headers, body: JSON.stringify({
            intentId: intent.data.intentId, proof: intent.data.proof,
            envKey: 'fb-bad', label: '', platform: 'facebook',
            ...extra, proxyAuthority: { state: 'no_proxy' },
          }),
        });
        assert.equal(res.status, 400, JSON.stringify(extra));
        assert.equal(fx.registered.has('fb-bad'), false, JSON.stringify(extra));
      }

      // 省略两个字段的旧客户端请求继续成功，一项配置都不写。
      const legacy = await newIntent();
      const legacyRun = await fetch(`${base}/environment-provisioning/complete`, {
        method: 'POST', headers, body: JSON.stringify({
          intentId: legacy.data.intentId, proof: legacy.data.proof,
          envKey: 'fb-legacy', label: '', platform: 'facebook',
          proxyAuthority: { state: 'no_proxy' },
        }),
      });
      assert.equal(legacyRun.status, 201);
      assert.equal(fx.provisionedRuleModes.has('fb-legacy'), false);
      assert.equal(fx.provisionedApprovalModes.has('fb-legacy'), false);
    },
  );
});

test('归属完成：统一模式/legacy/no-field 均返回初始 policy，新旧字段共存含 false 也原子拒绝', async () => {
  const fx = makeFakeStore();
  fx.users.set('alice', { userId: 'user-a', key: 'ck_alice', status: 'enabled' });
  await withServer(
    { store: fx.store, revocation: new TokenRevocationStore(), rateLimiter: new LoginRateLimiter() },
    baseConfig(0),
    async (base) => {
      const login = await (await fetch(`${base}/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'alice', key: 'ck_alice' }),
      })).json() as { token: string };
      const headers = { authorization: `Bearer ${login.token}`, 'content-type': 'application/json' };
      const newIntent = async () => (await (await fetch(`${base}/environment-provisioning/intents`, {
        method: 'POST',
        headers,
        body: '{}',
      })).json()) as { data: { intentId: string; proof: string } };
      const complete = async (envKey: string, extra: Record<string, unknown>) => {
        const intent = await newIntent();
        return fetch(`${base}/environment-provisioning/complete`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            intentId: intent.data.intentId,
            proof: intent.data.proof,
            envKey,
            label: '',
            platform: 'facebook',
            proxyAuthority: { state: 'no_proxy' },
            ...extra,
          }),
        });
      };

      for (const [envKey, extra, expectedBase] of [
        ['new-consumption', { facebookOperationMode: 'consumption' }, 'consumption'],
        ['legacy-rule', { facebookRuleModeEnabled: true }, 'rule'],
        ['legacy-slow', { slowStartEnabled: true }, 'persona'],
        ['legacy-none', {}, 'persona'],
      ] as const) {
        const response = await complete(envKey, extra);
        assert.equal(response.status, 201, envKey);
        const text = await response.text();
        const body = JSON.parse(text) as {
          data: {
            facebookOperationPolicy: {
              baseMode: string;
              policyRevision: number;
              effectiveMode: null;
              slowStart: { state: string };
            };
          };
        };
        assert.equal(body.data.facebookOperationPolicy.baseMode, expectedBase, envKey);
        assert.equal(Number.isSafeInteger(body.data.facebookOperationPolicy.policyRevision), true);
        assert.equal(body.data.facebookOperationPolicy.effectiveMode, null);
        assert.deepEqual(
          body.data.facebookOperationPolicy.slowStart,
          { state: envKey === 'legacy-slow' ? 'active' : 'off' },
        );
        for (const banned of ['viewsPerLike', 'confirmedLikesPerJoin', 'accountId', '"bounds"']) {
          assert.equal(text.includes(banned), false, `${envKey} leaked ${banned}`);
        }
      }
      assert.equal(fx.slowStarts.get('legacy-slow') != null, true);
      assert.equal(fx.provisionedOperationPolicies.get('legacy-none')?.baseMode, 'persona');

      for (const [envKey, legacyField] of [
        ['new-with-slow-false', { slowStartEnabled: false }],
        ['new-with-rule-false', { facebookRuleModeEnabled: false }],
      ] as const) {
        const response = await complete(envKey, {
          facebookOperationMode: 'consumption',
          ...legacyField,
        });
        assert.equal(response.status, 400);
        assert.equal(
          (await response.json() as { error: string }).error,
          'conflicting_run_mode',
        );
        assert.equal(fx.registered.has(envKey), false);
      }

      const xhsIntent = await newIntent();
      const xhs = await fetch(`${base}/environment-provisioning/complete`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          intentId: xhsIntent.data.intentId,
          proof: xhsIntent.data.proof,
          envKey: 'new-xhs-mode',
          label: '',
          platform: 'xiaohongshu',
          facebookOperationMode: 'persona',
          proxyAuthority: { state: 'no_proxy' },
        }),
      });
      assert.equal(xhs.status, 400);
      assert.equal(fx.registered.has('new-xhs-mode'), false);
    },
  );
});

// ── 客户对自有环境的评论审批覆盖（全局免审）读写 ─────────────────────────────

/** 环境评论审批策略假体：只按 (userId, envKey) 归属判定，绝不接受账号选择器。 */
function makeCommentApprovalDep(options: { unavailable?: boolean } = {}) {
  const rows = new Map<string, { mode: 'source_rules' | 'auto_approve_all'; updatedBy: string; updatedAt: number }>();
  const calls: Array<Record<string, unknown>> = [];
  const owned = (userId: string, envKey: string) => userId === 'u1' && envKey === 'p1';
  const project = (envKey: string, boundAccountId: string | null) => {
    const row = rows.get(envKey);
    return {
      envKey,
      mode: row?.mode ?? ('source_rules' as const),
      configured: row != null,
      updatedBy: row?.updatedBy ?? null,
      updatedAt: row?.updatedAt ?? null,
      boundAccountId,
    };
  };
  const dep: NonNullable<ClientAuthDeps['commentApprovalPolicy']> = {
    async getForOwnedEnv(userId, envKey) {
      calls.push({ action: 'get', userId, envKey });
      if (options.unavailable) return { ok: false as const, reason: 'policy_unavailable' as const };
      if (!owned(userId, envKey)) return { ok: false as const, reason: 'environment_not_owned' as const };
      return { ok: true as const, row: project(envKey, null) };
    },
    async setForOwnedEnv(userId, envKey, mode, updatedBy) {
      calls.push({ action: 'set', userId, envKey, mode, updatedBy });
      if (options.unavailable) return { ok: false as const, reason: 'policy_unavailable' as const };
      if (!owned(userId, envKey)) return { ok: false as const, reason: 'environment_not_owned' as const };
      rows.set(envKey, { mode, updatedBy, updatedAt: 1_700_000_000_000 });
      return { ok: true as const, row: project(envKey, null) };
    },
  };
  return { dep, rows, calls };
}

test('免审写：未绑定账号也能保存，回包标注没有执行对象且署名与管理员可区分', async () => {
  const fx = ownerOfP1();
  const { dep, rows, calls } = makeCommentApprovalDep();
  await withServer(
    {
      store: fx.store,
      revocation: new TokenRevocationStore(),
      rateLimiter: new LoginRateLimiter(),
      commentApprovalPolicy: dep,
    },
    baseConfig(0),
    async (base) => {
      assert.equal((await fetch(`${base}/environments/p1/comment-approval`)).status, 401);
      const headers = await loggedIn(fx, {} as ClientAuthDeps, base);
      const res = await fetch(`${base}/environments/p1/comment-approval`, {
        method: 'PUT', headers, body: JSON.stringify({ mode: 'auto_approve_all' }),
      });
      assert.equal(res.status, 200);
      const text = await res.text();
      const body = JSON.parse(text) as {
        data: { envKey: string; commentApproval: Record<string, unknown> };
      };
      assert.equal(body.data.envKey, 'p1');
      assert.deepEqual(body.data.commentApproval, {
        mode: 'auto_approve_all',
        configured: true,
        updatedAt: 1_700_000_000_000,
        hasExecutionTarget: false,
      });
      assert.doesNotMatch(text, new RegExp(ACCT_P1));
      assert.doesNotMatch(text, /updatedBy/, '回包 MUST NOT 泄露内部操作人');
      assert.equal(rows.get('p1')?.updatedBy, 'client:u1', '客户署名 MUST NOT 复用管理员的 panel: 前缀');
      assert.deepEqual(calls, [
        { action: 'set', userId: 'u1', envKey: 'p1', mode: 'auto_approve_all', updatedBy: 'client:u1' },
      ]);

      // 读回同一真态；同样不带账号身份。
      const read = await fetch(`${base}/environments/p1/comment-approval`, { headers });
      assert.equal(read.status, 200);
      assert.equal(
        ((await read.json()) as { data: { commentApproval: { mode: string } } }).data.commentApproval.mode,
        'auto_approve_all',
      );
    },
  );
});

test('免审写：夹带账号选择器或任何其它键整块拒绝，且先于归属解析', async () => {
  const fx = ownerOfP1();
  const { dep, calls } = makeCommentApprovalDep();
  await withServer(
    {
      store: fx.store,
      revocation: new TokenRevocationStore(),
      rateLimiter: new LoginRateLimiter(),
      commentApprovalPolicy: dep,
    },
    baseConfig(0),
    async (base) => {
      const headers = await loggedIn(fx, {} as ClientAuthDeps, base);
      const badBodies: unknown[] = [
        {},
        { mode: 'auto_approve' },
        { mode: 'auto_approve_all', accountId: ACCT_P1 },
        { mode: 'auto_approve_all', updatedBy: 'panel:admin' },
        { accountId: ACCT_P1 },
      ];
      for (const body of badBodies) {
        const res = await fetch(`${base}/environments/p1/comment-approval`, {
          method: 'PUT', headers, body: JSON.stringify(body),
        });
        assert.equal(res.status, 422, JSON.stringify(body));
        assert.equal((await res.json() as { error: string }).error, 'validation_failed');
      }
      // 非所有者环境也用坏 body 打一次：同样 422，MUST NOT 因归属差异漏出状态码侧信道。
      const leak = await fetch(`${base}/environments/p2/comment-approval`, {
        method: 'PUT', headers, body: JSON.stringify({ mode: 'auto_approve_all', accountId: ACCT_P1 }),
      });
      assert.equal(leak.status, 422);
      assert.equal(calls.length, 0, '坏 body MUST 先于归属/store 解析被拒绝');
    },
  );
});

test('免审读写：非所有者 fail-closed 且不泄露策略；策略不可读返回 503 而非「按来源规则」', async () => {
  const fx = ownerOfP1();
  const { dep, calls } = makeCommentApprovalDep();
  await withServer(
    {
      store: fx.store,
      revocation: new TokenRevocationStore(),
      rateLimiter: new LoginRateLimiter(),
      commentApprovalPolicy: dep,
    },
    baseConfig(0),
    async (base) => {
      const headers = await loggedIn(fx, {} as ClientAuthDeps, base);
      for (const init of [
        { headers },
        { method: 'PUT', headers, body: JSON.stringify({ mode: 'auto_approve_all' }) },
      ]) {
        const res = await fetch(`${base}/environments/p2/comment-approval`, init as RequestInit);
        assert.equal(res.status, 404);
        const text = await res.text();
        assert.equal((JSON.parse(text) as { error: string }).error, 'environment_not_found');
        assert.doesNotMatch(text, /source_rules|auto_approve_all/, '非所有者 MUST NOT 看到现有策略');
        assert.doesNotMatch(text, new RegExp(ACCT_P1));
      }
      assert.equal(calls.filter((call) => call.action === 'set').length, 1,
        '非所有者的写请求打到 store 也必须被 store 的同语句 ownership 挡住');
    },
  );

  const unavailable = ownerOfP1();
  await withServer(
    {
      store: unavailable.store,
      revocation: new TokenRevocationStore(),
      rateLimiter: new LoginRateLimiter(),
      commentApprovalPolicy: makeCommentApprovalDep({ unavailable: true }).dep,
    },
    baseConfig(0),
    async (base) => {
      const headers = await loggedIn(unavailable, {} as ClientAuthDeps, base);
      const res = await fetch(`${base}/environments/p1/comment-approval`, { headers });
      assert.equal(res.status, 503);
      const text = await res.text();
      assert.equal((JSON.parse(text) as { error: string }).error, 'comment_approval_policy_unavailable');
      assert.doesNotMatch(text, /source_rules/, '读不到 MUST NOT 伪装成「按来源规则」');
    },
  );

  // 组合根未接线时诚实 503，MUST NOT 假装成「未配置 = 按来源规则」。
  const unwired = ownerOfP1();
  await withServer(
    { store: unwired.store, revocation: new TokenRevocationStore(), rateLimiter: new LoginRateLimiter() },
    baseConfig(0),
    async (base) => {
      const headers = await loggedIn(unwired, {} as ClientAuthDeps, base);
      assert.equal((await fetch(`${base}/environments/p1/comment-approval`, { headers })).status, 503);
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
          envKey: 'existing-env', label: '', platform: 'xiaohongshu',
          proxyAuthority: { state: 'no_proxy' } }) });
      assert.equal(existing.status, 409);
      assert.equal(((await existing.json()) as { error: string }).error, 'environment_already_registered');
      assert.deepEqual(fx.scope.get('user-a'), undefined);

      const freshIntent = (await (await fetch(`${base}/environment-provisioning/intents`, {
        method: 'POST', headers, body: '{}',
      })).json()) as { data: { intentId: string; proof: string } };
      const first = await fetch(`${base}/environment-provisioning/complete`, { method: 'POST', headers,
        body: JSON.stringify({ intentId: freshIntent.data.intentId, proof: freshIntent.data.proof,
          envKey: 'fresh-a', label: '', platform: 'xiaohongshu',
          proxyAuthority: { state: 'no_proxy' } }) });
      assert.equal(first.status, 201);
      const switched = await fetch(`${base}/environment-provisioning/complete`, { method: 'POST', headers,
        body: JSON.stringify({ intentId: freshIntent.data.intentId, proof: freshIntent.data.proof,
          envKey: 'fresh-b', label: '', platform: 'xiaohongshu',
          proxyAuthority: { state: 'no_proxy' } }) });
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
    async listForClient(accountId: string, options: {
      creationStatus: 'uncreated' | 'created' | 'creatable' | 'all';
      sort?: 'weighted' | 'collects' | 'likes' | 'recent';
      limit: number;
      offset: number;
    }) {
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
        options: { creationStatus: 'creatable', sort: 'weighted', limit: 12, offset: 24 },
      }, '旧筛选值必须精确保留原可创作集合');
      const invalid = await fetch(`${base}/curated-contents?envKey=p1&mode=unknown`, { headers });
      assert.equal(invalid.status, 400);
      assert.equal(reads.length, 1, '未知筛选值必须在触达 store 前明确拒绝');

      const invalidSort = await fetch(`${base}/curated-contents?envKey=p1&sort=like_count%20DESC`, { headers });
      assert.equal(invalidSort.status, 400);
      assert.deepEqual(await invalidSort.json(), { error: 'bad_request', reason: 'invalid_sort' });
      assert.equal(reads.length, 1, '未知排序必须在环境解析和精选查询前明确拒绝');

      const listed = await fetch(`${base}/curated-contents?envKey=p1&mode=uncreated&sort=collects&limit=12&offset=24`, { headers });
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
        options: { creationStatus: 'uncreated', sort: 'collects', limit: 12, offset: 24 },
      });
      assert.notEqual(reads[1].accountId, 'p1', 'store 收到的绝不能是 envKey');

      assert.equal((await fetch(`${base}/curated-contents?envKey=p1&mode=created&sort=likes&limit=1&offset=0`, { headers })).status, 200);
      assert.equal((await fetch(`${base}/curated-contents?envKey=p1&mode=all&sort=recent&limit=1&offset=0`, { headers })).status, 200);
      assert.deepEqual(reads.slice(2, 4), [
        { kind: 'list', accountId: ACCT_P1, options: { creationStatus: 'created', sort: 'likes', limit: 1, offset: 0 } },
        { kind: 'list', accountId: ACCT_P1, options: { creationStatus: 'all', sort: 'recent', limit: 1, offset: 0 } },
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

function makeFacebookOperationPolicyDep(options: {
  unavailable?: boolean;
  writeReason?: 'environment_not_found' | 'unsupported_platform' | 'invalid_value'
    | 'revision_conflict' | 'binding_conflict' | 'policy_unavailable';
  legacyRuleReason?: 'environment_not_found' | 'environment_not_owned'
    | 'unsupported_platform' | 'invalid_value' | 'revision_conflict'
    | 'binding_conflict' | 'policy_unavailable' | 'mode_conflict';
  initialMode?: 'persona' | 'rule' | 'consumption';
  slowStartActive?: boolean;
  bindingState?: 'bound' | 'unbound' | 'conflict';
} = {}) {
  const calls: Array<Record<string, unknown>> = [];
  let currentRevision = 7;
  let currentMode: 'persona' | 'rule' | 'consumption' = options.initialMode ?? 'persona';
  let slowStartState: 'active' | 'off' | 'unknown' = options.slowStartActive
    ? 'active'
    : 'unknown';
  let updatedAt: string | null = null;
  const view = (envKey: string): FacebookOperationPolicyView => ({
    envKey,
    baseMode: currentMode,
    effectiveMode: slowStartState === 'active' ? 'slow_start' : null,
    policyRevision: currentRevision,
    schemaVersion: 'facebook_operation_policy@1',
    cadenceSource: 'environment',
    rule: { viewsPerLike: 17, joinEveryNRounds: 4 },
    consumption: {
      viewsPerLike: 19,
      confirmedLikesPerJoin: 6,
      confirmedJoinsPerComment: 3,
    },
    bounds: {
      rule: {
        viewsPerLike: { min: 1, max: 100, default: 5 },
        joinEveryNRounds: { min: 1, max: 20, default: 2 },
      },
      consumption: {
        viewsPerLike: { min: 1, max: 100, default: 5 },
        confirmedLikesPerJoin: { min: 1, max: 20, default: 2 },
        confirmedJoinsPerComment: { min: 1, max: 20, default: 2 },
      },
    },
    slowStart: {
      state: slowStartState,
      since: slowStartState === 'active' ? 1_700_000_000_000 : null,
      globallyDisabled: false,
    },
    binding: {
      state: options.bindingState ?? 'unbound',
      accountId: options.bindingState === 'bound' ? 'internal-account-id' : null,
      accountDisplayName: options.bindingState === 'bound' ? 'Internal Account' : null,
    },
    blocker: null,
    updatedAt,
    updatedBy: null,
  });
  const dep: NonNullable<ClientAuthDeps['facebookOperationPolicy']> = {
    async getForEnv(envKey) {
      calls.push({ action: 'get', envKey });
      return options.unavailable ? null : view(envKey);
    },
    async writeEnvironment(envKey, input, actor) {
      calls.push({ action: 'write', envKey, input, actor });
      if (options.writeReason) {
        return {
          ok: false as const,
          reason: options.writeReason,
          ...(options.writeReason === 'revision_conflict'
            ? { current: view(envKey) }
            : {}),
        };
      }
      currentRevision += 1;
      currentMode = input.mode === 'slow_start' ? 'persona' : input.mode;
      slowStartState = input.mode === 'slow_start' ? 'active' : 'off';
      updatedAt = '2026-07-30T08:00:00.000Z';
      return { ok: true as const, view: view(envKey) };
    },
    async writeLegacyRuleMode(envKey, input, actor) {
      calls.push({ action: 'write_legacy_rule', envKey, input, actor });
      const conflictReason = options.legacyRuleReason
        ?? (slowStartState === 'active' || currentMode === 'consumption'
          ? 'mode_conflict'
          : null);
      if (conflictReason) {
        return {
          ok: false as const,
          reason: conflictReason,
          ...(conflictReason === 'revision_conflict' || conflictReason === 'mode_conflict'
            ? { current: view(envKey) }
            : {}),
        };
      }
      const desiredMode = input.enabled ? 'rule' : 'persona';
      if (desiredMode === currentMode) {
        return { ok: true as const, view: view(envKey), changed: false };
      }
      currentRevision += 1;
      currentMode = desiredMode;
      updatedAt = '2026-07-30T08:00:00.000Z';
      return { ok: true as const, view: view(envKey), changed: true };
    },
    async writeLegacySlowStart(envKey, input, actor) {
      calls.push({ action: 'write_legacy_slow_start', envKey, input, actor });
      currentRevision += 1;
      slowStartState = input.enabled ? 'active' : 'off';
      updatedAt = '2026-07-30T08:00:00.000Z';
      return {
        ok: true as const,
        view: view(envKey),
        slowStartSince: input.enabled ? 1_700_000_000_000 : null,
      };
    },
  };
  return { dep, calls };
}

function makeLegacySlowStartPolicyDep(
  fx: ReturnType<typeof makeFakeStore>,
): NonNullable<ClientAuthDeps['facebookOperationPolicy']> {
  const policy = makeFacebookOperationPolicyDep();
  policy.dep.writeLegacySlowStart = async (envKey, input, actor) => {
    policy.calls.push({ action: 'write_legacy_slow_start', envKey, input, actor });
    const userId = input.requiredOwnerUserId ?? '';
    const stored = await fx.store.setEnvironmentSlowStart(userId, envKey, input.enabled, Date.now());
    if (!stored.ok) {
      return stored.reason === 'environment_not_owned'
        ? { ok: false as const, reason: 'environment_not_owned' as const }
        : { ok: false as const, reason: 'policy_unavailable' as const };
    }
    const view = await policy.dep.getForEnv(envKey);
    assert.ok(view);
    return { ok: true as const, view, slowStartSince: stored.slowStartSince };
  };
  return policy.dep;
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
  outcome?: 'processing' | 'applied' | 'refused' | 'failed' | 'unknown';
  rawOutcomeRiskStatus?: string;
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
    async submitRestrictedRecovery(envKey, accountId, reason, requestedBy) {
      calls.push({ action: 'submit', envKey, accountId, reason, requestedBy });
      return { commandId: '41' };
    },
    async restrictedRecoveryOutcomeOf(
      commandId,
      envKey,
      accountId,
    ): Promise<ClientEnvironmentRiskRecoveryOutcome> {
      calls.push({ action: 'outcome', commandId, envKey, accountId });
      const outcome = options.outcome ?? 'applied';
      if (outcome === 'processing' || outcome === 'unknown') return { commandId, state: outcome };
      if (outcome === 'failed') return { commandId, state: outcome, reason: 'owner_failed' };
      if (outcome === 'refused') {
        return {
          commandId,
          state: outcome,
          reason: 'state_not_restricted',
          risk: { status: 'frozen', statusSince: 2500, updatedAt: 3000 },
        };
      }
      resumed += 1;
      return {
        commandId,
        state: 'applied',
        risk: {
          status: (options.rawOutcomeRiskStatus ?? 'normal') as 'normal',
          statusSince: 3000,
          updatedAt: 3000,
        },
        changed: true,
        resumedEdges: options.resumedEdges ?? 2,
      };
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
      assert.deepEqual(
        Object.keys(body.data).sort(),
        ['changed', 'commandId', 'envKey', 'resumedEdges', 'state', 'status', 'statusSince', 'updatedAt'],
      );
      assert.equal(body.data.commandId, '41');
      assert.equal(body.data.state, 'applied');
      assert.equal(body.data.status, 'normal');
      assert.equal(body.data.changed, true);
      assert.equal(body.data.resumedEdges, 3);
      const submit = risk.calls.find((c) => c.action === 'submit');
      assert.equal(submit?.envKey, 'p1');
      assert.equal(submit?.accountId, ACCT_P1);
      assert.match(String(submit?.reason), /user=u1:env=p1/);
      assert.equal(submit?.requestedBy, 'client-auth:u1:p1');
      assert.equal(risk.resumedCount(), 1);
    },
  );
});

test('环境风险恢复：异步受理返回 202，并按同环境同账号续查同一 command', async () => {
  const fx = ownerOfP1();
  fx.bindings.set('p1', ACCT_P1);
  const risk = makeEnvironmentRiskDep({ outcome: 'processing' });
  await withServer(
    { store: fx.store, revocation: new TokenRevocationStore(), rateLimiter: new LoginRateLimiter(), environmentRisk: risk.dep },
    baseConfig(0),
    async (base) => {
      const headers = await loggedIn(fx, {} as ClientAuthDeps, base);
      const submitted = await fetch(`${base}/environments/p1/risk-state/recover`, {
        method: 'POST', headers, body: JSON.stringify({}),
      });
      assert.equal(submitted.status, 202);
      const submittedBody = (await submitted.json()) as { data: Record<string, unknown> };
      assert.equal(submittedBody.data.status, undefined, '受理回包不得伪造写后 normal');
      assert.deepEqual(submittedBody.data, { envKey: 'p1', commandId: '41', state: 'processing' });

      const polled = await fetch(`${base}/environments/p1/risk-state/recovery-commands/41`, { headers });
      assert.equal(polled.status, 202);
      assert.deepEqual((await polled.json() as { data: Record<string, unknown> }).data, {
        envKey: 'p1',
        commandId: '41',
        state: 'processing',
      });
      assert.ok(risk.calls.some((call) =>
        call.action === 'outcome' &&
        call.commandId === '41' &&
        call.envKey === 'p1' &&
        call.accountId === ACCT_P1));
    },
  );
});

test('环境风险恢复：refused、failed 与 unknown 保持不同 HTTP 结局', async () => {
  for (const [outcome, expectedStatus, expectedError] of [
    ['refused', 409, 'risk_recovery_refused'],
    ['failed', 503, 'risk_recovery_failed'],
    ['unknown', 404, 'risk_recovery_unknown'],
  ] as const) {
    const fx = ownerOfP1();
    fx.bindings.set('p1', ACCT_P1);
    const risk = makeEnvironmentRiskDep({ outcome });
    await withServer(
      { store: fx.store, revocation: new TokenRevocationStore(), rateLimiter: new LoginRateLimiter(), environmentRisk: risk.dep },
      baseConfig(0),
      async (base) => {
        const headers = await loggedIn(fx, {} as ClientAuthDeps, base);
        const res = await fetch(`${base}/environments/p1/risk-state/recover`, {
          method: 'POST', headers, body: JSON.stringify({}),
        });
        assert.equal(res.status, expectedStatus, outcome);
        const body = (await res.json()) as { error: string; data: Record<string, unknown> };
        assert.equal(body.error, expectedError, outcome);
        assert.equal(body.data.state, outcome, outcome);
        assert.equal(risk.resumedCount(), 0, outcome);
      },
    );
  }
});

test('环境风险恢复：非法 owner risk status 只公开稳定 incomplete reason，raw 仅写服务端日志', async () => {
  const fx = ownerOfP1();
  fx.bindings.set('p1', ACCT_P1);
  const rawStatus = 'owner_internal_status';
  const warnings: unknown[][] = [];
  const risk = makeEnvironmentRiskDep({ rawOutcomeRiskStatus: rawStatus });
  await withServer(
    { store: fx.store, revocation: new TokenRevocationStore(), rateLimiter: new LoginRateLimiter(), environmentRisk: risk.dep },
    baseConfig(0, {
      logger: {
        log() {},
        error() {},
        warn(...args: unknown[]) {
          warnings.push(args);
        },
      },
    }),
    async (base) => {
      const headers = await loggedIn(fx, {} as ClientAuthDeps, base);
      const res = await fetch(`${base}/environments/p1/risk-state/recover`, {
        method: 'POST', headers, body: JSON.stringify({}),
      });
      assert.equal(res.status, 503);
      const text = await res.text();
      assert.doesNotMatch(text, new RegExp(rawStatus));
      assert.deepEqual(JSON.parse(text), {
        error: 'risk_recovery_failed',
        data: {
          envKey: 'p1',
          commandId: '41',
          state: 'failed',
          reason: 'recovery_outcome_incomplete',
        },
      });
      assert.match(JSON.stringify(warnings), new RegExp(rawStatus));
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
        assert.equal(risk.resumedCount(), 0, status);
        assert.equal(risk.calls.some((call) => call.action === 'submit'), false, status);
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
  const dailyUsage: UiDailyUsagePayload = {
    asOf: 1_721_277_200_000,
    totals: { view: 17, search: 2, publish: 1 },
    quotas: { view: 35, search: 10, publish: 1 },
    saturated: ['publish'],
    windows: {
      session: { active: false, totals: { search: 1 }, quotas: { search: 3 }, saturated: [] },
      day: { totals: { search: 2 }, quotas: { search: 10 }, saturated: [] },
    },
  };
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
    {
      store: fx.store,
      revocation: new TokenRevocationStore(),
      rateLimiter: new LoginRateLimiter(),
      slowStart: dep,
      facebookOperationPolicy: makeLegacySlowStartPolicyDep(fx),
      resolveEdgeIdForAccount: () => null,
    },
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
    {
      store: fx.store,
      revocation: new TokenRevocationStore(),
      rateLimiter: new LoginRateLimiter(),
      slowStart: dep,
      facebookOperationPolicy: makeLegacySlowStartPolicyDep(fx),
    },
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
    {
      store: fx.store,
      revocation: new TokenRevocationStore(),
      rateLimiter: new LoginRateLimiter(),
      slowStart: dep,
      facebookOperationPolicy: makeLegacySlowStartPolicyDep(fx),
    },
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
    {
      store: fx.store,
      revocation: new TokenRevocationStore(),
      rateLimiter: new LoginRateLimiter(),
      slowStart: dep,
      facebookOperationPolicy: makeLegacySlowStartPolicyDep(fx),
    },
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
    {
      store: fx.store,
      revocation: new TokenRevocationStore(),
      rateLimiter: new LoginRateLimiter(),
      slowStart: dep,
      facebookOperationPolicy: makeLegacySlowStartPolicyDep(fx),
    },
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
    {
      store: fx.store,
      revocation: new TokenRevocationStore(),
      rateLimiter: new LoginRateLimiter(),
      slowStart: dep,
      facebookOperationPolicy: makeLegacySlowStartPolicyDep(fx),
    },
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

// ── Facebook unified operation policy：客户投影无节奏，写入只收 mode + CAS ────

test('统一运行模式：未绑定 fb 别名环境可读写，DTO 无节奏/账号且写入严格走 CAS authority', async () => {
  const fx = ownerOfP1();
  fx.envPlatforms.set('p1', 'fb');
  const policy = makeFacebookOperationPolicyDep();
  await withServer(
    {
      store: fx.store,
      revocation: new TokenRevocationStore(),
      rateLimiter: new LoginRateLimiter(),
      facebookOperationPolicy: policy.dep,
    },
    baseConfig(0),
    async (base) => {
      const headers = await loggedIn(fx, {} as ClientAuthDeps, base);
      const read = await fetch(`${base}/environments/p1/facebook-operation-policy`, { headers });
      assert.equal(read.status, 200);
      const readText = await read.text();
      const readBody = JSON.parse(readText) as {
        data: {
          envKey: string;
          facebookOperationPolicy: Record<string, unknown>;
        };
      };
      assert.equal(readBody.data.envKey, 'p1');
      assert.deepEqual(Object.keys(readBody.data.facebookOperationPolicy).sort(), [
        'baseMode',
        'blocker',
        'effectiveMode',
        'policyRevision',
        'slowStart',
      ]);
      assert.deepEqual(readBody.data.facebookOperationPolicy.slowStart, { state: 'unknown' });
      for (const banned of [
        'accountId',
        'executionTarget',
        'viewsPerLike',
        'confirmedLikesPerJoin',
        'confirmedJoinsPerComment',
        '"rule"',
        '"consumption"',
        '"bounds"',
      ]) {
        assert.equal(readText.includes(banned), false, `customer projection leaked ${banned}`);
      }

      const write = await fetch(`${base}/environments/p1/facebook-operation-policy`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ expectedRevision: 7, mode: 'consumption' }),
      });
      assert.equal(write.status, 200);
      const writeBody = await write.json() as {
        data: { facebookOperationPolicy: { baseMode: string; policyRevision: number } };
      };
      assert.equal(writeBody.data.facebookOperationPolicy.baseMode, 'consumption');
      assert.equal(writeBody.data.facebookOperationPolicy.policyRevision, 8);
      const authorityWrite = policy.calls.find((call) => call.action === 'write')!;
      assert.equal(authorityWrite.envKey, 'p1');
      assert.equal(authorityWrite.actor, 'client:u1');
      assert.deepEqual(
        Object.keys(authorityWrite.input as Record<string, unknown>).sort(),
        ['expectedRevision', 'mode', 'requestId', 'requiredOwnerUserId'],
      );
      assert.equal(
        (authorityWrite.input as { requiredOwnerUserId?: string }).requiredOwnerUserId,
        'u1',
      );
    },
  );
});

test('统一运行模式：夹带节奏/账号在归属写前拒绝；stale 只回 cadence-free current', async () => {
  const fx = ownerOfP1();
  const strict = makeFacebookOperationPolicyDep();
  await withServer(
    {
      store: fx.store,
      revocation: new TokenRevocationStore(),
      rateLimiter: new LoginRateLimiter(),
      facebookOperationPolicy: strict.dep,
    },
    baseConfig(0),
    async (base) => {
      const headers = await loggedIn(fx, {} as ClientAuthDeps, base);
      for (const extra of [
        { viewsPerLike: 5 },
        { accountId: ACCT_P1 },
        { executionTarget: 'dev' },
        { consumption: { confirmedLikesPerJoin: 2 } },
      ]) {
        const response = await fetch(`${base}/environments/p1/facebook-operation-policy`, {
          method: 'PUT',
          headers,
          body: JSON.stringify({ expectedRevision: 7, mode: 'consumption', ...extra }),
        });
        assert.equal(response.status, 422, JSON.stringify(extra));
      }
      assert.equal(strict.calls.some((call) => call.action === 'write'), false);
    },
  );

  const stale = makeFacebookOperationPolicyDep({ writeReason: 'revision_conflict' });
  await withServer(
    {
      store: fx.store,
      revocation: new TokenRevocationStore(),
      rateLimiter: new LoginRateLimiter(),
      facebookOperationPolicy: stale.dep,
    },
    baseConfig(0),
    async (base) => {
      const headers = await loggedIn(fx, {} as ClientAuthDeps, base);
      const response = await fetch(`${base}/environments/p1/facebook-operation-policy`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ expectedRevision: 6, mode: 'rule' }),
      });
      assert.equal(response.status, 409);
      const text = await response.text();
      const body = JSON.parse(text) as {
        error: string;
        current: { envKey: string; facebookOperationPolicy: { policyRevision: number } };
      };
      assert.equal(body.error, 'revision_conflict');
      assert.equal(body.current.envKey, 'p1');
      assert.equal(body.current.facebookOperationPolicy.policyRevision, 7);
      for (const banned of ['viewsPerLike', 'confirmedLikesPerJoin', 'accountId', '"bounds"']) {
        assert.equal(text.includes(banned), false, `conflict projection leaked ${banned}`);
      }
    },
  );
});

test('统一运行模式：foreign、绑定冲突、非 Facebook 与 authority 不可读均 fail-closed', async () => {
  const fx = ownerOfP1();
  const policy = makeFacebookOperationPolicyDep();
  fx.bindings.set('p1', ACCT_P1);
  fx.bindings.set('p2', ACCT_P1);
  await withServer(
    {
      store: fx.store,
      revocation: new TokenRevocationStore(),
      rateLimiter: new LoginRateLimiter(),
      facebookOperationPolicy: policy.dep,
    },
    baseConfig(0),
    async (base) => {
      const headers = await loggedIn(fx, {} as ClientAuthDeps, base);
      const foreign = await fetch(`${base}/environments/p2/facebook-operation-policy`, { headers });
      assert.equal(foreign.status, 403);
      const conflicted = await fetch(`${base}/environments/p1/facebook-operation-policy`, { headers });
      assert.equal(conflicted.status, 409);
      assert.equal((await conflicted.json() as { error: string }).error, 'binding_conflict');
      assert.equal(policy.calls.length, 0);
    },
  );

  fx.bindings.clear();
  fx.envPlatforms.set('p1', 'xiaohongshu');
  await withServer(
    {
      store: fx.store,
      revocation: new TokenRevocationStore(),
      rateLimiter: new LoginRateLimiter(),
      facebookOperationPolicy: policy.dep,
    },
    baseConfig(0),
    async (base) => {
      const headers = await loggedIn(fx, {} as ClientAuthDeps, base);
      const unsupported = await fetch(`${base}/environments/p1/facebook-operation-policy`, { headers });
      assert.equal(unsupported.status, 409);
      assert.equal((await unsupported.json() as { error: string }).error, 'unsupported_platform');
    },
  );

  fx.envPlatforms.set('p1', 'facebook');
  const unavailable = makeFacebookOperationPolicyDep({ unavailable: true });
  await withServer(
    {
      store: fx.store,
      revocation: new TokenRevocationStore(),
      rateLimiter: new LoginRateLimiter(),
      facebookOperationPolicy: unavailable.dep,
    },
    baseConfig(0),
    async (base) => {
      const headers = await loggedIn(fx, {} as ClientAuthDeps, base);
      const response = await fetch(`${base}/environments/p1/facebook-operation-policy`, { headers });
      assert.equal(response.status, 503);
      assert.equal(
        (await response.json() as { error: string }).error,
        'facebook_operation_policy_unavailable',
      );
    },
  );
});

// ── Facebook 规则模式客户开关：envKey 作用域、Cloud 单写、离线可用 ─────────────

test('规则模式读：必须登录；已绑定 Facebook 环境离线可读且只回最小投影', async () => {
  const fx = ownerOfP1();
  fx.bindings.set('p1', ACCT_P1);
  const { dep, calls } = makeFacebookOperationPolicyDep({
    initialMode: 'rule',
    bindingState: 'bound',
  });
  let edgeLookupCalls = 0;
  await withServer(
    {
      store: fx.store,
      revocation: new TokenRevocationStore(),
      rateLimiter: new LoginRateLimiter(),
      facebookOperationPolicy: dep,
      resolveEdgeIdForAccount: () => {
        edgeLookupCalls += 1;
        return null;
      },
    },
    baseConfig(0),
    async (base) => {
      assert.equal((await fetch(`${base}/environments/p1/facebook-rule-mode`)).status, 401);
      const headers = await loggedIn(fx, {} as ClientAuthDeps, base);
      const res = await fetch(`${base}/environments/p1/facebook-rule-mode`, { headers });
      assert.equal(res.status, 200);
      const text = await res.text();
      assert.doesNotMatch(text, new RegExp(ACCT_P1));
      assert.doesNotMatch(text, /updatedBy|panel:admin/);
      const body = JSON.parse(text) as {
        data: { envKey: string; binding: string; facebookRuleMode: Record<string, unknown> };
      };
      assert.equal(body.data.envKey, 'p1');
      assert.deepEqual(body.data.facebookRuleMode, {
        enabled: true,
        definitionId: FACEBOOK_RULE_RUNTIME_DEFINITION_ID,
        definitionVersion: FACEBOOK_RULE_RUNTIME_DEFINITION_VERSION,
        updatedAt: null,
        problem: null,
      });
      assert.equal(edgeLookupCalls, 0, '纯 Cloud 配置读不得要求活 Edge');
      assert.deepEqual(calls, [{ action: 'get', envKey: 'p1' }]);
      assert.equal(body.data.binding, 'bound');
    },
  );
});

test('规则模式兼容写：消费或慢启动生效时冲突且返回统一策略真态', async () => {
  for (const scenario of [
    { initialMode: 'consumption' as const, slowStartActive: false, expectedEffective: null },
    { initialMode: 'persona' as const, slowStartActive: true, expectedEffective: 'slow_start' },
  ]) {
    const fx = ownerOfP1();
    fx.bindings.set('p1', ACCT_P1);
    const policy = makeFacebookOperationPolicyDep(scenario);
    await withServer(
      {
        store: fx.store,
        revocation: new TokenRevocationStore(),
        rateLimiter: new LoginRateLimiter(),
        facebookOperationPolicy: policy.dep,
      },
      baseConfig(0),
      async (base) => {
        const headers = await loggedIn(fx, {} as ClientAuthDeps, base);
        const res = await fetch(`${base}/environments/p1/facebook-rule-mode`, {
          method: 'PUT',
          headers,
          body: JSON.stringify({ enabled: true }),
        });
        assert.equal(res.status, 409);
        const body = await res.json() as {
          error: string;
          current: {
            facebookRuleMode: { enabled: boolean };
            facebookOperationPolicy: { baseMode: string; effectiveMode: string | null };
          };
        };
        assert.equal(body.error, 'facebook_operation_mode_conflict');
        assert.equal(body.current.facebookRuleMode.enabled, false);
        assert.equal(body.current.facebookOperationPolicy.baseMode, scenario.initialMode);
        assert.equal(
          body.current.facebookOperationPolicy.effectiveMode,
          scenario.expectedEffective,
        );
        assert.equal(
          policy.calls.filter((call) => call.action === 'write_legacy_rule').length,
          1,
        );
      },
    );
  }
});

test('规则模式写：只接受 enabled，写后回读 Cloud 真态且不要求环境内核在线', async () => {
  const fx = ownerOfP1();
  fx.bindings.set('p1', ACCT_P1);
  const { dep, calls } = makeFacebookOperationPolicyDep();
  let edgeLookupCalls = 0;
  await withServer(
    {
      store: fx.store,
      revocation: new TokenRevocationStore(),
      rateLimiter: new LoginRateLimiter(),
      facebookOperationPolicy: dep,
      resolveEdgeIdForAccount: () => {
        edgeLookupCalls += 1;
        return null;
      },
    },
    baseConfig(0),
    async (base) => {
      const headers = await loggedIn(fx, {} as ClientAuthDeps, base);
      const res = await fetch(`${base}/environments/p1/facebook-rule-mode`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ enabled: true }),
      });
      assert.equal(res.status, 200);
      const body = await res.json() as {
        data: {
          envKey: string;
          binding: string;
          facebookRuleMode: { enabled: boolean; updatedAt: string | null };
        };
      };
      assert.equal(body.data.envKey, 'p1');
      assert.equal(body.data.facebookRuleMode.enabled, true);
      assert.equal(body.data.facebookRuleMode.updatedAt, '2026-07-30T08:00:00.000Z');
      assert.equal(
        body.data.binding,
        'binding_unknown',
        '成功回包必须采用条件写后的权威 binding，而非 ownership 预检时的旧值',
      );
      assert.equal(edgeLookupCalls, 0, 'Cloud 配置写不得碰活 Edge 佐证');
      assert.equal(calls.length, 2);
      assert.deepEqual(calls[0], { action: 'get', envKey: 'p1' });
      const write = calls[1] as {
        action: string;
        envKey: string;
        input: Record<string, unknown>;
        actor: string;
      };
      assert.equal(write.action, 'write_legacy_rule');
      assert.equal(write.envKey, 'p1');
      assert.equal(write.actor, 'client_rule_compat:u1');
      assert.equal(write.input.enabled, true);
      assert.equal(write.input.expectedRevision, 7);
      assert.equal(write.input.requiredOwnerUserId, 'u1');
      assert.equal(write.input.reason, 'legacy_customer_rule_toggle');
      assert.match(String(write.input.requestId), /^[0-9a-f-]{36}$/);
    },
  );
});

test('规则模式写：夹带账号、规则或空字段整块拒绝且不调用 store', async () => {
  const fx = ownerOfP1();
  fx.bindings.set('p1', ACCT_P1);
  const { dep, calls } = makeFacebookOperationPolicyDep();
  await withServer(
    {
      store: fx.store,
      revocation: new TokenRevocationStore(),
      rateLimiter: new LoginRateLimiter(),
      facebookOperationPolicy: dep,
    },
    baseConfig(0),
    async (base) => {
      const headers = await loggedIn(fx, {} as ClientAuthDeps, base);
      const invalidBodies: unknown[] = [
        {},
        { enabled: 'true' },
        { enabled: true, accountId: ACCT_P1 },
        { enabled: true, definitionVersion: 2 },
      ];
      for (const body of invalidBodies) {
        const res = await fetch(`${base}/environments/p1/facebook-rule-mode`, {
          method: 'PUT',
          headers,
          body: JSON.stringify(body),
        });
        assert.equal(res.status, 422);
        assert.equal((await res.json() as { error: string }).error, 'validation_failed');
      }
      assert.equal(calls.length, 0, '坏 body 必须先于归属/store 解析被拒绝');
    },
  );
});

test('规则模式读写：非所有者与注册表不可读 fail-closed；未绑定 / 绑定冲突仍可配置但如实标注', async () => {
  // change environment-level-rule-mode-and-approval：环境配置不以「此刻有没有执行对象」为前置。
  // 只有 ownership 与注册表可读这两件事失败才拒绝；绑定三态只影响回包的诚实标注。
  const rejections: Array<{
    name: string;
    setup(fx: ReturnType<typeof ownerOfP1>): string;
    expectedStatus: number;
    expectedError: string;
  }> = [
    {
      name: 'environment_not_owned',
      setup(fx) {
        fx.bindings.set('p2', ACCT_P1);
        return 'p2';
      },
      expectedStatus: 403,
      expectedError: 'environment_not_owned',
    },
    {
      name: 'binding_unavailable',
      setup(fx) {
        (fx.store as unknown as { getOwnedEnvironment: unknown }).getOwnedEnvironment =
          async () => ({ ok: false as const, reason: 'binding_unavailable' as const });
        return 'p1';
      },
      expectedStatus: 503,
      expectedError: 'binding_unavailable',
    },
  ];

  for (const item of rejections) {
    const fx = ownerOfP1();
    const envKey = item.setup(fx);
    const { dep, calls } = makeFacebookOperationPolicyDep();
    await withServer(
      {
        store: fx.store,
        revocation: new TokenRevocationStore(),
        rateLimiter: new LoginRateLimiter(),
        facebookOperationPolicy: dep,
      },
      baseConfig(0),
      async (base) => {
        const headers = await loggedIn(fx, {} as ClientAuthDeps, base);
        const res = await fetch(`${base}/environments/${envKey}/facebook-rule-mode`, { headers });
        assert.equal(res.status, item.expectedStatus, item.name);
        const text = await res.text();
        assert.equal((JSON.parse(text) as { error: string }).error, item.expectedError);
        assert.doesNotMatch(text, new RegExp(ACCT_P1));
        assert.equal(calls.length, 0, `${item.name} 不得触达规则 store`);
      },
    );
  }

  // 未绑定账号的自有环境：写入照常落库，回包标注 binding_unknown，且绝不出现账号身份。
  const unbound = ownerOfP1();
  const unboundDep = makeFacebookOperationPolicyDep();
  await withServer(
    {
      store: unbound.store,
      revocation: new TokenRevocationStore(),
      rateLimiter: new LoginRateLimiter(),
      facebookOperationPolicy: unboundDep.dep,
    },
    baseConfig(0),
    async (base) => {
      const headers = await loggedIn(unbound, {} as ClientAuthDeps, base);
      const res = await fetch(`${base}/environments/p1/facebook-rule-mode`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ enabled: true }),
      });
      assert.equal(res.status, 200);
      const text = await res.text();
      const body = JSON.parse(text) as {
        data: { envKey: string; binding: string; facebookRuleMode: { enabled: boolean } };
      };
      assert.equal(body.data.binding, 'binding_unknown');
      assert.equal(body.data.facebookRuleMode.enabled, true);
      assert.doesNotMatch(text, /accountId/);
      assert.equal(
        unboundDep.calls.filter((call) => call.action === 'write_legacy_rule').length,
        1,
      );
    },
  );

  // 绑定冲突：配置仍属于环境、仍可读写，但回包 MUST 标注冲突而不是假装有唯一执行对象。
  const conflicted = ownerOfP1();
  conflicted.bindings.set('p1', ACCT_P1);
  conflicted.bindings.set('p2', ACCT_P1);
  const conflictedDep = makeFacebookOperationPolicyDep({ bindingState: 'conflict' });
  await withServer(
    {
      store: conflicted.store,
      revocation: new TokenRevocationStore(),
      rateLimiter: new LoginRateLimiter(),
      facebookOperationPolicy: conflictedDep.dep,
    },
    baseConfig(0),
    async (base) => {
      const headers = await loggedIn(conflicted, {} as ClientAuthDeps, base);
      const res = await fetch(`${base}/environments/p1/facebook-rule-mode`, { headers });
      assert.equal(res.status, 200);
      const text = await res.text();
      assert.equal((JSON.parse(text) as { data: { binding: string } }).data.binding, 'binding_conflict');
      assert.doesNotMatch(text, new RegExp(ACCT_P1));
    },
  );
});

test('规则模式读写：非 Facebook、组合根缺失与 store 失败均 fail-closed', async () => {
  const fx = ownerOfP1();
  fx.bindings.set('p1', ACCT_P1);
  // 平台判据取**环境自己的权威字段**（change environment-level-rule-mode-and-approval），不再经账号。
  const nonFacebook = ownerOfP1();
  nonFacebook.bindings.set('p1', ACCT_P1);
  nonFacebook.envPlatforms.set('p1', 'xiaohongshu');
  await withServer(
    {
      store: nonFacebook.store,
      revocation: new TokenRevocationStore(),
      rateLimiter: new LoginRateLimiter(),
      facebookOperationPolicy: makeFacebookOperationPolicyDep().dep,
    },
    baseConfig(0),
    async (base) => {
      const headers = await loggedIn(nonFacebook, {} as ClientAuthDeps, base);
      assert.equal((await fetch(`${base}/environments/p1/facebook-rule-mode`, { headers })).status, 409);
    },
  );
  await withServer(
    { store: fx.store, revocation: new TokenRevocationStore(), rateLimiter: new LoginRateLimiter() },
    baseConfig(0),
    async (base) => {
      const headers = await loggedIn(fx, {} as ClientAuthDeps, base);
      assert.equal((await fetch(`${base}/environments/p1/facebook-rule-mode`, { headers })).status, 503);
    },
  );
  await withServer(
    {
      store: fx.store,
      revocation: new TokenRevocationStore(),
      rateLimiter: new LoginRateLimiter(),
      facebookOperationPolicy: makeFacebookOperationPolicyDep({ unavailable: true }).dep,
    },
    baseConfig(0),
    async (base) => {
      const headers = await loggedIn(fx, {} as ClientAuthDeps, base);
      assert.equal((await fetch(`${base}/environments/p1/facebook-rule-mode`, { headers })).status, 503);
    },
  );
  await withServer(
    {
      store: fx.store,
      revocation: new TokenRevocationStore(),
      rateLimiter: new LoginRateLimiter(),
      facebookOperationPolicy: makeFacebookOperationPolicyDep({
        legacyRuleReason: 'environment_not_found',
      }).dep,
    },
    baseConfig(0),
    async (base) => {
      const headers = await loggedIn(fx, {} as ClientAuthDeps, base);
      const res = await fetch(`${base}/environments/p1/facebook-rule-mode`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ enabled: true }),
      });
      assert.equal(res.status, 404);
      assert.equal((await res.json() as { error: string }).error, 'environment_not_found');
    },
  );
  await withServer(
    {
      store: fx.store,
      revocation: new TokenRevocationStore(),
      rateLimiter: new LoginRateLimiter(),
      facebookOperationPolicy: makeFacebookOperationPolicyDep({
        legacyRuleReason: 'mode_conflict',
      }).dep,
    },
    baseConfig(0),
    async (base) => {
      const headers = await loggedIn(fx, {} as ClientAuthDeps, base);
      const res = await fetch(`${base}/environments/p1/facebook-rule-mode`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ enabled: true }),
      });
      assert.equal(res.status, 409);
      assert.equal(
        (await res.json() as { error: string }).error,
        'facebook_operation_mode_conflict',
      );
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
    sourceCuratedId: 7,
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
        'publishMode', 'publishTime', 'sourceCuratedId', 'title', 'topics', 'updatedAt',
      ]);
      assert.equal(body.items[0].sourceCuratedId, 7);
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

test('客户待审稿直接编辑按环境账号与版本收口，并返回最小写后真态', async () => {
  const fx = ownerOfP1();
  fx.bindings.set('p1', ACCT_P1);
  const calls: unknown[] = [];
  const pendingDrafts = {
    async listPendingPublishPreviewsForAccount() { return { items: [], total: 0 }; },
    async pendingPublishPreviewForAccountRecord() { return null; },
  };
  const publishDraftActions: NonNullable<ClientAuthDeps['publishDraftActions']> = {
    async edit(recordId, expectedVersion, patch, accountId, actor) {
      calls.push({ recordId, expectedVersion, patch, accountId, actor });
      return {
        ok: true, contentVersion: 4, title: patch.title ?? '标题', content: patch.content ?? '正文',
        metadata: { topics: patch.topics ?? [] } as never, images: ['https://img/1.jpg'],
      };
    },
    async approve(payload) { return { requestId: payload.requestId, ok: false, reason: 'not_pending' }; },
    async removeImage(payload) { return { requestId: payload.requestId, ok: false, reason: 'not_pending' }; },
  };
  await withServer(
    { store: fx.store, revocation: new TokenRevocationStore(), rateLimiter: new LoginRateLimiter(), pendingDrafts, publishDraftActions },
    baseConfig(0),
    async (base) => {
      const headers = await loggedIn(fx, {} as ClientAuthDeps, base);
      const edited = await fetch(`${base}/environments/p1/publish-drafts/42`, {
        method: 'PATCH', headers,
        body: JSON.stringify({ expectedVersion: 3, title: '新标题', content: '新正文', topics: ['新话题'] }),
      });
      assert.equal(edited.status, 200);
      const body = await edited.json() as { data: { item: Record<string, unknown> } };
      assert.deepEqual(body.data.item, {
        id: 42, title: '新标题', content: '新正文', topics: ['新话题'],
        images: ['https://img/1.jpg'], contentVersion: 4,
      });
      assert.equal(JSON.stringify(body).includes(ACCT_P1), false);

      const injected = await fetch(`${base}/environments/p1/publish-drafts/42`, {
        method: 'PATCH', headers,
        body: JSON.stringify({ expectedVersion: 3, content: 'x', accountId: 'victim' }),
      });
      assert.equal(injected.status, 422);
      const foreign = await fetch(`${base}/environments/not-owned/publish-drafts/42`, {
        method: 'PATCH', headers,
        body: JSON.stringify({ expectedVersion: 3, content: 'x' }),
      });
      assert.equal(foreign.status, 403);
    },
  );
  assert.deepEqual(calls, [{
    recordId: 42, expectedVersion: 3,
    patch: { title: '新标题', content: '新正文', topics: ['新话题'] },
    accountId: ACCT_P1, actor: 'client-auth:u1:p1',
  }]);
});

test('客户创建和读取持久稿件调整任务，选区与响应均最小披露', async () => {
  const fx = ownerOfP1();
  fx.bindings.set('p1', ACCT_P1);
  const item: PendingPublishPreview = {
    id: 42, accountId: ACCT_P1, platform: 'xiaohongshu', kind: 'rewrite', title: '标题',
    content: '开头需要调整的文字结尾', topics: [], images: ['image-a', 'image-b'],
    contentVersion: 3, updatedAt: 1, publishMode: 'immediate', publishTime: null, sourceCuratedId: 7,
  };
  const pendingDrafts = {
    async listPendingPublishPreviewsForAccount() { return { items: [item], total: 1 }; },
    async pendingPublishPreviewForAccountRecord(accountId: string, recordId: number) {
      return accountId === ACCT_P1 && recordId === 42 ? item : null;
    },
  };
  const created: unknown[] = [];
  const refinementJob: DraftRefinementJob = {
    id: '00000000-0000-4000-8000-000000000057', executionTarget: 'dev', accountId: ACCT_P1,
    recordId: 42, expectedVersion: 3, scope: 'selected_text', instruction: '更自然',
    selection: { start: 2, end: 9, text: '需要调整的文字' }, status: 'queued',
    progress: [{ seq: 1, stage: '计划', status: 'running', summary: '核对调整范围', at: 10 }],
    claimToken: null, resultVersion: null, errorCode: null, errorMessage: null,
    createdAt: 1, updatedAt: 1, completedAt: null,
  };
  const draftRefinements: NonNullable<ClientAuthDeps['draftRefinements']> = {
    async create(input) { created.push(input); return refinementJob; },
    async getForAccount(accountId, recordId, jobId) {
      return accountId === ACCT_P1 && recordId === 42 && jobId === refinementJob.id ? refinementJob : null;
    },
    async latestForAccountRecord(accountId, recordId) {
      return accountId === ACCT_P1 && recordId === 42 ? refinementJob : null;
    },
    async latestForAccountRecords(accountId, recordIds) {
      return accountId === ACCT_P1 && recordIds.includes(42) ? new Map([[42, refinementJob]]) : new Map();
    },
  };
  await withServer(
    { store: fx.store, revocation: new TokenRevocationStore(), rateLimiter: new LoginRateLimiter(), pendingDrafts, draftRefinements },
    baseConfig(0),
    async (base) => {
      const headers = await loggedIn(fx, {} as ClientAuthDeps, base);
      const list = await fetch(`${base}/publish-drafts?envKey=p1`, { headers });
      assert.equal(list.status, 200);
      const listed = await list.json() as { items: Array<Record<string, unknown>> };
      assert.deepEqual(listed.items[0].refinement, {
        id: refinementJob.id,
        scope: 'selected_text',
        status: 'queued',
        current: { stage: '计划', status: 'running', summary: '核对调整范围' },
        resultVersion: null,
        error: null,
      });
      const start = await fetch(`${base}/environments/p1/publish-drafts/42/refinements`, {
        method: 'POST', headers,
        body: JSON.stringify({
          expectedVersion: 3, scope: 'selected_text', instruction: '更自然',
          selection: { start: 2, end: 9, text: '需要调整的文字' },
        }),
      });
      assert.equal(start.status, 202);
      const started = await start.json() as { data: { job: Record<string, unknown> } };
      assert.equal(started.data.job.status, 'queued');
      const wire = JSON.stringify(started);
      assert.equal(wire.includes(ACCT_P1), false);
      assert.equal(wire.includes('executionTarget'), false);
      assert.equal(wire.includes('instruction'), false);
      assert.equal(wire.includes('selection'), false);

      const read = await fetch(`${base}/environments/p1/publish-drafts/42/refinements/${refinementJob.id}`, { headers });
      assert.equal(read.status, 200);
      const latest = await fetch(`${base}/environments/p1/publish-drafts/42/refinements/latest`, { headers });
      assert.equal(latest.status, 200);

      const staleSelection = await fetch(`${base}/environments/p1/publish-drafts/42/refinements`, {
        method: 'POST', headers,
        body: JSON.stringify({
          expectedVersion: 3, scope: 'selected_text', instruction: '更自然',
          selection: { start: 2, end: 9, text: '不匹配的文字' },
        }),
      });
      assert.equal(staleSelection.status, 422);
      const injected = await fetch(`${base}/environments/p1/publish-drafts/42/refinements`, {
        method: 'POST', headers,
        body: JSON.stringify({ expectedVersion: 3, scope: 'body', instruction: '更自然', accountId: 'victim' }),
      });
      assert.equal(injected.status, 422);
      const foreign = await fetch(`${base}/environments/not-owned/publish-drafts/42/refinements`, {
        method: 'POST', headers,
        body: JSON.stringify({ expectedVersion: 3, scope: 'body', instruction: '更自然' }),
      });
      assert.equal(foreign.status, 403);
    },
  );
  assert.deepEqual(created, [{
    accountId: ACCT_P1, recordId: 42, expectedVersion: 3, scope: 'selected_text', instruction: '更自然',
    selection: { start: 2, end: 9, text: '需要调整的文字' },
  }]);
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
    async edit(recordId, expectedVersion, patch, accountId, actor) {
      calls.push({ kind: 'edit', recordId, expectedVersion, patch, accountId, actor });
      return { ok: true, contentVersion: expectedVersion + 1, title: patch.title ?? '稿件', content: patch.content ?? '正文', metadata: { topics: patch.topics ?? [] } as never, images: [] };
    },
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

const CLIENT_SCHEDULE_VIEW: ClientEnvironmentScheduleView = {
  timezone: 'Asia/Shanghai',
  weekStartsOn: 'monday',
  autoEnabled: true,
  days: [
    { day: 'monday', activityRanges: [{ startHour: 9, endHour: 12 }], contentRanges: [{ startHour: 10, endHour: 11 }] },
    { day: 'tuesday', activityRanges: [], contentRanges: [] },
    { day: 'wednesday', activityRanges: [], contentRanges: [] },
    { day: 'thursday', activityRanges: [], contentRanges: [] },
    { day: 'friday', activityRanges: [], contentRanges: [] },
    { day: 'saturday', activityRanges: [], contentRanges: [] },
    { day: 'sunday', activityRanges: [], contentRanges: [] },
  ],
  actions: [{
    key: 'post',
    label: '创作与发布',
    dailyCap: 1,
    approval: 'review',
    resultCopy: '草稿完成后等你确认',
  }],
  windows: {
    currentActivity: null,
    currentContent: null,
    nextActivity: {
      day: 'monday', dayIndex: 0, dayOffset: 0,
      startHour: 9, endHour: 12, startsAt: 100, endsAt: 200,
    },
    nextContent: {
      day: 'monday', dayIndex: 0, dayOffset: 0,
      startHour: 10, endHour: 11, startsAt: 120, endsAt: 180,
    },
  },
};

test('环境排期：离线可读、按绑定账号判平台并返回最小客户 DTO', async () => {
  const fx = ownerOfP1();
  fx.bindings.set('p1', ACCT_P1);
  const calls: string[] = [];
  const environmentSchedule: NonNullable<ClientAuthDeps['environmentSchedule']> = {
    platformForAccount(accountId) {
      calls.push(`platform:${accountId}`);
      return 'xiaohongshu';
    },
    viewForAccount(accountId) {
      calls.push(`view:${accountId}`);
      return CLIENT_SCHEDULE_VIEW;
    },
  };
  await withServer(
    {
      store: fx.store,
      revocation: new TokenRevocationStore(),
      rateLimiter: new LoginRateLimiter(),
      environmentSchedule,
    },
    baseConfig(0),
    async (base) => {
      const headers = await loggedIn(fx, {} as ClientAuthDeps, base);
      const response = await fetch(`${base}/environments/p1/schedule`, { headers });
      assert.equal(response.status, 200);
      const body = await response.json() as {
        data: ClientEnvironmentScheduleView & { envKey: string };
        meta: { requestId: string; asOf: number };
      };
      assert.equal(body.data.envKey, 'p1');
      assert.equal(body.data.timezone, 'Asia/Shanghai');
      assert.deepEqual(body.data.days[0].activityRanges, [{ startHour: 9, endHour: 12 }]);
      assert.deepEqual(body.data.actions.map((action) => action.label), ['创作与发布']);
      assert.ok(body.meta.requestId);
      assert.ok(Number.isFinite(body.meta.asOf));
      const json = JSON.stringify(body);
      for (const forbidden of ['accountId', 'activeWeekMask', 'effectiveMask', 'override', 'updatedBy']) {
        assert.equal(json.includes(forbidden), false, forbidden);
      }
    },
  );
  assert.deepEqual(calls, [`platform:${ACCT_P1}`, `view:${ACCT_P1}`]);
});

test('环境排期：非小红书、绑定未知与依赖不可用均诚实失败', async () => {
  const fx = ownerOfP1();
  await withServer(
    {
      store: fx.store,
      revocation: new TokenRevocationStore(),
      rateLimiter: new LoginRateLimiter(),
      environmentSchedule: {
        platformForAccount: () => 'xiaohongshu',
        viewForAccount: () => CLIENT_SCHEDULE_VIEW,
      },
    },
    baseConfig(0),
    async (base) => {
      const headers = await loggedIn(fx, {} as ClientAuthDeps, base);
      assert.equal((await fetch(`${base}/environments/p1/schedule`, { headers })).status, 409);
    },
  );

  fx.bindings.set('p1', ACCT_P1);
  await withServer(
    {
      store: fx.store,
      revocation: new TokenRevocationStore(),
      rateLimiter: new LoginRateLimiter(),
      environmentSchedule: {
        platformForAccount: () => 'facebook',
        viewForAccount: () => CLIENT_SCHEDULE_VIEW,
      },
    },
    baseConfig(0),
    async (base) => {
      const headers = await loggedIn(fx, {} as ClientAuthDeps, base);
      const unsupported = await fetch(`${base}/environments/p1/schedule`, { headers });
      assert.equal(unsupported.status, 409);
      assert.deepEqual(await unsupported.json(), { error: 'unsupported_platform' });
    },
  );

  await withServer(
    { store: fx.store, revocation: new TokenRevocationStore(), rateLimiter: new LoginRateLimiter() },
    baseConfig(0),
    async (base) => {
      const headers = await loggedIn(fx, {} as ClientAuthDeps, base);
      assert.equal((await fetch(`${base}/environments/p1/schedule`, { headers })).status, 503);
    },
  );
});

test('环境排期：非 GET 不形成客户写通道', async () => {
  const fx = ownerOfP1();
  fx.bindings.set('p1', ACCT_P1);
  let viewCalls = 0;
  await withServer(
    {
      store: fx.store,
      revocation: new TokenRevocationStore(),
      rateLimiter: new LoginRateLimiter(),
      environmentSchedule: {
        platformForAccount: () => 'xiaohongshu',
        viewForAccount: () => {
          viewCalls += 1;
          return CLIENT_SCHEDULE_VIEW;
        },
      },
    },
    baseConfig(0),
    async (base) => {
      const headers = await loggedIn(fx, {} as ClientAuthDeps, base);
      const response = await fetch(`${base}/environments/p1/schedule`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ activeWeekMask: '1'.repeat(168), autoEnabled: true }),
      });
      assert.equal(response.status, 404);
    },
  );
  assert.equal(viewCalls, 0);
});
