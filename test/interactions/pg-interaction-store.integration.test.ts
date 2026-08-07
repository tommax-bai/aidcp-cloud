import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import pg from 'pg';
import type { Envelope } from '@automation/comm/protocol.js';
import { InteractionStore } from '@automation/interactions/interaction-store.js';
import { PgInteractionApiWrites } from '@api/interactions/interaction-api-writes.js';
import { PgInteractionAuthGate } from '@api/interactions/interaction-auth-gate.js';
import {
  INTERACTION_TEST_EXECUTION_TARGET,
  drainInteractionAuditRelay,
  interactionAccountPlatform,
} from '../helpers/interaction-store-test-deps.js';
import { InteractionInboxService } from '@automation/interactions/interaction-inbox-service.js';
import { InteractionMetrics } from '@automation/interactions/metrics.js';
import { ReplyAiService } from '@content/interactions/reply-ai.js';
import { ReplyConfigStore } from '@api/interactions/reply-config-store.js';
import { ReplyWorkflow } from '@automation/interactions/reply-workflow.js';
import { parseSyncBatchPayload } from '@automation/interactions/contract.js';
import { InteractionSendOrchestrator, replyIdempotencyKey } from '@automation/interactions/send-orchestrator.js';
import type { InteractionReplyResultPayload, InteractionSyncBatchPayload } from '@kernel/kernel/interaction-types.js';
import { INTERACTION_URL_ENV, resolveIntegrationDatabase } from '../helpers/pg-test-database-guard.js';

/**
 * 连库前 MUST 过 `test/helpers/pg-test-database-guard.ts` 的三条守卫：拒绝已知生产 host、
 * 强制 `aidcp_test*` 专用库名、只在显式测试通道（`npm run test:pg`）里生效。
 * 理由：dev 与 ol 连的是同一台物理 PostgreSQL，那台就是生产库，而本组用例会 TRUNCATE / 建表。
 * 不在通道里 → 整组 skip、绝不连库；在通道里而守卫不过 → 当场抛错，MUST NOT 降级为 skip。
 */
const target = resolveIntegrationDatabase(INTERACTION_URL_ENV);
const connectionString = target.enabled ? target.connectionString : undefined;
const skipReason = target.enabled ? (false as const) : target.skipReason;
const attemptGate = {
  rateLimits: { accountPerMinute: 100, accountPerHour: 100, accountPerDay: 100,
    threadCooldownSeconds: 0, newLoginCooldownSeconds: 0, consecutiveFailureLimit: 3 },
  now: 1784044802100,
};

