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

// 背压 / 大载荷防护参数（change console-cloud-panel-hardening #20）。面板 WS 与浏览编排同进程，
// 慢客户端的无界发送缓冲会 OOM 连累整个云端 → 广播前查发送缓冲堆积、超阈值跳帧、持续超阈值断开慢客户端。
export const PANEL_WS_MAX_FRAME_BYTES = 256 * 1024; // 单帧载荷上限，超则截断为摘要帧
export const PANEL_WS_BACKPRESSURE_BYTES = 1024 * 1024; // 发送缓冲堆积阈值
export const PANEL_WS_MAX_SLOW_STRIKES = 30; // 连续跳帧上限 → 断开慢客户端

/**
 * 序列化面板帧；载荷超上限则截断为带标记的摘要帧（大对象如 page.cards / note.detail，前端按需另拉）。
 * 纯函数——便于单测，不依赖真 ws。
 */
export function serializePanelFrame(
  event: string,
  data: unknown,
  now: number,
  maxBytes = PANEL_WS_MAX_FRAME_BYTES,
): string {
  const text = JSON.stringify({ ts: now, kind: event, data } satisfies PanelFrame);
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes <= maxBytes) return text;
  return JSON.stringify({
    ts: now,
    kind: event,
    data: { truncated: true, reason: 'payload_too_large', bytes },
  } satisfies PanelFrame);
}

/**
 * 背压决策（纯函数）：发送缓冲堆积超阈值 → 跳帧（strike+1）；连续跳帧达上限 → 断开慢客户端；
 * 缓冲已回落 → 正常发送并清零 strike。只读监控流丢帧优于 OOM。
 */
export function backpressureDecision(
  bufferedAmount: number,
  strikes: number,
  opts: { thresholdBytes?: number; maxStrikes?: number } = {},
): { send: boolean; close: boolean; nextStrikes: number } {
  const threshold = opts.thresholdBytes ?? PANEL_WS_BACKPRESSURE_BYTES;
  const maxStrikes = opts.maxStrikes ?? PANEL_WS_MAX_SLOW_STRIKES;
  if (bufferedAmount > threshold) {
    const nextStrikes = strikes + 1;
    if (nextStrikes >= maxStrikes) return { send: false, close: true, nextStrikes: 0 };
    return { send: false, close: false, nextStrikes };
  }
  return { send: true, close: false, nextStrikes: 0 };
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

  // 订阅 EventBus，归一化广播给所有客户端（纯读侧扇出，绝不回发 edge）。
  // 背压保护（#20）：零订阅短路省序列化；大载荷截断；慢客户端跳帧/断开，防同进程 OOM。
  const slowStrikes = new WeakMap<WebSocket, number>();
  const unsub = options.eventBus.onAny((event, data) => {
    if (wss.clients.size === 0) return; // 零订阅：不序列化，不在编排热路径白耗 CPU
    const text = serializePanelFrame(event, data, Date.now());
    for (const client of wss.clients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      const decision = backpressureDecision(client.bufferedAmount, slowStrikes.get(client) ?? 0);
      if (decision.close) {
        slowStrikes.delete(client);
        logger.warn('[panel-ws] 慢客户端持续缓冲堆积，断开（slow_consumer，防同进程 OOM）');
        client.close(1013, 'slow_consumer'); // 1013 = try again later
        continue;
      }
      slowStrikes.set(client, decision.nextStrikes);
      if (decision.send) client.send(text);
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
