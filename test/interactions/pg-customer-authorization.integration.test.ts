import assert from 'node:assert/strict';
import { ensureCapabilitySchema } from '../../src/schema/schema-capability.js';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import pg from 'pg';
import { ClientUserStore } from '../../src/client-auth/client-user-store.js';
import { PgOffboardMaterializationOps } from '../../src/interactions/offboard-write-adapter.js';
import { PgClientEnvAutomationRead } from '../../src/interactions/client-env-automation-read.js';
import { InteractionApiWrites } from '../../src/interactions/interaction-api-writes.js';
import { parseSyncBatchPayload } from '../../src/interactions/contract.js';
import { InteractionStore } from '../../src/interactions/interaction-store.js';
import { PgInteractionAuthGate } from '../../src/interactions/interaction-auth-gate.js';
import { shanghaiDayStartMs } from '../../src/time/shanghai-day.js';
import { INTERACTION_URL_ENV, resolveIntegrationDatabase } from '../helpers/pg-test-database-guard.js';

import { INTERACTION_TEST_EXECUTION_TARGET } from '../helpers/interaction-store-test-deps.js';

/**
 * 连库前 MUST 过 `test/helpers/pg-test-database-guard.ts` 的三条守卫：拒绝已知生产 host、
 * 强制 `aidcp_test*` 专用库名、只在显式测试通道（`npm run test:pg`）里生效。
 * 理由：dev 与 ol 连的是同一台物理 PostgreSQL，那台就是生产库，而本组用例会 TRUNCATE / 建表。
 * 不在通道里 → 整组 skip、绝不连库；在通道里而守卫不过 → 当场抛错，MUST NOT 降级为 skip。
 */
const target = resolveIntegrationDatabase(INTERACTION_URL_ENV);
const connectionString = target.enabled ? target.connectionString : undefined;
const skipReason = target.enabled ? (false as const) : target.skipReason;

