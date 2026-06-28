/**
 * 边-云 WebSocket 服务端。
 *
 * 职责：
 * - 在指定端口监听边缘节点连接；
 * - 解析协议信封（protocol.ts），按 type 路由到注入的 MessageHandler；
 * - 把 handler 的返回信封回发给对应边缘连接；
 * - 维护每条连接的会话状态（sessionId / edgeId），并登记"已上线的边缘连接"，
 *   以便云端在收到控制端（如 trigger-like）的指令时，主动把命令推送给边缘。
 *
 * 仅依赖 `ws`，不绑定具体业务逻辑——planner / cache / llm 通过 handler 注入，
 * 便于单测（可不起真实网络，直接调 routeMessage）。
 */

import { WebSocketServer, WebSocket } from 'ws';
import {
  makeEnvelope,
  parseEnvelope,
  type Envelope,
  type MessageType,
} from './protocol.js';

/** 单条边缘连接的会话上下文 */
export interface EdgeSession {
  sessionId: string;
  edgeId?: string;
  app?: string;
  /** 该边缘当前驱动的账号（hello 上报，用于风控归属与验证码定位） */
  accountId?: string;
  /** 人类可读机器标签（hello 上报，验证码卡片告诉运维去哪台机器） */
  machineLabel?: string;
  /** 远程桌面/可达地址（hello 上报，用于人工远程处置） */
  remoteAddr?: string;
  /**
   * 当前会话正在浏览的笔记 id（随 note.detail / note.content 戳；V1 task 9.2）。
   * 用于在 action.completed 发射 interaction.occurred 时补 noteId（编排已知当前笔记），
   * 喂按笔记互动历史（risk_interactions）。
   */
  currentNoteId?: string;
  /**
   * 当前会话正在访问的作者 id（随 profile.detail 戳；change interaction-feed-enrichment）。
   * 用于在 action.completed 发射 follow 的 interaction.occurred 时补 targetId（关注按作者归属，无当前笔记）。
   */
  currentAuthorId?: string;
}

/**
 * 边缘推送器：把一个信封下发给已上线的边缘连接。
 * 控制端（trigger）触发的命令通过它主动推给边缘（而非请求/响应）。
 */
export interface EdgePusher {
  /** 推送给指定 edgeId 的连接；未指定则广播给所有已上线边缘。返回送达连接数。 */
  pushToEdges(env: Envelope, edgeId?: string): number;
  /**
   * 解析「绑定某账号的在线边缘节点」的 edgeId（change publish-history-account-and-detail）。
   * 供发布命令定向下发：返回该账号当前在线（OPEN + 非 stale）连接的 edgeId；无在线节点则 null
   * （调用方据此诚实失败、绝不广播）。同账号多连接取确定性单目标（最早登记者）并记日志。
   * 可选成员：EdgeCloudServer 概念实现；旧测试桩不实现亦满足接口（发布定向退回广播旧行为）。
   */
  resolveEdgeIdForAccount?(accountId: string): string | null;
  /** 当前已登记（完成 hello）的边缘连接总数 */
  edgeCount(): number;
  /** 真实在线的边缘数：已登记 AND 近期有心跳（staleness 校验，绝不把死连接当在线）。 */
  onlineEdgeCount(): number;
  /** 暂停向某 edge 下发指令（验证码期间）。`session.end` 不受暂停影响，仍可送达。 */
  pauseEdge(edgeId: string): void;
  /** 解除某 edge 的暂停（验证码清除/人工恢复）。 */
  resumeEdge(edgeId: string): void;
}

/** 消息处理器：收到一个请求信封，产出 0/1 个响应信封 */
export interface MessageHandler {
  handle(
    env: Envelope,
    session: EdgeSession,
    pusher?: EdgePusher,
  ): Promise<Envelope | null> | Envelope | null;
}

export interface WsServerOptions {
  port?: number;
  host?: string;
  handler: MessageHandler;
  /** 注入时钟（测试用），默认 Date.now */
  clock?: () => number;
  /** 注入会话 id 生成器（测试用） */
  sessionIdGen?: () => string;
  /** 主动心跳 ping 间隔（ms）；0 关闭定时器（测试）。默认 30000。 */
  heartbeatMs?: number;
  /** 超过此时长无帧/pong 即视为 stale（不在线）。默认 75000（2.5×心跳）。 */
  staleAfterMs?: number;
  /** 连接关闭回调（multi-account-node-support）：拆除该连接的多租户运行时。 */
  onClose?: (session: EdgeSession) => void;
}

