/**
 * 对外客户鉴权 HTTP 服务（进程内、独立端口、**独立 JWT 密钥**）。change edge-client-customer-auth。
 *
 * 与内部面板（8090）**物理隔离**:独立 http.Server、独立路由表、独立 revocation、独立限流、
 * 身份源为 client_users 表（非 env AIDCP_PANEL_USERS）。三条不变量：
 *  - N1 密钥即边界：secret 独立且启动断言 ≠ 面板 secret（相等则拒启，见 startClientAuthApi）。
 *  - N2 结构性无泄漏：环境读只有 store.listEnvScope(userId) 这一个 scoped 方法。
 *  - N3 每请求回库复核 status：验签通过后再查 isEnabled(sub)，停用即时 401。
 *
 * 复用 panel/jwt.ts（signJwt/verifyJwt，独立 secret 即独立域）、panel/revocation.ts、panel/auth.ts:parseBearer。
 * 启动失败一律 started=false 而非抛出，绝不连累边-云闭环与面板。
 */

import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { signJwt, verifyJwt } from '../panel/jwt.js';
import { parseBearer } from '../panel/auth.js';
import type { TokenRevocationStore } from '../panel/revocation.js';
import type { ClientUserStore } from './client-user-store.js';
import type { ClientOffboardView } from './client-user-store.js';
import type { LoginRateLimiter } from './rate-limiter.js';
import { DelegatedTaskServiceError, type DelegatedTaskService } from '../delegated-task/service.js';
import type { DelegatedTaskIntent } from '../delegated-task/types.js';

const MAX_BODY_BYTES = 64 * 1024;

export interface ClientAuthDeps {
  store: ClientUserStore;
  revocation: TokenRevocationStore;
  rateLimiter: LoginRateLimiter;
  /** Customer-scoped delegated tasks. Every route re-checks env ownership from the DB. */
  delegatedTasks?: DelegatedTaskService;
  interactionApi?: {
    handle(req: http.IncomingMessage, res: http.ServerResponse, userId: string): Promise<boolean>;
  };
  onOffboardCreated?: (offboard: ClientOffboardView) => Promise<void>;
}

export interface ClientAuthConfig {
  port: number;
  /** 客户令牌签名密钥（独立于面板）。 */
  jwtSecret: string;
  /** 面板密钥——仅用于启动断言 ≠（N1）；服务运行不使用它。 */
  panelJwtSecret: string;
  jwtTtlSeconds: number;
  forbiddenPorts: number[];
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
}

export type ClientAuthStartReason = 'forbidden_port' | 'missing_secret' | 'secret_collision' | 'listen_error';

export interface ClientAuthHandle {
  started: boolean;
  reason?: ClientAuthStartReason;
  detail?: string;
  port?: number;
  close(): Promise<void>;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(payload);
}

async function readJsonBody(req: http.IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > maxBytes) {
        reject(new Error('body_too_large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('bad_json'));
      }
    });
    req.on('error', reject);
  });
}

/** 取客户端源 IP（Nginx 注入 x-forwarded-for 首段；回落 socket 地址）。 */
function clientIp(req: http.IncomingMessage): string {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) return xff.split(',')[0].trim();
  return req.socket.remoteAddress ?? 'unknown';
}

