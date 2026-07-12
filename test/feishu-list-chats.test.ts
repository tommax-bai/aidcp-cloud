import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FeishuMessenger } from '../src/feishu/messenger.js';
import type { FeishuTokenManager } from '../src/feishu/token.js';

/**
 * change feishu-bot-chat-name-display：FeishuMessenger.listChats 分页聚合 + 错误抛出（供 provider 降级）。
 */

const fakeTokenManager = { getToken: async () => 'tok' } as unknown as FeishuTokenManager;
const CHATS = 'https://feishu.test/chats';

function jsonResp(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

test('listChats：分页取全并聚合，null 群名归一', async () => {
  const fetchImpl = (async (input: string) => {
    const u = new URL(input);
    const pt = u.searchParams.get('page_token');
    if (!pt) {
      return jsonResp({ code: 0, msg: 'ok', data: { items: [{ chat_id: 'oc_1', name: '客户A群' }, { chat_id: 'oc_2', name: '  ' }], page_token: 'p2', has_more: true } });
    }
    return jsonResp({ code: 0, msg: 'ok', data: { items: [{ chat_id: 'oc_3', name: '客户B群' }], has_more: false } });
  }) as unknown as typeof fetch;
  const m = new FeishuMessenger({ tokenManager: fakeTokenManager, fetchImpl, chatsEndpoint: CHATS });
  const chats = await m.listChats();
  assert.deepEqual(chats, [
    { chatId: 'oc_1', name: '客户A群' },
    { chatId: 'oc_2', name: null }, // 空白群名归一为 null
    { chatId: 'oc_3', name: '客户B群' },
  ]);
});

test('listChats：code≠0（如缺 im:chat:readonly 权限）→ 抛错（供调用方降级，绝不静默空）', async () => {
  const fetchImpl = (async () => jsonResp({ code: 99991672, msg: 'permission denied', data: {} })) as unknown as typeof fetch;
  const m = new FeishuMessenger({ tokenManager: fakeTokenManager, fetchImpl, chatsEndpoint: CHATS });
  await assert.rejects(() => m.listChats(), /群列表获取失败.*code=99991672/);
});

test('listChats：HTTP 非 2xx → 抛错', async () => {
  const fetchImpl = (async () => jsonResp({}, false, 500)) as unknown as typeof fetch;
  const m = new FeishuMessenger({ tokenManager: fakeTokenManager, fetchImpl, chatsEndpoint: CHATS });
  await assert.rejects(() => m.listChats(), /HTTP 500/);
});

test('getChat：按已知 chat_id 读取单群详情并归一群名', async () => {
  const seen: string[] = [];
  const fetchImpl = (async (input: string) => {
    seen.push(input);
    return jsonResp({ code: 0, msg: 'ok', data: { chat_id: 'oc_1', name: ' AI运营 ' } });
  }) as unknown as typeof fetch;
  const m = new FeishuMessenger({ tokenManager: fakeTokenManager, fetchImpl, chatsEndpoint: CHATS });
  assert.deepEqual(await m.getChat('oc_1'), { chatId: 'oc_1', name: 'AI运营' });
  assert.equal(seen[0], `${CHATS}/oc_1`);
});

test('getChat：code≠0 → 抛错，供调用方过滤不可读旧群', async () => {
  const fetchImpl = (async () => jsonResp({ code: 232010, msg: 'Operator and chat can NOT be in different tenants.', data: {} }, true, 400)) as unknown as typeof fetch;
  const m = new FeishuMessenger({ tokenManager: fakeTokenManager, fetchImpl, chatsEndpoint: CHATS });
  await assert.rejects(() => m.getChat('oc_old'), /群详情获取失败.*232010/);
});
