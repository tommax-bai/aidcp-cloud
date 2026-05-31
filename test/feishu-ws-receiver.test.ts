import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FeishuWsReceiver, extractText } from '../src/feishu/ws-receiver.js';
import { CommandRouter, type CommandActions } from '../src/feishu/commands.js';
import { FeishuMessenger } from '../src/feishu/messenger.js';
import { FeishuTokenManager } from '../src/feishu/token.js';

function makeRouter(): CommandRouter {
  const actions: CommandActions = {
    status: (id) => `状态 ${id}`,
    pause: () => {},
    resume: () => {},
  };
  return new CommandRouter(actions);
}

/** 记录所有 sendCard 调用的 messenger（注入 fake token + fake fetch） */
function makeRecordingMessenger() {
  const sent: { chatId: string; body: string }[] = [];
  const tokenManager = new FeishuTokenManager({
    appId: 'a',
    appSecret: 's',
    fetchImpl: (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ code: 0, msg: 'ok', tenant_access_token: 't', expire: 7200 }),
    })) as unknown as typeof fetch,
    clock: () => 0,
  });
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as { receive_id: string };
    sent.push({ chatId: body.receive_id, body: init.body as string });
    return {
      ok: true,
      status: 200,
      json: async () => ({ code: 0, msg: 'ok', data: { message_id: 'om_x' } }),
    } as Response;
  }) as unknown as typeof fetch;
  const messenger = new FeishuMessenger({ tokenManager, fetchImpl });
  return { messenger, sent };
}

test('ws-receiver: extractText 抽出文本并剥离 @ 提及占位', () => {
  assert.equal(extractText(JSON.stringify({ text: '/aidcp status' })), '/aidcp status');
  assert.equal(
    extractText(JSON.stringify({ text: '@_user_1 /aidcp pause acc-02' })),
    '/aidcp pause acc-02',
  );
  assert.equal(extractText('{not json'), '');
});

test('ws-receiver: 文本消息 → 路由指令 → 发回执卡片', async () => {
  const { messenger, sent } = makeRecordingMessenger();
  const receiver = new FeishuWsReceiver({
    appId: 'a',
    appSecret: 's',
    commandRouter: makeRouter(),
    messenger,
  });
  await receiver.handleMessage({
    message_id: 'om_1',
    chat_id: 'oc_chat',
    message_type: 'text',
    content: JSON.stringify({ text: '/aidcp status acc-01' }),
  });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].chatId, 'oc_chat');
  assert.match(sent[0].body, /interactive/);
});

test('ws-receiver: @ 提及占位被剥离后仍能解析指令', async () => {
  const { messenger, sent } = makeRecordingMessenger();
  const receiver = new FeishuWsReceiver({
    appId: 'a',
    appSecret: 's',
    commandRouter: makeRouter(),
    messenger,
  });
  await receiver.handleMessage({
    message_id: 'om_2',
    chat_id: 'oc_chat',
    message_type: 'text',
    content: JSON.stringify({ text: '@_user_1 /aidcp pause acc-02' }),
  });
  assert.equal(sent.length, 1);
});

test('ws-receiver: 非文本消息被忽略', async () => {
  const { messenger, sent } = makeRecordingMessenger();
  const receiver = new FeishuWsReceiver({
    appId: 'a',
    appSecret: 's',
    commandRouter: makeRouter(),
    messenger,
  });
  await receiver.handleMessage({
    message_id: 'om_3',
    chat_id: 'oc_chat',
    message_type: 'image',
    content: JSON.stringify({ image_key: 'img_x' }),
  });
  assert.equal(sent.length, 0);
});

test('ws-receiver: 缺少凭证时 start 抛错', async () => {
  const receiver = new FeishuWsReceiver({
    appId: '',
    appSecret: '',
    commandRouter: makeRouter(),
  });
  await assert.rejects(() => receiver.start(), /飞书凭证缺失/);
});
