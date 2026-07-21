import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  projectClientPublishQueue,
  projectClientPublishQueueCancelReceipt,
} from '../src/client-auth/client-publish-queue.js';
import type { DelegatedTask } from '../src/delegated-task/types.js';
import type {
  PublishJourneyView,
  PublishLifecycleProjection,
  PublishStageView,
} from '../src/panel/publish-stage-lifecycle.js';

function task(overrides: Partial<DelegatedTask> = {}): DelegatedTask {
  return {
    id: 'task-1',
    executionTarget: 'dev',
    accountId: 'acct-target',
    accountName: 'internal account name',
    platform: 'xiaohongshu',
    action: 'publish_post',
    actionFamily: 'publish',
    targetSuccessCount: 1,
    maxAttempts: 2,
    deadlineAt: 9_000,
    notBefore: 2_000,
    executionWindow: { mode: 'immediate' },
    sourceConstraints: { title: '夏日穿搭', internalPrompt: 'never expose this prompt' },
    targetConstraints: { internalTarget: 'never expose this target' },
    approvalMode: 'review',
    priority: 'normal',
    source: 'edge',
    sourceRef: 'internal-source-ref',
    originChatId: 'internal-chat',
    status: 'queued',
    progress: { successCount: 0, attemptCount: 0, skippedCount: 0, failureCount: 0 },
    currentStep: 'internal-step',
    terminalOutcome: null,
    pauseRequested: false,
    cancelRequested: false,
    nextEligibleAt: null,
    claimToken: 'internal-claim-token',
    claimExpiresAt: 8_000,
    dedupeKey: 'internal-dedupe',
    version: 3,
    createdAt: 1_000,
    updatedAt: 1_500,
    confirmedAt: 1_200,
    completedAt: null,
    ...overrides,
  };
}

function stage(
  key: PublishStageView['key'],
  state: PublishStageView['state'],
  progress?: { current: number; total: number },
): PublishStageView {
  return {
    key,
    label: `internal-${key}`,
    state,
    summary: `internal summary ${key}`,
    facts: [`internal fact ${key}`],
    ...(progress ? { progress } : {}),
  };
}

function journey(overrides: Partial<PublishJourneyView> = {}): PublishJourneyView {
  return {
    journeyId: 'publish:21',
    runId: 'internal-run',
    recordId: 21,
    accountId: 'acct-target',
    title: '已经生成的笔记',
    sourceTitle: '原始灵感',
    kind: 'rewrite',
    startedAt: 3_000,
    active: true,
    status: 'waiting_approval',
    statusSummary: 'internal status summary',
    stages: [
      stage('source', 'completed'),
      stage('content', 'completed'),
      stage('text_quality', 'completed'),
      stage('visual_plan', 'completed'),
      stage('image_review', 'completed', { current: 2, total: 4 }),
      stage('package', 'completed'),
      stage('approval', 'waiting_human'),
      stage('dispatch', 'pending'),
    ],
    snapshot: { prompt: 'internal snapshot must not cross customer boundary' },
    ...overrides,
  };
}

test('客户发布队列只输出白名单字段、按账号隔离并压缩为真实四阶段', () => {
  const lifecycle: PublishLifecycleProjection = {
    status: 'waiting_human',
    active: [journey(), journey({ journeyId: 'other', accountId: 'acct-other' })],
    recent: [journey({
      journeyId: 'publish:20',
      recordId: 20,
      active: false,
      status: 'submitted',
      stages: [stage('approval', 'completed'), stage('dispatch', 'completed')],
    })],
  };
  const view = projectClientPublishQueue({
    accountId: 'acct-target',
    lifecycle,
    tasks: [
      task(),
      task({ id: 'other-task', accountId: 'acct-other' }),
      task({ id: 'wrong-platform-task', platform: 'facebook' }),
    ],
  });

  assert.deepEqual(view.summary, { inProgress: 2, waitingForYou: 1, cancellable: 1 });
  assert.deepEqual(view.tasks[0], {
    id: 'task-1',
    title: '夏日穿搭',
    action: '发布笔记',
    status: 'queued',
    statusLabel: '排队中',
    cancelRequested: false,
    version: 3,
    createdAt: 1_000,
    updatedAt: 1_500,
    notBefore: 2_000,
  });
  assert.deepEqual(view.active[0].stages.map(({ key, label, state }) => ({ key, label, state })), [
    { key: 'source', label: '开始创作', state: 'completed' },
    { key: 'content', label: '正文与配图', state: 'completed' },
    { key: 'approval', label: '发布确认', state: 'waiting_human' },
    { key: 'dispatch', label: '发布结果', state: 'pending' },
  ]);
  assert.deepEqual(view.active[0].stages[1].progress, { current: 2, total: 4 });
  assert.equal(view.active[0].stages[2].summary, '发布确认：待你确认');
  assert.equal(view.active[0].stages[3].summary, '发布结果：等待发布');
  assert.equal(view.recent[0].stages[2].summary, '发布确认：已确认');
  assert.equal(view.recent[0].statusLabel, '平台确认中，请勿重复操作');
  const serialized = JSON.stringify(view);
  for (const secret of [
    'acct-target', 'acct-other', 'internal fact', 'internal snapshot', 'internal-claim-token',
    'internal-source-ref', 'internal-step', 'internalPrompt', 'internalTarget', 'internal-run',
  ]) assert.doesNotMatch(serialized, new RegExp(secret));
});

test('取消回执诚实区分立即终态与规划中的安全停止', () => {
  assert.deepEqual(projectClientPublishQueueCancelReceipt(task({
    status: 'cancelled', cancelRequested: false, version: 4,
  })), {
    id: 'task-1', status: 'cancelled', cancelRequested: false, version: 4, terminal: true,
  });
  assert.deepEqual(projectClientPublishQueueCancelReceipt(task({
    status: 'planning', cancelRequested: true, version: 4,
  })), {
    id: 'task-1', status: 'planning', cancelRequested: true, version: 4, terminal: false,
  });
});
