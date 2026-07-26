import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { StructuredNotificationCommand } from '../src/kernel/api-direct-port.js';
import {
  StructuredNotificationDelivery,
  type StructuredNotificationDeliveryDeps,
} from '../src/feishu/structured-notification-delivery.js';

function fixture(overrides: Partial<StructuredNotificationDeliveryDeps> = {}) {
  const sent: Array<{ kind: string; chatId: string; value: unknown }> = [];
  const deps: StructuredNotificationDeliveryDeps = {
    resolveCardChatId: async (originChatId, accountId) =>
      originChatId?.trim() || (accountId ? `chat:${accountId}` : 'chat:default'),
    resolveAccountChatId: async (accountId) => `chat:${accountId}`,
    resolveDefaultChatId: async () => 'chat:default',
    accountDisplayName: (accountId) => `真名:${accountId}`,
    messenger: {
      sendCard: async (chatId, card) => {
        sent.push({ kind: 'card', chatId, value: card });
      },
      sendApprovalCard: async (chatId, card) => {
        sent.push({ kind: 'approval', chatId, value: card });
      },
      sendText: async (chatId, text) => {
        sent.push({ kind: 'text', chatId, value: text });
      },
    },
    ...overrides,
  };
  return { sent, delivery: new StructuredNotificationDelivery(deps) };
}

const COMMANDS: StructuredNotificationCommand[] = [
  {
    kind: 'comment_approval',
    input: {
      requestId: 'comment-1',
      noteId: 'note-1',
      text: '拟评论',
      accountId: 'account-1',
      accountName: 'caller-stale-name',
    },
  },
  {
    kind: 'mandatory_comment_pre_authorization',
    input: {
      requestId: 'comment-preauth-1',
      noteId: 'note-preauth-1',
      text: '强制互动评论',
      accountId: 'account-1',
    },
  },
  {
    kind: 'mandatory_comment_outcome',
    input: {
      requestId: 'comment-2',
      noteId: 'note-2',
      text: '评论',
      outcome: 'unknown',
      accountId: 'account-1',
    },
  },
  {
    kind: 'notification_inbox',
    accountId: 'account-1',
    items: [{
      kind: 'mention',
      fromUser: '用户甲',
      content: '你好',
      noteTitle: '帖子',
    }],
  },
  {
    kind: 'command_result',
    input: {
      command: '/publish',
      ok: false,
      level: 'warning',
      title: '未触发',
      message: '当前未执行',
      accountId: 'account-1',
    },
  },
  {
    kind: 'publish_approval',
    input: {
      requestId: 'publish-1',
      title: '标题',
      content: '正文',
      tags: [],
      accountId: 'account-1',
    },
  },
  {
    kind: 'operational_text',
    input: {
      route: 'default',
      text: '运维通知',
    },
  },
  {
    kind: 'alert',
    input: {
      severity: 'critical',
      title: '验证码',
      detail: '需要人工处理',
      accountId: 'account-1',
    },
  },
];

test('structured notification: 八种 kind 均由 API 构卡/路由，审批卡走专用发送口', async () => {
  const { sent, delivery } = fixture();
  for (const [index, notification] of COMMANDS.entries()) {
    assert.deepEqual(await delivery.deliver({
      commandId: `delivery-${index}`,
      notification,
    }), {
      outcome: 'delivered',
      deliveryId: `delivery-${index}`,
    });
  }
  assert.equal(sent.length, 8);
  assert.equal(sent[0].kind, 'approval');
  assert.equal(sent[5].kind, 'approval');
  assert.equal(sent[6].chatId, 'chat:default');
  assert.match(JSON.stringify(sent[0].value), /真名:account-1/);
  assert.doesNotMatch(JSON.stringify(sent[0].value), /caller-stale-name/);
});

test('structured notification: 卡片保留 originChatId 并由 API owner 执行 origin-first 路由', async () => {
  const routeCalls: Array<{
    originChatId: string | undefined | null;
    accountId: string | undefined;
  }> = [];
  let accountRouteCalls = 0;
  let defaultRouteCalls = 0;
  const { sent, delivery } = fixture({
    resolveCardChatId: async (originChatId, accountId) => {
      routeCalls.push({ originChatId, accountId });
      return originChatId?.trim() || (accountId ? `chat:${accountId}` : 'chat:default');
    },
    resolveAccountChatId: async () => {
      accountRouteCalls += 1;
      return 'unexpected-account-route';
    },
    resolveDefaultChatId: async () => {
      defaultRouteCalls += 1;
      return 'unexpected-default-route';
    },
  });
  const notification = {
    kind: 'comment_approval',
    input: {
      requestId: 'comment-origin',
      noteId: 'note-origin',
      text: '拟评论',
      accountId: 'account-origin',
      originChatId: ' chat:origin ',
    },
  } as StructuredNotificationCommand;

  assert.deepEqual(await delivery.deliver({
    commandId: 'origin-first',
    notification,
  }), {
    outcome: 'delivered',
    deliveryId: 'origin-first',
  });
  assert.deepEqual(routeCalls, [{
    originChatId: 'chat:origin',
    accountId: 'account-origin',
  }]);
  assert.equal(accountRouteCalls, 0);
  assert.equal(defaultRouteCalls, 0);
  assert.equal(sent[0]?.chatId, 'chat:origin');
});

