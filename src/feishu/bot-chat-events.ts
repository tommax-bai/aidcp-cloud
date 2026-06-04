import type { BotChatStore } from '../cache/bot-chat-store.js';
import type { FeishuBotAddedEvent, FeishuBotDeletedEvent } from './types.js';

function resolveChatName(event: { name?: string; i18n_names?: { zh_cn?: string; en_us?: string; ja_jp?: string } }): string | null {
  return event.name ?? event.i18n_names?.zh_cn ?? event.i18n_names?.en_us ?? event.i18n_names?.ja_jp ?? null;
}

export class FeishuBotChatEventHandler {
  constructor(
    private readonly store: Pick<BotChatStore, 'upsertActive' | 'markInactive'>,
    private readonly logger: Pick<Console, 'log' | 'warn' | 'error'> = console,
  ) {}

  async handleBotAdded(event: FeishuBotAddedEvent['event']): Promise<void> {
    if (!event.chat_id) {
      this.logger.warn('[feishu] bot added 事件缺少 chat_id，已忽略');
      return;
    }
    await this.store.upsertActive({
      chatId: event.chat_id,
      chatName: resolveChatName(event),
      chatType: null,
    });
    this.logger.log(`[feishu] bot added chat_id=${event.chat_id}`);
  }

  async handleBotDeleted(event: FeishuBotDeletedEvent['event']): Promise<void> {
    if (!event.chat_id) {
      this.logger.warn('[feishu] bot deleted 事件缺少 chat_id，已忽略');
      return;
    }
    await this.store.markInactive(event.chat_id);
    this.logger.log(`[feishu] bot deleted chat_id=${event.chat_id}`);
  }
}