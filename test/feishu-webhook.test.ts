import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FeishuWebhookServer } from '../src/feishu/webhook.js';
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

test('webhook: URL 验证回 challenge', async () => {
  const srv = new FeishuWebhookServer({ commandRouter: makeRouter() });
  const res = await srv.handleBody(
    JSON.stringify({ type: 'url_verification', challenge: 'abc123', token: 'vt' }),
  );
  assert.deepEqual(res, { challenge: 'abc123' });
});

test('webhook: 文本消息 → 路由指令 → 发回执卡片', async () => {
  const { messenger, sent } = makeRecordingMessenger();
  const srv = new FeishuWebhookServer({ commandRouter: makeRouter(), messenger });
  const body = JSON.stringify({
    schema: '2.0',
    header: { event_id: 'e1', event_type: 'im.message.receive_v1' },
    event: {
      sender: { sender_id: { open_id: 'ou_1' } },
      message: {
        message_id: 'om_1',
        chat_id: 'oc_chat',
        message_type: 'text',
        content: JSON.stringify({ text: '/aidcp status acc-01' }),
      },
    },
  });
  const res = await srv.handleBody(body);
  assert.deepEqual(res, { code: 0 });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].chatId, 'oc_chat');
  assert.match(sent[0].body, /interactive/);
});

test('webhook: @ 提及占位被剥离后仍能解析指令', async () => {
  const { messenger, sent } = makeRecordingMessenger();
  const srv = new FeishuWebhookServer({ commandRouter: makeRouter(), messenger });
  const body = JSON.stringify({
    schema: '2.0',
    header: { event_id: 'e-mention', event_type: 'im.message.receive_v1' },
    event: {
      sender: {},
      message: {
        message_id: 'om_2',
        chat_id: 'oc_chat',
        message_type: 'text',
        content: JSON.stringify({ text: '@_user_1 /aidcp pause acc-02' }),
      },
    },
  });
  await srv.handleBody(body);
  assert.equal(sent.length, 1);
});

test('webhook: 按 event_id 去重，重复事件不再发卡片', async () => {
  const { messenger, sent } = makeRecordingMessenger();
  const srv = new FeishuWebhookServer({ commandRouter: makeRouter(), messenger });
  const body = JSON.stringify({
    schema: '2.0',
    header: { event_id: 'dup-1', event_type: 'im.message.receive_v1' },
    event: {
      sender: {},
      message: {
        message_id: 'om_3',
        chat_id: 'oc_chat',
        message_type: 'text',
        content: JSON.stringify({ text: '/aidcp status' }),
      },
    },
  });
  const first = await srv.handleBody(body);
  const second = await srv.handleBody(body);
  assert.deepEqual(first, { code: 0 });
  assert.deepEqual(second, { code: 0, msg: 'duplicate' });
  assert.equal(sent.length, 1);
});

test('webhook: 卡片回调触发 onCardAction', async () => {
  const captured: Record<string, unknown>[] = [];
  const srv = new FeishuWebhookServer({
    commandRouter: makeRouter(),
    onCardAction: (value) => {
      captured.push(value);
    },
  });
  const body = JSON.stringify({
    schema: '2.0',
    header: { event_id: 'card-1', event_type: 'card.action.trigger' },
    event: {
      operator: { open_id: 'ou_1' },
      action: { tag: 'button', value: { act: 'pause', accountId: 'acc-01' } },
      context: { open_chat_id: 'oc_chat' },
    },
  });
  const res = await srv.handleBody(body);
  assert.deepEqual(res, { code: 0 });
  assert.equal(captured.length, 1);
  assert.deepEqual(captured[0], { act: 'pause', accountId: 'acc-01' });
});

test('webhook: 非法 JSON 返回错误码', async () => {
  const srv = new FeishuWebhookServer({ commandRouter: makeRouter() });
  const res = await srv.handleBody('{not json');
  assert.equal(res.code, -1);
});

test('webhook: 启动后真实 HTTP challenge 验证（端到端）', async () => {
  const srv = new FeishuWebhookServer({ commandRouter: makeRouter(), port: 0 });
  await srv.start();
  const port = srv.address();
  assert.ok(port);
  const resp = await fetch(`http://127.0.0.1:${port}/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'url_verification', challenge: 'ping' }),
  });
  const data = (await resp.json()) as { challenge: string };
  assert.equal(data.challenge, 'ping');
  await srv.close();
});
