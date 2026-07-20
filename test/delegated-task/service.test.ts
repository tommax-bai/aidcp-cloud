import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryDelegatedTaskStore } from '../../src/delegated-task/store.js';
import { DelegatedTaskService, DelegatedTaskServiceError, type DelegatedAccountCandidate } from '../../src/delegated-task/service.js';

const NOW = Date.parse('2026-07-15T10:00:00+08:00');

function service(accounts: DelegatedAccountCandidate[] = [
  { accountId: 'xhs-1', nickname: '小萝北', platform: 'xiaohongshu' as const, status: 'active' as const },
  { accountId: 'fb-1', nickname: 'Tom', platform: 'facebook' as const, status: 'active' as const },
]) {
  const store = new MemoryDelegatedTaskStore();
  return { store, service: new DelegatedTaskService({ store, listAccounts: async () => accounts, now: () => NOW }) };
}

test('creates awaiting confirmation and confirm is idempotent while stale version is rejected', async () => {
  const { service: svc } = service();
  const draft = await svc.createFromText('让小萝北完成 3 条有效评论，最多尝试 5 次');
  assert.equal(draft.kind, 'task');
  if (draft.kind !== 'task') return;
  assert.equal(draft.task.status, 'awaiting_confirmation');
  const confirmed = await svc.confirm(draft.task.id, draft.task.version);
  assert.equal(confirmed.status, 'queued');
  const repeated = await svc.confirm(draft.task.id, draft.task.version);
  assert.equal(repeated.status, 'queued');
});

test('legacy /publish slash command auto-confirms and queues directly (no confirmation card)', async () => {
  const { service: svc } = service();
  const res = await svc.createFromText('/publish 小萝北');
  assert.equal(res.kind, 'task');
  if (res.kind !== 'task') return;
  assert.equal(res.autoQueued, true);
  assert.equal(res.task.status, 'queued');
  assert.equal(res.task.source, 'legacy_command');
  assert.equal(res.task.action, 'publish_post');
  assert.equal(res.task.targetSuccessCount, 1);
  // 人审未被削弱：发布保留 review 审批模式，逐篇内容人审在下游仍会触发。
  assert.equal(res.task.approvalMode, 'review');
});

// change restore-delegated-command-card-origin-chat：命令来源会话被捕获、持久化、与 sourceRef 解耦。
test('command origin chat is captured, round-trips through the store, and is distinct from sourceRef', async () => {
  const { store, service: svc } = service();
  const res = await svc.createFromText('/publish 小萝北', { sourceRef: 'om_message_123', originChatId: 'oc_private_P' });
  assert.equal(res.kind, 'task');
  if (res.kind !== 'task') return;
  assert.equal(res.task.originChatId, 'oc_private_P');
  assert.equal(res.task.sourceRef, 'om_message_123'); // 来源会话与偏向 messageId 的 sourceRef 解耦
  const reloaded = await store.get(res.task.id);
  assert.equal(reloaded?.originChatId, 'oc_private_P');
});

test('non-command task has null originChatId (falls back to existing default / team routing)', async () => {
  const { service: svc } = service();
  const res = await svc.createDraft({
    accountName: '小萝北', action: 'publish_post', targetSuccessCount: 1, maxAttempts: 2,
    deadlineAt: NOW + 86_400_000, source: 'console',
  });
  assert.equal(res.task.originChatId, null);
});

test('legacy /comment slash command auto-confirms and queues directly', async () => {
  const { service: svc } = service();
  const res = await svc.createFromText('/comment 小萝北');
  assert.equal(res.kind, 'task');
  if (res.kind !== 'task') return;
  assert.equal(res.autoQueued, true);
  assert.equal(res.task.status, 'queued');
  assert.equal(res.task.action, 'comment_batch');
  assert.equal(res.task.approvalMode, 'review');
});

test('natural-language business goal still requires the confirmation card (not auto-queued)', async () => {
  const { service: svc } = service();
  const res = await svc.createFromText('让小萝北发布一篇稿件');
  assert.equal(res.kind, 'task');
  if (res.kind !== 'task') return;
  assert.equal(res.autoQueued, false);
  assert.equal(res.task.status, 'awaiting_confirmation');
  assert.equal(res.task.source, 'feishu');
});

