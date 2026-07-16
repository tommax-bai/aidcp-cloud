import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import pg from 'pg';
import type { Envelope } from '../../src/comm/protocol.js';
import { InteractionStore } from '../../src/interactions/interaction-store.js';
import { InteractionInboxService } from '../../src/interactions/interaction-inbox-service.js';
import { InteractionMetrics } from '../../src/interactions/metrics.js';
import { ReplyAiService } from '../../src/interactions/reply-ai.js';
import { ReplyConfigStore } from '../../src/interactions/reply-config-store.js';
import { ReplyWorkflow } from '../../src/interactions/reply-workflow.js';
import { parseSyncBatchPayload } from '../../src/interactions/contract.js';
import { InteractionSendOrchestrator, replyIdempotencyKey } from '../../src/interactions/send-orchestrator.js';
import type { InteractionReplyResultPayload, InteractionSyncBatchPayload } from '../../src/interactions/types.js';

const connectionString = process.env.AIDCP_INTERACTION_TEST_DATABASE_URL;
const attemptGate = {
  rateLimits: { accountPerMinute: 100, accountPerHour: 100, accountPerDay: 100,
    threadCooldownSeconds: 0, newLoginCooldownSeconds: 0, consecutiveFailureLimit: 3 },
  now: 1784044802100,
};

