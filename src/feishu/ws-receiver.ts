/**
 * 飞书事件接收入口（官方 SDK 长连接 / WSClient）。
 *
 * 取代原 node:http webhook（8788 端口）：由本端主动连接飞书，无需公网 IP，
 * 也无需配置回调地址。职责：
 * - 注册 im.message.receive_v1：解析文本 → 路由到 CommandRouter，结果以指令回执卡片回到群；
 * - 事件去重：SDK 已对长连接事件做幂等保证（依据 event_id），无需自行维护 SeenSet；
 * - URL 验证：长连接模式不需要 challenge 回包，SDK 内部处理握手。
 *
 * 依赖 @larksuiteoapi/node-sdk 的 WSClient + EventDispatcher；
 * 业务通过 CommandRouter / FeishuMessenger 注入，消息发送仍走现有 REST messenger.ts。
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import * as lark from '@larksuiteoapi/node-sdk';
import { CommandRouter } from './commands.js';
import { FeishuMessenger } from './messenger.js';
import { buildCommandResultCard } from './cards.js';
import type { PublishApprovalPayload } from './types.js';

/** im.message.receive_v1 事件中 message 字段的最小形状（与 SDK 类型对齐的子集） */
export interface FeishuWsMessage {
  message_id: string;
  chat_id: string;
  chat_type?: string;
  message_type: string;
  /** JSON 字符串，文本消息形如 {"text":"..."} */
  content: string;
}

export interface FeishuWsReceiverOptions {
  /** App ID，默认读 env FEISHU_APP_ID */
  appId?: string;
  /** App Secret，默认读 env FEISHU_APP_SECRET */
  appSecret?: string;
  /** 指令路由器（解析 + 执行） */
  commandRouter: CommandRouter;
  /** 消息发送器（回执卡片）；缺省则不回执 */
  messenger?: FeishuMessenger;
  /** 注入日志（测试用），默认 console */
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
  /** 注入 fs（测试用） */
  fsImpl?: Pick<typeof fs, 'writeFile' | 'rm'>;
}

interface ApprovalActionValue {
  action?: unknown;
  token?: unknown;
  payload?: unknown;
}

interface ApprovalSignal {
  token: string;
  approved: boolean;
  ts: number;
  payload: PublishApprovalPayload;
}

const APPROVAL_SIGNAL_DIR = '/tmp';

function isPublishApprovalPayload(value: unknown): value is PublishApprovalPayload {
  if (!value || typeof value !== 'object') return false;
  const payload = value as Record<string, unknown>;
  return (
    typeof payload.title === 'string' &&
    typeof payload.content === 'string' &&
    Array.isArray(payload.tags) &&
    payload.tags.every((tag) => typeof tag === 'string')
  );
}

export function parseApprovalActionValue(value: unknown):
  | { action: 'approve' | 'cancel'; token: string; payload: PublishApprovalPayload }
  | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as ApprovalActionValue;
  if ((raw.action !== 'approve' && raw.action !== 'cancel') || typeof raw.token !== 'string') {
    return null;
  }
  if (!isPublishApprovalPayload(raw.payload)) return null;
  return { action: raw.action, token: raw.token, payload: raw.payload };
}

export function getApprovalSignalPath(token: string): string {
  return join(APPROVAL_SIGNAL_DIR, `aidcp-publish-approve-${token}.json`);
}

/**
 * 从飞书文本消息 content（JSON 字符串）抽出纯文本，并剥离 @ 提及占位。
 * 纯函数，便于单测：飞书 @ 提及在 text 中以 @_user_N 占位。
 */
export function extractText(content: string): string {
  try {
    const obj = JSON.parse(content) as { text?: string };
    const raw = obj.text ?? '';
    return raw.replace(/@_user_\d+/g, '').trim();
  } catch {
    return '';
  }
}

/** 飞书事件接收（长连接） */
export class FeishuWsReceiver {
  private readonly appId: string;
  private readonly appSecret: string;
  private readonly commandRouter: CommandRouter;
  private readonly messenger?: FeishuMessenger;
  private readonly logger: Pick<Console, 'log' | 'warn' | 'error'>;
  private readonly fsImpl: Pick<typeof fs, 'writeFile' | 'rm'>;
  private wsClient?: lark.WSClient;

