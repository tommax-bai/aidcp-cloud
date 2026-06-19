/**
 * 飞书通知/审批目标群解析（共享口径）。
 *
 * 解析顺序：默认群（bot_chats，经 /bind 设定）→ fallbackChatId（通常 FEISHU_CHAT_ID）→ 空串。
 * 发布审批与验证码告警共用此解析，避免在多处复制同一段逻辑。
 */

import type { BotChatStore } from '../cache/bot-chat-store.js';

export interface ChatTargetDeps {
  botChatStore?: Pick<BotChatStore, 'getDefaultChat'>;
  /** 兜底群（通常来自 FEISHU_CHAT_ID） */
  fallbackChatId?: string;
  logger?: Pick<Console, 'warn'>;
}

/** 解析目标群 chatId；查询默认群失败时回退 fallbackChatId / FEISHU_CHAT_ID；都没有则返回空串。 */
export async function resolveDefaultChatId(deps: ChatTargetDeps): Promise<string> {
  let defaultChat = null;
  try {
    defaultChat = (await deps.botChatStore?.getDefaultChat()) ?? null;
  } catch (error) {
    deps.logger?.warn(
      '[feishu] 默认群查询失败，回退 fallbackChatId:',
      error instanceof Error ? error.message : String(error),
    );
  }
  return defaultChat?.chatId ?? deps.fallbackChatId ?? process.env.FEISHU_CHAT_ID ?? '';
}
