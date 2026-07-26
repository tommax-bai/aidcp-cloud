import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FeishuWsReceiver,
  extractText,
  parseApprovalActionValue,
} from '../src/feishu/ws-receiver.js';
import { CommandRouter, type CommandActions } from '../src/feishu/commands.js';
import { FeishuMessenger } from '../src/feishu/messenger.js';
import { FeishuTokenManager } from '../src/feishu/token.js';
import type { CommandResult } from '../src/feishu/types.js';

/** 可控命令桩：handleBatch 返回一个可手动 resolve/reject 的 promise，用于验证 fast-ack（受理即返回）。 */
function makeDeferredRouter(): {
  router: CommandRouter;
  resolve: (r: CommandResult) => void;
  reject: (e: unknown) => void;
} {
  let reject!: (e: unknown) => void;
  let resolveBatch!: (results: CommandResult[]) => void;
  const p = new Promise<CommandResult[]>((res, rej) => {
    resolveBatch = res;
    reject = rej;
  });
  const router = { handleBatch: () => p } as unknown as CommandRouter;
  return { router, resolve: (result) => resolveBatch([result]), reject };
}

const tick = () => new Promise((r) => setTimeout(r, 20));

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
  const reactions: { messageId: string; body: string }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const u = String(url);
    if (u.includes('/reactions')) {
      // .../im/v1/messages/{messageId}/reactions
      const m = u.match(/\/messages\/([^/]+)\/reactions/);
      reactions.push({ messageId: m ? decodeURIComponent(m[1]) : '', body: init.body as string });
      return { ok: true, status: 200, json: async () => ({ code: 0, msg: 'ok' }) } as Response;
    }
    const body = JSON.parse(init.body as string) as { receive_id: string };
    sent.push({ chatId: body.receive_id, body: init.body as string });
    return {
      ok: true,
      status: 200,
      json: async () => ({ code: 0, msg: 'ok', data: { message_id: 'om_x' } }),
    } as Response;
  }) as unknown as typeof fetch;
  const messenger = new FeishuMessenger({ tokenManager, fetchImpl });
  return { messenger, sent, reactions };
}

test('ws-receiver: extractText 抽出文本并剥离 @ 提及占位', () => {
  assert.equal(extractText(JSON.stringify({ text: '/status' })), '/status');
  assert.equal(
    extractText(JSON.stringify({ text: '@_user_1 /pause acc-02' })),
    '/pause acc-02',
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
    content: JSON.stringify({ text: '/status acc-01' }),
  });
  // fast-ack：命令执行 + 回卡在后台异步补发，等一拍让其落地。
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].chatId, 'oc_chat');
  assert.match(sent[0].body, /interactive/);
});

test('ws-receiver: 已读文本消息 → 贴「Typing」敲键盘表情回应（已读/处理中）', async () => {
  const { messenger, reactions } = makeRecordingMessenger();
  const receiver = new FeishuWsReceiver({
    appId: 'a',
    appSecret: 's',
    commandRouter: makeRouter(),
    messenger,
  });
  await receiver.handleMessage({
    message_id: 'om_react',
    chat_id: 'oc_chat',
    message_type: 'text',
    content: JSON.stringify({ text: '/status acc-01' }),
  });
  // addReaction 为 best-effort fire-and-forget，等一拍让其落地。
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(reactions.length, 1, '已读应贴一个表情回应');
  assert.equal(reactions[0].messageId, 'om_react');
  assert.match(reactions[0].body, /Typing/);
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
    content: JSON.stringify({ text: '@_user_1 /pause acc-02' }),
  });
  // fast-ack：回卡后台异步补发，等一拍。
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(sent.length, 1);
});

