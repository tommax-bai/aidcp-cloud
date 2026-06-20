/**
 * 面板 WebSocket：纯只读事件扇出。
 *
 * 订阅云内 EventBus（onAny），归一化为面板帧，单一全局流广播给所有浏览器客户端。
 * 红线：
 * - 绝不向 edge 发送任何消息（与边-云 :8787 物理隔离）；只读 EventBus、不接收 client 指令（指令走 /api）。
 * - JWT 经连接 URL 的 ?token= 校验（WS 不便设 Authorization 头）。
 * - attach 到 panel http server（同端口、path=/ws），与 /api 共存。
 */

import { WebSocketServer, WebSocket } from 'ws';
import type http from 'node:http';
import type { EventBus } from '../event-bus/index.js';
import { verifyJwt } from './jwt.js';

export interface PanelWsOptions {
  httpServer: http.Server;
  eventBus: EventBus;
  jwtSecret: string;
  logger?: Pick<Console, 'log' | 'warn'>;
}

/** 归一化面板帧（单一全局流，前端按 kind/account 客户端过滤）。 */
export interface PanelFrame {
  ts: number;
  kind: string;
  data: unknown;
}

export interface PanelWsHandle {
  clientCount(): number;
  close(): Promise<void>;
}

export function startPanelWs(options: PanelWsOptions): PanelWsHandle {
  const logger = options.logger ?? console;
  const wss = new WebSocketServer({ server: options.httpServer, path: '/ws' });

  wss.on('connection', (ws, req) => {
    // JWT 校验：从 ?token= 取（无效即拒绝，自定义 close code 4401）
    const url = new URL(req.url ?? '/', 'http://localhost');
    const token = url.searchParams.get('token') ?? '';
    const verified = verifyJwt(token, options.jwtSecret);
    if (!verified.valid) {
      ws.close(4401, 'unauthorized');
      return;
    }
    // 纯只读：不监听 client message（面板 WS 不接收指令）。
    ws.on('error', (err) => logger.warn(`[panel-ws] client error: ${err.message}`));
  });

  // 订阅 EventBus，归一化广播给所有客户端（纯读侧扇出，绝不回发 edge）
  const unsub = options.eventBus.onAny((event, data) => {
    const frame: PanelFrame = { ts: Date.now(), kind: event, data };
    const text = JSON.stringify(frame);
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(text);
    }
  });

  return {
    clientCount: () => wss.clients.size,
    close: () =>
      new Promise<void>((resolve) => {
        unsub();
        wss.close(() => resolve());
      }),
  };
}
