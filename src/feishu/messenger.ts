/**
 * 飞书消息发送。
 *
 * 封装飞书 IM 消息发送 API（POST im/v1/messages?receive_id_type=chat_id）：
 * - sendCard(chatId, card)：发送交互式卡片到群；
 * - sendText(chatId, text)：发送纯文本。
 *
 * 鉴权通过注入的 FeishuTokenManager 拿 tenant_access_token，放到
 * Authorization: Bearer 头。仅依赖全局 fetch（可注入，测试用）。
 */

import { FeishuTokenManager } from './token.js';
import type { FeishuCard } from './types.js';

const MESSAGE_ENDPOINT =
  'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id';

interface SendMessageResponse {
  code: number;
  msg: string;
  data?: { message_id?: string };
}

export interface FeishuMessengerOptions {
  /** token 管理器，默认按 env 新建一个 */
  tokenManager?: FeishuTokenManager;
  /** 消息发送端点，默认飞书国内站 */
  endpoint?: string;
  /** 注入 fetch（测试用），默认全局 fetch */
  fetchImpl?: typeof fetch;
}

/** 飞书消息发送器 */
export class FeishuMessenger {
  private readonly tokenManager: FeishuTokenManager;
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: FeishuMessengerOptions = {}) {
    this.tokenManager = options.tokenManager ?? new FeishuTokenManager();
    this.endpoint = options.endpoint ?? MESSAGE_ENDPOINT;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** 发送交互式卡片到群 */
  async sendCard(chatId: string, card: FeishuCard): Promise<void> {
    await this.send(chatId, 'interactive', JSON.stringify(card));
  }

  /** 发送纯文本到群 */
  async sendText(chatId: string, text: string): Promise<void> {
    await this.send(chatId, 'text', JSON.stringify({ text }));
  }

  /** 底层：调用飞书消息发送 API */
  private async send(chatId: string, msgType: string, content: string): Promise<void> {
    if (!chatId) throw new Error('飞书发送失败：chatId 为空');
    const token = await this.tokenManager.getToken();
    const resp = await this.fetchImpl(this.endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({
        receive_id: chatId,
        msg_type: msgType,
        content,
      }),
    });
    if (!resp.ok) {
      throw new Error(`飞书消息发送失败：HTTP ${resp.status}`);
    }
    const data = (await resp.json()) as SendMessageResponse;
    if (data.code !== 0) {
      throw new Error(`飞书消息发送失败：code=${data.code} msg=${data.msg}`);
    }
  }
}
