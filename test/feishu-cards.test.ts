import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAlertCard,
  buildCommandResultCard,
  buildDailySummaryCard,
  buildPublishApprovalCard,
} from '../src/feishu/cards.js';
import type { FeishuButton, FeishuElement } from '../src/feishu/types.js';

function findAction(elements: FeishuElement[]): FeishuButton[] {
  const action = elements.find((e) => e.tag === 'action');
  return action && action.tag === 'action' ? action.actions : [];
}

test('buildDailySummaryCard: 头部、字段与状态行齐全', () => {
  const card = buildDailySummaryCard({
    date: '2026-05-30',
    onlineAccounts: 6,
    totalAccounts: 8,
    totalViews: 920,
    likeRate: 0.26,
    likeRateHealthy: true,
    publishCount: 3,
    newFollowers: 42,
    statusBreakdown: { normal: 6, warned: 1, restricted: 1 },
    dashboardUrl: 'https://console.aidcp.local/dashboard',
  });

  assert.equal(card.header?.template, 'blue');
  assert.match(card.header?.title.content ?? '', /2026-05-30/);

  const div = card.elements.find((e) => e.tag === 'div' && 'fields' in e && e.fields);
  assert.ok(div && div.tag === 'div' && div.fields);
  // 在线/浏览/点赞率/发布 + 涨粉 = 5 字段
  assert.equal(div.fields!.length, 5);
  assert.match(div.fields![2].text.content, /26%/);
  assert.match(div.fields![2].text.content, /✅/);

  // 状态分布行
  const statusDiv = card.elements.find(
    (e) => e.tag === 'div' && 'text' in e && /normal/.test(e.text?.content ?? ''),
  );
  assert.ok(statusDiv);

  // 跳转按钮
  const buttons = findAction(card.elements);
  assert.equal(buttons[0].url, 'https://console.aidcp.local/dashboard');
});

test('buildDailySummaryCard: 点赞率不健康显示 ⚠️ 且省略涨粉', () => {
  const card = buildDailySummaryCard({
    date: '2026-05-30',
    onlineAccounts: 1,
    totalAccounts: 1,
    totalViews: 10,
    likeRate: 0.05,
    likeRateHealthy: false,
    publishCount: 0,
    statusBreakdown: { normal: 1 },
  });
  const div = card.elements.find((e) => e.tag === 'div' && 'fields' in e && e.fields);
  assert.ok(div && div.tag === 'div' && div.fields);
  assert.equal(div.fields!.length, 4); // 无涨粉
  assert.match(div.fields![2].text.content, /⚠️/);
});

test('buildAlertCard: P0/P1 红色头部 + 去处理按钮', () => {
  const card = buildAlertCard({
    severity: 'P1',
    title: '验证码弹出',
    accountId: 'acc-02',
    accountName: '小李美食',
    detail: '账号触发验证码，任务已自动暂停。',
    actionUrl: 'https://console.aidcp.local/accounts/acc-02',
  });
  assert.equal(card.header?.template, 'red');
  assert.match(card.header?.title.content ?? '', /P1/);
  assert.match(card.header?.title.content ?? '', /小李美食/);
  assert.doesNotMatch(card.header?.title.content ?? '', /acc-02/);
  const buttons = findAction(card.elements);
  assert.equal(buttons[0].text.content, '去处理');
  assert.equal(buttons[0].url, 'https://console.aidcp.local/accounts/acc-02');
});

test('buildAlertCard: 缺昵称时账号标题不泄漏机器 ID', () => {
  const card = buildAlertCard({
    severity: 'P1',
    title: '未知阻断弹窗',
    accountId: 'acc-02',
    detail: 'x',
  });
  assert.match(card.header?.title.content ?? '', /（未获取昵称）/);
  assert.doesNotMatch(card.header?.title.content ?? '', /acc-02/);
});

test('buildAlertCard: P2 用橙色头部', () => {
  const card = buildAlertCard({ severity: 'P2', title: '任务失败', detail: 'x' });
  assert.equal(card.header?.template, 'orange');
});

test('buildCommandResultCard: 成功用绿色，含指令与账号', () => {
  const card = buildCommandResultCard({
    command: '/pause 小李美食',
    ok: true,
    title: '已暂停账号',
    message: '账号已暂停。',
    accountId: 'acc-01',
    accountName: '小李美食',
  });
  assert.equal(card.header?.template, 'green');
  assert.match(card.header?.title.content ?? '', /✅/);
  const div = card.elements[0];
  assert.ok(div.tag === 'div' && div.text);
  assert.match(div.text!.content, /\/pause 小李美食/);
  assert.match(div.text!.content, /\*\*账号\*\*：小李美食/);
  assert.doesNotMatch(div.text!.content, /\*\*账号\*\*：acc-01/);
});

