import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Envelope } from '../../src/comm/protocol.js';
import type { EdgePusher } from '../../src/comm/ws-server.js';
import type { ReplyConfigStore } from '../../src/interactions/reply-config-store.js';
import type { InteractionStore } from '../../src/interactions/interaction-store.js';
import { InteractionMetrics } from '../../src/interactions/metrics.js';
import { InteractionSendOrchestrator, replyIdempotencyKey } from '../../src/interactions/send-orchestrator.js';
import type { ReplyConfigSnapshot, ScopedJobContext } from '../../src/interactions/types.js';

const now = 1784044810000;

function context(state: ScopedJobContext['job']['state'] = 'queued'): ScopedJobContext {
  return {
    thread: {
      id: 'thread_comment_100', platform: 'wechat_channels', accountId: 'acct_wc_demo', envKey: 'env_wc_demo',
      channel: 'comment', externalThreadId: 'comment_msg_100', sourceExternalId: 'video-demo-001',
      sourceTitle: '示例视频标题', sourceCoverUrl: null,
      participant: { externalId: 'viewer-demo-001', displayName: '示例观众', avatarUrl: null },
      status: 'waiting_review', lastMessageAt: now - 10_000, lastSyncedAt: now - 9_000,
    },
    message: {
      id: 'msg_comment_100', threadId: 'thread_comment_100', direction: 'inbound',
      externalMessageId: 'comment_msg_100', externalParentId: null, externalRootId: 'comment_msg_100',
      messageType: 'text', contentText: '这个视频很有帮助，谢谢分享。', attachmentMeta: null,
      lifecycle: 'active', platformCreatedAt: now - 10_000,
    },
    job: {
      id: 'job_comment_100', inboundMessageId: 'msg_comment_100', state, version: 4,
      matchedRuleId: 'rule_thanks', configVersion: 2,
      template: { templateId: 'tpl_thanks', templateVersion: 1 },
      renderedText: '谢谢你的喜欢，欢迎继续交流。', polishedText: '谢谢你的喜欢，欢迎继续交流。',
      finalText: '谢谢你的喜欢，欢迎继续交流。', riskLevel: 'low', riskReasons: [],
      approvalActor: 'client:user-a', approvedAt: now - 1_000, idempotencyKey: null, updatedAt: now - 1_000,
      meaningChanged: false, introducedClaims: [], lastErrorCode: null,
    },
  };
}

function config(): ReplyConfigSnapshot {
  return {
    accountId: 'acct_wc_demo', platform: 'wechat_channels', configVersion: 2, state: 'published',
    policy: {
      mode: 'review_before_send', generateDrafts: true, sendReplies: true,
      channels: {
        comment: { enabled: true, aiPolishEnabled: true, allowAutoSend: false },
        dm: { enabled: true, aiPolishEnabled: true, allowAutoSend: false },
      },
      rateLimits: { accountPerMinute: 2, accountPerHour: 10, accountPerDay: 30,
        threadCooldownSeconds: 60, newLoginCooldownSeconds: 600, consecutiveFailureLimit: 3 },
    },
    templates: [], rules: [], profiles: [{
      channel: 'comment', selfName: '示例视频号', userAddress: '你', tone: ['friendly'], maxLength: 500,
      allowEmoji: false, allowLinks: false, blockedPhrases: [], disallowedClaims: [], requiredDisclaimer: null,
      variableFallbacks: { user_name: '朋友', video_title: '这个视频', account_name: '本账号', support_channel: '客服' },
    }], createdAt: now - 100_000, createdBy: 'admin',
    publishedAt: now - 100_000, publishedBy: 'admin',
  };
}

test('reply idempotency key exactly matches the frozen UTF-8 formula fixture', () => {
  assert.equal(replyIdempotencyKey(context()), 'e0e055e5abfced94f0e808eb5745a36b5f9f7aecc75c2d0377f5b2f692ae2ae9');
});

test('global write kill switch defaults off before any job data is touched', async () => {
  let read = false;
  const sender = new InteractionSendOrchestrator({
    store: { getJobContext: async () => { read = true; return context(); } } as unknown as InteractionStore,
    configs: {} as ReplyConfigStore,
    pusher: {} as EdgePusher,
    controllerFor: () => undefined,
    metrics: new InteractionMetrics(),
    env: {},
  });
  await assert.rejects(sender.dispatchQueued({ accountId: 'acct_wc_demo', envKey: 'env_wc_demo', jobId: 'job_comment_100', expectedVersion: 4 }),
    (error: unknown) => (error as { code?: string }).code === 'INTERACTION_FEATURE_DISABLED');
  assert.equal(read, false);
});

