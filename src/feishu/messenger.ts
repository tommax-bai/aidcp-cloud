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

const IMAGE_ENDPOINT = 'https://open.feishu.cn/open-apis/im/v1/images';

/** 获取机器人所在群列表端点（change feishu-bot-chat-name-display）。 */
const CHATS_ENDPOINT = 'https://open.feishu.cn/open-apis/im/v1/chats';

/** 分页取群列表的最大页数上限（防异常无限翻页；100/页 × 20 = 2000 群，远超实际）。 */
const MAX_CHAT_PAGES = 20;

interface SendMessageResponse {
  code: number;
  msg: string;
  data?: { message_id?: string };
}

interface ListChatsResponse {
  code: number;
  msg: string;
  data?: {
    items?: Array<{ chat_id?: string; name?: string }>;
    page_token?: string;
    has_more?: boolean;
  };
}

interface UploadImageResponse {
  code: number;
  msg: string;
  data?: { image_key?: string };
}

/** 一个机器人所在的群（真实群名，change feishu-bot-chat-name-display）。 */
export interface FeishuChatSummary {
  chatId: string;
  name: string | null;
}

export interface FeishuMessengerOptions {
  /** token 管理器，默认按 env 新建一个 */
  tokenManager?: FeishuTokenManager;
  /** 消息发送端点，默认飞书国内站 */
  endpoint?: string;
  /** 群列表端点，默认飞书国内站（测试注入） */
  chatsEndpoint?: string;
  /** 图片上传端点，默认飞书国内站（测试注入） */
  imageEndpoint?: string;
  /** 注入 fetch（测试用），默认全局 fetch */
  fetchImpl?: typeof fetch;
}

/** 飞书消息发送器 */
export class FeishuMessenger {
  private readonly tokenManager: FeishuTokenManager;
  private readonly endpoint: string;
  private readonly chatsEndpoint: string;
  private readonly imageEndpoint: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: FeishuMessengerOptions = {}) {
    this.tokenManager = options.tokenManager ?? new FeishuTokenManager();
    this.endpoint = options.endpoint ?? MESSAGE_ENDPOINT;
    this.chatsEndpoint = options.chatsEndpoint ?? CHATS_ENDPOINT;
    this.imageEndpoint = options.imageEndpoint ?? IMAGE_ENDPOINT;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /**
   * 列机器人所在的全部群（真实群名，change feishu-bot-chat-name-display）。
   * 调飞书 `im/v1/chats`（需 `im:chat:readonly` 权限），分页取全（有界 MAX_CHAT_PAGES）。
   * best-effort：HTTP 非 2xx / code≠0（如缺权限）抛错，由调用方降级回 bot_chats 表——绝不静默返回空冒充"无群"。
   */
  async listChats(): Promise<FeishuChatSummary[]> {
    const token = await this.tokenManager.getToken();
    const out: FeishuChatSummary[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_CHAT_PAGES; page++) {
      const url = new URL(this.chatsEndpoint);
      url.searchParams.set('page_size', '100');
      if (pageToken) url.searchParams.set('page_token', pageToken);
      const resp = await this.fetchImpl(url.toString(), {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!resp.ok) throw new Error(`飞书群列表请求失败：HTTP ${resp.status}`);
      const data = (await resp.json()) as ListChatsResponse;
      if (data.code !== 0) throw new Error(`飞书群列表获取失败：code=${data.code} msg=${data.msg}`);
      for (const it of data.data?.items ?? []) {
        if (!it.chat_id) continue;
        out.push({ chatId: it.chat_id, name: (it.name ?? '').trim() || null });
      }
      if (!data.data?.has_more || !data.data?.page_token) break;
      pageToken = data.data.page_token;
    }
    return out;
  }

  /** 按已知 chat_id 读取单群详情；用于群列表接口返回空时校验本地历史记录是否仍可被当前机器人访问。 */
  async getChat(chatId: string): Promise<FeishuChatSummary> {
    if (!chatId) throw new Error('飞书群详情获取失败：chatId 为空');
    const token = await this.tokenManager.getToken();
    const resp = await this.fetchImpl(`${this.chatsEndpoint}/${encodeURIComponent(chatId)}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!resp.ok) throw new Error(`飞书群详情请求失败：HTTP ${resp.status}`);
    const data = (await resp.json()) as {
      code: number;
      msg: string;
      data?: { chat_id?: string; name?: string };
    };
    if (data.code !== 0) throw new Error(`飞书群详情获取失败：code=${data.code} msg=${data.msg}`);
    return {
      chatId: data.data?.chat_id || chatId,
      name: (data.data?.name ?? '').trim() || null,
    };
  }

  /** 发送交互式卡片到群 */
  async sendCard(chatId: string, card: FeishuCard): Promise<void> {
    await this.send(chatId, 'interactive', JSON.stringify(card));
  }

  async sendApprovalCard(chatId: string, card: FeishuCard): Promise<void> {
    await this.sendCard(chatId, card);
  }

  async uploadImageFromUrl(url: string): Promise<string> {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') throw new Error('飞书图片上传拒绝非 https URL');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const resp = await this.fetchImpl(url, { signal: controller.signal });
      if (!resp.ok) throw new Error(`飞书图片抓取失败：HTTP ${resp.status}`);
      const contentType = (resp.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
      if (!contentType.startsWith('image/')) throw new Error('飞书图片抓取失败：响应不是图片');
      const arrayBuffer = await resp.arrayBuffer();
      if (arrayBuffer.byteLength === 0) throw new Error('飞书图片抓取失败：空图片');
      if (arrayBuffer.byteLength > 10 * 1024 * 1024) throw new Error('飞书图片抓取失败：图片超过 10MB');
      return this.uploadImageBytes(arrayBuffer, contentType);
    } finally {
      clearTimeout(timeout);
    }
  }

  async uploadImageBytes(bytes: ArrayBuffer, contentType = 'image/png'): Promise<string> {
    const token = await this.tokenManager.getToken();
    const form = new FormData();
    form.set('image_type', 'message');
    form.set('image', new Blob([bytes], { type: contentType }), 'aidcp-facebook-publish-media');
    const resp = await this.fetchImpl(this.imageEndpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
    if (!resp.ok) throw new Error(`飞书图片上传失败：HTTP ${resp.status}`);
    const data = (await resp.json()) as UploadImageResponse;
    if (data.code !== 0 || !data.data?.image_key) {
      throw new Error(`飞书图片上传失败：code=${data.code} msg=${data.msg}`);
    }
    return data.data.image_key;
  }

  /** 发送纯文本到群 */
  async sendText(chatId: string, text: string): Promise<void> {
    await this.send(chatId, 'text', JSON.stringify({ text }));
  }

  /**
   * 给某条消息贴 emoji 表情回应（默认 'Typing' 敲键盘表情，表示"已读/处理中"）。
   * best-effort：失败不抛、不阻断消息处理。messageId 为开放平台 message_id（om_xxx）。
   */
  async addReaction(messageId: string, emojiType = 'Typing'): Promise<void> {
    if (!messageId) return;
    try {
      const token = await this.tokenManager.getToken();
      const url = `https://open.feishu.cn/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reactions`;
      await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({ reaction_type: { emoji_type: emojiType } }),
      });
    } catch {
      // best-effort：表情回应失败不影响命令处理
    }
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
