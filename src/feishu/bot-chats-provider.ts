import type { BotChatRecord, BotChatStore } from '../cache/bot-chat-store.js';
import type { FeishuChatSummary, FeishuMessenger } from './messenger.js';
import { resolveDefaultChatId } from './chat-target.js';

export interface BotChatsProviderView {
  chats: Array<{ chatId: string; name: string | null; isDefault: boolean }>;
  defaultChatId: string | null;
  source: 'feishu' | 'store';
}

export interface BotChatsProviderDeps {
  messenger: Pick<FeishuMessenger, 'listChats' | 'getChat'>;
  botChatStore: Pick<BotChatStore, 'listActive' | 'getDefaultChat'>;
  fallbackChatId?: string;
  logger?: Pick<Console, 'warn'>;
  ttlMs?: number;
}

function maskChatId(chatId: string): string {
  return chatId.length <= 12 ? chatId : `${chatId.slice(0, 8)}...${chatId.slice(-4)}`;
}

function toView(
  chats: FeishuChatSummary[],
  resolvedDefault: string | null,
): BotChatsProviderView {
  return {
    chats: chats.map((c) => ({ chatId: c.chatId, name: c.name, isDefault: c.chatId === resolvedDefault })),
    defaultChatId: resolvedDefault,
    source: 'feishu',
  };
}

async function verifyStoreChats(
  active: Array<BotChatRecord & { isDefault: boolean }>,
  messenger: Pick<FeishuMessenger, 'getChat'>,
  resolvedDefault: string | null,
  logger?: Pick<Console, 'warn'>,
): Promise<BotChatsProviderView | null> {
  const checked: BotChatsProviderView['chats'] = [];
  for (const chat of active.slice(0, 50)) {
    try {
      const live = await messenger.getChat(chat.chatId);
      checked.push({
        chatId: live.chatId,
        name: live.name ?? chat.chatName,
        isDefault: chat.chatId === resolvedDefault || chat.isDefault,
      });
    } catch (err) {
      logger?.warn(
        `[bot-chats] 本地群记录不可被当前飞书应用读取，已从候选中过滤 chat=${maskChatId(chat.chatId)}:`,
        (err as Error).message,
      );
    }
  }
  if (checked.length === 0) return null;
  return {
    chats: checked,
    defaultChatId:
      checked.some((c) => c.chatId === resolvedDefault)
        ? resolvedDefault
        : checked.find((c) => c.isDefault)?.chatId ?? null,
    source: 'feishu',
  };
}

export function createBotChatsProvider(deps: BotChatsProviderDeps): { list(): Promise<BotChatsProviderView> } {
  const ttlMs = deps.ttlMs ?? 60_000;
  let cache: { at: number; view: BotChatsProviderView } | undefined;
  return {
    list: async () => {
      const now = Date.now();
      if (cache && now - cache.at < ttlMs) return cache.view;
      const resolvedDefault =
        (await resolveDefaultChatId({
          botChatStore: deps.botChatStore,
          fallbackChatId: deps.fallbackChatId,
          logger: deps.logger,
        })) || null;
      try {
        const chats = await deps.messenger.listChats();
        if (chats.length === 0) {
          const active = await deps.botChatStore.listActive();
          const verified = await verifyStoreChats(active, deps.messenger, resolvedDefault, deps.logger);
          if (verified) {
            cache = { at: now, view: verified };
            return verified;
          }
        }
        const view = toView(chats, resolvedDefault);
        cache = { at: now, view };
        return view;
      } catch (err) {
        deps.logger?.warn(
          '[bot-chats] 飞书群列表取失败，降级 bot_chats 表（检查 im:chat:readonly 权限）:',
          (err as Error).message,
        );
        const active = await deps.botChatStore.listActive();
        return {
          chats: active.map((c) => ({ chatId: c.chatId, name: c.chatName, isDefault: c.isDefault })),
          defaultChatId: resolvedDefault ?? active.find((c) => c.isDefault)?.chatId ?? null,
          source: 'store',
        };
      }
    },
  };
}