  constructor(options: FeishuWsReceiverOptions) {
    this.appId = options.appId ?? process.env.FEISHU_APP_ID ?? '';
    this.appSecret = options.appSecret ?? process.env.FEISHU_APP_SECRET ?? '';
    this.commandRouter = options.commandRouter;
    this.messenger = options.messenger;
    this.logger = options.logger ?? console;
    this.fsImpl = options.fsImpl ?? fs;
  }

  /**
   * 处理一条 im.message.receive_v1 事件：解析文本 → CommandRouter → 回执卡片。
   * 抽成纯方法（接收 message 子集）以便单测：无需真实长连接即可验证路由。
   */
  async handleMessage(message: FeishuWsMessage): Promise<void> {
    if (message.message_type !== 'text') return;
    const text = extractText(message.content);
    if (!text) return;

    const result = await this.commandRouter.handle(text, { chatId: message.chat_id });
    if (this.messenger) {
      const card = buildCommandResultCard(result);
      await this.messenger.sendCard(message.chat_id, card);
    }
  }

  async handleCardAction(value: unknown): Promise<{
    toast: { type: 'success' | 'error' | 'info'; content: string };
    card?: { type: 'template'; data: { template_id: string; template_variable: Record<string, string> } };
  }> {
    const parsed = parseApprovalActionValue(value);
    if (!parsed) {
      return {
        toast: { type: 'error', content: '审批回调参数无效' },
      };
    }

    const signalPath = getApprovalSignalPath(parsed.token);
    if (parsed.action === 'approve') {
      const signal: ApprovalSignal = {
        token: parsed.token,
        approved: true,
        ts: Date.now(),
        payload: parsed.payload,
      };
      await this.fsImpl.writeFile(signalPath, JSON.stringify(signal), 'utf8');
      return {
        toast: { type: 'success', content: '已授权发布' },
      };
    }

    const signal: ApprovalSignal = {
      token: parsed.token,
      approved: false,
      ts: Date.now(),
      payload: parsed.payload,
    };
    await this.fsImpl.writeFile(signalPath, JSON.stringify(signal), 'utf8');
    return {
      toast: { type: 'info', content: '已取消发布' },
    };
  }

  /** 构建 EventDispatcher 并注册事件处理器 */
  private buildDispatcher(): lark.EventDispatcher {
    return new lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data) => {
        try {
          await this.handleMessage(data.message as FeishuWsMessage);
        } catch (err) {
          this.logger.error('[feishu] 处理消息事件失败:', (err as Error).message);
        }
      },
      'card.action.trigger': async (data: { action?: { value?: unknown } }) => {
        try {
          return await this.handleCardAction(data.action?.value);
        } catch (err) {
          this.logger.error('[feishu] 处理卡片回调失败:', (err as Error).message);
          return {
            toast: { type: 'error', content: '处理审批回调失败' },
          };
        }
      },
    });
  }

  /** 启动长连接：主动连接飞书，无需公网 IP。建立成功后通过 onReady 回调打印日志。 */
  async start(): Promise<void> {
    if (!this.appId || !this.appSecret) {
      throw new Error('飞书凭证缺失：请配置 FEISHU_APP_ID / FEISHU_APP_SECRET');
    }
    this.wsClient = new lark.WSClient({
      appId: this.appId,
      appSecret: this.appSecret,
      onReady: () => this.logger.log('[aidcp-cloud] 飞书长连接已建立（WSClient onReady）'),
      onError: (err) => this.logger.error('[aidcp-cloud] 飞书长连接错误:', err.message),
      onReconnecting: () => this.logger.warn('[aidcp-cloud] 飞书长连接重连中…'),
      onReconnected: () => this.logger.log('[aidcp-cloud] 飞书长连接已重连'),
    });
    await this.wsClient.start({ eventDispatcher: this.buildDispatcher() });
  }
}