test('PostgreSQL: batch idempotency/rollback, job+attempt races, ambiguous recovery and confirmed result',
  { skip: !connectionString }, async () => {
    const pool = new pg.Pool({ connectionString });
    const store = new InteractionStore({ pool, clock: () => 1784044802100 });
    try {
      await pool.query(`TRUNCATE
        interaction_api_requests,interaction_audit_events,interaction_send_attempts,interaction_reply_jobs,
        interaction_messages,interaction_threads,interaction_sync_batches,interaction_sync_cursors,
        interaction_auth_state,interaction_runtime_controls
        RESTART IDENTITY CASCADE`);
      await pool.query(`INSERT INTO accounts(account_id,label,platform) VALUES
        ('acct_wc_demo','mock Edge account','wechat_channels')
        ON CONFLICT (account_id) DO UPDATE SET platform=EXCLUDED.platform`);
      await store.init();
      await store.upsertAuthStatus({
        envKey: 'env_wc_demo', accountId: 'acct_wc_demo', platform: 'wechat_channels', status: 'active',
        browserState: 'closed', capabilities: { commentsRead: true, commentsReply: true, dmRead: true,
          dmSendText: true, dmSendImage: false },
        identity: { externalId: 'finder_demo_public', displayName: '示例视频号', identityHash: `sha256:${'1'.repeat(64)}` },
        runtimeControlsVersion: 0, checkedAt: 1784044000000, reasonCode: null,
      });
      const fixture = JSON.parse(await readFile(new URL('../fixtures/wechat-channels-interaction/v1/ws/comment-sync-batch.json', import.meta.url), 'utf8')) as { payload: unknown };
      const payload = parseSyncBatchPayload(fixture.payload);
      assert.ok(payload);

      const duplicates = await Promise.all([store.ingestBatch(payload), store.ingestBatch(payload)]);
      assert.deepEqual(duplicates.map((result) => result.ack.status).sort(), ['accepted', 'duplicate']);
      assert.equal((await pool.query(`SELECT count(*)::int AS n FROM interaction_messages`)).rows[0].n, 1);
      assert.equal((await pool.query(`SELECT count(*)::int AS n FROM interaction_reply_jobs`)).rows[0].n, 1);

      const broken: InteractionSyncBatchPayload = {
        ...payload, batchId: 'batch-rollback', cursorAfter: 'cursor-must-not-commit',
        threads: [{ ...payload.threads[0], externalThreadId: 'thread-rollback' }],
        messages: [{ ...payload.messages[0], externalThreadId: 'missing-thread', externalMessageId: 'message-rollback' }],
      };
      await assert.rejects(store.ingestBatch(broken));
      assert.equal((await pool.query(`SELECT count(*)::int AS n FROM interaction_sync_batches WHERE batch_id='batch-rollback'`)).rows[0].n, 0);
      assert.equal((await pool.query(`SELECT count(*)::int AS n FROM interaction_threads WHERE external_thread_id='thread-rollback'`)).rows[0].n, 0);

      const raceA = { ...payload, batchId: 'batch-race-a', cursorAfter: 'race-a' };
      const raceB = { ...payload, batchId: 'batch-race-b', cursorAfter: 'race-b' };
      const raced = await Promise.all([store.ingestBatch(raceA), store.ingestBatch(raceB)]);
      assert.equal(raced.flatMap((result) => result.newJobIds).length, 0,
        '同一 inbound message 的后续 batch 不得再创建 active job');
      assert.equal((await pool.query(`SELECT count(*)::int AS n FROM interaction_reply_jobs`)).rows[0].n, 1);

      const jobRow = (await pool.query<{ id: string }>(`SELECT id FROM interaction_reply_jobs LIMIT 1`)).rows[0];
      await pool.query(`UPDATE interaction_reply_jobs SET state='queued',version=4,config_version=2,
        final_text='谢谢你的喜欢，欢迎继续交流。',risk_level='low' WHERE id=$1`, [jobRow.id]);
      const context = await store.getJobContext('acct_wc_demo', 'env_wc_demo', jobRow.id);
      assert.ok(context);
      const idempotencyKey = replyIdempotencyKey(context);
      const attempts = await Promise.allSettled([
        store.createAttempt({ accountId: 'acct_wc_demo', envKey: 'env_wc_demo', jobId: jobRow.id, expectedVersion: 4, idempotencyKey, ...attemptGate }),
        store.createAttempt({ accountId: 'acct_wc_demo', envKey: 'env_wc_demo', jobId: jobRow.id, expectedVersion: 4, idempotencyKey, ...attemptGate }),
      ]);
      assert.equal(attempts.filter((result) => result.status === 'fulfilled').length, 1);
      assert.equal(attempts.filter((result) => result.status === 'rejected').length, 1);
      assert.equal((await pool.query(`SELECT count(*)::int AS n FROM interaction_send_attempts WHERE reply_job_id=$1`, [jobRow.id])).rows[0].n, 1);
      const created = attempts.find((result) => result.status === 'fulfilled');
      assert.ok(created && created.status === 'fulfilled');
      await store.markAttemptDispatched('acct_wc_demo', 'env_wc_demo', created.value.attempt.id);

      const baseResult: InteractionReplyResultPayload = {
        jobId: jobRow.id, attemptId: created.value.attempt.id, idempotencyKey,
        envKey: 'env_wc_demo', accountId: 'acct_wc_demo', platform: 'wechat_channels', channel: 'comment',
        status: 'ambiguous', externalMessageId: null, errorCategory: 'transient_network',
        errorCode: 'INTERACTION_UPSTREAM_UNAVAILABLE', verification: 'not_verified', retryAfterMs: null,
        finishedAt: 1784044811000,
      };
      const ambiguous = await store.applyReplyResult(baseResult);
      assert.equal(ambiguous.duplicate, false);
      assert.equal((await store.applyReplyResult(baseResult)).duplicate, true);
      assert.deepEqual(await store.recoverableAttemptIds(), [created.value.attempt.id]);
      assert.equal((await store.getJobContext('acct_wc_demo', 'env_wc_demo', jobRow.id))?.job.state, 'ambiguous');
      await assert.rejects(store.createAttempt({ accountId: 'acct_wc_demo', envKey: 'env_wc_demo',
        jobId: jobRow.id, expectedVersion: 6, idempotencyKey, ...attemptGate }),
      (error: unknown) => ['INTERACTION_SEND_AMBIGUOUS', 'INTERACTION_STATE_CONFLICT'].includes((error as { code?: string }).code ?? ''));

      const confirmed = await store.applyReplyResult({
        ...baseResult, status: 'confirmed', externalMessageId: 'comment-reply-demo-101',
        errorCategory: null, errorCode: null, verification: 'comment_lookup', finishedAt: 1784044820000,
      });
      assert.equal(confirmed.confirmedNeedsRiskRecord, true);
      assert.equal((await store.getJobContext('acct_wc_demo', 'env_wc_demo', jobRow.id))?.job.state, 'sent');
      await assert.rejects(store.applyReplyResult({
        ...baseResult, jobId: 'wrong-job', status: 'confirmed', externalMessageId: 'comment-reply-demo-101',
        errorCategory: null, errorCode: null, verification: 'comment_lookup', finishedAt: 1784044820000,
      }), (error: unknown) => (error as { code?: string }).code === 'INTERACTION_SCOPE_MISMATCH',
      'duplicate terminal result must still validate jobId');
      assert.deepEqual(await store.recoverableAttemptIds(), []);
      assert.equal(await store.getJobContext('acct_wc_demo', 'another-env', jobRow.id), null,
        'accountId/envKey 必须同时命中');

      const failedBatch: InteractionSyncBatchPayload = {
        ...payload, batchId: 'batch-failed-result', cursorAfter: 'failed-result-cursor',
        messages: [{ ...payload.messages[0], externalMessageId: 'comment_msg_failed_result',
          externalRootId: 'comment_msg_failed_result', platformCreatedAt: payload.messages[0].platformCreatedAt + 1 }],
      };
      const failedIngest = await store.ingestBatch(failedBatch);
      assert.equal(failedIngest.newJobIds.length, 1);
      const failedJobId = failedIngest.newJobIds[0];
      await pool.query(`UPDATE interaction_reply_jobs SET state='queued',version=1,config_version=2,
        final_text='谢谢反馈。',risk_level='low' WHERE id=$1`, [failedJobId]);
      const failedContext = await store.getJobContext('acct_wc_demo', 'env_wc_demo', failedJobId);
      assert.ok(failedContext);
      const failedKey = replyIdempotencyKey(failedContext);
      const failedAttempt = await store.createAttempt({ accountId: 'acct_wc_demo', envKey: 'env_wc_demo',
        jobId: failedJobId, expectedVersion: 1, idempotencyKey: failedKey, ...attemptGate });
      await store.applyReplyResult({
        jobId: failedJobId, attemptId: failedAttempt.attempt.id, idempotencyKey: failedKey,
        envKey: 'env_wc_demo', accountId: 'acct_wc_demo', platform: 'wechat_channels', channel: 'comment',
        status: 'failed', externalMessageId: null, errorCategory: 'platform_rejected',
        errorCode: 'WECHAT_PERMISSION_DENIED', verification: 'not_verified', retryAfterMs: null,
        finishedAt: 1784044830000,
      });
      await store.markAttemptDispatched('acct_wc_demo', 'env_wc_demo', failedAttempt.attempt.id);
      // 上一行应幂等成功：权威 Edge result 可以抢在 created→dispatched 持久化之前到达。
      assert.equal((await store.getJobContext('acct_wc_demo', 'env_wc_demo', failedJobId))?.job.state, 'failed');
      await pool.query(`UPDATE interaction_reply_jobs SET state='approval_required',version=5,expires_at=NULL WHERE id=$1`, [failedJobId]);
      const approvals = await Promise.allSettled([
        store.transitionJob({ accountId: 'acct_wc_demo', envKey: 'env_wc_demo', jobId: failedJobId,
          expectedVersion: 5, from: ['approval_required'], to: 'approved', actor: 'client:user-a' }),
        store.transitionJob({ accountId: 'acct_wc_demo', envKey: 'env_wc_demo', jobId: failedJobId,
          expectedVersion: 5, from: ['approval_required'], to: 'approved', actor: 'client:user-a' }),
      ]);
      assert.equal(approvals.filter((result) => result.status === 'fulfilled').length, 1);
      assert.equal(approvals.filter((result) => result.status === 'rejected').length, 1,
        '重复审批点击必须由 CAS 拒绝一个');
      await store.transitionMessageJob({ accountId: 'acct_wc_demo', envKey: 'env_wc_demo',
        messageId: failedContext.message.id, expectedVersion: 6, to: 'escalated', actor: 'client:user-a',
        reason: '这里可能包含私信或客户正文，审计不得保存原文' });
      const escalationAudit = (await pool.query<{ summary: string; labels: Record<string, unknown> }>(
        `SELECT summary,labels FROM interaction_audit_events WHERE action='escalated' ORDER BY created_at DESC LIMIT 1`,
      )).rows[0];
      assert.equal(escalationAudit.summary, 'escalated');
      assert.deepEqual(escalationAudit.labels, { reasonProvided: true });
      await pool.query(`UPDATE interaction_reply_jobs SET state='approval_required',version=10,
        expires_at=to_timestamp(1) WHERE id=$1`, [jobRow.id]);
      await assert.rejects(store.transitionJob({ accountId: 'acct_wc_demo', envKey: 'env_wc_demo', jobId: jobRow.id,
        expectedVersion: 10, from: ['approval_required'], to: 'approved', actor: 'client:user-a' }),
      (error: unknown) => (error as { details?: { issues?: Array<{ code?: string }> } }).details?.issues?.[0]?.code === 'expired_job');

      const singleFlightPayloads = ['sf-1', 'sf-2'].map((suffix, index) => ({
        ...payload, batchId: `batch-${suffix}`, cursorAfter: `cursor-${suffix}`,
        messages: [{ ...payload.messages[0], externalMessageId: `comment_msg_${suffix}`,
          externalRootId: `comment_msg_${suffix}`, platformCreatedAt: payload.messages[0].platformCreatedAt + 100 + index }],
      }));
      const singleFlightJobs = (await Promise.all(singleFlightPayloads.map((item) => store.ingestBatch(item))))
        .flatMap((item) => item.newJobIds);
      assert.equal(singleFlightJobs.length, 2);
      await pool.query(`UPDATE interaction_reply_jobs SET state='queued',version=1,config_version=2,
        final_text='账号级单飞测试。',risk_level='low' WHERE id=ANY($1::text[])`, [singleFlightJobs]);
      const singleFlightContexts = await Promise.all(singleFlightJobs.map((jobId) =>
        store.getJobContext('acct_wc_demo', 'env_wc_demo', jobId)));
      assert.ok(singleFlightContexts.every(Boolean));
      const singleFlightAttempts = await Promise.allSettled(singleFlightJobs.map((jobId, index) => store.createAttempt({
        accountId: 'acct_wc_demo', envKey: 'env_wc_demo', jobId, expectedVersion: 1,
        idempotencyKey: replyIdempotencyKey(singleFlightContexts[index]!), ...attemptGate,
      })));
      assert.equal(singleFlightAttempts.filter((item) => item.status === 'fulfilled').length, 1);
      assert.equal(singleFlightAttempts.filter((item) => item.status === 'rejected').length, 1,
        'two jobs for one account must not both create active attempts');

      await pool.query(`UPDATE interaction_messages SET platform_created_at=to_timestamp($2/1000.0)-interval '181 days'
        WHERE id=(SELECT inbound_message_id FROM interaction_reply_jobs WHERE id=$1)`, [jobRow.id, attemptGate.now]);
      await pool.query(`UPDATE interaction_reply_jobs SET rendered_text='old',polished_text='old',final_text='old',
        introduced_claims='["old"]'::jsonb WHERE id=$1`, [jobRow.id]);
      const apiClaim = await store.claimApiRequest({ actor: 'client:user-a', action: 'send', idempotencyKey: 'old-request',
        accountId: 'acct_wc_demo', envKey: 'env_wc_demo', resourceId: jobRow.id });
      await store.completeApiRequest(apiClaim.requestId, { finalText: 'must be purged' });
      await pool.query(`UPDATE interaction_api_requests SET created_at=to_timestamp($2/1000.0)-interval '91 days'
        WHERE request_id=$1`, [apiClaim.requestId, attemptGate.now]);
      const purged = await store.purgeExpiredContent(attemptGate.now);
      assert.ok(purged.comments >= 1 && purged.replyJobs >= 1 && purged.apiRequests >= 1);
      const retainedText = (await pool.query<{ final_text: string | null; introduced_claims: unknown }>(
        `SELECT final_text,introduced_claims FROM interaction_reply_jobs WHERE id=$1`, [jobRow.id])).rows[0];
      assert.equal(retainedText.final_text, null);
      assert.deepEqual(retainedText.introduced_claims, []);
    } finally {
      await pool.end();
    }
  });