let sessionSeq = 0;

/** 已登记的边缘连接 */
interface EdgeConn {
  ws: WebSocket;
  session: EdgeSession;
  /** 最近一次从该连接收到帧/pong 的时刻（staleness 判定用）。 */
  lastSeen: number;
}

/** 边-云 WebSocket 服务端 */
export class EdgeCloudServer implements EdgePusher {
  private wss?: WebSocketServer;
  private readonly port: number;
  private readonly host: string;
  private readonly handler: MessageHandler;
  private readonly clock: () => number;
  private readonly sessionIdGen: () => string;
  /** 已上线（完成 hello）的边缘连接，按 sessionId 索引 */
  private readonly edges = new Map<string, EdgeConn>();
  /**
   * 被暂停下发的 edgeId 集合（验证码期间）。持于传输层而非会话态，
   * 故 RoleDispatcher.restartSession（每次 edge.hello 重建）后仍生效。
   */
  private readonly pausedEdges = new Set<string>();
  private readonly heartbeatMs: number;
  private readonly staleAfterMs: number;
  private readonly onCloseCb?: (session: EdgeSession) => void;
  private heartbeatTimer?: ReturnType<typeof setInterval>;

  constructor(options: WsServerOptions) {
    this.port = options.port ?? 8787;
    this.host = options.host ?? '0.0.0.0';
    this.handler = options.handler;
    this.clock = options.clock ?? Date.now;
    this.sessionIdGen = options.sessionIdGen ?? (() => `sess-${++sessionSeq}`);
    this.heartbeatMs = options.heartbeatMs ?? 30000;
    this.staleAfterMs = options.staleAfterMs ?? 75000;
    this.onCloseCb = options.onClose;
  }