test('ws-receiver: 批命令逐个发送非静默结果，静默入队不冒充完成', async () => {
  const { messenger, sent } = makeRecordingMessenger();
  const router = {
    handleBatch: async () => [
      { command: '/publish Tianxing Bai', ok: true, level: 'warning', title: '已入队', message: '', silent: true },
      { command: '/comment Missing', ok: false, level: 'warning', title: '未找到账号', message: 'Missing' },
    ],
  } as unknown as CommandRouter;
  const receiver = new FeishuWsReceiver({ appId: 'a', appSecret: 's', commandRouter: router, messenger });
  await receiver.handleMessage({
    message_id: 'om_batch', chat_id: 'oc_chat', message_type: 'text',
    content: JSON.stringify({ text: '/publish Tianxing Bai; /comment Missing' }),
  });
  await tick();
  assert.equal(sent.length, 1);
  assert.match(sent[0]!.body, /未找到账号/);
  assert.doesNotMatch(sent[0]!.body, /已入队/);
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

test('ws-receiver: fast-ack — 命令未完成时 handleMessage 即返回，终态卡后台异步补发', async () => {
  const { messenger, sent } = makeRecordingMessenger();
  const { router, resolve } = makeDeferredRouter();
  const receiver = new FeishuWsReceiver({
    appId: 'a',
    appSecret: 's',
    commandRouter: router,
    messenger,
  });
  // 命令永不完成也应立即返回（受理即返回，不阻塞 SDK 回帧）。node:test 若 handleMessage 阻塞会挂起超时。
  await receiver.handleMessage({
    message_id: 'om_slow',
    chat_id: 'oc_chat',
    message_type: 'text',
    content: JSON.stringify({ text: '/publish acc-01' }),
  });
  await tick();
  assert.equal(sent.length, 0, '命令未完成前不发终态卡（受理即返回、不阻塞）');

  // 命令完成 → 后台异步补发终态卡。
  resolve({ command: '/publish acc-01', ok: true, level: 'success', title: '已触发发帖编排', message: 'ok' });
  await tick();
  assert.equal(sent.length, 1, '命令完成后异步补发一张终态卡');
});

test('ws-receiver: 终态卡随 honest-status（未产出=黄⚠️），受理与终态卡之间无中间卡', async () => {
  const { messenger, sent } = makeRecordingMessenger();
  const { router, resolve } = makeDeferredRouter();
  const receiver = new FeishuWsReceiver({
    appId: 'a',
    appSecret: 's',
    commandRouter: router,
    messenger,
  });
  await receiver.handleMessage({
    message_id: 'om_warn',
    chat_id: 'oc_chat',
    message_type: 'text',
    content: JSON.stringify({ text: '/publish acc-01' }),
  });
  await tick();
  assert.equal(sent.length, 0, '终态未定前不插「任务启动中」中间卡');

  resolve({
    command: '/publish acc-01',
    ok: false,
    level: 'warning',
    title: '发帖未产出',
    message: '已有一轮发帖编排在运行中',
  });
  await tick();
  assert.equal(sent.length, 1, '仅发一张终态卡');
  assert.match(sent[0].body, /发帖未产出/, '终态卡应含真实标题');
  assert.match(sent[0].body, /已有一轮发帖编排在运行中/, '终态卡应含真实原因（honest-status 不变）');
});

test('ws-receiver: 后台执行抛错被 catch 记日志、不外溢、不发卡', async () => {
  const { messenger, sent } = makeRecordingMessenger();
  const { router, reject } = makeDeferredRouter();
  const errors: string[] = [];
  const receiver = new FeishuWsReceiver({
    appId: 'a',
    appSecret: 's',
    commandRouter: router,
    messenger,
    logger: { log: () => {}, warn: () => {}, error: (...a: unknown[]) => errors.push(a.map(String).join(' ')) },
  });
  await receiver.handleMessage({
    message_id: 'om_err',
    chat_id: 'oc_chat',
    message_type: 'text',
    content: JSON.stringify({ text: '/publish acc-01' }),
  });
  reject(new Error('boom'));
  await tick();
  assert.equal(sent.length, 0, '后台失败不发卡（与改动前一致）');
  assert.equal(errors.length, 1, '后台异常被 catch 记一条错误日志');
  assert.match(errors[0], /boom/);
});

test('ws-receiver: 缺少凭证时 start 抛错', async () => {
  const receiver = new FeishuWsReceiver({
    appId: '',
    appSecret: '',
    commandRouter: makeRouter(),
  });
  await assert.rejects(() => receiver.start(), /飞书凭证缺失/);
});

test('ws-receiver: parseApprovalActionValue 解析 approve/cancel', () => {
  const parsed = parseApprovalActionValue({
    action: 'approve',
    requestId: 'req-1',
    payload: { title: 't', content: 'c', tags: ['x'] },
  });
  assert.deepEqual(parsed, {
    action: 'approve',
    requestId: 'req-1',
    payload: { title: 't', content: 'c', tags: ['x'] },
  });
  assert.equal(parseApprovalActionValue({ action: 'noop' }), null);
});

/**
 * 授权写出口桩（change publish-approval-signal-to-database）：first-writer-wins 由「已有活跃决定」
 * 承担，与持久记录的活跃行唯一索引同义——不再有任何文件路径参与。
 */
function makeApprovalOutlet() {
  const decided = new Map<string, boolean>();
  const calls: Array<{ requestId: string; approved: boolean; decidedBy: string; decidedVia: string; contentVersion?: number }> = [];
  const writeApproval = async (
    requestId: string,
    approved: boolean,
    payload: { contentVersion?: number },
    context: { decidedBy: string; decidedVia: 'feishu' },
  ) => {
    calls.push({ requestId, approved, decidedBy: context.decidedBy, decidedVia: context.decidedVia, contentVersion: payload.contentVersion });
    if (decided.has(requestId)) return { written: false, alreadyDecided: decided.get(requestId)!, revision: 1 };
    decided.set(requestId, approved);
    return { written: true, revision: 1 };
  };
  return { writeApproval, calls, decided };
}

test('ws-receiver: approve 经唯一授权出口写入持久授权（不落任何文件路径）', async () => {
  const outlet = makeApprovalOutlet();
  const receiver = new FeishuWsReceiver({
    appId: 'a',
    appSecret: 's',
    commandRouter: makeRouter(),
    writeApproval: outlet.writeApproval,
  });
  const res = await receiver.handleCardAction(
    {
      action: 'approve',
      requestId: 'req-approve',
      payload: { title: '标题', content: '正文', tags: ['话题'] },
    },
    'ou_operator_1',
  );
  assert.equal(res.toast.type, 'success');
  assert.equal(outlet.calls.length, 1);
  assert.equal(outlet.calls[0].approved, true);
  // 决策人是真实点卡人（MUST NOT 常量占位）、渠道为飞书。
  assert.equal(outlet.calls[0].decidedBy, 'ou_operator_1');
  assert.equal(outlet.calls[0].decidedVia, 'feishu');
});

test('ws-receiver: 授权出口未接线 → fail-closed 报错，绝不退回文件互斥、绝不静默放行', async () => {
  const approved: unknown[] = [];
  const receiver = new FeishuWsReceiver({
    appId: 'a',
    appSecret: 's',
    commandRouter: makeRouter(),
    logger: { log: () => {}, warn: () => {}, error: () => {} },
    onApproved: (trigger) => approved.push(trigger),
  });
  const res = await receiver.handleCardAction({
    action: 'approve',
    requestId: 'req-no-outlet',
    payload: { title: '标题', content: '正文', tags: [] },
  });
  assert.equal(res.toast.type, 'error');
  assert.deepEqual(approved, [], '未写入授权即绝不触发下发');
});

test('ws-receiver: cancel 写入 approved=false 授权', async () => {
  const outlet = makeApprovalOutlet();
  const receiver = new FeishuWsReceiver({
    appId: 'a',
    appSecret: 's',
    commandRouter: makeRouter(),
    writeApproval: outlet.writeApproval,
  });
  const res = await receiver.handleCardAction({
    action: 'cancel',
    requestId: 'req-cancel',
    payload: { title: '标题', content: '正文', tags: ['话题'] },
  });
  assert.equal(res.toast.type, 'info');
  assert.equal(outlet.calls.length, 1);
  assert.equal(outlet.calls[0].approved, false);
});

// ── 写时版本预检（change edit-note-draft-before-publish）──────────────────────
function receiverWithVersion(live: number | null, writes: Array<{ path: string; content: string }>) {
  return new FeishuWsReceiver({
    appId: 'a',
    appSecret: 's',
    commandRouter: makeRouter(),
    writeApproval: async (requestId, approved, payload) => {
      writes.push({ path: requestId, content: JSON.stringify({ approved, ...payload }) });
      return { written: true, revision: 1 };
    },
    readLiveContentVersion: async () => live,
  });
}

test('ws-receiver: 版本预检 — 活版本 == 卡片烤入版本 → 写授权（携 contentVersion）', async () => {
  const writes: Array<{ path: string; content: string }> = [];
  const res = await receiverWithVersion(2, writes).handleCardAction({
    action: 'approve',
    requestId: 'publish-42',
    payload: { title: '标题', content: '正文', tags: ['话题'], contentVersion: 2 },
  });
  assert.equal(res.toast.type, 'success');
  assert.equal(writes.length, 1, '版本一致才写授权');
  assert.match(writes[0].content, /\"contentVersion\":2/);
});

test('ws-receiver: 版本预检 — 活版本 ≠ 烤入版本 → 拒绝、绝不写签名、回重新审批替换卡', async () => {
  const writes: Array<{ path: string; content: string }> = [];
  const res = await receiverWithVersion(3, writes).handleCardAction({
    action: 'approve',
    requestId: 'publish-42',
    payload: { title: '标题', content: '正文', tags: ['话题'], contentVersion: 1 },
  });
  assert.equal(writes.length, 0, '版本不符绝不写签名');
  assert.equal(res.toast.type, 'info');
  assert.ok(res.card, '返回替换卡引导到控制台');
});

test('ws-receiver: 版本预检 — 陈旧 cancel 同样被拒（防锁死编辑过的草稿签名）', async () => {
  const writes: Array<{ path: string; content: string }> = [];
  await receiverWithVersion(3, writes).handleCardAction({
    action: 'cancel',
    requestId: 'publish-42',
    payload: { title: '标题', content: '正文', tags: ['话题'], contentVersion: 1 },
  });
  assert.equal(writes.length, 0, '陈旧 cancel 也不写签名（否则先到先得锁死、编辑过的草稿再也发不出）');
});

test('ws-receiver: 版本预检 fail-safe — 读版本失败(null) → 拒到控制台、不写签名', async () => {
  const writes: Array<{ path: string; content: string }> = [];
  const res = await receiverWithVersion(null, writes).handleCardAction({
    action: 'approve',
    requestId: 'publish-42',
    payload: { title: '标题', content: '正文', tags: ['话题'], contentVersion: 0 },
  });
  assert.equal(writes.length, 0, 'fail-safe：无法确认版本绝不放行');
  assert.equal(res.toast.type, 'error');
});

test('ws-receiver: 授权发布前账号离线 → 提醒且不写签名、不替换审批卡', async () => {
  const writes: Array<{ path: string; content: string }> = [];
  const approved: unknown[] = [];
  const receiver = new FeishuWsReceiver({
    appId: 'a',
    appSecret: 's',
    commandRouter: makeRouter(),
    fsImpl: {
      writeFile: async (path, content) => {
        writes.push({ path: String(path), content: String(content) });
      },
      rm: async () => {},
    },
    onApproved: (trigger) => approved.push(trigger),
    preflightApprovePublish: async () => ({ ok: false, reason: 'account_offline', accountId: 'acc-offline' }),
  });
  const res = await receiver.handleCardAction({
    action: 'approve',
    requestId: 'publish-42',
    payload: { title: '标题', content: '正文', tags: ['话题'], contentVersion: 0 },
  });
  assert.equal(res.toast.type, 'error');
  assert.equal(res.toast.content, '账号不在线，无法发布');
  assert.equal(writes.length, 0, '离线时绝不写 approved=true 签名');
  assert.equal(res.card, undefined, '不返回替换卡，飞书审批卡保持原待审状态');
  assert.deepEqual(approved, [], '不触发下发段');
});

// ── 陪伴界面 rejected 通知（change edge-companion-ui 8.1）──────────────────────
test('ws-receiver: cancel 首写成功 → 触发 onRejected；approve 首写只交 durable outbox', async () => {
  const rejected: string[] = [];
  const approved: unknown[] = [];
  const receiver = new FeishuWsReceiver({
    appId: 'a',
    appSecret: 's',
    commandRouter: makeRouter(),
    writeApproval: makeApprovalOutlet().writeApproval,
    onApproved: (trigger) => approved.push(trigger),
    onRejected: (id) => rejected.push(id),
  });
  const cancelRes = await receiver.handleCardAction({
    action: 'cancel',
    requestId: 'publish-86',
    payload: { title: '标题', content: '正文', tags: [] },
  });
  assert.equal(cancelRes.toast.type, 'info');
  assert.deepEqual(rejected, ['publish-86']);
  assert.deepEqual(approved, []);

  const approveRes = await receiver.handleCardAction({
    action: 'approve',
    requestId: 'publish-87',
    payload: { title: '标题', content: '正文', tags: [] },
  });
  assert.equal(approveRes.toast.type, 'success');
  assert.deepEqual(approved, [], '首写批准由 PublishApproved outbox relay 产生 decision_recorded');
  assert.deepEqual(rejected, ['publish-86'], 'approve 不触发 onRejected');
});

test('ws-receiver: 已决批准上的人工重批携 revision 发送 human_reconfirm', async () => {
  const triggers: unknown[] = [];
  const receiver = new FeishuWsReceiver({
    appId: 'a',
    appSecret: 's',
    commandRouter: makeRouter(),
    writeApproval: async () => ({ written: false, alreadyDecided: true, revision: 7 }),
    onApproved: (trigger) => triggers.push(trigger),
  });

  const res = await receiver.handleCardAction({
    action: 'approve',
    requestId: 'publish-87',
    payload: { title: '标题', content: '正文', tags: [] },
  });

  assert.equal(res.toast.type, 'info');
  assert.deepEqual(triggers, [{
    requestId: 'publish-87',
    revision: 7,
    kind: 'human_reconfirm',
  }]);
});

test('ws-receiver: cancel 撞先到的决定（first-writer-wins 未写入）→ 不触发 onRejected', async () => {
  const rejected: string[] = [];
  const payload = { title: '标题', content: '正文', tags: [] };
  const receiver = new FeishuWsReceiver({
    appId: 'a',
    appSecret: 's',
    commandRouter: makeRouter(),
    // 活跃授权行已存在（他人先决定为「取消」）→ 后到者得 alreadyDecided，不覆盖。
    writeApproval: async () => ({ written: false, alreadyDecided: false, revision: 1 }),
    onRejected: (id) => rejected.push(id),
  });
  const res = await receiver.handleCardAction({
    action: 'cancel',
    requestId: 'publish-88',
    payload,
  });
  assert.equal(res.toast.type, 'info');
  assert.equal(res.toast.content, '该发布已被处理（已取消）');
  assert.equal((res.card as { type?: string } | undefined)?.type, 'raw', '重复点击也要返回替换卡');
  assert.equal(
    (res.card as { data?: { header?: { title?: { content?: string } } } }).data?.header?.title?.content,
    '已取消发布',
  );
  assert.deepEqual(rejected, [], '未首写不触发（决定已被他人先做）');
});