function createRequestHandler(deps: ClientAuthDeps, config: ClientAuthConfig) {
  const logger = config.logger ?? console;

  async function handleLogin(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch {
      sendJson(res, 400, { error: 'bad_request' });
      return;
    }
    const { name, key } = (body ?? {}) as { name?: unknown; key?: unknown };
    if (typeof name !== 'string' || typeof key !== 'string') {
      sendJson(res, 400, { error: 'bad_request' });
      return;
    }
    const ip = clientIp(req);
    const dims = [`name:${name.trim()}`, `ip:${ip}`];
    const wait = deps.rateLimiter.retryAfter(dims);
    if (wait > 0) {
      sendJson(res, 429, { error: 'rate_limited', retryAfter: wait });
      return;
    }
    const result = await deps.store.verifyLogin(name, key);
    if (!result.ok) {
      deps.rateLimiter.recordFailure(dims);
      // 统一不可区分错误（不区分 name 不存在 / 停用 / key 错），防枚举。
      sendJson(res, 401, { error: 'invalid_credentials' });
      return;
    }
    deps.rateLimiter.clear(dims);
    const token = signJwt({ sub: result.userId }, config.jwtSecret, config.jwtTtlSeconds);
    sendJson(res, 200, { token, expiresIn: config.jwtTtlSeconds });
  }

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const method = req.method ?? 'GET';
    const rawUrl = req.url ?? '/';
    const url = rawUrl.split('?')[0];

    // ── 公开端点 ──────────────────────────────────────────────
    if (method === 'GET' && url === '/health') {
      sendJson(res, 200, { ok: true });
      return;
    }
    if (method === 'POST' && url === '/login') {
      await handleLogin(req, res);
      return;
    }

    // ── 其余受客户令牌保护 ────────────────────────────────────
    const token = parseBearer(req.headers.authorization);
    if (!token) {
      sendJson(res, 401, { error: 'unauthorized', reason: 'missing_token' });
      return;
    }
    const verified = verifyJwt(token, config.jwtSecret);
    if (!verified.valid) {
      sendJson(res, 401, { error: 'unauthorized', reason: verified.reason });
      return;
    }
    if (deps.revocation.isRevoked(verified.payload.jti)) {
      sendJson(res, 401, { error: 'unauthorized', reason: 'revoked' });
      return;
    }
    // N3：每请求回库复核启用态——停用/删除即时失效（范围/状态绝不内嵌令牌）。
    const userId = verified.payload.sub;
    if (!(await deps.store.isEnabled(userId))) {
      sendJson(res, 401, { error: 'unauthorized', reason: 'disabled' });
      return;
    }

    if (method === 'POST' && url === '/auth/refresh') {
      const fresh = signJwt({ sub: userId }, config.jwtSecret, config.jwtTtlSeconds);
      sendJson(res, 200, { token: fresh, expiresIn: config.jwtTtlSeconds });
      return;
    }
    if (method === 'POST' && url === '/logout') {
      deps.revocation.revoke(verified.payload.jti, verified.payload.exp);
      sendJson(res, 200, { ok: true });
      return;
    }
    if (method === 'GET' && url === '/me') {
      sendJson(res, 200, { clientId: userId });
      return;
    }
    // 权威过滤点：只返回该客户归属的环境（N2 scoped 读）。
    if (method === 'GET' && url === '/my-environments') {
      const scope = await deps.store.listEnvScope(userId);
      sendJson(res, 200, { environments: scope.map((s) => ({ envKey: s.envKey, label: s.label, platform: s.platform })) });
      return;
    }
    // 环境归属只能来自内部权威注册表 + 管理员分配。保留旧路由用于明确拒绝
    // 老客户端，绝不把客户提交的 envKey 写入归属表。
    if (method === 'POST' && url === '/environments') {
      try {
        await readJsonBody(req);
      } catch {
        sendJson(res, 400, { error: 'bad_request' });
        return;
      }
      sendJson(res, 403, { error: 'forbidden', reason: 'environment_assignment_admin_only' });
      return;
    }
    const environmentOffboard = /^\/environments\/([^/]+)$/.exec(url);
    if (method === 'DELETE' && environmentOffboard) {
      const envKey = decodeURIComponent(environmentOffboard[1]).trim();
      const result = await deps.store.beginEnvironmentOffboard(userId, envKey);
      if (!result.ok) {
        sendJson(res, result.reason === 'disabled' ? 401 : result.reason === 'not_authorized' ? 404 : 409,
          { error: result.reason });
        return;
      }
      await deps.onOffboardCreated?.(result.offboard);
      sendJson(res, 202, { data: result.offboard, meta: { requestId: randomUUID(), asOf: Date.now() } });
      return;
    }
    const offboardStatus = /^\/offboarding\/([^/]+)$/.exec(url);
    if (method === 'GET' && offboardStatus) {
      const offboard = await deps.store.getOffboard(userId, decodeURIComponent(offboardStatus[1]));
      if (!offboard) {
        sendJson(res, 404, { error: 'not_found' });
        return;
      }
      sendJson(res, 200, { data: offboard, meta: { requestId: randomUUID(), asOf: Date.now() } });
      return;
    }

    // Edge task entry is bound to the selected environment. Scope is read from
    // client_env_scope on every request; accountId is never accepted as an
    // unverified cross-customer selector.
    if (url === '/delegated-tasks' && method === 'GET') {
      if (!deps.delegatedTasks) {
        sendJson(res, 503, { error: 'delegated_tasks_unavailable' });
        return;
      }
      const envKey = (new URL(rawUrl, 'http://localhost').searchParams.get('envKey') ?? '').trim();
      const scope = await deps.store.listEnvScope(userId);
      if (!envKey || !scope.some((item) => item.envKey === envKey)) {
        sendJson(res, 403, { error: 'environment_not_owned' });
        return;
      }
      sendJson(res, 200, { tasks: await deps.delegatedTasks.list({ accountId: envKey, limit: 50 }) });
      return;
    }
    if (url === '/delegated-tasks/draft' && method === 'POST') {
      if (!deps.delegatedTasks) {
        sendJson(res, 503, { error: 'delegated_tasks_unavailable' });
        return;
      }
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch {
        sendJson(res, 400, { error: 'bad_request' });
        return;
      }
      const raw = (body ?? {}) as Partial<DelegatedTaskIntent> & { envKey?: unknown };
      const envKey = typeof raw.envKey === 'string' ? raw.envKey.trim() : '';
      const scope = await deps.store.listEnvScope(userId);
      if (!envKey || !scope.some((item) => item.envKey === envKey)) {
        sendJson(res, 403, { error: 'environment_not_owned' });
        return;
      }
      try {
        const result = await deps.delegatedTasks.createDraft({
          ...raw as DelegatedTaskIntent,
          accountId: envKey,
          source: 'edge',
          sourceRef: typeof raw.sourceRef === 'string' && raw.sourceRef.trim()
            ? raw.sourceRef.trim()
            : `edge:${envKey}:${Date.now()}`,
        });
        sendJson(res, result.created ? 201 : 200, result);
      } catch (err) {
        if (err instanceof DelegatedTaskServiceError) {
          sendJson(res, err.status, { error: err.code, message: err.message });
        } else {
          throw err;
        }
      }
      return;
    }
    const taskAction = /^\/delegated-tasks\/([^/]+)\/(confirm|pause|resume|cancel)$/.exec(url);
    if (taskAction && method === 'POST') {
      if (!deps.delegatedTasks) {
        sendJson(res, 503, { error: 'delegated_tasks_unavailable' });
        return;
      }
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch {
        sendJson(res, 400, { error: 'bad_request' });
        return;
      }
      try {
        const taskId = decodeURIComponent(taskAction[1]);
        const task = await deps.delegatedTasks.get(taskId);
        const scope = await deps.store.listEnvScope(userId);
        if (!scope.some((item) => item.envKey === task.accountId)) {
          sendJson(res, 403, { error: 'environment_not_owned' });
          return;
        }
        const raw = (body ?? {}) as { version?: unknown };
        const version = typeof raw.version === 'number' ? raw.version : undefined;
        const action = taskAction[2];
        const updated = action === 'confirm'
          ? await deps.delegatedTasks.confirm(taskId, version ?? -1)
          : action === 'pause'
            ? await deps.delegatedTasks.pause(taskId, version)
            : action === 'resume'
              ? await deps.delegatedTasks.resume(taskId, version)
              : await deps.delegatedTasks.cancel(taskId, version);
        sendJson(res, 200, { task: updated });
      } catch (err) {
        if (err instanceof DelegatedTaskServiceError) {
          sendJson(res, err.status, { error: err.code, message: err.message });
        } else {
          throw err;
        }
      }
      return;
    }

    if (deps.interactionApi && await deps.interactionApi.handle(req, res, userId)) return;

    sendJson(res, 404, { error: 'not_found' });
  }

  return (req: http.IncomingMessage, res: http.ServerResponse) => {
    void handle(req, res).catch((err) => {
      logger.warn(`[client-auth] 请求处理异常: ${(err as Error).message}`);
      if (!res.headersSent) sendJson(res, 500, { error: 'internal_error' });
    });
  };
}