test('PostgreSQL: authoritative env ownership is unique and cross-customer interaction access fails closed',
  { skip: skipReason }, async () => {
    const pool = new pg.Pool({ connectionString });
    const users = new ClientUserStore({ schemaEnsurer: ensureCapabilitySchema, pool,
      offboardMaterialization: new PgOffboardMaterializationOps({ pool }),
      // Block③ L3：automation 属主表的顶层只读经端口取；真库单库下与直读逐字节等价。
      automationReads: new PgClientEnvAutomationRead({ pool }) });
    try {
      await users.init();
      await pool.query(`TRUNCATE client_env_revocation_holds,interaction_offboard_audit,interaction_offboards,
        client_env_provisioning_intents,client_env_scope_audit,client_env_scope,client_users,client_environments RESTART IDENTITY CASCADE`);
      await pool.query(`DELETE FROM interaction_auth_state WHERE account_id IN ('acct-auth-a','acct-auth-b')`);
      await pool.query(`INSERT INTO accounts(account_id,label,platform) VALUES
        ('acct-auth-a','A','wechat_channels'),('acct-auth-b','B','wechat_channels')
        ON CONFLICT (account_id) DO UPDATE SET platform=EXCLUDED.platform`);
      await pool.query(`INSERT INTO client_users(user_id,name,key_hash,key_salt,status) VALUES
        ('user-a','auth-a','hash','salt','enabled'),
        ('user-b','auth-b','hash','salt','enabled')`);
      await users.registerEnvironments([
        { envKey: 'env-auth-a', label: 'A 权威环境', platform: 'wechat_channels' },
        { envKey: 'env-auth-b', label: 'B 权威环境', platform: 'wechat_channels' },
        { envKey: 'env-auth-race', label: '唯一归属竞争', platform: 'wechat_channels' },
      ], 'admin');
      await pool.query(`INSERT INTO interaction_auth_state
        (platform,account_id,env_key,status,browser_state,capabilities,checked_at)
        VALUES
        ('wechat_channels','acct-auth-a','env-auth-a','active','closed','{}'::jsonb,now()),
        ('wechat_channels','acct-auth-b','env-auth-b','active','closed','{}'::jsonb,now())
        ON CONFLICT (platform,account_id) DO UPDATE SET env_key=EXCLUDED.env_key,status='active'`);

      // Simulate a row created by the removed customer self-attach path. Re-running
      // the idempotent schema migration must move it out of active scope into audit.
      await pool.query(`ALTER TABLE client_env_scope DROP CONSTRAINT client_env_scope_authoritative_source`);
      await pool.query(`INSERT INTO client_env_scope
        (user_id,env_key,label,platform,source,assigned_by)
        VALUES ('user-a','env-auth-b','伪造归属','wechat_channels','client','user-a')`);
      await users.init();
      assert.equal((await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM client_env_scope
        WHERE user_id='user-a' AND env_key='env-auth-b'`)).rows[0].n, 0);
      const legacyAudit = (await pool.query<{ source: string; reason: string }>(
        `SELECT source,reason FROM client_env_scope_audit
         WHERE user_id='user-a' AND env_key='env-auth-b' ORDER BY revoked_at DESC LIMIT 1`,
      )).rows[0];
      assert.deepEqual(legacyAudit, { source: 'client', reason: 'legacy_self_claim' });
      await assert.rejects(pool.query(`INSERT INTO client_env_scope(user_id,env_key,source)
        VALUES ('user-a','env-auth-b','client')`),
      (error: unknown) => (error as { code?: string }).code === '23514',
      'database must reject the removed customer attach path even for an old binary');

      assert.equal((await users.setScope('user-a', [{ envKey: 'env-auth-a', label: 'caller spoof' }], 'admin')).ok, true);
      assert.equal((await users.setScope('user-b', [{ envKey: 'env-auth-b' }], 'admin')).ok, true);
      assert.deepEqual((await users.listEnvScope('user-a')).map((row) => [row.envKey, row.label]),
        [['env-auth-a', 'A 权威环境']], 'scope metadata must come from the registry');

      let crossTenantOperationCalls = 0;
      const allowed = await users.withAuthorizedInteractionScope('user-a', 'env-auth-a', async ({ accountId }) => accountId);
      assert.deepEqual(allowed, { ok: true, accountId: 'acct-auth-a', value: 'acct-auth-a' });
      const denied = await users.withAuthorizedInteractionScope('user-a', 'env-auth-b', async () => {
        crossTenantOperationCalls += 1;
      });
      assert.deepEqual(denied, { ok: false, reason: 'not_authorized' });
      assert.equal(crossTenantOperationCalls, 0);

      const unknown = await users.setScope('user-a', [{ envKey: 'customer-invented-env' }], 'admin');
      assert.deepEqual(unknown, { ok: false, reason: 'unknown_environment', envKey: 'customer-invented-env' });

      const raced = await Promise.all([
        users.setScope('user-a', [{ envKey: 'env-auth-race' }], 'admin-1'),
        users.setScope('user-b', [{ envKey: 'env-auth-race' }], 'admin-2'),
      ]);
      assert.equal(raced.filter((result) => result.ok).length, 1);
      assert.equal(raced.filter((result) => !result.ok && result.reason === 'env_already_assigned').length, 1);
      assert.equal((await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM client_env_scope
        WHERE env_key='env-auth-race' AND source='admin'`)).rows[0].n, 1);

      const provision = await users.createProvisioningIntent('user-a');
      assert.equal(provision.ok, true);
      if (!provision.ok) return;
      const provisionStartedAt = Date.now();
      const completed = await users.completeProvisioningIntent('user-a', {
        intentId: provision.intentId, proof: provision.proof, envKey: 'env-auth-provisioned',
        label: '客户端新建', platform: 'facebook', slowStartEnabled: true,
      });
      assert.equal(completed.ok, true);
      if (!completed.ok) return;
      const provisionFinishedAt = Date.now();
      assert.equal(completed.idempotent, false);
      const firstSlowStart = (await pool.query<{ slow_start_since: Date | null }>(
        `SELECT slow_start_since FROM client_environments WHERE env_key='env-auth-provisioned'`,
      )).rows[0].slow_start_since;
      assert.ok((firstSlowStart?.getTime() ?? 0) >= shanghaiDayStartMs(provisionStartedAt));
      assert.ok((firstSlowStart?.getTime() ?? 0) <= shanghaiDayStartMs(provisionFinishedAt));
      assert.equal((await users.setEnvironmentSlowStart('user-a', 'env-auth-provisioned', false, Date.now())).ok, true);
      const retried = await users.completeProvisioningIntent('user-a', {
        intentId: provision.intentId, proof: provision.proof, envKey: 'env-auth-provisioned',
        label: '客户端新建', platform: 'facebook', slowStartEnabled: true,
      });
      assert.equal(retried.ok && retried.idempotent, true);
      assert.equal((await pool.query<{ slow_start_since: Date | null }>(
        `SELECT slow_start_since FROM client_environments WHERE env_key='env-auth-provisioned'`,
      )).rows[0].slow_start_since, null, '完成重试不得复活已关闭的慢启动');
      assert.equal((await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM client_env_scope
        WHERE env_key='env-auth-provisioned' AND user_id='user-a' AND source='admin'`)).rows[0].n, 1);
      const storedProof = (await pool.query<{ proof_hash: string }>(
        `SELECT proof_hash FROM client_env_provisioning_intents WHERE intent_id=$1`, [provision.intentId],
      )).rows[0].proof_hash;
      assert.notEqual(storedProof, provision.proof);
      assert.match(storedProof, /^[a-f0-9]{64}$/);

      const bobIntent = await users.createProvisioningIntent('user-b');
      assert.equal(bobIntent.ok, true);
      if (!bobIntent.ok) return;
      assert.deepEqual(await users.completeProvisioningIntent('user-b', {
        intentId: bobIntent.intentId, proof: bobIntent.proof, envKey: 'env-auth-provisioned',
        label: '伪造认领', platform: 'facebook',
      }), { ok: false, reason: 'environment_already_registered' });
      assert.equal((await users.listEnvScope('user-b')).some((row) => row.envKey === 'env-auth-provisioned'), false);

      const mismatchIntent = await users.createProvisioningIntent('user-a');
      assert.equal(mismatchIntent.ok, true);
      if (!mismatchIntent.ok) return;
      assert.equal((await users.completeProvisioningIntent('user-a', {
        intentId: mismatchIntent.intentId, proof: mismatchIntent.proof, envKey: 'env-auth-first',
        label: null, platform: 'xiaohongshu',
      })).ok, true);
      assert.deepEqual(await users.completeProvisioningIntent('user-a', {
        intentId: mismatchIntent.intentId, proof: mismatchIntent.proof, envKey: 'env-auth-second',
        label: null, platform: 'xiaohongshu',
      }), { ok: false, reason: 'intent_target_mismatch' });

      await pool.query(`UPDATE client_users SET status='disabled' WHERE user_id='user-a'`);
      const disabled = await users.withAuthorizedInteractionScope('user-a', 'env-auth-race', async () => 'never');
      assert.deepEqual(disabled, { ok: false, reason: 'disabled' });
    } finally {
      await pool.end();
    }
  });

test('PostgreSQL: unbind/termination revoke first, retry offline cleanup, tombstone after exact Edge result and purge by deadline',
  { skip: skipReason }, async () => {
    const pool = new pg.Pool({ connectionString });
    const users = new ClientUserStore({ schemaEnsurer: ensureCapabilitySchema, pool,
      offboardMaterialization: new PgOffboardMaterializationOps({ pool }),
      // Block③ L3：automation 属主表的顶层只读经端口取；真库单库下与直读逐字节等价。
      automationReads: new PgClientEnvAutomationRead({ pool }) });
    const interactions = new InteractionStore({ pool, clock: () => 1_784_044_830_000, apiPurge: new InteractionApiWrites(),
      authGate: new PgInteractionAuthGate({ pool }), executionTarget: INTERACTION_TEST_EXECUTION_TARGET });
    try {
      await users.init();
      await interactions.init();
      await pool.query(`TRUNCATE client_env_revocation_holds,interaction_offboard_audit,interaction_offboards,
        client_env_provisioning_intents,client_env_scope_audit,client_env_scope,client_users,client_environments RESTART IDENTITY CASCADE`);
      await pool.query(`DELETE FROM interaction_auth_state
        WHERE account_id IN ('acct-offboard-a','acct-offboard-b','acct-term-a','acct-term-b')`);
      await pool.query(`INSERT INTO accounts(account_id,label,platform) VALUES
        ('acct-offboard-a','offboard-a','wechat_channels'),('acct-offboard-b','offboard-b','wechat_channels'),
        ('acct-term-a','term-a','wechat_channels'),('acct-term-b','term-b','wechat_channels')
        ON CONFLICT (account_id) DO UPDATE SET platform=EXCLUDED.platform`);
      await pool.query(`INSERT INTO client_users(user_id,name,key_hash,key_salt,status) VALUES
        ('user-offboard-a','offboard-user-a','hash','salt','enabled'),
        ('user-offboard-b','offboard-user-b','hash','salt','enabled'),
        ('user-term','terminated-user','hash','salt','enabled')`);
      await users.registerEnvironments([
        { envKey: 'env-offboard-a', platform: 'wechat_channels' },
        { envKey: 'env-offboard-b', platform: 'wechat_channels' },
        { envKey: 'env-term-a', platform: 'wechat_channels' },
        { envKey: 'env-term-b', platform: 'wechat_channels' },
      ], 'admin');
      await pool.query(`INSERT INTO interaction_auth_state
        (platform,account_id,env_key,status,browser_state,capabilities,identity,checked_at)
        VALUES
        ('wechat_channels','acct-offboard-a','env-offboard-a','active','closed','{}'::jsonb,'{"externalId":"secret-id"}'::jsonb,now()),
        ('wechat_channels','acct-offboard-b','env-offboard-b','active','closed','{}'::jsonb,NULL,now()),
        ('wechat_channels','acct-term-a','env-term-a','active','closed','{}'::jsonb,NULL,now()),
        ('wechat_channels','acct-term-b','env-term-b','active','closed','{}'::jsonb,NULL,now())
        ON CONFLICT (platform,account_id) DO UPDATE SET env_key=EXCLUDED.env_key,status='active',identity=EXCLUDED.identity`);
      await pool.query(`INSERT INTO interaction_runtime_controls
        (platform,account_id,env_key,comments_read_enabled,comments_reply_enabled,dm_read_enabled,
         dm_send_text_enabled,dm_send_image_enabled,write_paused,updated_by)
        VALUES ('wechat_channels','acct-offboard-a',NULL,true,true,true,true,false,false,'admin')
        ON CONFLICT (platform,account_id) DO UPDATE SET env_key=NULL,comments_read_enabled=true,
          comments_reply_enabled=true,dm_read_enabled=true,dm_send_text_enabled=true,write_paused=false`);
      assert.equal((await users.setScope('user-offboard-a', [{ envKey: 'env-offboard-a' }], 'admin')).ok, true);
      assert.equal((await users.setScope('user-offboard-b', [{ envKey: 'env-offboard-b' }], 'admin')).ok, true);
      assert.equal((await users.setScope('user-term', [{ envKey: 'env-term-a' }, { envKey: 'env-term-b' }], 'admin')).ok, true);

      const rawFixture = JSON.parse(await readFile(
        new URL('../fixtures/wechat-channels-interaction/v1/ws/comment-sync-batch.json', import.meta.url), 'utf8',
      )) as { payload: unknown };
      const fixture = parseSyncBatchPayload(rawFixture.payload);
      assert.ok(fixture);
      await interactions.ingestBatch({
        ...fixture, accountId: 'acct-offboard-b', envKey: 'env-offboard-b',
        batchId: 'batch-offboard-b-content', cursorAfter: 'cursor-offboard-b-content',
        threads: [{ ...fixture.threads[0], externalThreadId: 'thread-offboard-b',
          participant: { externalId: 'participant-offboard-b', displayName: '待清除昵称',
            avatarUrl: 'https://example.invalid/avatar.jpg' }, sourceTitle: '待清除会话标题' }],
        messages: [{ ...fixture.messages[0], externalThreadId: 'thread-offboard-b',
          externalMessageId: 'message-offboard-b', externalRootId: 'message-offboard-b',
          contentText: '待清除消息正文', attachmentMeta: {
            mimeType: 'image/jpeg', width: 100, height: 100, url: 'https://example.invalid/content.jpg',
          } }],
      });

      const started = await users.beginEnvironmentOffboard('user-offboard-a', 'env-offboard-a');
      assert.equal(started.ok, true);
      if (!started.ok) return;
      assert.equal(started.offboard.state, 'pending_edge');
      assert.equal((await users.withAuthorizedInteractionScope('user-offboard-a', 'env-offboard-a', async () => true)).ok, false,
        'scope must be revoked before Edge cleanup');
      assert.equal((await interactions.pendingOffboards('acct-offboard-a')).length, 1,
        'offline Edge leaves a durable pending cleanup');
      const disabled = (await pool.query<{ status: string }>(`SELECT status FROM interaction_auth_state
        WHERE account_id='acct-offboard-a'`)).rows[0];
      assert.equal(disabled.status, 'disabled');
      const revokedControls = (await pool.query<{
        env_key: string | null; comments_read_enabled: boolean; comments_reply_enabled: boolean;
        dm_read_enabled: boolean; dm_send_text_enabled: boolean; write_paused: boolean;
      }>(`SELECT env_key,comments_read_enabled,comments_reply_enabled,dm_read_enabled,dm_send_text_enabled,write_paused
            FROM interaction_runtime_controls WHERE platform='wechat_channels' AND account_id='acct-offboard-a'`)).rows[0];
      assert.deepEqual(revokedControls, {
        env_key: null, comments_read_enabled: false, comments_reply_enabled: false,
        dm_read_enabled: false, dm_send_text_enabled: false, write_paused: true,
      }, 'revocation must use account identity even when runtime controls have no env binding');

      const failed = await interactions.applyOffboardResult({
        offboardId: started.offboard.offboardId, envKey: 'env-offboard-a', accountId: 'acct-offboard-a',
        platform: 'wechat_channels', status: 'failed', errorCode: 'INTERACTION_UPSTREAM_UNAVAILABLE',
        finishedAt: 1_784_044_831_000,
      });
      assert.equal(failed.duplicate, false);
      assert.equal((await interactions.pendingOffboards('acct-offboard-a'))[0].state, 'pending_edge');
      const cleared = await interactions.applyOffboardResult({
        offboardId: started.offboard.offboardId, envKey: 'env-offboard-a', accountId: 'acct-offboard-a',
        platform: 'wechat_channels', status: 'cleared', errorCode: null, finishedAt: 1_784_044_832_000,
      });
      assert.equal(cleared.duplicate, false);
      assert.equal((await interactions.applyOffboardResult({
        offboardId: started.offboard.offboardId, envKey: 'env-offboard-a', accountId: 'acct-offboard-a',
        platform: 'wechat_channels', status: 'cleared', errorCode: null, finishedAt: 1_784_044_832_000,
      })).duplicate, true);
      assert.equal((await users.getOffboard('user-offboard-a', started.offboard.offboardId))?.state, 'tombstoned');
      assert.equal((await pool.query<{ identity: unknown }>(`SELECT identity FROM interaction_auth_state
        WHERE account_id='acct-offboard-a'`)).rows[0].identity, null);

      await pool.query(`UPDATE interaction_offboards SET purge_due_at=to_timestamp(1)
        WHERE offboard_id=$1`, [started.offboard.offboardId]);
      assert.equal(await interactions.purgeDueOffboards(1_784_044_833_000), 1);
      assert.equal((await users.getOffboard('user-offboard-a', started.offboard.offboardId))?.state, 'purged');
      assert.equal((await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM interaction_auth_state
        WHERE account_id='acct-offboard-a'`)).rows[0].n, 0);

      await pool.query(`CREATE OR REPLACE FUNCTION aidcp_test_skip_auth_revoke() RETURNS trigger AS $$
        BEGIN
          IF OLD.account_id='acct-offboard-b' AND NEW.status='disabled' THEN RETURN NULL; END IF;
          RETURN NEW;
        END;
      $$ LANGUAGE plpgsql`);
      await pool.query(`CREATE TRIGGER aidcp_test_skip_auth_revoke
        BEFORE UPDATE ON interaction_auth_state FOR EACH ROW EXECUTE FUNCTION aidcp_test_skip_auth_revoke()`);
      try {
        await assert.rejects(
          users.beginEnvironmentOffboard('user-offboard-b', 'env-offboard-b'),
          /interaction_auth_state_revoke_missed/,
        );
        assert.equal((await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM interaction_offboards
          WHERE account_id='acct-offboard-b'`)).rows[0].n, 0, 'failed revocation must roll back the offboard row');
        assert.equal((await users.listEnvScope('user-offboard-b')).length, 1,
          'failed revocation must not remove authoritative ownership');
      } finally {
        await pool.query(`DROP TRIGGER IF EXISTS aidcp_test_skip_auth_revoke ON interaction_auth_state`);
        await pool.query(`DROP FUNCTION IF EXISTS aidcp_test_skip_auth_revoke()`);
      }

      const noEdgeReceipt = await users.beginEnvironmentOffboard('user-offboard-b', 'env-offboard-b');
      assert.equal(noEdgeReceipt.ok, true);
      if (!noEdgeReceipt.ok) return;
      await pool.query(`UPDATE interaction_offboards SET purge_due_at=to_timestamp(1)
        WHERE offboard_id=$1`, [noEdgeReceipt.offboard.offboardId]);
      assert.equal(await interactions.purgeDueOffboards(1_784_044_833_000), 1,
        'Cloud 到期清除不得等待 Edge 回执');
      assert.equal((await users.getOffboard('user-offboard-b', noEdgeReceipt.offboard.offboardId))?.state, 'purged');
      assert.equal((await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM interaction_threads
        WHERE account_id='acct-offboard-b'`)).rows[0].n, 0);
      assert.equal((await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM interaction_auth_state
        WHERE account_id='acct-offboard-b'`)).rows[0].n, 0);
      const unconfirmedAudit = (await pool.query<{ status: string }>(
        `SELECT status FROM interaction_offboard_audit
          WHERE offboard_id=$1 AND event='cloud_purged' ORDER BY created_at DESC LIMIT 1`,
        [noEdgeReceipt.offboard.offboardId],
      )).rows[0];
      assert.equal(unconfirmedAudit.status, 'purged_edge_unconfirmed');

      assert.equal((await interactions.applyOffboardResult({
        offboardId: noEdgeReceipt.offboard.offboardId, envKey: 'env-offboard-b', accountId: 'acct-offboard-b',
        platform: 'wechat_channels', status: 'cleared', errorCode: null, finishedAt: 1_784_044_834_000,
      })).duplicate, false, 'Cloud 已清除后到达的 Edge 回执仍须独立记账');
      const lateEdge = (await pool.query<{ edge_result_status: string | null }>(
        `SELECT edge_result_status FROM interaction_offboards WHERE offboard_id=$1`,
        [noEdgeReceipt.offboard.offboardId],
      )).rows[0];
      assert.equal(lateEdge.edge_result_status, 'cleared');
      assert.equal((await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM interaction_offboard_audit
        WHERE offboard_id=$1 AND event='edge_cleanup_confirmed_after_cloud_purge'
          AND status='purged_edge_confirmed'`, [noEdgeReceipt.offboard.offboardId])).rows[0].n, 1);

      const terminated = await users.updateUser('user-term', { status: 'disabled' }, 'admin-termination');
      assert.equal(terminated.ok, true);
      if (!terminated.ok) return;
      assert.equal(terminated.offboards.length, 2);
      assert.deepEqual(terminated.offboards.map((item) => item.reason), ['customer_terminated', 'customer_terminated']);
      assert.equal((await users.listEnvScope('user-term')).length, 0);
      assert.equal((await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM interaction_offboard_audit
        WHERE user_id='user-term' AND event='access_revoked' AND status='pending_edge'`)).rows[0].n, 2);
      const auditColumns = (await pool.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns
        WHERE table_name='interaction_offboard_audit' ORDER BY column_name`)).rows.map((row) => row.column_name);
      assert.equal(auditColumns.some((name) => /content|text|cookie|credential|template/i.test(name)), false);
    } finally {
      await pool.end();
    }
  });

