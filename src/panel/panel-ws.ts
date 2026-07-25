/**
 * 面板 WebSocket：纯只读事件扇出。
 *
 * 订阅云内 EventBus（onAny），归一化为面板帧，单一全局流广播给所有浏览器客户端。
 * 红线：
 * - 绝不向 edge 发送任何消息（与边-云 :8787 物理隔离）；只读 EventBus、不接收 client 指令（指令走 /api）。
 * - JWT 经**首帧**校验（连上后 client 首帧发 {token}；不走 URL ?token= 以免明文落 Nginx 日志，#25）——
 *   验签通过 + 未撤销才认证、加入广播集；令牌到 exp 主动断连（#25）。
 * - attach 到 panel http server（同端口、path=/ws），与 /api 共存。
 */

import { WebSocketServer, WebSocket } from 'ws';
import type http from 'node:http';
import type { EventBus } from '../event-bus/index.js';
import {
  PANEL_FRAME_MAX_BYTES,
  panelPayloadByteLength,
  panelPayloadTruncated,
} from '../kernel/panel-frame-limits.js';
import { verifyJwt } from './jwt.js';
import type { TokenRevocationStore } from './revocation.js';

export interface PanelWsOptions {
  httpServer: http.Server;
  eventBus: EventBus;
  jwtSecret: string;
  /** 令牌撤销黑名单（#26）；首帧验签后额外查它，被撤销令牌拒连。 */
  revocation?: TokenRevocationStore;
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
// 单帧载荷上限，超则截断为摘要帧。**同源自 kernel**（`src/kernel/panel-frame-limits.ts`）：
// 面板事件旁路（automation·tee 写 outbox）用的是同一个常量，两处各写一份必然漂移。此处保留本名字，
// 只为不打断既有引用。
export const PANEL_WS_MAX_FRAME_BYTES = PANEL_FRAME_MAX_BYTES;
export const PANEL_WS_BACKPRESSURE_BYTES = 1024 * 1024; // 发送缓冲堆积阈值
export const PANEL_WS_MAX_SLOW_STRIKES = 30; // 连续跳帧上限 → 断开慢客户端
export const PANEL_WS_AUTH_TIMEOUT_MS = 5000; // 首帧鉴权超时（#25）：连上后须在此内发有效 {token} 首帧

/**
 * 序列化面板帧；载荷超上限则截断为带标记的摘要帧（大对象如 page.cards / note.detail，前端按需另拉）。
 * 纯函数——便于单测，不依赖真 ws。上限与摘要形状取自 kernel，与 tee 侧同源。
 */
export function serializePanelFrame(
  event: string,
  data: unknown,
  now: number,
  maxBytes = PANEL_WS_MAX_FRAME_BYTES,
): string {
  const text = JSON.stringify({ ts: now, kind: event, data } satisfies PanelFrame);
  const bytes = panelPayloadByteLength(text);
  if (bytes <= maxBytes) return text;
  return JSON.stringify({ ts: now, kind: event, data: panelPayloadTruncated(bytes) } satisfies PanelFrame);
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

  // 已认证客户端集合（首帧鉴权后加入）。广播只发给它们；未认证连接不收任何事件。
  const authed = new Set<WebSocket>();
  const slowStrikes = new WeakMap<WebSocket, number>();

  wss.on('connection', (ws) => {
    // 首帧鉴权（#25）：连上后 client 须在超时内发首帧 {token}；不走 URL ?token=（明文落 Nginx 日志）。
    let isAuthed = false;
    let expiryTimer: ReturnType<typeof setTimeout> | undefined;
    const authTimer = setTimeout(() => {
      if (!isAuthed) ws.close(4401, 'auth_timeout');
    }, PANEL_WS_AUTH_TIMEOUT_MS);

    ws.on('message', (raw) => {
      if (isAuthed) return; // 已认证：纯只读，忽略后续 client 消息（指令走 /api）
      let token = '';
      try {
        const msg = JSON.parse(raw.toString()) as { token?: unknown };
        if (typeof msg?.token === 'string') token = msg.token;
      } catch {
        ws.close(4401, 'bad_auth_frame');
        return;
      }
      const verified = verifyJwt(token, options.jwtSecret);
      if (!verified.valid || options.revocation?.isRevoked(verified.payload.jti)) {
        ws.close(4401, 'unauthorized');
        return;
      }
      isAuthed = true;
      authed.add(ws);
      clearTimeout(authTimer);
      // 到期断连（#25）：令牌到 exp 时主动关闭，过期令牌不再享有连接期法外之地。
      const msToExp = verified.payload.exp * 1000 - Date.now();
      expiryTimer = setTimeout(() => ws.close(4401, 'token_expired'), Math.max(0, msToExp));
    });

    ws.on('close', () => {
      authed.delete(ws);
      slowStrikes.delete(ws);
      clearTimeout(authTimer);
      if (expiryTimer) clearTimeout(expiryTimer);
    });
    ws.on('error', (err) => logger.warn(`[panel-ws] client error: ${err.message}`));
  });

  // 订阅 EventBus，归一化广播给**已认证**客户端（纯读侧扇出，绝不回发 edge）。
  // 背压保护（#20）：无已认证订阅时短路省序列化；大载荷截断；慢客户端跳帧/断开，防同进程 OOM。
  // `originTs`（epoch ms）只在**跨进程回放**路径上出现（api 模式：automation tee 的事件经 outbox 回放
  // 进本进程 EventBus）。有它就用它当帧时间——否则任何回放都会被面板显示成「刚刚发生」。
  // 进程内直连路径（monolith / core）恒为 undefined ⇒ 仍取 Date.now()，逐字节等价。
  const unsub = options.eventBus.onAny((event, data, originTs) => {
    if (authed.size === 0) return; // 无已认证订阅：不序列化，不在编排热路径白耗 CPU
    const text = serializePanelFrame(event, data, originTs ?? Date.now());
    for (const client of authed) {
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
    clientCount: () => authed.size,
    close: () =>
      new Promise<void>((resolve) => {
        unsub();
        wss.close(() => resolve());
      }),
  };
}
