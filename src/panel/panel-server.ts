/**
 * 面板 API 层：独立 http.Server（独立端口、内网 127.0.0.1，Nginx 反代）+ 极小 switch 路由 + JWT。
 *
 * 红线：
 * - 独立端口、不碰边-云 8787 ws，不触 protocol.ts / command-bridge；
 * - 启动自检拒绝绑定保留端口（8787/5432/8788/isales 等）；
 * - listen 失败（端口占用/初始化错误）非致命——记日志并返回 started=false，绝不抛出让 main() 崩溃，
 *   边-云闭环与飞书核心继续运行。
 *
 * task 1（本文件）：骨架 + JWT 鉴权 + /api/version 漂移哨兵 + summary 骨架（证明注入链路）。
 * 只读接口全集见 task 5；写接口见 task 4。
 */

import http from 'node:http';
import { signJwt, verifyJwt } from './jwt.js';
import { parseBearer, verifyCredentials } from './auth.js';
import { buildVersionPayload } from './version.js';
import type { PanelDeps, PanelConfig, PanelHandle } from './types.js';

/** 登录/写体很小，限制请求体大小防滥用。 */
const MAX_BODY_BYTES = 16 * 1024;

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const buf = Buffer.from(JSON.stringify(body), 'utf8');
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(buf);
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) throw new Error('body_too_large');
    chunks.push(buf);
  }
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function createRequestHandler(
  deps: PanelDeps,
  config: PanelConfig,
): (req: http.IncomingMessage, res: http.ServerResponse) => void {
  const logger = config.logger ?? console;

  async function handleLogin(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch {
      sendJson(res, 400, { error: 'bad_request' });
      return;
    }
    const { username, password } = (body ?? {}) as { username?: unknown; password?: unknown };
    if (typeof username !== 'string' || typeof password !== 'string') {
      sendJson(res, 400, { error: 'bad_request' });
      return;
    }
    if (!verifyCredentials(config.users, username, password)) {
      sendJson(res, 401, { error: 'invalid_credentials' });
      return;
    }
    const token = signJwt({ sub: username }, config.jwtSecret, config.jwtTtlSeconds);
    sendJson(res, 200, { token, expiresIn: config.jwtTtlSeconds });
  }

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const method = req.method ?? 'GET';
    const url = (req.url ?? '/').split('?')[0];

    if (!url.startsWith('/api/')) {
      sendJson(res, 404, { error: 'not_found' });
      return;
    }

    // ── 公开端点（无需 JWT）──────────────────────────────────────────────
    if (method === 'GET' && url === '/api/health') {
      sendJson(res, 200, { ok: true });
      return;
    }
    if (method === 'GET' && url === '/api/version') {
      // 公开：登录页需在登录前读 version（build/health + 枚举）。
      sendJson(res, 200, buildVersionPayload());
      return;
    }
    if (method === 'POST' && url === '/api/auth/login') {
      await handleLogin(req, res);
      return;
    }

    // ── 其余 /api/* 受 JWT 保护 ──────────────────────────────────────────
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

    if (method === 'GET' && url === '/api/me') {
      sendJson(res, 200, { sub: verified.payload.sub, panelApiVersion: buildVersionPayload().panelApiVersion });
      return;
    }
    if (method === 'GET' && url === '/api/dashboard/summary') {
      // task 1 骨架：证明注入链路（真实读 edgeServer）。totals/ratios/accounts/alerts 见 task 5。
      sendJson(res, 200, { asOf: Date.now(), edgesOnline: deps.edgeServer.edgeCount(), partial: true });
      return;
    }

    sendJson(res, 404, { error: 'not_found' });
  }

  return (req, res) => {
    void handle(req, res).catch((err) => {
      logger.warn(`[panel] 请求处理异常: ${(err as Error).message}`);
      if (!res.headersSent) sendJson(res, 500, { error: 'internal_error' });
    });
  };
}

/**
 * 启动面板 API。失败（保留端口/缺密钥/无用户/端口占用）一律返回 started=false 而非抛出，
 * 保证边-云闭环与飞书不受面板影响。
 */
export function startPanelApi(deps: PanelDeps, config: PanelConfig): Promise<PanelHandle> {
  const logger = config.logger ?? console;
  const noop = async (): Promise<void> => {};

  if (config.forbiddenPorts.includes(config.port)) {
    logger.warn(`[panel] 拒绝绑定保留端口 ${config.port}（forbidden_port）——面板未启动，边-云闭环不受影响`);
    return Promise.resolve({ started: false, reason: 'forbidden_port', port: config.port, close: noop });
  }
  if (!config.jwtSecret) {
    logger.warn('[panel] 未配置 JWT 密钥（missing_secret）——面板未启动');
    return Promise.resolve({ started: false, reason: 'missing_secret', close: noop });
  }
  if (config.users.length === 0) {
    logger.warn('[panel] 未配置任何面板用户（no_users）——面板未启动');
    return Promise.resolve({ started: false, reason: 'no_users', close: noop });
  }

  const server = http.createServer(createRequestHandler(deps, config));

  return new Promise<PanelHandle>((resolve) => {
    server.once('error', (err: NodeJS.ErrnoException) => {
      logger.warn(
        `[panel] listen 失败（${err.code ?? err.message}，非致命）——面板不可用，边-云闭环与飞书继续运行`,
      );
      resolve({ started: false, reason: 'listen_error', detail: err.code ?? err.message, port: config.port, close: noop });
    });
    server.listen(config.port, '127.0.0.1', () => {
      const addr = server.address();
      const actualPort = typeof addr === 'object' && addr ? addr.port : config.port;
      logger.log(`[panel] 面板 API 已监听 127.0.0.1:${actualPort}`);
      resolve({
        started: true,
        port: actualPort,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}