test('PostgreSQL: batch idempotency/rollback, job+attempt races, ambiguous recovery and confirmed result',
  { skip: skipReason }, async () => {
    const pool = new pg.Pool({ connectionString });
    const store = new InteractionStore({ pool, clock: () => 1784044802100, apiPurge: new PgInteractionApiWrites(pool),
      authGate: new PgInteractionAuthGate({ pool }), executionTarget: INTERACTION_TEST_EXECUTION_TARGET,
      accountPlatform: interactionAccountPlatform() });
    try {
      await pool.query(`TRUNCATE
        interaction_api_requests,interaction_audit_events,interaction_send_attempts,interaction_reply_jobs,
        interaction_messages,interaction_threads,interaction_sync_batches,interaction_sync_cursors,
        interaction_auth_state,interaction_runtime_controls,event_outbox,event_outbox_cursor,event_outbox_topic_cursor
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
      await store.upsertAuthStatus({
        envKey: 'env_wc_demo', accountId: 'acct_wc_demo', platform: 'wechat_channels',
        status: 'reauth_required', browserState: 'unavailable',
        capabilities: { commentsRead: false, commentsReply: false, dmRead: false,
          dmSendText: false, dmSendImage: false },
        identity: null, runtimeControlsVersion: 0, checkedAt: 1784044001000,
        reasonCode: 'INTERACTION_BROWSER_PROFILE_IN_USE',
      });
      assert.deepEqual(await store.getAuth('acct_wc_demo', 'env_wc_demo'), {
        envKey: 'env_wc_demo', accountId: 'acct_wc_demo', platform: 'wechat_channels',
        status: 'reauth_required', browserState: 'unavailable',
        capabilities: { commentsRead: false, commentsReply: false, dmRead: false,
          dmSendText: false, dmSendImage: false },
        identity: null, runtimeControlsVersion: 0, checkedAt: 1784044001000,
        reasonCode: 'INTERACTION_BROWSER_PROFILE_IN_USE',
      });
      await store.upsertAuthStatus({
        envKey: 'env_wc_demo', accountId: 'acct_wc_demo', platform: 'wechat_channels', status: 'active',
        browserState: 'closed', capabilities: { commentsRead: true, commentsReply: true, dmRead: true,
          dmSendText: true, dmSendImage: false },
        identity: { externalId: 'finder_demo_public', displayName: '示例视频号', identityHash: `sha256:${'1'.repeat(64)}` },
        runtimeControlsVersion: 0, checkedAt: 1784044002000, reasonCode: null,
      });
      const fixture = JSON.parse(await readFile(new URL('../fixtures/wechat-channels-inbox/v1/ws/comment-sync-batch.json', import.meta.url), 'utf8')) as { payload: unknown };
      const payload = parseSyncBatchPayload(fixture.payload);
      assert.ok(payload);

      const futureBatch: InteractionSyncBatchPayload = {
        ...payload,
        batchId: 'batch-future-thread',
        threads: [{ ...payload.threads[0], externalThreadId: 'thread-future', updatedAt: payload.observedAt + 300_001 }],
        messages: [{ ...payload.messages[0], externalThreadId: 'thread-future', externalMessageId: 'message-future' }],
      };
      await assert.rejects(
        store.ingestBatch(futureBatch),
        (error: unknown) => (error as { code?: string; httpStatus?: number; message?: string }).code === 'INTERACTION_VALIDATION_FAILED'
          && (error as { httpStatus?: number }).httpStatus === 422
          && (error as { message?: string }).message?.includes('thread-future') === true,
      );
      assert.equal((await pool.query(`SELECT count(*)::int AS n FROM interaction_sync_batches WHERE batch_id='batch-future-thread'`)).rows[0].n, 0);
      assert.equal((await pool.query(`SELECT count(*)::int AS n FROM interaction_threads WHERE external_thread_id='thread-future'`)).rows[0].n, 0);

      const duplicates = await Promise.all([store.ingestBatch(payload), store.ingestBatch(payload)]);
      assert.deepEqual(duplicates.map((result) => result.ack.status).sort(), ['accepted', 'duplicate']);
      assert.equal((await pool.query(`SELECT count(*)::int AS n FROM interaction_messages`)).rows[0].n, 1);
      assert.equal((await pool.query(`SELECT count(*)::int AS n FROM interaction_reply_jobs`)).rows[0].n, 1);
      assert.deepEqual(await store.getSyncFreshness('acct_wc_demo', 'env_wc_demo'), {
        comment: { observedAt: payload.observedAt, receivedAt: 1784044802100 },
        dm: null,
      });

      const laterObservation = { ...payload, observedAt: payload.observedAt + 5_000 };
      const laterDuplicate = await store.ingestBatch(laterObservation);
      assert.equal(laterDuplicate.ack.status, 'duplicate');
      assert.equal(laterDuplicate.ack.receivedAt, 1784044802101,
        'a newer unchanged observation must get a monotonic Cloud receipt time');
      assert.deepEqual(await store.getSyncFreshness('acct_wc_demo', 'env_wc_demo'), {
        comment: { observedAt: laterObservation.observedAt, receivedAt: 1784044802101 },
        dm: null,
      });
      assert.equal((await pool.query(`SELECT count(*)::int AS n FROM interaction_messages`)).rows[0].n, 1);
      assert.equal((await pool.query(`SELECT count(*)::int AS n FROM interaction_reply_jobs`)).rows[0].n, 1);
      const replay = await store.ingestBatch(payload);
      assert.equal(replay.ack.receivedAt, 1784044802101,
        'an equal/older replay must retain the latest successful receipt evidence');
      assert.deepEqual(await store.getSyncFreshness('acct_wc_demo', 'env_wc_demo'), {
        comment: { observedAt: laterObservation.observedAt, receivedAt: 1784044802101 },
        dm: null,
      });
      const syncedThread = (await pool.query<{ last_synced_at: Date }>(
        `SELECT last_synced_at FROM interaction_threads WHERE account_id=$1 AND env_key=$2 AND channel='comment' LIMIT 1`,
        ['acct_wc_demo', 'env_wc_demo'],
      )).rows[0];
      assert.equal(syncedThread.last_synced_at.getTime(), laterObservation.observedAt);

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

      const reset = await store.resetTestData({ accountId: 'acct_wc_demo', envKey: 'env_wc_demo',
        channel: 'comment', actor: 'client:test' });
      assert.ok(reset.deleted.threads >= 1);
      assert.ok(reset.deleted.syncBatches >= 1);
      assert.ok(reset.deleted.syncCursors >= 1);
      assert.equal((await pool.query(`SELECT count(*)::int AS n FROM interaction_threads WHERE account_id='acct_wc_demo' AND channel='comment'`)).rows[0].n, 0);
      assert.equal((await pool.query(`SELECT count(*)::int AS n FROM interaction_auth_state WHERE account_id='acct_wc_demo'`)).rows[0].n, 1,
        '测试重置必须保留授权');
      assert.equal((await pool.query(`SELECT count(*)::int AS n FROM interaction_runtime_controls WHERE account_id='acct_wc_demo'`)).rows[0].n, 1,
        '测试重置必须保留运行控制');
      // 配置面审计现走本域 outbox + 中继（跨属主最终一致），断言前 MUST 先排空队列。
      await drainInteractionAuditRelay(pool);
      assert.equal((await pool.query(`SELECT count(*)::int AS n FROM interaction_audit_events WHERE action='test_data_reset'`)).rows[0].n, 1);
      const replayed = await store.ingestBatch(payload);
      assert.equal(replayed.ack.status, 'accepted', '删除 batch 去重状态后同一真实样本应可重新入箱');
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
      await pool.query(`UPDATE interaction_reply_jobs SET state='queued',version=version+1 WHERE id=$1`, [failedJobId]);
      const retryContext = await store.getJobContext('acct_wc_demo', 'env_wc_demo', failedJobId);
      assert.ok(retryContext);
      const retryAttempt = await store.createAttempt({ accountId: 'acct_wc_demo', envKey: 'env_wc_demo',
        jobId: failedJobId, expectedVersion: retryContext.job.version, idempotencyKey: failedKey, ...attemptGate });
      assert.equal(retryAttempt.attempt.attemptNo, 2, 'a terminal attempt must release the deterministic idempotency key');
      await store.markDispatchDeferred('acct_wc_demo', 'env_wc_demo', retryAttempt.attempt.id,
        'INTERACTION_UPSTREAM_UNAVAILABLE');
      assert.equal((await store.getJobContext('acct_wc_demo', 'env_wc_demo', failedJobId))?.job.state, 'queued');
      assert.ok((await store.pendingQueuedJobs()).some((job) => job.jobId === failedJobId),
        'a zero-delivery attempt must not remain in the active exclusion set');
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
      await drainInteractionAuditRelay(pool);
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

      // 开发测试重置：无条件、彻底。此刻 comment 渠道里已有 已发送 / 转人工 / 排队中 等各种状态的
      // 回复任务和发送台账；重置必须把它们连同线程/消息/批次/游标一次清光，且不要求先暂停写入。
      await pool.query(`UPDATE interaction_runtime_controls SET write_paused=false WHERE account_id='acct_wc_demo'`);
      const wipe = await store.resetTestData({ accountId: 'acct_wc_demo', envKey: 'env_wc_demo',
        channel: 'comment', actor: 'client:test' });
      assert.ok(wipe.deleted.threads >= 1, '未暂停写入、且已有发送/转人工记录，也能重置');
      for (const table of ['interaction_threads', 'interaction_messages', 'interaction_reply_jobs',
        'interaction_send_attempts', 'interaction_sync_batches', 'interaction_sync_cursors']) {
        const remaining = (await pool.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM ${table}
             WHERE account_id='acct_wc_demo' AND env_key='env_wc_demo' AND channel='comment'`)).rows[0].n;
        assert.equal(remaining, 0, `${table} 的 comment 记录必须被清空`);
      }
      assert.equal((await pool.query(`SELECT count(*)::int AS n FROM interaction_auth_state WHERE account_id='acct_wc_demo'`)).rows[0].n, 1,
        '重置保留授权，不动登录态');
      assert.equal((await pool.query(`SELECT count(*)::int AS n FROM interaction_runtime_controls WHERE account_id='acct_wc_demo'`)).rows[0].n, 1,
        '重置保留运行控制');
    } finally {
      await pool.end();
    }
  });

