/**
 * 飞书事件接收入口（原生 http 服务端）。
 *
 * 与边-云 WS（8787）分开，默认监听 8788。职责：
 * - URL 验证：飞书首次配置订阅地址时发 {type:'url_verification', challenge}，原样回 challenge；
 * - 消息事件 im.message.receive_v1：解析文本 → 路由到 CommandRouter，结果以指令回执卡片回到群；
 * - 卡片回调 card.action.trigger：解析按钮 value → 执行动作（MVP 仅记录/回执）；
 * - 事件去重：按 header.event_id（卡片回调按 event_id/token）做内存去重，飞书重试不重复执行。
 *
 * 仅依赖 node:http，不引 express/koa；业务通过 CommandRouter / FeishuMessenger 注入。
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { CommandRouter } from './commands.js';
import { FeishuMessenger } from './messenger.js';
import { buildCommandResultCard } from './cards.js';
import type {
  FeishuCardActionEvent,
  FeishuEvent,
  FeishuMessageReceiveEvent,
} from './types.js';

/** 已处理事件 id 的内存 LRU（简单上限淘汰，够 MVP 去重） */
class SeenSet {
  private readonly set = new Set<string>();
  constructor(private readonly max = 2000) {}
  /** 返回 true 表示首次出现（应处理）；false 表示已见过（跳过） */
  add(id: string): boolean {
    if (this.set.has(id)) return false;
    this.set.add(id);
    if (this.set.size > this.max) {
      const first = this.set.values().next().value;
      if (first !== undefined) this.set.delete(first);
    }
    return true;
  }
}

export interface FeishuWebhookOptions {
  port?: number;
  host?: string;
  /** 指令路由器（解析 + 执行） */
  commandRouter: CommandRouter;
  /** 消息发送器（回执卡片） */
  messenger?: FeishuMessenger;
  /** 卡片回调动作处理（按钮 value → 业务）；可选 */
  onCardAction?: (value: Record<string, unknown>, event: FeishuCardActionEvent) => Promise<void> | void;
}

/** 飞书事件接收 HTTP 服务端 */
export class FeishuWebhookServer {
  private server?: http.Server;
  private readonly port: number;
  private readonly host: string;
  private readonly commandRouter: CommandRouter;
  private readonly messenger?: FeishuMessenger;
  private readonly onCardAction?: FeishuWebhookOptions['onCardAction'];
  private readonly seen = new SeenSet();

  constructor(options: FeishuWebhookOptions) {
    this.port = options.port ?? 8788;
    this.host = options.host ?? '0.0.0.0';
    this.commandRouter = options.commandRouter;
    this.messenger = options.messenger;
    this.onCardAction = options.onCardAction;
  }

  /** 启动监听 */
  start(): Promise<void> {
    return new Promise((resolve) => {
      this.server = http.createServer((req, res) => this.onRequest(req, res));
      this.server.listen(this.port, this.host, () => resolve());
    });
  }

  /** 关闭服务端 */
  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.server) return resolve();
      this.server.close((err) => (err ? reject(err) : resolve()));
    });
  }

  /** 实际监听端口（测试用 port=0 时取系统分配端口） */
  address(): number | undefined {
    const addr = this.server?.address() as AddressInfo | null;
    return addr ? addr.port : undefined;
  }

  private onRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'text/plain' });
      res.end('Method Not Allowed');
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      this.handleBody(body)
        .then((result) => {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(result));
        })
        .catch((err) => {
          res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: (err as Error).message }));
        });
    });
  }

  /**
   * 处理一段请求体，返回应答 JSON。抽成纯方法以便单测：无需真实网络即可验证。
   * 返回值：URL 验证回 {challenge}；其余回 {code:0}。
   */
  async handleBody(body: string): Promise<Record<string, unknown>> {
    let parsed: FeishuEvent;
    try {
      parsed = JSON.parse(body) as FeishuEvent;
    } catch {
      return { code: -1, msg: 'bad json' };
    }

    // 1) URL 验证
    if ('type' in parsed && parsed.type === 'url_verification') {
      return { challenge: parsed.challenge };
    }

    // 2) schema 2.0 事件
    if ('header' in parsed && parsed.header) {
      const eventId = parsed.header.event_id;
      if (eventId && !this.seen.add(eventId)) {
        // 重试的重复事件，直接确认不再处理
        return { code: 0, msg: 'duplicate' };
      }
      const eventType = parsed.header.event_type;
      if (eventType === 'im.message.receive_v1') {
        await this.handleMessage(parsed as FeishuMessageReceiveEvent);
      } else if (eventType === 'card.action.trigger') {
        await this.handleCardAction(parsed as FeishuCardActionEvent);
      }
    }

    return { code: 0 };
  }

  /** 处理消息事件：解析文本 → CommandRouter → 回执卡片 */
  private async handleMessage(evt: FeishuMessageReceiveEvent): Promise<void> {
    const { message } = evt.event;
    if (message.message_type !== 'text') return;
    const text = this.extractText(message.content);
    if (!text) return;

    const result = await this.commandRouter.handle(text);
    if (this.messenger) {
      const card = buildCommandResultCard(result);
      await this.messenger.sendCard(message.chat_id, card);
    }
  }

  /** 处理卡片按钮回调 */
  private async handleCardAction(evt: FeishuCardActionEvent): Promise<void> {
    const value = evt.event.action?.value;
    if (value && this.onCardAction) {
      await this.onCardAction(value, evt);
    }
  }

  /** 从飞书文本消息 content（JSON 字符串）抽出纯文本，并剥离 @ 提及占位 */
  private extractText(content: string): string {
    try {
      const obj = JSON.parse(content) as { text?: string };
      const raw = obj.text ?? '';
      // 飞书 @ 提及在 text 中以 @_user_N 占位，去掉后再 trim
      return raw.replace(/@_user_\d+/g, '').trim();
    } catch {
      return '';
    }
  }
}

export { SeenSet };