/**
 * 启动客户鉴权 API。失败（保留端口 / 缺密钥 / 密钥与面板相同 / 端口占用）一律 started=false 而非抛出。
 * N1 头号风险：secret 与面板相同则客户令牌能在内部面板验签通过 → 边界坍塌，故此处硬断言拒启。
 */
export function startClientAuthApi(deps: ClientAuthDeps, config: ClientAuthConfig): Promise<ClientAuthHandle> {
  const logger = config.logger ?? console;
  const noop = async (): Promise<void> => {};

  if (config.forbiddenPorts.includes(config.port)) {
    logger.warn(`[client-auth] 拒绝绑定保留端口 ${config.port}（forbidden_port）——客户鉴权未启动`);
    return Promise.resolve({ started: false, reason: 'forbidden_port', port: config.port, close: noop });
  }
  if (!config.jwtSecret) {
    logger.warn('[client-auth] 未配置 AIDCP_CLIENT_JWT_SECRET（missing_secret）——客户鉴权未启动');
    return Promise.resolve({ started: false, reason: 'missing_secret', close: noop });
  }
  if (config.jwtSecret === config.panelJwtSecret) {
    logger.error(
      '[client-auth] AIDCP_CLIENT_JWT_SECRET 与面板密钥相同（secret_collision）——密钥即边界会坍塌,拒启客户鉴权',
    );
    return Promise.resolve({ started: false, reason: 'secret_collision', close: noop });
  }

  const server = http.createServer(createRequestHandler(deps, config));

  return new Promise<ClientAuthHandle>((resolve) => {
    server.once('error', (err: NodeJS.ErrnoException) => {
      logger.warn(`[client-auth] listen 失败（${err.code ?? err.message}，非致命）——客户鉴权不可用`);
      resolve({ started: false, reason: 'listen_error', detail: err.code ?? err.message, port: config.port, close: noop });
    });
    // 绑 127.0.0.1：与面板同款,由 Nginx 反代（TLS 终止 + 转发,注入 x-forwarded-for）;绝不裸暴露 HTTP 端口。
    server.listen(config.port, '127.0.0.1', () => {
      const addr = server.address();
      const actualPort = typeof addr === 'object' && addr ? addr.port : config.port;
      logger.log(`[client-auth] 客户鉴权 API 已监听 :${actualPort}（/login /my-environments，独立密钥）`);
      resolve({
        started: true,
        port: actualPort,
        close: async () => {
          server.closeAllConnections?.();
          await new Promise<void>((r) => server.close(() => r()));
        },
      });
    });
  });
}