test('structured notification: no-chat、未知 kind 与 commandId collision 不发送', async () => {
  const noChat = fixture({
    resolveCardChatId: async () => null,
    resolveAccountChatId: async () => null,
  });
  assert.deepEqual(await noChat.delivery.deliver({
    commandId: 'no-chat',
    notification: COMMANDS[0],
  }), { outcome: 'not_delivered', reason: 'no_chat' });
  assert.equal(noChat.sent.length, 0);

  const unknown = fixture();
  assert.deepEqual(await unknown.delivery.deliver({
    commandId: 'unknown',
    notification: { kind: 'raw_text', text: 'unsafe' } as never,
  }), { outcome: 'not_delivered', reason: 'invalid_command' });
  assert.equal(unknown.sent.length, 0);

  const collision = fixture();
  await collision.delivery.deliver({ commandId: 'same', notification: COMMANDS[5] });
  assert.deepEqual(await collision.delivery.deliver({
    commandId: 'same',
    notification: { kind: 'operational_text', input: { route: 'default', text: 'different' } },
  }), { outcome: 'not_delivered', reason: 'invalid_command' });
  assert.equal(collision.sent.length, 1);
});

test('structured notification: 显式飞书拒绝与发送后结果未知分离，同 commandId 不重发', async () => {
  let explicitCalls = 0;
  const explicit = fixture({
    messenger: {
      sendCard: async () => {
        explicitCalls += 1;
        throw new Error('飞书消息发送失败：HTTP 403');
      },
      sendApprovalCard: async () => {
        explicitCalls += 1;
        throw new Error('飞书消息发送失败：code=230001 msg=denied');
      },
      sendText: async () => {
        explicitCalls += 1;
        throw new Error('飞书消息发送失败：HTTP 403');
      },
    },
  });
  assert.deepEqual(await explicit.delivery.deliver({
    commandId: 'explicit',
    notification: COMMANDS[0],
  }), { outcome: 'not_delivered', reason: 'owner_rejected' });

  let unknownCalls = 0;
  const unknown = fixture({
    messenger: {
      sendCard: async () => {
        unknownCalls += 1;
        throw new Error('socket closed after request write');
      },
      sendApprovalCard: async () => {
        unknownCalls += 1;
        throw new Error('socket closed after request write');
      },
      sendText: async () => {
        unknownCalls += 1;
        throw new Error('socket closed after request write');
      },
    },
  });
  const input = { commandId: 'unknown-result', notification: COMMANDS[0] };
  assert.deepEqual(await unknown.delivery.deliver(input), {
    outcome: 'unknown',
    reason: 'delivery_result_unknown',
  });
  assert.deepEqual(await unknown.delivery.deliver(input), {
    outcome: 'unknown',
    reason: 'delivery_result_unknown',
  });
  assert.equal(explicitCalls, 1);
  assert.equal(unknownCalls, 1, 'same commandId must return current-process receipt, not resend');
});

test('structured notification: 并发等价 command 共享一次发送，in-flight collision 被拒绝', async () => {
  let releaseSend: (() => void) | undefined;
  const sendStarted = new Promise<void>((resolve) => {
    releaseSend = resolve;
  });
  let sendCalls = 0;
  let unblockSend: (() => void) | undefined;
  const sendBlocked = new Promise<void>((resolve) => {
    unblockSend = resolve;
  });
  const concurrent = fixture({
    messenger: {
      sendCard: async () => {
        throw new Error('unexpected card send');
      },
      sendApprovalCard: async () => {
        throw new Error('unexpected approval send');
      },
      sendText: async () => {
        sendCalls += 1;
        releaseSend?.();
        await sendBlocked;
      },
    },
  });
  const input = {
    commandId: 'concurrent-command',
    notification: {
      kind: 'operational_text' as const,
      input: { route: 'default' as const, text: 'same payload' },
    },
  };
  const first = concurrent.delivery.deliver(input);
  await sendStarted;
  const duplicate = concurrent.delivery.deliver(input);
  assert.deepEqual(await concurrent.delivery.deliver({
    commandId: input.commandId,
    notification: {
      kind: 'operational_text',
      input: { route: 'default', text: 'different payload' },
    },
  }), { outcome: 'not_delivered', reason: 'invalid_command' });
  assert.equal(sendCalls, 1);
  unblockSend?.();
  assert.deepEqual(await Promise.all([first, duplicate]), [
    { outcome: 'delivered', deliveryId: input.commandId },
    { outcome: 'delivered', deliveryId: input.commandId },
  ]);
  assert.equal(sendCalls, 1);
});

test('structured notification: 超过旧 FIFO 容量后仍保留旧 receipt，不重发最早 command', async () => {
  const many = fixture();
  const notification = {
    kind: 'operational_text' as const,
    input: { route: 'default' as const, text: 'bounded receipt proof' },
  };
  for (let index = 0; index < 1_025; index += 1) {
    assert.equal((await many.delivery.deliver({
      commandId: `capacity-${index}`,
      notification,
    })).outcome, 'delivered');
  }
  assert.deepEqual(await many.delivery.deliver({
    commandId: 'capacity-0',
    notification,
  }), {
    outcome: 'delivered',
    deliveryId: 'capacity-0',
  });
  assert.equal(many.sent.length, 1_025);
});
