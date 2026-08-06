import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { InteractionStore } from '@automation/interactions/interaction-store.js';
import { InteractionInboxService } from '@automation/interactions/interaction-inbox-service.js';
import { InteractionMetrics } from '@automation/interactions/metrics.js';
import type { ReplyConfigStore } from '@api/interactions/reply-config-store.js';
import type { ReplyWorkflow } from '@automation/interactions/reply-workflow.js';
import type { InteractionAuthStatusPayload } from '@kernel/kernel/interaction-types.js';

const activeAuth: InteractionAuthStatusPayload = {
  envKey: 'env-wechat-a',
  accountId: 'acct-wechat-a',
  platform: 'wechat_channels',
  status: 'active',
  browserState: 'closed',
  capabilities: {
    commentsRead: true,
    commentsReply: false,
    dmRead: true,
    dmSendText: false,
    dmSendImage: false,
  },
  runtimeControlsVersion: 1,
  identity: {
    externalId: 'finder-a',
    displayName: '  视频号昵称  ',
    identityHash: `sha256:${'a'.repeat(64)}`,
  },
  checkedAt: 1,
  reasonCode: null,
};

function createService(input: {
  recordNickname: (accountId: string, nickname: string) => Promise<void> | void;
  events: string[];
  metrics?: InteractionMetrics;
  warnings?: string[];
}): InteractionInboxService {
  const store = {
    upsertAuthStatus: async () => { input.events.push('auth'); },
  } as unknown as InteractionStore;
  return new InteractionInboxService({
    store,
    workflow: {} as ReplyWorkflow,
    configs: {} as ReplyConfigStore,
    controllerFor: () => undefined,
    metrics: input.metrics ?? new InteractionMetrics(),
    recordNickname: async (accountId, nickname) => {
      input.events.push(`nickname:${accountId}:${nickname}`);
      await input.recordNickname(accountId, nickname);
      return { outcome: 'updated', nickname };
    },
    logger: { warn: (message) => { input.warnings?.push(String(message)); } },
  });
}

test('active Video Channels auth persists the verified display name after auth scope persistence', async () => {
  const events: string[] = [];
  const service = createService({ events, recordNickname: () => undefined });

  await service.onAuthStatus(activeAuth);

  assert.deepEqual(events, ['auth', 'nickname:acct-wechat-a:视频号昵称']);
});

test('auth nickname enrichment ignores unverified states and missing identity', async () => {
  const events: string[] = [];
  const service = createService({ events, recordNickname: () => undefined });

  await service.onAuthStatus(activeAuth);
  await service.onAuthStatus({ ...activeAuth, status: 'reauth_required' });
  await service.onAuthStatus({ ...activeAuth, identity: null });

  assert.deepEqual(events, ['auth', 'nickname:acct-wechat-a:视频号昵称', 'auth', 'auth']);
});

test('nickname enrichment failure does not reject an already persisted auth status', async () => {
  const events: string[] = [];
  const warnings: string[] = [];
  const metrics = new InteractionMetrics();
  const service = createService({
    events,
    warnings,
    metrics,
    recordNickname: () => { throw new Error('nickname-store-unavailable'); },
  });

  await service.onAuthStatus(activeAuth);

  assert.deepEqual(events, ['auth', 'nickname:acct-wechat-a:视频号昵称']);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /account=acct-wechat-a/);
  assert.equal(metrics.snapshot().counters['interaction_auth_status_total|status=active'], 1);
  assert.equal(metrics.snapshot().counters['interaction_account_nickname_total|status=failed'], 1);
});
