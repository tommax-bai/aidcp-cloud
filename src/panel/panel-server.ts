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
import { startPanelWs, type PanelWsHandle } from './panel-ws.js';
import type { PublishApprovalPayload } from '../feishu/index.js';

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
      const [totals, likeRate, accounts, todayPublishes] = await Promise.all([
        deps.panelStore.todayTotals(),
        deps.panelStore.likeRate(),
        deps.panelStore.listAccounts(),
        deps.panelStore.todayPublishCount(),
      ]);
      sendJson(res, 200, {
        asOf: Date.now(),
        edgesOnline: deps.edgeServer.onlineEdgeCount(), // staleness-aware（死连接不算在线，D9）
        totals: { ...totals, publish: todayPublishes },
        likeRate,
        accounts,
        alerts: [], // V1（无数据源，前端开空态）
        // 归因未落地：totals/likeRate 为全局，按账号切片须标「attribution pending」（interaction-attribution 红线）
        attributionPending: true,
      });
      return;
    }
    if (method === 'GET' && url === '/api/accounts') {
      sendJson(res, 200, { accounts: await deps.panelStore.listAccounts() });
      return;
    }
    if (method === 'GET' && url.startsWith('/api/accounts/')) {
      const id = decodeURIComponent(url.slice('/api/accounts/'.length));
      const account = await deps.panelStore.getAccount(id);
      if (!account) {
        sendJson(res, 404, { error: 'not_found' });
        return;
      }
      sendJson(res, 200, account);
      return;
    }
    if (method === 'GET' && url === '/api/content/published') {
      sendJson(res, 200, { items: await deps.panelStore.publishedHistory(50) });
      return;
    }
    if (method === 'GET' && url === '/api/content/queue') {
      sendJson(res, 200, deps.publishOrchestrator.getStatus());
      return;
    }
    if (method === 'GET' && url === '/api/analytics/like-rate') {
      sendJson(res, 200, await deps.panelStore.likeRate());
      return;
    }

    // ── 写操作（task 4）：经拥有写的对象，绝不乐观假成功 ──────────────────
    if (method === 'POST' && url.startsWith('/api/publish/') && url.endsWith('/approve')) {
      const requestId = decodeURIComponent(url.slice('/api/publish/'.length, -'/approve'.length));
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch {
        sendJson(res, 400, { error: 'bad_request' });
        return;
      }
      const { approved, payload } = (body ?? {}) as { approved?: unknown; payload?: PublishApprovalPayload };
      if (typeof approved !== 'boolean') {
        sendJson(res, 400, { error: 'bad_request' });
        return;
      }
      // payload 对 Web 审批为占位（edge 从 publish.request 已知内容）；first-writer-wins 的决定才是关键
      const result = await deps.writeApprovalSignal(
        requestId,
        approved,
        payload ?? { title: '', content: '', tags: [] },
      );
      sendJson(res, 200, result); // {written} 或 {alreadyDecided}，绝不 published
      return;
    }
    if (method === 'POST' && url.startsWith('/api/accounts/') && url.endsWith('/command')) {
      const accountId = decodeURIComponent(url.slice('/api/accounts/'.length, -'/command'.length));
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch {
        sendJson(res, 400, { error: 'bad_request' });
        return;
      }
      const { command } = (body ?? {}) as { command?: unknown };
      if (command === 'pause') {
        sendJson(res, 200, await deps.commandActions.pause(accountId));
        return;
      }
      if (command === 'resume') {
        sendJson(res, 200, await deps.commandActions.resume(accountId));
        return;
      }
      sendJson(res, 400, { error: 'bad_request', reason: 'unknown_command' });
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
      // attach 面板 WS（同端口 /ws，纯只读 EventBus 扇出，绝不碰 edge）。失败非致命，/api 仍可用。
      let panelWs: PanelWsHandle | undefined;
      try {
        panelWs = startPanelWs({
          httpServer: server,
          eventBus: deps.eventBus,
          jwtSecret: config.jwtSecret,
          logger,
        });
      } catch (err) {
        logger.warn(`[panel] 面板 WS attach 失败（非致命，/api 仍可用）: ${(err as Error).message}`);
      }
      logger.log(`[panel] 面板 API 已监听 127.0.0.1:${actualPort}（/api${panelWs ? ' + /ws 面板事件流' : ''}）`);
      resolve({
        started: true,
        port: actualPort,
        close: async () => {
          if (panelWs) await panelWs.close();
          // 强制断开 keep-alive 连接，使 server.close 能及时完成（优雅关闭）
          server.closeAllConnections?.();
          await new Promise<void>((r) => server.close(() => r()));
        },
      });
    });
  });
}