test('PostgreSQL: circuit reset, replay-safe thread states and periodic classifying recovery',
  { skip: skipReason }, async () => {
    const pool = new pg.Pool({ connectionString });
    const now = 1_784_044_900_000;
    const store = new InteractionStore({ pool, clock: () => now,
      authGate: new PgInteractionAuthGate({ pool }), executionTarget: INTERACTION_TEST_EXECUTION_TARGET,
      accountPlatform: interactionAccountPlatform() });
    try {
      await pool.query(`TRUNCATE
        interaction_api_requests,interaction_audit_events,interaction_send_attempts,interaction_reply_jobs,
        interaction_messages,interaction_threads,interaction_sync_batches,interaction_sync_cursors,
        interaction_auth_state,interaction_runtime_controls,event_outbox,event_outbox_cursor,event_outbox_topic_cursor
        RESTART IDENTITY CASCADE`);
      await pool.query(`INSERT INTO accounts(account_id,label,platform) VALUES
        ('acct_wc_store_circuit','store-circuit','wechat_channels')
        ON CONFLICT (account_id) DO UPDATE SET platform=EXCLUDED.platform`);
      await store.init();
      await store.upsertAuthStatus({
        envKey: 'env_wc_store_circuit', accountId: 'acct_wc_store_circuit', platform: 'wechat_channels',
        status: 'active', browserState: 'closed', capabilities: { commentsRead: true, commentsReply: true,
          dmRead: true, dmSendText: true, dmSendImage: false },
        identity: { externalId: 'finder-store-circuit', displayName: '存储熔断测试号',
          identityHash: `sha256:${'2'.repeat(64)}` },
        runtimeControlsVersion: 0, checkedAt: now - 1_000, reasonCode: null,
      });

      await store.noteSendOutcome('acct_wc_store_circuit', false, 3);
      await store.noteSendOutcome('acct_wc_store_circuit', false, 3);
      await store.noteSendOutcome('acct_wc_store_circuit', false, 3);
      const tripped = await store.getRuntimeControls('acct_wc_store_circuit');
      assert.equal(tripped.writePaused, true);
      assert.equal(tripped.consecutiveFailures, 3);
      assert.ok(tripped.circuitOpenedAt !== null);
      await assert.rejects(store.updateRuntimeControls({
        accountId: 'acct_wc_store_circuit', expectedVersion: tripped.version - 1, actor: 'admin-conflict',
        commentsReadEnabled: true, commentsReplyEnabled: true, dmReadEnabled: true,
        dmSendTextEnabled: true, dmSendImageEnabled: false, writePaused: false,
      }), (error: unknown) => (error as { code?: string }).code === 'INTERACTION_VERSION_CONFLICT');
      const afterConflict = await store.getRuntimeControls('acct_wc_store_circuit');
      assert.equal(afterConflict.consecutiveFailures, 3);
      assert.equal(afterConflict.circuitOpenedAt, tripped.circuitOpenedAt);

      const cleared = await store.updateRuntimeControls({
        accountId: 'acct_wc_store_circuit', expectedVersion: tripped.version, actor: 'admin-recovery',
        commentsReadEnabled: true, commentsReplyEnabled: true, dmReadEnabled: true,
        dmSendTextEnabled: true, dmSendImageEnabled: false, writePaused: false,
      });
      assert.equal(cleared.writePaused, false);
      assert.equal(cleared.consecutiveFailures, 0);
      assert.equal(cleared.circuitOpenedAt, null);
      await drainInteractionAuditRelay(pool);
      const resetAudit = (await pool.query<{ labels: Record<string, unknown> }>(
        `SELECT labels FROM interaction_audit_events
          WHERE account_id='acct_wc_store_circuit' AND action='runtime_controls_updated'
          ORDER BY created_at DESC LIMIT 1`,
      )).rows[0];
      assert.deepEqual(resetAudit.labels, {
        version: cleared.version, circuitReset: true, circuitWasOpen: true, previousConsecutiveFailures: 3,
      });

      const raw = JSON.parse(await readFile(new URL('../fixtures/wechat-channels-inbox/v1/ws/comment-sync-batch.json', import.meta.url), 'utf8')) as { payload: unknown };
      const fixture = parseSyncBatchPayload(raw.payload);
      assert.ok(fixture);
      const oldKinds = ['ignored', 'escalated', 'replied'] as const;
      const oldThreads = oldKinds.map((kind, index) => ({
        ...fixture.threads[0], externalThreadId: `thread-${kind}`,
        participant: { ...fixture.threads[0].participant!, externalId: `viewer-${kind}` },
        updatedAt: now - 5_000 + index,
      }));
      const oldMessages = oldKinds.map((kind, index) => ({
        ...fixture.messages[0], externalThreadId: `thread-${kind}`, externalMessageId: `message-${kind}`,
        externalRootId: `message-${kind}`, platformCreatedAt: now - 5_000 + index,
      }));
      const initial = await store.ingestBatch({
        ...fixture, accountId: 'acct_wc_store_circuit', envKey: 'env_wc_store_circuit',
        batchId: 'batch-state-initial', cursorAfter: 'cursor-state-initial',
        threads: oldThreads, messages: oldMessages, observedAt: now - 4_000,
      });
      assert.equal(initial.newJobIds.length, 3);
      await store.transitionMessageJob({ accountId: 'acct_wc_store_circuit', envKey: 'env_wc_store_circuit',
        messageId: (await store.getJobContext('acct_wc_store_circuit', 'env_wc_store_circuit', initial.newJobIds[0]))!.message.id,
        expectedVersion: 0, to: 'ignored', actor: 'admin' });
      await store.transitionMessageJob({ accountId: 'acct_wc_store_circuit', envKey: 'env_wc_store_circuit',
        messageId: (await store.getJobContext('acct_wc_store_circuit', 'env_wc_store_circuit', initial.newJobIds[1]))!.message.id,
        expectedVersion: 0, to: 'escalated', actor: 'admin' });
      await pool.query(`UPDATE interaction_reply_jobs SET state='sent',version=version+1 WHERE id=$1`,
        [initial.newJobIds[2]]);
      await pool.query(`UPDATE interaction_threads SET status='replied'
        WHERE external_thread_id='thread-replied' AND account_id='acct_wc_store_circuit'`);

      const newThread = { ...fixture.threads[0], externalThreadId: 'thread-new',
        participant: { ...fixture.threads[0].participant!, externalId: 'viewer-new' }, updatedAt: now };
      const newMessage = { ...fixture.messages[0], externalThreadId: 'thread-new', externalMessageId: 'message-new',
        externalRootId: 'message-new', platformCreatedAt: now };
      const replay = await store.ingestBatch({
        ...fixture, accountId: 'acct_wc_store_circuit', envKey: 'env_wc_store_circuit',
        batchId: 'batch-state-replay-with-new', cursorAfter: 'cursor-state-replay-with-new',
        threads: [...oldThreads, newThread], messages: [...oldMessages, newMessage], observedAt: now,
      });
      assert.equal(replay.newJobIds.length, 1);
      const statuses = (await pool.query<{ external_thread_id: string; status: string }>(
        `SELECT external_thread_id,status FROM interaction_threads
          WHERE account_id='acct_wc_store_circuit' ORDER BY external_thread_id`,
      )).rows;
      assert.deepEqual(Object.fromEntries(statuses.map((row) => [row.external_thread_id, row.status])), {
        'thread-escalated': 'escalated', 'thread-ignored': 'closed',
        'thread-new': 'waiting_review', 'thread-replied': 'replied',
      });

      await pool.query(`UPDATE interaction_reply_jobs SET state='classifying',version=10,
        updated_at=to_timestamp($2/1000.0) WHERE id=$1`, [initial.newJobIds[0], now - 60_000]);
      await pool.query(`UPDATE interaction_reply_jobs SET state='classifying',version=20,
        updated_at=to_timestamp($2/1000.0) WHERE id=$1`, [initial.newJobIds[1], now - 10_000]);
      assert.equal(await store.recoverStalledClassifyingJobs(now - 40_000), 1);
      const recovered = (await pool.query<{ id: string; state: string; version: number }>(
        `SELECT id,state,version FROM interaction_reply_jobs WHERE id=ANY($1::text[]) ORDER BY id`,
        [[initial.newJobIds[0], initial.newJobIds[1]]],
      )).rows;
      const byId = new Map(recovered.map((row) => [row.id, row]));
      assert.deepEqual({ state: byId.get(initial.newJobIds[0])?.state, version: byId.get(initial.newJobIds[0])?.version },
        { state: 'new', version: 11 });
      assert.deepEqual({ state: byId.get(initial.newJobIds[1])?.state, version: byId.get(initial.newJobIds[1])?.version },
        { state: 'classifying', version: 20 });
    } finally {
      await pool.end();
    }
  });