test('PostgreSQL: provisioned video environment without an auth binding gets terminal offboard while legacy missing binding stays closed',
  { skip: skipReason }, async () => {
    const pool = new pg.Pool({ connectionString });
    const users = new ClientUserStore({ schemaEnsurer: ensureCapabilitySchema, pool,
      offboardMaterialization: new PgOffboardMaterializationOps({ pool }),
      // Block③ L3：automation 属主表的顶层只读经端口取；真库单库下与直读逐字节等价。
      automationReads: new PgClientEnvAutomationRead({ pool }) });
    const interactions = new InteractionStore({ pool, apiPurge: new InteractionApiWrites(),
      authGate: new PgInteractionAuthGate({ pool }), executionTarget: INTERACTION_TEST_EXECUTION_TARGET });
    try {
      await users.init();
      await interactions.init();
      await pool.query(`TRUNCATE client_env_revocation_holds,interaction_offboard_audit,interaction_offboards,
        client_env_provisioning_intents,client_env_scope_audit,client_env_scope,client_users,client_environments RESTART IDENTITY CASCADE`);
      await pool.query(`INSERT INTO client_users(user_id,name,key_hash,key_salt,status) VALUES
        ('user-provisioned-unbound','provisioned-unbound','hash','salt','enabled'),
        ('user-legacy-unbound','legacy-unbound','hash','salt','enabled')`);

      const intent = await users.createProvisioningIntent('user-provisioned-unbound');
      assert.equal(intent.ok, true);
      if (!intent.ok) return;
      const completed = await users.completeProvisioningIntent('user-provisioned-unbound', {
        intentId: intent.intentId,
        proof: intent.proof,
        envKey: 'env-provisioned-unbound',
        label: '尚未登录的视频号环境',
        platform: 'wechat_channels',
      });
      assert.equal(completed.ok, true);

      const terminal = await users.beginEnvironmentOffboard('user-provisioned-unbound', 'env-provisioned-unbound');
      assert.equal(terminal.ok, true);
      if (!terminal.ok) return;
      assert.equal(terminal.offboard.state, 'tombstoned');
      assert.equal(terminal.offboard.accountId, 'env-provisioned-unbound');
      assert.equal((await users.listEnvScope('user-provisioned-unbound')).length, 0,
        'authoritative ownership is revoked in the same transaction');
      assert.equal((await interactions.pendingOffboards('env-provisioned-unbound')).length, 0,
        'terminal no-binding offboard must never be dispatched as credential cleanup');
      assert.equal((await users.getOffboard('user-provisioned-unbound', terminal.offboard.offboardId))?.state, 'tombstoned');
      const terminalRow = (await pool.query<{
        state: string; account_id: string; tombstoned: boolean; purged: boolean;
      }>(`SELECT state,account_id,tombstoned_at IS NOT NULL AS tombstoned,purged_at IS NOT NULL AS purged
            FROM interaction_offboards WHERE offboard_id=$1`, [terminal.offboard.offboardId])).rows[0];
      assert.deepEqual(terminalRow, {
        state: 'tombstoned', account_id: 'env-provisioned-unbound', tombstoned: true, purged: false,
      });
      assert.deepEqual((await pool.query<{ event: string; status: string }>(
        `SELECT event,status FROM interaction_offboard_audit WHERE offboard_id=$1 ORDER BY event`,
        [terminal.offboard.offboardId],
      )).rows, [
        { event: 'access_revoked', status: 'tombstoned' },
        { event: 'unbound_cleanup_not_required', status: 'tombstoned' },
      ]);
      await pool.query(`INSERT INTO accounts(account_id,label,platform) VALUES
        ('env-provisioned-unbound','late first auth','wechat_channels')
        ON CONFLICT (account_id) DO UPDATE SET platform=EXCLUDED.platform`);
      await interactions.upsertAuthStatus({
        envKey: 'env-provisioned-unbound',
        accountId: 'env-provisioned-unbound',
        platform: 'wechat_channels',
        status: 'active',
        browserState: 'open',
        capabilities: { commentsRead: true, commentsReply: false, dmRead: false, dmSendText: false, dmSendImage: false },
        identity: null,
        runtimeControlsVersion: 0,
        checkedAt: Date.now(),
        reasonCode: null,
      });
      assert.equal((await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM interaction_auth_state
        WHERE env_key='env-provisioned-unbound'`)).rows[0].n, 0,
      'tombstone must reject a late first-auth status instead of recreating the binding');
      assert.equal((await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM interaction_offboard_audit
        WHERE offboard_id=$1 AND event='auth_status_ignored' AND status='tombstoned'`,
      [terminal.offboard.offboardId])).rows[0].n, 1);

      await users.registerEnvironments([
        { envKey: 'env-legacy-unbound', label: '存量视频号环境', platform: 'wechat_channels' },
      ], 'admin');
      assert.equal((await users.setScope('user-legacy-unbound', [{ envKey: 'env-legacy-unbound' }], 'admin')).ok, true);
      assert.deepEqual(
        await users.beginEnvironmentOffboard('user-legacy-unbound', 'env-legacy-unbound'),
        { ok: false, reason: 'offboard_binding_missing' },
      );
      assert.deepEqual((await users.listEnvScope('user-legacy-unbound')).map((row) => row.envKey),
        ['env-legacy-unbound'], 'missing legacy binding must not silently revoke ownership');
    } finally {
      await pool.end();
    }
  });

