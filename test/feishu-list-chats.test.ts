import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FeishuMessenger } from '../src/feishu/messenger.js';
import type { FeishuTokenManager } from '../src/feishu/token.js';

/**
 * change feishu-bot-chat-name-display：FeishuMessenger.listChats 分页聚合 + 错误抛出（供 provider 降级）。
 */

const fakeTokenManager = { getToken: async () => 'tok' } as unknown as FeishuTokenManager;
const CHATS = 'https://feishu.test/chats';
const IMAGES = 'https://feishu.test/images';

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

test('uploadImageFromUrl：抓 https 图片并上传为飞书 image_key', async () => {
  const calls: Array<{ input: string; init?: RequestInit }> = [];
  const fetchImpl = (async (input: string, init?: RequestInit) => {
    calls.push({ input, init });
    if (input === 'https://cdn.test/a.png') {
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'image/png' }),
        arrayBuffer: async () => new Uint8Array([137, 80, 78, 71]).buffer,
      } as unknown as Response;
    }
    if (input === IMAGES) {
      assert.equal(init?.method, 'POST');
      assert.equal((init?.headers as Record<string, string>)?.Authorization, 'Bearer tok');
      assert.ok(init?.body instanceof FormData);
      return jsonResp({ code: 0, msg: 'ok', data: { image_key: 'img_v3_key' } });
    }
    throw new Error(`unexpected fetch ${input}`);
  }) as unknown as typeof fetch;
  const m = new FeishuMessenger({ tokenManager: fakeTokenManager, fetchImpl, imageEndpoint: IMAGES });
  const key = await m.uploadImageFromUrl('https://cdn.test/a.png');
  assert.equal(key, 'img_v3_key');
  assert.deepEqual(calls.map((c) => c.input), ['https://cdn.test/a.png', IMAGES]);
});

test('uploadImageFromUrl：拒绝非图片或非 https，不上传', async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return {
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'text/plain' }),
      arrayBuffer: async () => new Uint8Array([1]).buffer,
    } as unknown as Response;
  }) as unknown as typeof fetch;
  const m = new FeishuMessenger({ tokenManager: fakeTokenManager, fetchImpl, imageEndpoint: IMAGES });
  await assert.rejects(() => m.uploadImageFromUrl('http://cdn.test/a.png'), /非 https/);
  await assert.rejects(() => m.uploadImageFromUrl('https://cdn.test/a.txt'), /不是图片/);
  assert.equal(calls, 1);
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