test('PostgreSQL: immutable template/config versions, publish CAS and fail-closed invalid variables',
  { skip: skipReason }, async () => {
    const pool = new pg.Pool({ connectionString });
    const configs = new ReplyConfigStore({ pool });
    try {
      await pool.query(`INSERT INTO accounts(account_id,label,platform) VALUES
        ('acct_wc_demo','demo','wechat_channels'),('acct_wc_other','other','wechat_channels'),
        ('acct_wc_init','init','wechat_channels'),('acct_xhs_init','xhs','xiaohongshu')
        ON CONFLICT (account_id) DO UPDATE SET platform=EXCLUDED.platform`);
      await pool.query(`TRUNCATE reply_rules,reply_templates,account_reply_profiles,
        interaction_reply_config_versions,interaction_reply_configs RESTART IDENTITY CASCADE`);
      await configs.init();
      const initialized = await configs.initialize('acct_wc_init', 0, 'admin');
      assert.equal(initialized.configVersion, 1);
      assert.equal(initialized.state, 'draft');
      assert.equal(initialized.policy.mode, 'draft_only');
      assert.equal(initialized.policy.generateDrafts, false);
      assert.equal(initialized.policy.sendReplies, false);
      assert.deepEqual(initialized.templates, []);
      assert.deepEqual(initialized.rules, []);
      assert.deepEqual(initialized.profiles.map((profile) => profile.channel).sort(), ['comment', 'dm']);
      const initializedHead = await configs.getHead('acct_wc_init');
      assert.deepEqual({ currentVersion: initializedHead?.currentVersion, draftVersion: initializedHead?.draftVersion,
        publishedVersion: initializedHead?.publishedVersion }, { currentVersion: 1, draftVersion: 1, publishedVersion: null });
      await assert.rejects(configs.initialize('acct_wc_init', 0, 'late-admin'),
        (error: unknown) => (error as { code?: string }).code === 'INTERACTION_VERSION_CONFLICT');
      await assert.rejects(configs.initialize('acct_xhs_init', 0, 'admin'),
        (error: unknown) => (error as { code?: string }).code === 'INTERACTION_NOT_FOUND');
      assert.ok((await configs.listAudit('acct_wc_init', 10)).some((item) => item.action === 'config_initialized'));
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
  { skip: skipReason }, async () => {
    const pool = new pg.Pool({ connectionString });
    const store = new InteractionStore({ pool, clock: () => attemptGate.now,
      authGate: new PgInteractionAuthGate({ pool }), executionTarget: INTERACTION_TEST_EXECUTION_TARGET,
      accountPlatform: interactionAccountPlatform() });
    const configs = new ReplyConfigStore({ pool });
    try {
      await pool.query(`TRUNCATE
        interaction_api_requests,interaction_audit_events,interaction_send_attempts,interaction_reply_jobs,
        interaction_messages,interaction_threads,interaction_sync_batches,interaction_sync_cursors,
        interaction_auth_state,interaction_runtime_controls,reply_rules,reply_templates,account_reply_profiles,
        interaction_reply_config_versions,interaction_reply_configs,event_outbox,event_outbox_cursor,event_outbox_topic_cursor
        RESTART IDENTITY CASCADE`);
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
      const fixture = JSON.parse(await readFile(new URL('../fixtures/wechat-channels-inbox/v1/ws/comment-sync-batch.json', import.meta.url), 'utf8')) as { payload: unknown };
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
      assert.equal(pushed[0]?.type, 'wechat_channels.inbox.reply.send');
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