test('PostgreSQL: immutable template/config versions, publish CAS and fail-closed invalid variables',
  { skip: !connectionString }, async () => {
    const pool = new pg.Pool({ connectionString });
    const configs = new ReplyConfigStore({ pool });
    try {
      await pool.query(`INSERT INTO accounts(account_id,label,platform) VALUES
        ('acct_wc_demo','demo','wechat_channels'),('acct_wc_other','other','wechat_channels')
        ON CONFLICT (account_id) DO UPDATE SET platform=EXCLUDED.platform`);
      await pool.query(`TRUNCATE reply_rules,reply_templates,account_reply_profiles,
        interaction_reply_config_versions,interaction_reply_configs RESTART IDENTITY CASCADE`);
      await configs.init();
      const policy = {
        mode: 'review_before_send' as const, generateDrafts: true, sendReplies: true,
        channels: {
          comment: { enabled: true, aiPolishEnabled: true, allowAutoSend: false },
          dm: { enabled: true, aiPolishEnabled: false, allowAutoSend: false },
        },
        rateLimits: { accountPerMinute: 1, accountPerHour: 5, accountPerDay: 20,
          threadCooldownSeconds: 60, newLoginCooldownSeconds: 600, consecutiveFailureLimit: 3 },
      };
      await configs.savePolicy('acct_wc_demo', 0, 'admin', policy);
      await configs.saveTemplate('acct_wc_demo', 1, 'admin', {
        templateId: 'tpl-thanks', channel: 'comment', name: '感谢', content: '{{user_name}}，谢谢关注。',
        enabled: true, variables: ['user_name'],
      });
      const revised = await configs.saveTemplate('acct_wc_demo', 2, 'admin', {
        templateId: 'tpl-thanks', channel: 'comment', name: '感谢', content: '{{user_name}}，谢谢关注我们。',
        enabled: true, variables: ['user_name'],
      });
      assert.equal(revised.templates[0].templateVersion, 2);
      await configs.saveRule('acct_wc_demo', 3, 'admin', {
        ruleId: 'rule-thanks', channel: 'comment', name: '感谢规则', priority: 10, enabled: true,
        conditions: { keywordsAny: [], intentsAny: ['gratitude'], sourceExternalIds: [], messageTypes: ['text'], workHours: null },
        actions: { templateId: 'tpl-thanks', polish: true, allowAutoSend: false, forceHumanTags: [] },
      });
      const published = await configs.publish('acct_wc_demo', 4, 'publisher');
      assert.equal(published.configVersion, 5);
      assert.equal(published.state, 'published');
      assert.equal(published.templates[0].templateVersion, 2);

      await configs.savePolicy('acct_wc_demo', 5, 'admin', { ...policy, sendReplies: false });
      const stillPublished = await configs.getSnapshot('acct_wc_demo', 'published');
      assert.equal(stillPublished?.configVersion, 5);
      assert.equal(stillPublished?.policy.sendReplies, true, 'new draft must not mutate immutable published snapshot');
      await assert.rejects(configs.savePolicy('acct_wc_demo', 5, 'late-admin', policy),
        (error: unknown) => (error as { code?: string }).code === 'INTERACTION_VERSION_CONFLICT');

      await configs.savePolicy('acct_wc_other', 0, 'admin', policy);
      await configs.saveTemplate('acct_wc_other', 1, 'admin', {
        templateId: 'tpl-invalid', channel: 'comment', name: '非法变量', content: '{{coupon}}',
        enabled: true, variables: [] as never[],
      });
      await configs.saveRule('acct_wc_other', 2, 'admin', {
        ruleId: 'rule-invalid', channel: 'comment', name: '非法规则', priority: 1, enabled: true,
        conditions: { keywordsAny: [], intentsAny: ['gratitude'], sourceExternalIds: [], messageTypes: ['text'], workHours: null },
        actions: { templateId: 'tpl-invalid', polish: false, allowAutoSend: false, forceHumanTags: [] },
      });
      await assert.rejects(configs.publish('acct_wc_other', 3, 'publisher'),
        (error: unknown) => (error as { code?: string }).code === 'INTERACTION_VALIDATION_FAILED');
    } finally {
      await pool.end();
    }
  });