test('approved command is persisted as one attempt and dispatched to one account Edge without claiming sent', async () => {
  const pushed: Envelope[] = [];
  let markedDispatched = false;
  let createCalls = 0;
  const base = context('queued');
  const store = {
    getJobContext: async () => base,
    getRuntimeControls: async () => ({
      accountId: 'acct_wc_demo', platform: 'wechat_channels', envKey: 'env_wc_demo', version: 1,
      commentsReadEnabled: true, commentsReplyEnabled: true, dmReadEnabled: true, dmSendTextEnabled: true,
      dmSendImageEnabled: false, writePaused: false, consecutiveFailures: 0, circuitOpenedAt: null,
      lastConfirmedAt: null, updatedAt: now, updatedBy: 'admin',
    }),
    getSendAuthGate: async () => ({
      activeSince: now - 700_000,
      auth: {
        envKey: 'env_wc_demo', accountId: 'acct_wc_demo', platform: 'wechat_channels', status: 'active',
        browserState: 'closed', capabilities: { commentsRead: true, commentsReply: true, dmRead: true,
          dmSendText: true, dmSendImage: false },
        identity: { externalId: 'finder', displayName: '示例视频号', identityHash: `sha256:${'1'.repeat(64)}` },
        checkedAt: now - 1_000, reasonCode: null,
      },
    }),
    sendWindowCounts: async () => ({ minute: 0, hour: 0, day: 0, lastThreadSendAt: null }),
    createAttempt: async (input: { idempotencyKey: string }) => {
      createCalls += 1;
      return {
        job: { ...base.job, state: 'sending' as const, version: 5, idempotencyKey: input.idempotencyKey },
        attempt: { id: 'attempt_comment_100_1', replyJobId: base.job.id, attemptNo: 1,
          idempotencyKey: input.idempotencyKey, status: 'created' as const, verificationStatus: 'not_needed' as const,
          externalMessageId: null, errorCode: null, startedAt: now, finishedAt: null },
      };
    },
    markAttemptDispatched: async () => { markedDispatched = true; },
  } as unknown as InteractionStore;
  const pusher: EdgePusher = {
    resolveEdgeIdForAccount: (accountId) => accountId === 'acct_wc_demo' ? 'edge-wc' : null,
    pushToEdges: (env, edgeId) => { assert.equal(edgeId, 'edge-wc'); pushed.push(env); return 1; },
    edgeCount: () => 1, onlineEdgeCount: () => 1, pauseEdge: () => {}, resumeEdge: () => {},
  };
  const sender = new InteractionSendOrchestrator({
    store,
    configs: { getSnapshot: async () => config() } as unknown as ReplyConfigStore,
    pusher,
    controllerFor: () => ({ explain: () => ({ allowed: true }), record: async () => true }),
    metrics: new InteractionMetrics(), env: { AIDCP_INTERACTION_WRITE_ENABLED: 'true' }, clock: () => now,
  });
  const output = await sender.dispatchQueued({ accountId: 'acct_wc_demo', envKey: 'env_wc_demo',
    jobId: 'job_comment_100', expectedVersion: 4 });
  assert.equal(output.job.state, 'sending');
  assert.equal(createCalls, 1);
  assert.equal(markedDispatched, true);
  assert.equal(pushed.length, 1);
  assert.equal(pushed[0].type, 'interaction.reply.send');
  assert.deepEqual(pushed[0].payload, {
    jobId: 'job_comment_100', attemptId: 'attempt_comment_100_1',
    idempotencyKey: 'e0e055e5abfced94f0e808eb5745a36b5f9f7aecc75c2d0377f5b2f692ae2ae9',
    envKey: 'env_wc_demo', accountId: 'acct_wc_demo', platform: 'wechat_channels', channel: 'comment',
    target: { threadExternalId: 'comment_msg_100', inboundMessageExternalId: 'comment_msg_100', parentExternalId: null },
    content: { type: 'text', text: '谢谢你的喜欢，欢迎继续交流。' }, expiresAt: now + 120_000,
  });
});

test('startup/reconnect recovery emits verification-only reconcile and never replays reply.send', async () => {
  const pushed: Envelope[] = [];
  const base = context('sending');
  const command = {
    jobId: base.job.id, attemptId: 'attempt-recover-1', idempotencyKey: 'a'.repeat(64),
    envKey: base.thread.envKey, accountId: base.thread.accountId, platform: 'wechat_channels' as const,
    channel: base.thread.channel, target: { threadExternalId: base.thread.externalThreadId,
      inboundMessageExternalId: base.message.externalMessageId, parentExternalId: base.message.externalParentId },
    content: { type: 'text' as const, text: base.job.finalText! }, expiresAt: now,
  };
  const sender = new InteractionSendOrchestrator({
    store: { recoverableAttempts: async () => [{ accountId: base.thread.accountId, envKey: base.thread.envKey,
      status: 'dispatched', command }] } as unknown as InteractionStore,
    configs: {} as ReplyConfigStore,
    pusher: { pushToEdges: (envelope: Envelope, edgeId?: string) => {
      assert.equal(edgeId, 'edge-recovery'); pushed.push(envelope); return 1;
    } } as EdgePusher,
    controllerFor: () => undefined, metrics: new InteractionMetrics(), env: {}, clock: () => now,
  });
  assert.equal(await sender.reconcileRecoverable(base.thread.accountId, 'edge-recovery'), 1);
  assert.deepEqual(pushed.map((envelope) => envelope.type), ['interaction.reply.reconcile']);
  assert.deepEqual((pushed[0].payload as { attempts: Array<{ command: unknown }> }).attempts[0].command, command);
});
