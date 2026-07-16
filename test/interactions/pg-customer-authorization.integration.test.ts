import assert from 'node:assert/strict';
import { test } from 'node:test';
import pg from 'pg';
import { ClientUserStore } from '../../src/client-auth/client-user-store.js';
import { InteractionStore } from '../../src/interactions/interaction-store.js';

const connectionString = process.env.AIDCP_INTERACTION_TEST_DATABASE_URL;

test('PostgreSQL: authoritative env ownership is unique and cross-customer interaction access fails closed',
  { skip: !connectionString }, async () => {
    const pool = new pg.Pool({ connectionString });
    const users = new ClientUserStore({ pool });
    try {
      await users.init();
      await pool.query(`TRUNCATE interaction_offboard_audit,interaction_offboards,
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
      const completed = await users.completeProvisioningIntent('user-a', {
        intentId: provision.intentId, proof: provision.proof, envKey: 'env-auth-provisioned',
        label: '客户端新建', platform: 'facebook',
      });
      assert.equal(completed.ok, true);
      if (!completed.ok) return;
      assert.equal(completed.idempotent, false);
      const retried = await users.completeProvisioningIntent('user-a', {
        intentId: provision.intentId, proof: provision.proof, envKey: 'env-auth-provisioned',
        label: '客户端新建', platform: 'facebook',
      });
      assert.equal(retried.ok && retried.idempotent, true);
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
  { skip: !connectionString }, async () => {
    const pool = new pg.Pool({ connectionString });
    const users = new ClientUserStore({ pool });
    const interactions = new InteractionStore({ pool, clock: () => 1_784_044_830_000 });
    try {
      await users.init();
      await interactions.init();
      await pool.query(`TRUNCATE interaction_offboard_audit,interaction_offboards,
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
      assert.equal((await users.setScope('user-offboard-a', [{ envKey: 'env-offboard-a' }], 'admin')).ok, true);
      assert.equal((await users.setScope('user-offboard-b', [{ envKey: 'env-offboard-b' }], 'admin')).ok, true);
      assert.equal((await users.setScope('user-term', [{ envKey: 'env-term-a' }, { envKey: 'env-term-b' }], 'admin')).ok, true);

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