test('PostgreSQL mock Edge E2E: sync → list/detail → generate/approve/send → confirmed',
  { skip: !connectionString }, async () => {
    const pool = new pg.Pool({ connectionString });
    const store = new InteractionStore({ pool, clock: () => attemptGate.now });
    const configs = new ReplyConfigStore({ pool });
    try {
      await pool.query(`TRUNCATE
        interaction_api_requests,interaction_audit_events,interaction_send_attempts,interaction_reply_jobs,
        interaction_messages,interaction_threads,interaction_sync_batches,interaction_sync_cursors,
        interaction_auth_state,interaction_runtime_controls,reply_rules,reply_templates,account_reply_profiles,
        interaction_reply_config_versions,interaction_reply_configs RESTART IDENTITY CASCADE`);
      await pool.query(`INSERT INTO accounts(account_id,label,platform) VALUES
        ('acct_wc_e2e','e2e','wechat_channels') ON CONFLICT (account_id) DO UPDATE SET platform=EXCLUDED.platform`);
      await store.init();
      await configs.init();
      const policy = {
        mode: 'review_before_send' as const, generateDrafts: true, sendReplies: true,
        channels: { comment: { enabled: true, aiPolishEnabled: true, allowAutoSend: false },
          dm: { enabled: false, aiPolishEnabled: false, allowAutoSend: false } },
        rateLimits: { accountPerMinute: 2, accountPerHour: 10, accountPerDay: 30,
          threadCooldownSeconds: 0, newLoginCooldownSeconds: 0, consecutiveFailureLimit: 3 },
      };
      await configs.savePolicy('acct_wc_e2e', 0, 'admin', policy);
      await configs.saveTemplate('acct_wc_e2e', 1, 'admin', {
        templateId: 'tpl-thanks', channel: 'comment', name: '感谢', content: '{{user_name}}，谢谢你的关注。',
        enabled: true, variables: ['user_name'],
      });
      await configs.saveRule('acct_wc_e2e', 2, 'admin', {
        ruleId: 'rule-thanks', channel: 'comment', name: '感谢规则', priority: 1, enabled: true,
        conditions: { keywordsAny: [], intentsAny: ['gratitude'], sourceExternalIds: [], messageTypes: ['text'], workHours: null },
        actions: { templateId: 'tpl-thanks', polish: true, allowAutoSend: false, forceHumanTags: [] },
      });
      await configs.publish('acct_wc_e2e', 3, 'publisher');

      const outputs = [
        { role: 'reply_intent_classifier', intent: 'gratitude', confidence: 1, riskTags: [], reasons: [] },
        { role: 'reply_polisher', polishedText: '示例观众，谢谢你的关注。', meaningChanged: false, introducedClaims: [], riskTags: [] },
        { role: 'reply_risk_reviewer', riskLevel: 'low', riskTags: [], reasons: [], allowAutoSend: false },
      ];
      const workflow = new ReplyWorkflow(store, configs,
        new ReplyAiService({ complete: async () => JSON.stringify(outputs.shift()) }, 100));
      const metrics = new InteractionMetrics();
      let riskRecords = 0;
      const controller = { explain: () => ({ allowed: true }), record: async () => { riskRecords += 1; return true; } };
      const pushed: Array<{ type: string; payload: unknown }> = [];
      const sender = new InteractionSendOrchestrator({ store, configs,
        pusher: { resolveEdgeIdForAccount: () => 'edge-e2e', pushToEdges: (envelope: Envelope) => { pushed.push(envelope); return 1; } } as never,
        controllerFor: () => controller, metrics, env: { AIDCP_INTERACTION_WRITE_ENABLED: 'true' },
        clock: () => attemptGate.now });
      const inbox = new InteractionInboxService({ store, configs, workflow, controllerFor: () => controller, metrics });
      await inbox.onAuthStatus({ envKey: 'env_wc_e2e', accountId: 'acct_wc_e2e', platform: 'wechat_channels',
        status: 'active', browserState: 'closed', capabilities: { commentsRead: true, commentsReply: true,
          dmRead: false, dmSendText: false, dmSendImage: false },
        identity: { externalId: 'finder-e2e', displayName: 'E2E 账号', identityHash: `sha256:${'e'.repeat(64)}` },
        runtimeControlsVersion: 0, checkedAt: attemptGate.now, reasonCode: null });
      await store.updateRuntimeControls({ accountId: 'acct_wc_e2e', expectedVersion: 0, actor: 'admin',
        commentsReadEnabled: true, commentsReplyEnabled: true, dmReadEnabled: false, dmSendTextEnabled: false,
        dmSendImageEnabled: false, writePaused: false });
      const fixture = JSON.parse(await readFile(new URL('../fixtures/wechat-channels-interaction/v1/ws/comment-sync-batch.json', import.meta.url), 'utf8')) as { payload: unknown };
      const parsed = parseSyncBatchPayload(fixture.payload);
      assert.ok(parsed);
      const payload = { ...parsed, batchId: 'batch-e2e', envKey: 'env_wc_e2e', accountId: 'acct_wc_e2e' };
      assert.equal((await inbox.onSyncBatch(payload)).status, 'accepted');

      let listed = await store.listInteractions({ accountId: 'acct_wc_e2e', envKey: 'env_wc_e2e',
        asOf: attemptGate.now + 1, limit: 10 });
      for (let index = 0; index < 50 && listed.items[0]?.jobState !== 'approval_required'; index += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        listed = await store.listInteractions({ accountId: 'acct_wc_e2e', envKey: 'env_wc_e2e',
          asOf: attemptGate.now + 1, limit: 10 });
      }
      assert.equal(listed.items.length, 1);
      assert.equal(listed.items[0].jobState, 'approval_required');
      const detail = await store.getDetail('acct_wc_e2e', 'env_wc_e2e', listed.items[0].threadId, 100);
      assert.ok(detail?.replyJob?.finalText);
      const approved = await workflow.approve({ accountId: 'acct_wc_e2e', envKey: 'env_wc_e2e',
        jobId: detail.replyJob.id, expectedVersion: detail.replyJob.version, actor: 'client:user-e2e' });
      const queued = await sender.queueApproved({ accountId: 'acct_wc_e2e', envKey: 'env_wc_e2e',
        jobId: approved.id, expectedVersion: approved.version, actor: 'client:user-e2e' });
      const dispatched = await sender.dispatchQueued({ accountId: 'acct_wc_e2e', envKey: 'env_wc_e2e',
        jobId: queued.id, expectedVersion: queued.version });
      assert.equal((await store.getJobContext('acct_wc_e2e', 'env_wc_e2e', queued.id))?.job.state, 'sending');
      assert.equal(pushed[0]?.type, 'interaction.reply.send');
      const command = pushed[0].payload as { idempotencyKey: string };
      await inbox.onReplyResult({ jobId: queued.id, attemptId: dispatched.attemptId,
        idempotencyKey: command.idempotencyKey, envKey: 'env_wc_e2e', accountId: 'acct_wc_e2e',
        platform: 'wechat_channels', channel: 'comment', status: 'confirmed', externalMessageId: 'reply-e2e',
        errorCategory: null, errorCode: null, verification: 'comment_lookup', retryAfterMs: null,
        finishedAt: attemptGate.now + 1_000 });
      assert.equal((await store.getJobContext('acct_wc_e2e', 'env_wc_e2e', queued.id))?.job.state, 'sent');
      assert.equal(riskRecords, 1);
    } finally {
      await pool.end();
    }
  });
