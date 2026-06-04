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
  assert.match(card.header?.title.content ?? '', /小李美食\(acc-02\)/);
  const buttons = findAction(card.elements);
  assert.equal(buttons[0].text.content, '去处理');
  assert.equal(buttons[0].url, 'https://console.aidcp.local/accounts/acc-02');
});

test('buildAlertCard: P2 用橙色头部', () => {
  const card = buildAlertCard({ severity: 'P2', title: '任务失败', detail: 'x' });
  assert.equal(card.header?.template, 'orange');
});

test('buildCommandResultCard: 成功用绿色，含指令与账号', () => {
  const card = buildCommandResultCard({
    command: '/aidcp pause acc-01',
    ok: true,
    title: '已暂停账号',
    message: '账号已暂停。',
    accountId: 'acc-01',
  });
  assert.equal(card.header?.template, 'green');
  assert.match(card.header?.title.content ?? '', /✅/);
  const div = card.elements[0];
  assert.ok(div.tag === 'div' && div.text);
  assert.match(div.text!.content, /\/aidcp pause acc-01/);
  assert.match(div.text!.content, /acc-01/);
});

test('buildCommandResultCard: 失败用红色', () => {
  const card = buildCommandResultCard({
    command: '/aidcp foo',
    ok: false,
    title: '需要帮助',
    message: 'help',
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
    },
  });
  assert.equal(buttons[1].behaviors?.[0]?.value.action, 'cancel');
});
