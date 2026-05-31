/**
 * 边-云 WebSocket 服务端。
 *
 * 职责：
 * - 在指定端口监听边缘节点连接；
 * - 解析协议信封（protocol.ts），按 type 路由到注入的 MessageHandler；
 * - 把 handler 的返回信封回发给对应边缘连接；
 * - 维护每条连接的会话状态（sessionId / edgeId）。
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
}

/** 消息处理器：收到一个请求信封，产出 0/1 个响应信封 */
export interface MessageHandler {
  handle(env: Envelope, session: EdgeSession): Promise<Envelope | null> | Envelope | null;
}

export interface WsServerOptions {
  port?: number;
  host?: string;
  handler: MessageHandler;
  /** 注入时钟（测试用），默认 Date.now */
  clock?: () => number;
  /** 注入会话 id 生成器（测试用） */
  sessionIdGen?: () => string;
}

let sessionSeq = 0;

/** 边-云 WebSocket 服务端 */
export class EdgeCloudServer {
  private wss?: WebSocketServer;
  private readonly port: number;
  private readonly host: string;
  private readonly handler: MessageHandler;
  private readonly clock: () => number;
  private readonly sessionIdGen: () => string;

  constructor(options: WsServerOptions) {
    this.port = options.port ?? 8787;
    this.host = options.host ?? '0.0.0.0';
    this.handler = options.handler;
    this.clock = options.clock ?? Date.now;
    this.sessionIdGen = options.sessionIdGen ?? (() => `sess-${++sessionSeq}`);
  }

  /** 启动监听 */
  start(): Promise<void> {
    return new Promise((resolve) => {
      this.wss = new WebSocketServer({ port: this.port, host: this.host });
      this.wss.on('connection', (ws) => this.onConnection(ws));
      this.wss.on('listening', () => resolve());
    });
  }

  /** 关闭服务端 */
  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.wss) return resolve();
      this.wss.close((err) => (err ? reject(err) : resolve()));
    });
  }

  private onConnection(ws: WebSocket): void {
    const session: EdgeSession = { sessionId: this.sessionIdGen() };
    ws.on('message', async (data) => {
      const text = typeof data === 'string' ? data : data.toString();
      const reply = await this.routeMessage(text, session);
      if (reply) ws.send(JSON.stringify(reply));
    });
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
      return await this.handler.handle(env, session);
    } catch (err) {
      return this.errorEnvelope('handler_error', (err as Error).message, env.id);
    }
  }

  private errorEnvelope(code: string, message: string, id = 'server'): Envelope {
    return makeEnvelope('error' as MessageType, id, this.clock(), { code, message });
  }
}
