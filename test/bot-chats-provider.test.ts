import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBotChatsProvider } from '../src/feishu/bot-chats-provider.js';

test('bot chats provider verifies store chats when Feishu list is empty', async () => {
  const warnings: string[] = [];
  const provider = createBotChatsProvider({
    ttlMs: 0,
    fallbackChatId: 'oc_env',
    logger: { warn: (...args: unknown[]) => warnings.push(args.map(String).join(' ')) },
    botChatStore: {
      getDefaultChat: async () => ({ chatId: 'oc_good', chatName: null, chatType: 'group' }),
      listActive: async () => [
        { chatId: 'oc_good', chatName: null, chatType: 'group', isDefault: true },
        { chatId: 'oc_old_tenant', chatName: null, chatType: 'group', isDefault: false },
      ],
    },
    messenger: {
      listChats: async () => [],
      getChat: async (chatId: string) => {
        if (chatId === 'oc_good') return { chatId, name: 'AI运营' };
        throw new Error('飞书群详情获取失败：code=232010 msg=Operator and chat can NOT be in different tenants.');
      },
    },
  });

  const view = await provider.list();
  assert.equal(view.source, 'feishu');
  assert.equal(view.defaultChatId, 'oc_good');
  assert.deepEqual(view.chats, [{ chatId: 'oc_good', name: 'AI运营', isDefault: true }]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /本地群记录不可被当前飞书应用读取/);
  assert.doesNotMatch(warnings[0], /oc_old_tenant/);
});

test('bot chats provider falls back to store when Feishu list throws', async () => {
  const provider = createBotChatsProvider({
    ttlMs: 0,
    fallbackChatId: 'oc_env',
    logger: { warn: () => {} },
    botChatStore: {
      getDefaultChat: async () => null,
      listActive: async () => [{ chatId: 'oc_store', chatName: '本地群', chatType: 'group', isDefault: true }],
    },
    messenger: {
      listChats: async () => {
        throw new Error('permission denied');
      },
      getChat: async () => {
        throw new Error('should not be called');
      },
    },
  });

  const view = await provider.list();
  assert.equal(view.source, 'store');
  assert.equal(view.defaultChatId, 'oc_env');
  assert.deepEqual(view.chats, [{ chatId: 'oc_store', name: '本地群', isDefault: true }]);
});