test('buildCommandResultCard: 缺昵称时账号行回落 ID', () => {
  const card = buildCommandResultCard({
    command: '参照创作',
    ok: false,
    level: 'error',
    title: '参照创作编排失败',
    message: '编排状态 failed',
    accountId: 'acc-01',
  });
  const div = card.elements[0];
  assert.ok(div.tag === 'div' && div.text);
  assert.match(div.text!.content, /\*\*账号\*\*：（未获取昵称）/);
  assert.doesNotMatch(div.text!.content, /acc-01/);
});

test('buildCommandResultCard: 失败用红色', () => {
  const card = buildCommandResultCard({
    command: '/foo',
    ok: false,
    title: '需要帮助',
    message: 'help',
  });
  assert.equal(card.header?.template, 'red');
  assert.match(card.header?.title.content ?? '', /❌/);
});

test('buildCommandResultCard: level=warning 用黄色 ⚠️（触发成功但编排未产出，别染绿）', () => {
  const card = buildCommandResultCard({
    command: '/publish Tmax',
    ok: false,
    level: 'warning',
    title: '发帖未产出',
    message: '已触发但编排 skipped',
  });
  assert.equal(card.header?.template, 'yellow');
  assert.match(card.header?.title.content ?? '', /⚠️/);
});

test('buildCommandResultCard: level=error 用红色 ❌（编排失败，绝不绿色）', () => {
  const card = buildCommandResultCard({
    command: '/publish Tmax',
    ok: false,
    level: 'error',
    title: '发帖编排失败',
    message: '编排状态 failed\n原因：Pipeline timed out',
  });
  assert.equal(card.header?.template, 'red');
  assert.match(card.header?.title.content ?? '', /❌/);
});

test('buildPublishApprovalCard: 构造新版 callback behaviors', () => {
  const card = buildPublishApprovalCard({
    requestId: 'req-1',
    title: '测试标题',
    content: '这是一段很长的正文内容，用于验证审批卡片摘要与按钮回调载荷。',
    tags: ['话题A', '话题B'],
  });
  assert.equal(card.header?.template, 'orange');
  const buttons = findAction(card.elements);
  assert.equal(buttons.length, 2);
  assert.equal(buttons[0].behaviors?.[0]?.type, 'callback');
  assert.deepEqual(buttons[0].behaviors?.[0]?.value, {
    action: 'approve',
    requestId: 'req-1',
    payload: {
      title: '测试标题',
      content: '这是一段很长的正文内容，用于验证审批卡片摘要与按钮回调载荷。',
      tags: ['话题A', '话题B'],
      // edit-note-draft-before-publish：卡片烤入构建时内容版本号（未编辑草稿=0），随授权守「审=发」。
      contentVersion: 0,
    },
  });
  assert.equal(buttons[1].behaviors?.[0]?.value.action, 'cancel');
});

test('buildPublishApprovalCard: 审批卡显示账号昵称，缺昵称时回落账号 id', () => {
  const withName = buildPublishApprovalCard({
    requestId: 'publish-1',
    title: '标题',
    content: '正文',
    tags: [],
    accountId: 'acc-01',
    accountName: 'Tmax',
  });
  const named = JSON.stringify(withName);
  assert.match(named, /账号/);
  assert.match(named, /Tmax/);
  assert.doesNotMatch(named, /acc-01/);

  const fallback = buildPublishApprovalCard({
    requestId: 'publish-2',
    title: '标题',
    content: '正文',
    tags: [],
    accountId: 'acc-02',
  });
  const flat = JSON.stringify(fallback);
  assert.match(flat, /账号/);
  assert.match(flat, /（未获取昵称）/);
  assert.doesNotMatch(flat, /acc-02/);
});

test('buildPublishApprovalCard: publish-<n> 卡片带「编号」字段（与客户端发布卡对暗号）', () => {
  const card = buildPublishApprovalCard({
    requestId: 'publish-83',
    title: '标题',
    content: '正文',
    tags: [],
  });
  const flat = JSON.stringify(card);
  assert.match(flat, /编号/);
  assert.match(flat, /#83/);
});

test('buildPublishApprovalCard: 非 publish-<n> requestId 不带编号（宁缺毋假）', () => {
  const card = buildPublishApprovalCard({
    requestId: 'req-test-1',
    title: '标题',
    content: '正文',
    tags: [],
  });
  assert.ok(!JSON.stringify(card).includes('编号'));
});