  /** 启动监听 */
  start(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.wss = new WebSocketServer({ port: this.port, host: this.host });
      this.wss.on('connection', (ws) => this.onConnection(ws));
      this.wss.on('listening', () => resolve());
    }).then(() => this.startHeartbeat());
  }

  /** 主动心跳：定时 ping 每条在线连接；pong/入站帧回到时刷新 lastSeen（见 onConnection）。 */
  private startHeartbeat(): void {
    if (this.heartbeatMs <= 0 || this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      for (const conn of this.edges.values()) {
        if (conn.ws.readyState === WebSocket.OPEN) conn.ws.ping();
      }
    }, this.heartbeatMs);
    this.heartbeatTimer.unref?.();
  }

  /** 关闭服务端 */
  close(): Promise<void> {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    return new Promise((resolve, reject) => {
      if (!this.wss) return resolve();
      this.wss.close((err) => (err ? reject(err) : resolve()));
    });
  }

  /** EdgePusher：把命令推给已上线边缘 */
  pushToEdges(env: Envelope, edgeId?: string): number {
    const frame = JSON.stringify(env);
    // session.end 必达：绝不被验证码暂停闸吞掉，否则持久弹窗会导致会话无法终止（死锁）。
    const bypassPause = env.type === 'session.end';
    let sent = 0;
    for (const conn of this.edges.values()) {
      if (edgeId && conn.session.edgeId !== edgeId) continue;
      if (!bypassPause && conn.session.edgeId && this.pausedEdges.has(conn.session.edgeId)) continue;
      if (conn.ws.readyState === WebSocket.OPEN) {
        conn.ws.send(frame);
        sent++;
      }
    }
    return sent;
  }

  edgeCount(): number {
    return this.edges.size;
  }

  /** 真实在线数：已登记 AND 连接 OPEN AND 近期有帧/pong（staleness 校验，死连接不算在线，D9）。 */
  onlineEdgeCount(): number {
    const now = this.clock();
    let n = 0;
    for (const conn of this.edges.values()) {
      if (conn.ws.readyState === WebSocket.OPEN && now - conn.lastSeen < this.staleAfterMs) n++;
    }
    return n;
  }

  /** 已绑定端口（构造时 port:0 由系统分配，测试用）；未启动返回 null。 */
  address(): number | null {
    const a = this.wss?.address();
    return a && typeof a === 'object' ? a.port : null;
  }

  /** 暂停向某 edge 下发指令（验证码期间）。幂等。 */
  pauseEdge(edgeId: string): void {
    this.pausedEdges.add(edgeId);
  }

  /** 解除某 edge 的暂停（验证码清除/人工恢复）。幂等。 */
  resumeEdge(edgeId: string): void {
    this.pausedEdges.delete(edgeId);
  }

  /** 该 edge 是否处于暂停态（观测/测试用）。 */
  isEdgePaused(edgeId: string): boolean {
    return this.pausedEdges.has(edgeId);
  }

  /** 解除某账号名下所有 edge 的暂停（飞书人工恢复快路）。返回恢复的 edge 数。 */
  resumeEdgesForAccount(accountId: string): number {
    let resumed = 0;
    for (const conn of this.edges.values()) {
      const eid = conn.session.edgeId;
      if (eid && conn.session.accountId === accountId && this.pausedEdges.delete(eid)) resumed++;
    }
    return resumed;
  }

  /**
   * 解析绑定某账号的在线边缘节点 edgeId（发布命令定向下发用）。
   * 只认 OPEN + 非 stale 的连接（死连接不算在线，与 onlineEdgeCount 同口径）。
   * 严格匹配 `session.accountId === accountId`（retire-default-account：握手已保证每个连接带真实账号，
   * 去掉「目标为 default 时把未声明账号也算上」的 legacy 兼容）。同账号多条在线连接 → 取最早登记者（Map 插入序）并记日志。
   * 无在线节点返回 null（调用方据此诚实失败、绝不广播）。
   */
  resolveEdgeIdForAccount(accountId: string): string | null {
    const now = this.clock();
    const matches: string[] = [];
    for (const conn of this.edges.values()) {
      const eid = conn.session.edgeId;
      if (!eid) continue;
      if (conn.ws.readyState !== WebSocket.OPEN || now - conn.lastSeen >= this.staleAfterMs) continue;
      if (conn.session.accountId === accountId) matches.push(eid);
    }
    if (matches.length === 0) return null;
    if (matches.length > 1) {
      console.warn(`[ws-server] 账号 ${accountId} 有 ${matches.length} 条在线连接，定向发布取最早登记者 edgeId=${matches[0]}（其余=${matches.slice(1).join(',')}）`);
    }
    return matches[0];
  }

  private onConnection(ws: WebSocket): void {
    const session: EdgeSession = { sessionId: this.sessionIdGen() };
    ws.on('message', async (data) => {
      const text = typeof data === 'string' ? data : data.toString();
      // 在握手成功时登记边缘连接，使其可被主动推送
      const env = parseEnvelope(text);
      const reply = await this.routeMessage(text, session);
      if (env?.type === 'hello') {
        this.edges.set(session.sessionId, { ws, session, lastSeen: this.clock() });
      } else {
        // 任意入站帧刷新 lastSeen（连接活着的证据）
        const conn = this.edges.get(session.sessionId);
        if (conn) conn.lastSeen = this.clock();
      }
      if (reply) ws.send(JSON.stringify(reply));
    });
    // ws 协议层 pong（响应主动 ping）也刷新 lastSeen
    ws.on('pong', () => {
      const conn = this.edges.get(session.sessionId);
      if (conn) conn.lastSeen = this.clock();
    });
    ws.on('close', () => {
      this.edges.delete(session.sessionId);
      // 拆除该连接的多租户运行时（结束会话 + 解 tee + 清私有总线监听）。
      this.onCloseCb?.(session);
    });
  }

  /**
   * 主动关闭某 session 的连接（同 edgeId 重连顶替旧连接用）。
   * 关闭后 ws 'close' 会触发 edges.delete + onClose（拆除旧运行时）。
   */
  closeEdge(sessionId: string): void {
    const conn = this.edges.get(sessionId);
    if (conn && conn.ws.readyState === WebSocket.OPEN) conn.ws.close();
  }

  /**
   * 路由一帧文本消息，返回应回发的信封（或 null）。
   * 抽成纯方法以便单测：无需真实 socket 即可验证协议处理。
   */
  async routeMessage(text: string, session: EdgeSession): Promise<Envelope | null> {
    const env = parseEnvelope(text);
    if (!env) {
      return this.errorEnvelope('bad_envelope', '无法解析的协议帧');
    }
    try {
      return await this.handler.handle(env, session, this);
    } catch (err) {
      return this.errorEnvelope('handler_error', (err as Error).message, env.id);
    }
  }

  private errorEnvelope(code: string, message: string, id = 'server'): Envelope {
    return makeEnvelope('error' as MessageType, id, this.clock(), { code, message });
  }
}
