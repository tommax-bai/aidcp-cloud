import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PublishDispatchTriggerError } from '@kernel/kernel/publish-approval-contract.js';
import { PublishApprovalOutboxRelay } from '@api/publish-agent/publish-approval-outbox-relay.js';

test('PublishApproved outbox relay: 仅在 trigger 明确 queued/duplicate 后 ack，失败保持 durable pending', async () => {
  const command = {
    requestId: 'publish-42',
    revision: 3,
    candidateRef: '42',
    contentVersion: 7,
    envKey: 'env-1',
    executionTarget: 'dev' as const,
  };
  const acked: string[] = [];
  let fail = true;
  const relay = new PublishApprovalOutboxRelay({
    executionTarget: 'dev',
    store: {
      listPendingApprovedCommands: async () => [command],
      markApprovedCommandConsumed: async (item) => {
        acked.push(`${item.requestId}:${item.revision}`);
        return true;
      },
    },
    trigger: {
      triggerApproved: async () => {
        if (fail) throw new PublishDispatchTriggerError('publish_trigger_result_unknown');
        return { accepted: true, disposition: 'duplicate' };
      },
    },
    logger: { warn() {} },
  });

  assert.deepEqual(await relay.runOnce(), { found: 1, acknowledged: 0, failed: 1 });
  assert.deepEqual(acked, [], 'trigger 结果未知时 outbox 仍未消费，后续轮次可补投');
  fail = false;
  assert.deepEqual(await relay.runOnce(), { found: 1, acknowledged: 1, failed: 0 });
  assert.deepEqual(acked, ['publish-42:3']);
});

test('PublishApproved outbox relay: 安全退休 legacy comment，但 unknown publish 仍保留且不阻塞后续合法命令', async () => {
  const commands = [
    {
      requestId: 'comment-note-7-171',
      revision: 1,
      candidateRef: 'note-7-171',
      contentVersion: 0,
      envKey: null,
      executionTarget: 'dev' as const,
    },
    {
      requestId: 'publish-unknown',
      revision: 2,
      candidateRef: 'unknown',
      contentVersion: 0,
      envKey: null,
      executionTarget: 'dev' as const,
    },
    {
      requestId: 'publish-43',
      revision: 4,
      candidateRef: '43',
      contentVersion: 8,
      envKey: 'env-1',
      executionTarget: 'dev' as const,
    },
  ];
  const triggered: string[] = [];
  const acked: string[] = [];
  const warnings: string[] = [];
  const relay = new PublishApprovalOutboxRelay({
    executionTarget: 'dev',
    store: {
      listPendingApprovedCommands: async () => commands,
      markApprovedCommandConsumed: async (item) => {
        acked.push(`${item.requestId}:${item.revision}`);
        return true;
      },
    },
    trigger: {
      triggerApproved: async (input) => {
        triggered.push(input.requestId);
        if (input.requestId === 'publish-unknown') {
          throw new PublishDispatchTriggerError('publish_trigger_invalid_request');
        }
        return { accepted: true, disposition: 'queued' };
      },
    },
    logger: { warn: (message) => warnings.push(String(message)) },
  });

  assert.deepEqual(await relay.runOnce(), { found: 3, acknowledged: 2, failed: 1 });
  assert.deepEqual(
    triggered,
    ['publish-unknown', 'publish-43'],
    'legacy comment 不触发发布；unknown 仍交严格 trigger 判定，失败也不阻断后续合法命令',
  );
  assert.deepEqual(
    acked,
    ['comment-note-7-171:1', 'publish-43:4'],
    '只退休双字段吻合的 legacy comment 与明确受理的 publish',
  );
  assert.equal(
    warnings.some((line) => line.includes('publish-unknown') && line.includes('retained')),
    true,
    'unknown publish 必须保持 pending 并留可观测失败',
  );
});

test('PublishApproved outbox relay: comment 前缀与 candidateRef 不吻合时不得按 legacy 行吞掉', async () => {
  const command = {
    requestId: 'comment-note-8-171',
    revision: 1,
    candidateRef: 'different-note',
    contentVersion: 0,
    envKey: null,
    executionTarget: 'dev' as const,
  };
  let triggered = 0;
  let acked = 0;
  const relay = new PublishApprovalOutboxRelay({
    executionTarget: 'dev',
    store: {
      listPendingApprovedCommands: async () => [command],
      markApprovedCommandConsumed: async () => {
        acked += 1;
        return true;
      },
    },
    trigger: {
      triggerApproved: async () => {
        triggered += 1;
        throw new PublishDispatchTriggerError('publish_trigger_invalid_request');
      },
    },
    logger: { warn() {} },
  });

  assert.deepEqual(await relay.runOnce(), { found: 1, acknowledged: 0, failed: 1 });
  assert.equal(triggered, 1);
  assert.equal(acked, 0);
});
