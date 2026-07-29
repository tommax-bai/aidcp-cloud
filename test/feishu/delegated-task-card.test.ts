import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDelegatedTaskConfirmationCard,
  buildDelegatedTaskProgressCard,
  handleDelegatedTaskCardAction,
  parseDelegatedTaskCardAction,
} from '../../src/feishu/delegated-task-card.js';
import { DelegatedTaskService } from '../../src/delegated-task/service.js';
import { MemoryDelegatedTaskStore } from '../../src/delegated-task/store.js';
import { DelegatedTaskServiceError, type DelegatedTaskServicePort } from '../../src/kernel/delegated-task-types.js';

const TASK_ID = '11111111-1111-4111-8111-111111111111';

test('DelegatedTask confirmation card locks task id/version and states verified-success boundary', () => {
  const card = buildDelegatedTaskConfirmationCard({
    taskId: TASK_ID,
    version: 4,
    title: '请确认用户委托任务',
    accountName: '晚风',
    platformLabel: '小红书',
    capability: 'supported',
    actionLabel: '完成有效评论',
    target: '5 条平台验证成功的评论',
    attempts: '最多 8 次',
    schedule: '立即执行',
    approval: '公开评论保留人审',
    priority: '高',
    constraints: ['候选不足允许部分完成'],
  });
  const raw = JSON.stringify(card);
  assert.match(raw, /平台验证结果/);
  assert.match(raw, /候选不足/);
  assert.deepEqual(parseDelegatedTaskCardAction({ action: 'delegated_task_confirm', taskId: TASK_ID, version: 4 }), {
    action: 'delegated_task_confirm', taskId: TASK_ID, version: 4,
  });
  assert.equal(parseDelegatedTaskCardAction({ action: 'delegated_task_confirm', taskId: '../bad', version: 4 }), null);
});

test('DelegatedTask card duplicate confirm is idempotent and returns the same queued task', async () => {
  const now = 2_000_000_000_000;
  const store = new MemoryDelegatedTaskStore();
  const service = new DelegatedTaskService({
    store,
    listAccounts: async () => [{ accountId: 'acc-1', nickname: '晚风', platform: 'xiaohongshu' }],
    now: () => now,
  });
  const receipt = await service.createDraft({
    source: 'feishu', sourceRef: 'om-card', accountName: '晚风', action: 'comment_batch',
    targetSuccessCount: 3, maxAttempts: 5, deadlineAt: now + 86_400_000,
    executionWindow: { mode: 'immediate' }, sourceConstraints: {}, targetConstraints: {},
    approvalMode: 'review', priority: 'normal',
  });
  const value = { action: 'delegated_task_confirm', taskId: receipt.task.id, version: receipt.task.version };
  const first = await handleDelegatedTaskCardAction(service, value);
  assert.equal(first?.toast.type, 'success');
  // card.action.trigger 回调响应的 card 必须包成 { type: 'raw', data }，否则飞书回错误 200672。
  assert.equal(first?.card?.type, 'raw', '确认回调必须回 raw 包裹卡片，防 200672 回归');
  const firstTask = await service.get(receipt.task.id);
  assert.equal(firstTask.status, 'queued');
  const duplicate = await handleDelegatedTaskCardAction(service, value);
  assert.equal(duplicate?.toast.type, 'success');
  assert.equal(duplicate?.card?.type, 'raw', '重复确认回调同样必须回 raw 包裹卡片');
  const live = await service.get(receipt.task.id);
  assert.equal(live.version, firstTask.version, '重复确认不重复排队、不再次增长版本');
  assert.match(JSON.stringify(duplicate?.card?.data), /queued/);
  assert.match(JSON.stringify(buildDelegatedTaskProgressCard(live)), /成功/);
});

test('DelegatedTask 卡片：版本冲突经跨进程裸对象回来时仍判成「已过期」并回刷新卡', async () => {
  const now = 2_000_000_000_000;
  const store = new MemoryDelegatedTaskStore();
  const real = new DelegatedTaskService({
    store,
    listAccounts: async () => [{ accountId: 'acc-1', nickname: '晚风', platform: 'xiaohongshu' }],
    now: () => now,
  });
  const receipt = await real.createDraft({
    source: 'feishu', sourceRef: 'om-stale', accountName: '晚风', action: 'comment_batch',
    targetSuccessCount: 3, maxAttempts: 5, deadlineAt: now + 86_400_000,
    executionWindow: { mode: 'immediate' }, sourceConstraints: {}, targetConstraints: {},
    approvalMode: 'review', priority: 'normal',
  });
  // 委托服务拆到另一个进程后，拒绝是 JSON 反序列化出来的裸对象——原型链上什么都没有。
  const wireError = JSON.parse(
    JSON.stringify(new DelegatedTaskServiceError('version_conflict', '任务已被更新，请刷新后重试', 409)),
  ) as unknown;
  assert.equal(wireError instanceof DelegatedTaskServiceError, false, '前提：跨进程对象不再是本进程的类实例');
  const service = {
    ...real,
    confirm: async () => { throw wireError; },
    get: (taskId: string) => real.get(taskId),
  } as unknown as DelegatedTaskServicePort;

  const result = await handleDelegatedTaskCardAction(service, {
    action: 'delegated_task_confirm', taskId: receipt.task.id, version: receipt.task.version,
  });
  // 认不出来的后果不是报错，是静默降级：普通 error toast + 不再回刷新卡，运营看到的是「操作失败」。
  assert.equal(result?.toast.type, 'info', '版本冲突 MUST 判成提示而非失败');
  assert.equal(result?.card?.type, 'raw', '版本冲突 MUST 回一张最新状态卡，让运营就地看到真实版本');
});