test('PostgreSQL: admin revocation removes ownership before cleanup and late binding materializes exact offboard',
  { skip: skipReason }, async () => {
    const pool = new pg.Pool({ connectionString });
    const users = new ClientUserStore({ schemaEnsurer: ensureCapabilitySchema, pool,
      offboardMaterialization: new PgOffboardMaterializationOps({ pool }),
      // Block③ L3：automation 属主表的顶层只读经端口取；真库单库下与直读逐字节等价。
      automationReads: new PgClientEnvAutomationRead({ pool }) });
    const interactions = new InteractionStore({ pool, apiPurge: new InteractionApiWrites(),
      authGate: new PgInteractionAuthGate({ pool }), executionTarget: INTERACTION_TEST_EXECUTION_TARGET });
    try {
      await users.init();
      await interactions.init();
      await pool.query(`TRUNCATE client_env_revocation_holds,interaction_offboard_audit,interaction_offboards,
        client_env_provisioning_intents,client_env_scope_audit,client_env_scope,client_users,client_environments RESTART IDENTITY CASCADE`);
      await pool.query(`DELETE FROM interaction_auth_state WHERE env_key LIKE 'env-revoke-%'`);
      await pool.query(`INSERT INTO accounts(account_id,label,platform) VALUES
        ('acct-revoke-bound','bound cleanup','wechat_channels'),
        ('acct-revoke-late','late cleanup','wechat_channels'),
        ('acct-revoke-disable','disable cleanup','wechat_channels')
        ON CONFLICT (account_id) DO UPDATE SET platform=EXCLUDED.platform`);
      await pool.query(`INSERT INTO client_users(user_id,name,key_hash,key_salt,status) VALUES
        ('user-revoke-owner','revoke-owner','hash','salt','enabled'),
        ('user-revoke-next','revoke-next','hash','salt','enabled'),
        ('user-revoke-disable','revoke-disable','hash','salt','enabled')`);
      await users.registerEnvironments([
        { envKey: 'env-revoke-bound', platform: 'wechat_channels' },
        { envKey: 'env-revoke-missing', platform: 'wechat_channels' },
        { envKey: 'env-revoke-disable-bound', platform: 'wechat_channels' },
        { envKey: 'env-revoke-disable-missing', platform: 'wechat_channels' },
      ], 'admin');
      await interactions.upsertAuthStatus({
        envKey: 'env-revoke-bound', accountId: 'acct-revoke-bound', platform: 'wechat_channels', status: 'active',
        browserState: 'closed', capabilities: { commentsRead: true, commentsReply: false, dmRead: false,
          dmSendText: false, dmSendImage: false }, identity: null, runtimeControlsVersion: 0,
        checkedAt: Date.now(), reasonCode: null,
      });
      await interactions.upsertAuthStatus({
        envKey: 'env-revoke-disable-bound', accountId: 'acct-revoke-disable', platform: 'wechat_channels', status: 'active',
        browserState: 'closed', capabilities: { commentsRead: true, commentsReply: false, dmRead: false,
          dmSendText: false, dmSendImage: false }, identity: null, runtimeControlsVersion: 0,
        checkedAt: Date.now(), reasonCode: null,
      });
      await pool.query(`INSERT INTO interaction_runtime_controls
        (platform,account_id,env_key,comments_read_enabled,comments_reply_enabled,dm_read_enabled,
         dm_send_text_enabled,dm_send_image_enabled,write_paused,updated_by)
        VALUES ('wechat_channels','acct-revoke-late','env-revoke-missing',true,true,true,true,false,false,'admin')
        ON CONFLICT (platform,account_id) DO UPDATE SET env_key=EXCLUDED.env_key,comments_read_enabled=true,
          comments_reply_enabled=true,dm_read_enabled=true,dm_send_text_enabled=true,write_paused=false`);
      assert.equal((await users.setScope('user-revoke-owner', [
        { envKey: 'env-revoke-bound' }, { envKey: 'env-revoke-missing' },
      ], 'admin')).ok, true);

      const removals = await Promise.all([
        users.setScope('user-revoke-owner', [], 'admin-first'),
        users.setScope('user-revoke-owner', [], 'admin-retry'),
      ]);
      assert.equal(removals.every((result) => result.ok), true);
      const first = removals.find((result) => result.ok && result.cleanup.length === 2);
      assert.ok(first?.ok);
      assert.deepEqual(first.cleanup.map((item) => item.kind).sort(), ['binding_missing', 'offboard_pending']);
      assert.equal((await users.listEnvScope('user-revoke-owner')).length, 0,
        'ownership must be gone even when one binding is missing');
      assert.deepEqual(
        await users.withAuthorizedInteractionScope('user-revoke-owner', 'env-revoke-missing', async () => true),
        { ok: false, reason: 'not_authorized' },
      );
      assert.equal((await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM client_env_revocation_holds
        WHERE env_key='env-revoke-missing'`)).rows[0].n, 1, 'retry must not duplicate the hold');
      const heldControls = (await pool.query<{
        comments_read_enabled: boolean; comments_reply_enabled: boolean; dm_read_enabled: boolean;
        dm_send_text_enabled: boolean; write_paused: boolean;
      }>(`SELECT comments_read_enabled,comments_reply_enabled,dm_read_enabled,dm_send_text_enabled,write_paused
            FROM interaction_runtime_controls WHERE account_id='acct-revoke-late'`)).rows[0];
      assert.deepEqual(heldControls, {
        comments_read_enabled: false, comments_reply_enabled: false, dm_read_enabled: false,
        dm_send_text_enabled: false, write_paused: true,
      }, 'a cleanup hold must revoke known account capabilities in the same transaction');
      const blocked = await users.setScope('user-revoke-next', [{ envKey: 'env-revoke-missing' }], 'admin');
      assert.deepEqual(blocked, { ok: false, reason: 'cleanup_in_progress', envKey: 'env-revoke-missing' });
      await assert.rejects(pool.query(`INSERT INTO client_env_scope(user_id,env_key,source)
        VALUES ('user-revoke-next','env-revoke-missing','admin')`),
      (error: unknown) => (error as { constraint?: string }).constraint === 'client_env_scope_cleanup_hold');
      const registry = (await users.listAllEnvironments()).find((item) => item.envKey === 'env-revoke-missing');
      assert.equal(registry?.assigneeCount, 0);
      assert.equal(registry?.cleanup?.kind, 'binding_missing');

      await interactions.upsertAuthStatus({
        envKey: 'env-revoke-missing', accountId: 'acct-revoke-late', platform: 'wechat_channels', status: 'active',
        browserState: 'open', capabilities: { commentsRead: true, commentsReply: false, dmRead: false,
          dmSendText: false, dmSendImage: false }, identity: null, runtimeControlsVersion: 0,
        checkedAt: Date.now(), reasonCode: null,
      });
      assert.equal(await users.hasPendingRevocationHold('acct-revoke-late'), true);
      const fixture = JSON.parse(await readFile(new URL('../fixtures/wechat-channels-interaction/v1/ws/comment-sync-batch.json',
        import.meta.url), 'utf8')) as { payload: unknown };
      const parsed = parseSyncBatchPayload(fixture.payload);
      assert.ok(parsed);
      await assert.rejects(interactions.ingestBatch({
        ...parsed, envKey: 'env-revoke-missing', accountId: 'acct-revoke-late', batchId: 'batch-revocation-hold',
      }), (error: unknown) => (error as { code?: string }).code === 'INTERACTION_FEATURE_DISABLED');
      const materialized = await users.reconcileCleanupAdmissions();
      assert.deepEqual(materialized.map((item: { envKey: string; accountId: string | null; reason: string }) =>
        [item.envKey, item.accountId, item.reason]),
        [['env-revoke-missing', 'acct-revoke-late', 'admin_revoked']]);
      // 准入行不再随物化删除——它一路挡住改派直到属主台账清除（purged）。物化只是给它盖上 materialized_at。
      assert.equal((await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM client_env_revocation_holds
        WHERE env_key='env-revoke-missing' AND materialized_at IS NOT NULL`)).rows[0].n, 1);
      assert.equal(await users.hasPendingRevocationHold('acct-revoke-late'), false);
      assert.equal((await pool.query<{ comments_read_enabled: boolean }>(`SELECT comments_read_enabled
        FROM interaction_runtime_controls WHERE account_id='acct-revoke-late'`)).rows[0].comments_read_enabled, false,
      'late binding materialization must keep capabilities closed');
      assert.deepEqual(await users.setScope('user-revoke-next', [{ envKey: 'env-revoke-missing' }], 'admin'),
        { ok: false, reason: 'offboard_in_progress', envKey: 'env-revoke-missing' });

      assert.equal((await users.setScope('user-revoke-disable', [
        { envKey: 'env-revoke-disable-bound' }, { envKey: 'env-revoke-disable-missing' },
      ], 'admin')).ok, true);
      const disabled = await users.updateUser('user-revoke-disable', { status: 'disabled' }, 'admin-disable');
      assert.ok(disabled.ok);
      assert.equal(disabled.user.status, 'disabled');
      assert.equal((await users.listEnvScope('user-revoke-disable')).length, 0);
      assert.deepEqual(disabled.cleanup.map((item) => item.kind).sort(), ['binding_missing', 'offboard_pending']);
    } finally {
      await pool.end();
    }
  });