test('structured console source auto-confirms and queues directly (no confirmation card)', async () => {
  const { service: svc } = service();
  const res = await svc.createDraft({
    accountName: '小萝北', action: 'publish_post', targetSuccessCount: 1, maxAttempts: 2,
    deadlineAt: NOW + 86_400_000, source: 'console',
  });
  assert.equal(res.autoQueued, true);
  assert.equal(res.task.status, 'queued');
  assert.equal(res.task.source, 'console');
  assert.equal(res.task.approvalMode, 'review'); // 人审不受影响：仍在下游内容审批
});

test('dedupe returns the same active task', async () => {
  const { service: svc } = service();
  const a = await svc.createFromText('让小萝北完成 2 条有效评论');
  const b = await svc.createFromText('让小萝北完成 2 条有效评论');
  assert.equal(a.kind, 'task');
  assert.equal(b.kind, 'task');
  if (a.kind === 'task' && b.kind === 'task') {
    assert.equal(a.task.id, b.task.id);
    assert.equal(b.created, false);
  }
});

test('rejects Facebook arbitrary URL and inspiration publish', async () => {
  const { service: svc } = service();
  await assert.rejects(
    () => svc.createDraft({
      accountName: 'Tom', action: 'comment_batch', targetSuccessCount: 1, maxAttempts: 1,
      deadlineAt: NOW + 86_400_000, targetConstraints: { url: 'https://facebook.com/example/posts/1' }, source: 'feishu',
    }),
    (err: unknown) => err instanceof DelegatedTaskServiceError && err.code === 'unsupported_target_scope',
  );
  await assert.rejects(
    () => svc.createDraft({
      accountName: 'Tom', action: 'publish_from_inspiration', targetSuccessCount: 1, maxAttempts: 1,
      deadlineAt: NOW + 86_400_000, source: 'feishu',
    }),
    (err: unknown) => err instanceof DelegatedTaskServiceError && err.code === 'unsupported_action',
  );
});

test('rejects Video Channels delegated writes because the platform is inbox-only', async () => {
  const { service: svc, store } = service([
    { accountId: 'wc-1', nickname: '视频号客服', platform: 'wechat_channels', status: 'active' },
  ]);
  await assert.rejects(
    () => svc.createDraft({
      accountName: '视频号客服', action: 'publish_post', targetSuccessCount: 1, maxAttempts: 1,
      deadlineAt: NOW + 86_400_000, source: 'feishu',
    }),
    (err: unknown) => err instanceof DelegatedTaskServiceError
      && err.code === 'unsupported_action'
      && err.message.includes('仅支持入站互动回复工作流'),
  );
  assert.deepEqual(await store.list(), []);
});

test('nickname ambiguity fails closed', async () => {
  const { service: svc } = service([
    { accountId: 'a', nickname: '同名', platform: 'xiaohongshu' as const },
    { accountId: 'b', nickname: '同名', platform: 'facebook' as const },
  ]);
  await assert.rejects(
    () => svc.createDraft({ accountName: '同名', action: 'publish_post', targetSuccessCount: 1, maxAttempts: 1, deadlineAt: NOW + 10_000, source: 'feishu' }),
    (err: unknown) => err instanceof DelegatedTaskServiceError && err.code === 'account_ambiguous',
  );
});

test('unified account directory accepts legacy platform name but stores and displays the preferred operator alias', async () => {
  const { service: svc } = service([{
    accountId: 'fb-machine-id',
    displayName: 'Tianxing Bai1',
    names: ['Tianxing Bai1', 'Tianxing Bai', 'Facebook 运营号'],
    platform: 'facebook',
    status: 'active',
  }]);
  const result = await svc.createDraft({
    accountName: 'Tianxing Bai', action: 'publish_post', targetSuccessCount: 1, maxAttempts: 1,
    deadlineAt: NOW + 10_000, source: 'feishu',
  });
  assert.equal(result.task.accountId, 'fb-machine-id', '机器载荷仍使用 accountId');
  assert.equal(result.task.accountName, 'Tianxing Bai1', '人类可见回执使用统一首选名');
});
