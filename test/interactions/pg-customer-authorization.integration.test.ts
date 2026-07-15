import assert from 'node:assert/strict';
import { test } from 'node:test';
import pg from 'pg';
import { ClientUserStore } from '../../src/client-auth/client-user-store.js';

const connectionString = process.env.AIDCP_INTERACTION_TEST_DATABASE_URL;

test('PostgreSQL: authoritative env ownership is unique and cross-customer interaction access fails closed',
  { skip: !connectionString }, async () => {
    const pool = new pg.Pool({ connectionString });
    const users = new ClientUserStore({ pool });
    try {
      await users.init();
      await pool.query(`TRUNCATE client_env_scope, client_users, client_environments RESTART IDENTITY CASCADE`);
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

      await pool.query(`UPDATE client_users SET status='disabled' WHERE user_id='user-a'`);
      const disabled = await users.withAuthorizedInteractionScope('user-a', 'env-auth-race', async () => 'never');
      assert.deepEqual(disabled, { ok: false, reason: 'disabled' });
    } finally {
      await pool.end();
    }
  });
