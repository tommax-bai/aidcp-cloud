/**
 * 对外客户身份 + 客户↔环境归属存储（PostgreSQL，aidcp 库）。change edge-client-customer-auth。
 *
 * 与内部运营 console 的登录体系**物理隔离**：独立表、独立密钥（见 client-auth-server）。承载：
 *  - `client_users`：客户身份（name 唯一、key 以 scrypt+盐 hash、启用状态、轮换时间）。
 *  - `client_env_scope`：由内部管理员授予的客户↔环境归属（fail-closed + 每环境全局唯一 active owner）。
 *    env_key = 环境 profileId（AdsPower 分身 id；edge 本地即知、云端见为 edgeId=ads-<profileId>），
 *    刻意**不加 FK 到 accounts**（避免与账号单写者 / ensureAccount 时序耦合）。label/platform 冗余以便后台展示。
 *
 * 红线（对齐 group-route-store 家族范式）：
 *  - schema 在 init() 里 CREATE TABLE IF NOT EXISTS 自建（本仓无 migration 执行器）。
 *  - 单写者（UPDATE/UPSERT/事务 + RETURNING 读回为真），绝不乐观假成功。
 *  - **N2 结构性无泄漏**：客户可达的环境读只有吃 userId 的 scoped 方法（listEnvScope / ownsEnv），不存在取全量。
 *  - 读缺表（42P01，首启竞态）**fail-closed**：登录→凭据错、可见环境→空、启用态→false；绝不把读失败冒充放行。
 *  - key 明文绝不落库、绝不回读；只 create/rotate 时由上层一次性回显。
 */

import crypto from 'node:crypto';
import pg from 'pg';
import { resolveEnvPgConfig } from '../cache/pg-config.js';
import { generateKey, hashKey, verifyKey, decoyVerify } from './key.js';

const { Pool } = pg;

export const CLIENT_USERS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS client_users (
  user_id     TEXT        PRIMARY KEY,
  name        TEXT        NOT NULL UNIQUE,
  key_hash    TEXT        NOT NULL,
  key_salt    TEXT        NOT NULL,
  status      TEXT        NOT NULL DEFAULT 'enabled' CHECK (status IN ('enabled','disabled')),
  rotated_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS client_env_scope (
  user_id     TEXT        NOT NULL REFERENCES client_users(user_id) ON DELETE CASCADE,
  env_key     TEXT        NOT NULL,
  label       TEXT,
  platform    TEXT,
  source      TEXT        NOT NULL DEFAULT 'admin' CHECK (source IN ('admin','client')),
  assigned_by TEXT,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, env_key)
);
CREATE INDEX IF NOT EXISTS client_env_scope_env_idx ON client_env_scope (env_key);
-- 管理侧「环境注册表」（change client-user-env-registry）：系统已知的全部环境，**独立于归属**。
-- 有此表前，后台「待分配」池只能从 client_env_scope 反推（= 只认识已分过的环境），无法表达「已导入但未分配给任何人」。
-- 此表让环境可以只登记、不归属：一次性导入存量环境（source='import'）+ 边缘一连上来自动登记（source='auto'）都灌这里，
-- 后台「待分配」= 本表 ∪ 归属表 的并集减去当前端用户已归属。env_key = 环境 profileId（不带 ads- 前缀，与 edge 口径一致）。
CREATE TABLE IF NOT EXISTS client_environments (
  env_key     TEXT        PRIMARY KEY,
  label       TEXT,
  platform    TEXT,
  source      TEXT        NOT NULL DEFAULT 'import' CHECK (source IN ('import','auto','admin')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- 客户端程序化新建的短时一次性意图。proof 只以 SHA-256 落库；完成动作仍由 Cloud
-- 在事务内写权威注册表 + active owner，旧 customer attach 路径不复活。
CREATE TABLE IF NOT EXISTS client_env_provisioning_intents (
  intent_id         UUID        PRIMARY KEY,
  user_id           TEXT        NOT NULL REFERENCES client_users(user_id) ON DELETE CASCADE,
  proof_hash        CHAR(64)    NOT NULL,
  state             TEXT        NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','completed','expired')),
  expires_at        TIMESTAMPTZ NOT NULL,
  completed_env_key TEXT,
  completed_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((state = 'completed') = (completed_env_key IS NOT NULL AND completed_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS client_env_provisioning_intents_user_idx
  ON client_env_provisioning_intents (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS client_env_provisioning_intents_expiry_idx
  ON client_env_provisioning_intents (expires_at) WHERE state = 'pending';
CREATE TABLE IF NOT EXISTS client_env_scope_audit (
  audit_id     BIGSERIAL   PRIMARY KEY,
  user_id      TEXT        NOT NULL,
  env_key      TEXT        NOT NULL,
  label        TEXT,
  platform     TEXT,
  source       TEXT        NOT NULL CHECK (source IN ('admin','client')),
  assigned_by  TEXT,
  assigned_at  TIMESTAMPTZ NOT NULL,
  revoked_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_by   TEXT,
  reason       TEXT        NOT NULL CHECK (reason IN ('legacy_self_claim','scope_replaced','environment_unbind','customer_terminated','admin_revoked')),
  UNIQUE (user_id, env_key, assigned_at, reason)
);
CREATE INDEX IF NOT EXISTS client_env_scope_audit_scope_idx
  ON client_env_scope_audit (user_id, env_key, revoked_at DESC);
-- 管理员撤权必须先收回客户访问；若 interaction account binding 缺失，不能伪造 accountId
-- 或假称已清理。该 hold 只记录最小定位/审计字段，并在 binding 后到时转成既有 offboard。
CREATE TABLE IF NOT EXISTS client_env_revocation_holds (
  revocation_id UUID        PRIMARY KEY,
  env_key       TEXT        NOT NULL UNIQUE,
  user_id       TEXT        NOT NULL,
  reason        TEXT        NOT NULL CHECK (reason IN ('customer_terminated','admin_revoked')),
  revoked_by    TEXT,
  requested_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS client_env_revocation_holds_requested_idx
  ON client_env_revocation_holds (requested_at, env_key);
-- 数据库级 guard 保护回滚/旧二进制：hold 存在时，任何 scope insert/update 都 fail closed。
CREATE OR REPLACE FUNCTION reject_client_env_scope_during_revocation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM client_env_revocation_holds WHERE env_key = NEW.env_key) THEN
    RAISE EXCEPTION 'environment cleanup is still unresolved'
      USING ERRCODE = '23514', CONSTRAINT = 'client_env_scope_cleanup_hold';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS client_env_scope_cleanup_hold_guard ON client_env_scope;
CREATE TRIGGER client_env_scope_cleanup_hold_guard
  BEFORE INSERT OR UPDATE OF env_key ON client_env_scope
  FOR EACH ROW EXECUTE FUNCTION reject_client_env_scope_during_revocation();
DO $$
BEGIN
  LOCK TABLE client_env_scope IN SHARE ROW EXCLUSIVE MODE;
  INSERT INTO client_environments (env_key, label, platform, source, created_at, updated_at)
  SELECT DISTINCT ON (env_key) env_key, label, platform, 'import', assigned_at, now()
  FROM client_env_scope
  ORDER BY env_key, assigned_at DESC
  ON CONFLICT (env_key) DO UPDATE
    SET label = COALESCE(client_environments.label, EXCLUDED.label),
        platform = COALESCE(client_environments.platform, EXCLUDED.platform),
        updated_at = now();
  INSERT INTO client_env_scope_audit
    (user_id, env_key, label, platform, source, assigned_by, assigned_at, revoked_at, revoked_by, reason)
  SELECT user_id, env_key, label, platform, source, assigned_by, assigned_at,
         now(), 'schema:init', 'legacy_self_claim'
  FROM client_env_scope WHERE source = 'client'
  ON CONFLICT (user_id, env_key, assigned_at, reason) DO NOTHING;
  DELETE FROM client_env_scope WHERE source = 'client';
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'client_env_scope'::regclass
      AND conname = 'client_env_scope_authoritative_source'
  ) THEN
    ALTER TABLE client_env_scope
      ADD CONSTRAINT client_env_scope_authoritative_source
      CHECK (source = 'admin') NOT VALID;
  END IF;
END $$;
ALTER TABLE client_env_scope VALIDATE CONSTRAINT client_env_scope_authoritative_source;
CREATE UNIQUE INDEX IF NOT EXISTS uq_client_env_scope_active_env
  ON client_env_scope (env_key);
CREATE INDEX IF NOT EXISTS client_env_scope_active_user_idx
  ON client_env_scope (user_id, assigned_at);
`;

/** 客户视图（管理端读；**绝不含 key/hash/salt**）。 */
export interface ClientUserView {
  userId: string;
  name: string;
  status: 'enabled' | 'disabled';
  envCount: number;
  rotatedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

/** 一条环境归属（管理端 / 客户端读）。 */
export interface ClientEnvScopeRow {
  envKey: string;
  label: string | null;
  platform: string | null;
  source: 'admin' | 'client';
  assignedAt: number;
}

/** 某环境被归属到的一个客户（管理侧全局注册表用；仅 userId + name，绝不含 key）。 */
export interface ClientEnvAssignee {
  userId: string;
  name: string;
}

/**
 * 管理侧全局环境注册表的一行（change client-user-env-picker）：系统已知的一个环境 + 它被分配给哪些客户。
 * 跨用户聚合，**仅供内部 panel 端点消费**（见 listAllEnvironments 红线）。
 */
export interface ClientEnvironmentView {
  envKey: string;
  label: string | null;
  platform: string | null;
  assignees: ClientEnvAssignee[];
  assigneeCount: number;
  cleanup: ClientCleanupReceipt | null;
}

export type CreateUserResult =
  | { ok: true; user: ClientUserView; plainKey: string }
  | { ok: false; reason: 'invalid_name' | 'name_taken' };

export type RotateKeyResult = { ok: true; plainKey: string } | { ok: false; reason: 'not_found' };

export type MutateUserResult =
  { ok: true; user: ClientUserView; offboards: ClientOffboardView[]; cleanup: ClientCleanupReceipt[] } |
  { ok: false; reason: 'not_found' | 'invalid_name' | 'name_taken' };

export type SetScopeResult =
  | { ok: true; scope: ClientEnvScopeRow[]; offboards: ClientOffboardView[]; cleanup: ClientCleanupReceipt[] }
  | { ok: false; reason: 'not_found' | 'unknown_environment' | 'env_already_assigned' |
      'cleanup_in_progress' | 'offboard_in_progress'; envKey?: string };

export type CreateProvisioningIntentResult =
  | { ok: true; intentId: string; proof: string; expiresAt: number }
  | { ok: false; reason: 'disabled' | 'schema_unavailable' };

export type CompleteProvisioningIntentResult =
  | { ok: true; environment: ClientEnvScopeRow; idempotent: boolean }
  | { ok: false; reason: 'disabled' | 'invalid_intent' | 'intent_expired' | 'intent_target_mismatch' |
      'invalid_environment' | 'environment_already_registered' | 'env_already_assigned' };

export interface ClientOffboardView {
  offboardId: string;
  envKey: string;
  accountId: string;
  state: 'pending_edge' | 'dispatched' | 'tombstoned' | 'purged';
  reason: 'environment_unbind' | 'customer_terminated' | 'admin_revoked';
  requestedAt: number;
  purgeDueAt: number;
}

export interface ClientCleanupHoldView {
  kind: 'binding_missing';
  revocationId: string;
  envKey: string;
  state: 'binding_missing';
  reason: 'customer_terminated' | 'admin_revoked';
  requestedAt: number;
}

export type ClientCleanupReceipt =
  | ClientCleanupHoldView
  | ({ kind: 'offboard_pending' } & ClientOffboardView);

export type BeginOffboardResult =
  | { ok: true; offboard: ClientOffboardView }
  | { ok: false; reason: 'disabled' | 'not_authorized' | 'offboard_binding_missing' };

export type InteractionScopeAuthorization<T> =
  | { ok: true; accountId: string; value: T }
  | { ok: false; reason: 'disabled' | 'not_authorized' };

function isMissingTable(err: unknown): boolean {
  return (err as { code?: string })?.code === '42P01';
}

const PROVISIONING_INTENT_TTL_MS = 10 * 60 * 1000;
const ENV_KEY_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const PROVISIONING_INTENT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROVISIONING_PROOF_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const PROVISIONING_PLATFORMS = new Set(['xiaohongshu', 'facebook', 'wechat_channels']);

function provisioningProofHash(proof: string): string {
  return crypto.createHash('sha256').update(proof, 'utf8').digest('hex');
}

function provisioningProofMatches(proof: string, expectedHash: string): boolean {
  const actual = Buffer.from(provisioningProofHash(proof), 'hex');
  const expected = Buffer.from(String(expectedHash || ''), 'hex');
  return actual.length === expected.length && actual.length > 0 && crypto.timingSafeEqual(actual, expected);
}

export interface ClientUserStoreOptions {
  pool?: pg.Pool;
}

export class ClientUserStore {
  private readonly pool: pg.Pool;

  constructor(options: ClientUserStoreOptions = {}) {
    this.pool = options.pool ?? new Pool(resolveEnvPgConfig());
  }

  private offboardReceipt(offboard: ClientOffboardView): ClientCleanupReceipt {
    return { kind: 'offboard_pending', ...offboard };
  }

  private async enqueueCleanupHold(
    client: pg.PoolClient,
    input: { userId: string; envKey: string; reason: ClientCleanupHoldView['reason']; actor: string | null },
  ): Promise<ClientCleanupHoldView> {
    const revocationId = crypto.randomUUID();
    const { rows } = await client.query<{
      revocation_id: string; env_key: string; reason: ClientCleanupHoldView['reason']; requested_at: Date;
    }>(
      `INSERT INTO client_env_revocation_holds
         (revocation_id,env_key,user_id,reason,revoked_by,requested_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,now(),now())
       ON CONFLICT (env_key) DO UPDATE
         SET updated_at=client_env_revocation_holds.updated_at
       RETURNING revocation_id,env_key,reason,requested_at`,
      [revocationId, input.envKey, input.userId, input.reason, input.actor],
    );
    const row = rows[0];
    if (!row) throw new Error('revocation_hold_insert_failed');
    return {
      kind: 'binding_missing', revocationId: row.revocation_id, envKey: row.env_key,
      state: 'binding_missing', reason: row.reason, requestedAt: row.requested_at.getTime(),
    };
  }

  private async enqueueOffboard(
    client: pg.PoolClient,
    input: { userId: string; envKey: string; accountId: string; reason: ClientOffboardView['reason']; actor: string | null },
  ): Promise<ClientOffboardView> {
    const offboardId = crypto.randomUUID();
    const inserted = await client.query<{
      offboard_id: string; env_key: string; account_id: string; state: ClientOffboardView['state'];
      reason: ClientOffboardView['reason']; requested_at: Date; purge_due_at: Date;
    }>(
      `INSERT INTO interaction_offboards
         (offboard_id,platform,account_id,env_key,user_id,reason,state,requested_at,purge_due_at,updated_at)
       VALUES ($1,'wechat_channels',$2,$3,$4,$5,'pending_edge',now(),now()+interval '29 days',now())
       ON CONFLICT (platform,env_key) WHERE state <> 'purged' DO UPDATE
         SET updated_at=interaction_offboards.updated_at
       RETURNING offboard_id,env_key,account_id,state,reason,requested_at,purge_due_at`,
      [offboardId, input.accountId, input.envKey, input.userId, input.reason],
    );
    const row = inserted.rows[0];
    if (!row || row.account_id !== input.accountId) throw new Error('offboard_scope_conflict');
    await client.query(
      `UPDATE interaction_runtime_controls SET comments_read_enabled=false,comments_reply_enabled=false,
          dm_read_enabled=false,dm_send_text_enabled=false,dm_send_image_enabled=false,write_paused=true,
          version=version+1,updated_at=now(),updated_by=$3
        WHERE platform='wechat_channels' AND account_id=$1 AND env_key=$2`,
      [input.accountId, input.envKey, input.actor ?? 'offboarding'],
    );
    await client.query(
      `UPDATE interaction_auth_state SET status='disabled',capabilities=$3::jsonb,
          reason_code='INTERACTION_FEATURE_DISABLED',checked_at=now(),updated_at=now()
        WHERE platform='wechat_channels' AND account_id=$1 AND env_key=$2`,
      [input.accountId, input.envKey, JSON.stringify({ commentsRead: false, commentsReply: false,
        dmRead: false, dmSendText: false, dmSendImage: false })],
    );
    await client.query(
      `INSERT INTO interaction_offboard_audit
         (event_id,offboard_id,platform,account_id,env_key,user_id,event,status)
       VALUES ($1,$2,'wechat_channels',$3,$4,$5,'access_revoked','pending_edge')`,
      [crypto.randomUUID(), row.offboard_id, input.accountId, input.envKey, input.userId],
    );
    return { offboardId: row.offboard_id, envKey: row.env_key, accountId: row.account_id,
      state: row.state, reason: row.reason, requestedAt: row.requested_at.getTime(), purgeDueAt: row.purge_due_at.getTime() };
  }

  /**
   * A provisioned environment that never acquired an interaction binding has no
   * Cloud/Edge interaction credential scope to drain. Persist an explicit terminal
   * offboard before revoking ownership so Electron can still require authoritative
   * Cloud truth before deleting the physical profile.
   *
   * accountId uses the environment's reserved account namespace. This does not
   * create an account or auth binding, and tombstoned rows are never dispatched.
   */
  private async enqueueProvisionedUnboundOffboard(
    client: pg.PoolClient,
    input: { userId: string; envKey: string },
  ): Promise<ClientOffboardView> {
    const offboardId = crypto.randomUUID();
    const accountId = input.envKey;
    const inserted = await client.query<{
      offboard_id: string; env_key: string; account_id: string; state: ClientOffboardView['state'];
      reason: ClientOffboardView['reason']; requested_at: Date; purge_due_at: Date;
    }>(
      `INSERT INTO interaction_offboards
       (offboard_id,platform,account_id,env_key,user_id,reason,state,requested_at,
          tombstoned_at,purge_due_at,updated_at)
       VALUES ($1,'wechat_channels',$2,$3,$4,'environment_unbind','tombstoned',now(),now(),now()+interval '29 days',now())
       RETURNING offboard_id,env_key,account_id,state,reason,requested_at,purge_due_at`,
      [offboardId, accountId, input.envKey, input.userId],
    );
    const row = inserted.rows[0];
    if (!row) throw new Error('offboard_terminal_insert_failed');
    await client.query(
      `INSERT INTO interaction_offboard_audit
         (event_id,offboard_id,platform,account_id,env_key,user_id,event,status)
       VALUES
         ($1,$3,'wechat_channels',$4,$5,$6,'access_revoked','tombstoned'),
         ($2,$3,'wechat_channels',$4,$5,$6,'unbound_cleanup_not_required','tombstoned')`,
      [crypto.randomUUID(), crypto.randomUUID(), row.offboard_id, accountId, input.envKey, input.userId],
    );
    return { offboardId: row.offboard_id, envKey: row.env_key, accountId: row.account_id,
      state: row.state, reason: row.reason, requestedAt: row.requested_at.getTime(), purgeDueAt: row.purge_due_at.getTime() };
  }

  /** Customer-authorized relinquish: revoke scope and stop Cloud sync/write in the same transaction as durable offboard creation. */
  async beginEnvironmentOffboard(userId: string, envKey: string): Promise<BeginOffboardResult> {
    const key = (envKey ?? '').trim();
    if (!userId || !key) return { ok: false, reason: 'not_authorized' };
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const user = await client.query<{ status: string }>(
        `SELECT status FROM client_users WHERE user_id=$1 FOR UPDATE`, [userId],
      );
      if (user.rows[0]?.status !== 'enabled') {
        await client.query('ROLLBACK');
        return { ok: false, reason: user.rows[0] ? 'disabled' : 'not_authorized' };
      }
      // Serialize first-auth status creation with unbind for the same environment.
      // Without this lock, an auth row could race in after the no-binding check.
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [`interaction-env:${key}`]);
      const scope = await client.query<{ label: string | null; platform: string | null;
        source: string; assigned_by: string | null; assigned_at: Date }>(
        `SELECT s.label,s.platform,s.source,s.assigned_by,s.assigned_at
           FROM client_env_scope s
           JOIN client_environments e ON e.env_key=s.env_key AND e.platform='wechat_channels'
          WHERE s.user_id=$1 AND s.env_key=$2 AND s.source='admin'
          FOR UPDATE OF s,e`, [userId, key],
      );
      const row = scope.rows[0];
      if (!row) {
        const owned = await client.query(`SELECT 1 FROM client_env_scope WHERE user_id=$1 AND env_key=$2`, [userId, key]);
        await client.query('ROLLBACK');
        return { ok: false, reason: owned.rows[0] ? 'offboard_binding_missing' : 'not_authorized' };
      }
      const binding = await client.query<{ account_id: string }>(
        `SELECT account_id FROM interaction_auth_state
          WHERE env_key=$1 AND platform='wechat_channels' FOR UPDATE`, [key],
      );
      let offboard: ClientOffboardView;
      if (binding.rows[0]) {
        offboard = await this.enqueueOffboard(client, { userId, envKey: key, accountId: binding.rows[0].account_id,
          reason: 'environment_unbind', actor: `client:${userId}` });
      } else {
        // Only the original continuous client-provision grant may use the no-binding terminal path.
        // A legacy/admin grant with a missing binding remains fail-closed so corruption is not hidden.
        const provisioned = await client.query(
          `SELECT 1 FROM client_env_provisioning_intents i
            WHERE i.user_id=$1 AND i.completed_env_key=$2 AND i.state='completed'
              AND $3='client-provision:' || i.intent_id::text
            FOR UPDATE`,
          [userId, key, row.assigned_by],
        );
        if (!provisioned.rows[0]) {
          await client.query('ROLLBACK');
          return { ok: false, reason: 'offboard_binding_missing' };
        }
        offboard = await this.enqueueProvisionedUnboundOffboard(client, { userId, envKey: key });
      }
      await client.query(
        `INSERT INTO client_env_scope_audit
           (user_id,env_key,label,platform,source,assigned_by,assigned_at,revoked_at,revoked_by,reason)
         VALUES ($1,$2,$3,$4,$5,$6,$7,now(),$8,'environment_unbind')
         ON CONFLICT (user_id,env_key,assigned_at,reason) DO NOTHING`,
        [userId, key, row.label, row.platform, row.source, row.assigned_by, row.assigned_at, `client:${userId}`],
      );
      await client.query(`DELETE FROM client_env_scope WHERE user_id=$1 AND env_key=$2 AND source='admin'`, [userId, key]);
      await client.query('COMMIT');
      return { ok: true, offboard };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  async getOffboard(userId: string, offboardId: string): Promise<ClientOffboardView | null> {
    const { rows } = await this.pool.query<{
      offboard_id: string; env_key: string; account_id: string; state: ClientOffboardView['state'];
      reason: ClientOffboardView['reason']; requested_at: Date; purge_due_at: Date;
    }>(`SELECT offboard_id,env_key,account_id,state,reason,requested_at,purge_due_at
          FROM interaction_offboards WHERE offboard_id=$1 AND user_id=$2`, [offboardId, userId]);
    const row = rows[0];
    return row ? { offboardId: row.offboard_id, envKey: row.env_key, accountId: row.account_id,
      state: row.state, reason: row.reason, requestedAt: row.requested_at.getTime(), purgeDueAt: row.purge_due_at.getTime() } : null;
  }

  async init(): Promise<void> {
    await this.pool.query(CLIENT_USERS_SCHEMA_SQL);
  }

  // ── 鉴权侧（供 client-auth-server；fail-closed）──────────────────────────

  /**
   * 校验 name+key 登录。命中且 enabled 且 key 对 → { ok, userId }。
   * name 未命中 / 停用 / key 错 → **跑一次 decoyVerify 抹平时延** → { ok:false }（不可区分）。
   * 缺表（首启竞态）→ decoy + false（fail-closed）。
   */
  async verifyLogin(name: string, key: string): Promise<{ ok: true; userId: string } | { ok: false }> {
    const trimmed = (name ?? '').trim();
    try {
      const { rows } = await this.pool.query<{
        user_id: string;
        key_hash: string;
        key_salt: string;
        status: string;
      }>(`SELECT user_id, key_hash, key_salt, status FROM client_users WHERE name = $1`, [trimmed]);
      const row = rows[0];
      if (!row || row.status !== 'enabled') {
        decoyVerify(key); // 抹平「不存在 / 停用」与「key 错」的时延差
        return { ok: false };
      }
      if (!verifyKey(key ?? '', row.key_hash, row.key_salt)) return { ok: false };
      return { ok: true, userId: row.user_id };
    } catch (err) {
      if (isMissingTable(err)) {
        decoyVerify(key);
        return { ok: false };
      }
      throw err;
    }
  }

  /** 该客户当前是否启用（N3：每请求回库复核；缺表 / 无行 → false，fail-closed）。 */
  async isEnabled(userId: string): Promise<boolean> {
    try {
      const { rows } = await this.pool.query<{ status: string }>(
        `SELECT status FROM client_users WHERE user_id = $1`,
        [userId],
      );
      return rows[0]?.status === 'enabled';
    } catch (err) {
      if (isMissingTable(err)) return false;
      throw err;
    }
  }

  /** 某客户可见环境清单。只返回内部管理员授予且未撤销的权威归属；缺表 → 空。 */
  async listEnvScope(userId: string): Promise<ClientEnvScopeRow[]> {
    try {
      const { rows } = await this.pool.query<{
        env_key: string;
        label: string | null;
        platform: string | null;
        source: string;
        assigned_at: Date;
      }>(
        `SELECT env_key, label, platform, source, assigned_at
         FROM client_env_scope
         WHERE user_id = $1 AND source = 'admin'
         ORDER BY assigned_at ASC`,
        [userId],
      );
      return rows.map((r) => ({
        envKey: r.env_key,
        label: r.label,
        platform: r.platform,
        source: 'admin',
        assignedAt: r.assigned_at.getTime(),
      }));
    } catch (err) {
      if (isMissingTable(err)) return [];
      throw err;
    }
  }

  /**
   * 为当前 enabled 客户签发一个 10 分钟、一次性的程序化建号意图。proof 只回显本次，
   * 数据库只存 hash；过期 pending 行 opportunistic 标 expired，不删除 completed 审计真态。
   */
  async createProvisioningIntent(userId: string): Promise<CreateProvisioningIntentResult> {
    if (!userId) return { ok: false, reason: 'disabled' };
    const intentId = crypto.randomUUID();
    const proof = crypto.randomBytes(32).toString('base64url');
    const proofHash = provisioningProofHash(proof);
    try {
      await this.pool.query(
        `UPDATE client_env_provisioning_intents
            SET state='expired'
          WHERE state='pending' AND expires_at <= now()`,
      );
      const { rows } = await this.pool.query<{ expires_at: Date }>(
        `INSERT INTO client_env_provisioning_intents
           (intent_id,user_id,proof_hash,state,expires_at,created_at)
         SELECT $1,u.user_id,$2,'pending',now()+($3::double precision * interval '1 millisecond'),now()
           FROM client_users u
          WHERE u.user_id=$4 AND u.status='enabled'
         RETURNING expires_at`,
        [intentId, proofHash, PROVISIONING_INTENT_TTL_MS, userId],
      );
      if (!rows[0]) return { ok: false, reason: 'disabled' };
      return { ok: true, intentId, proof, expiresAt: rows[0].expires_at.getTime() };
    } catch (error) {
      if (isMissingTable(error)) return { ok: false, reason: 'schema_unavailable' };
      throw error;
    }
  }

  /**
   * Cloud 权威完成“本次程序化新建”：锁 user+intent，核 proof/TTL，再在同一事务中登记
   * 从未出现过的 envKey、写入唯一 active owner、标记 intent completed。任何拒绝均不部分落库。
   */
  async completeProvisioningIntent(
    userId: string,
    input: { intentId: string; proof: string; envKey: string; label?: string | null; platform?: string | null },
  ): Promise<CompleteProvisioningIntentResult> {
    const intentId = String(input.intentId || '').trim();
    const proof = String(input.proof || '');
    const envKey = String(input.envKey || '').trim();
    const label = String(input.label || '').trim().slice(0, 256) || null;
    const platformText = String(input.platform || '').trim().toLowerCase();
    const platform = PROVISIONING_PLATFORMS.has(platformText) ? platformText : null;
    if (!userId) return { ok: false, reason: 'disabled' };
    if (!PROVISIONING_INTENT_ID_PATTERN.test(intentId) || !PROVISIONING_PROOF_PATTERN.test(proof)) {
      return { ok: false, reason: 'invalid_intent' };
    }
    if (!ENV_KEY_PATTERN.test(envKey) || !platform) {
      return { ok: false, reason: 'invalid_environment' };
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const user = await client.query<{ status: string }>(
        `SELECT status FROM client_users WHERE user_id=$1 FOR UPDATE`, [userId],
      );
      if (user.rows[0]?.status !== 'enabled') {
        await client.query('ROLLBACK');
        return { ok: false, reason: 'disabled' };
      }
      const intentResult = await client.query<{
        proof_hash: string; state: 'pending' | 'completed' | 'expired'; expires_at: Date;
        completed_env_key: string | null; completed_at: Date | null;
      }>(
        `SELECT proof_hash,state,expires_at,completed_env_key,completed_at
           FROM client_env_provisioning_intents
          WHERE intent_id=$1 AND user_id=$2
          FOR UPDATE`,
        [intentId, userId],
      );
      const intent = intentResult.rows[0];
      if (!intent || !provisioningProofMatches(proof, intent.proof_hash)) {
        await client.query('ROLLBACK');
        return { ok: false, reason: 'invalid_intent' };
      }
      if (intent.state === 'completed') {
        if (intent.completed_env_key !== envKey) {
          await client.query('ROLLBACK');
          return { ok: false, reason: 'intent_target_mismatch' };
        }
        const existing = await client.query<{
          env_key: string; label: string | null; platform: string | null; assigned_at: Date;
        }>(
          `SELECT env_key,label,platform,assigned_at
             FROM client_env_scope
            WHERE user_id=$1 AND env_key=$2 AND source='admin'`,
          [userId, envKey],
        );
        await client.query('COMMIT');
        const row = existing.rows[0];
        if (!row) return { ok: false, reason: 'env_already_assigned' };
        return { ok: true, idempotent: true, environment: { envKey: row.env_key, label: row.label,
          platform: row.platform, source: 'admin', assignedAt: row.assigned_at.getTime() } };
      }
      if (intent.state === 'expired' || intent.expires_at.getTime() <= Date.now()) {
        await client.query(
          `UPDATE client_env_provisioning_intents SET state='expired'
            WHERE intent_id=$1 AND state='pending'`, [intentId],
        );
        await client.query('COMMIT');
        return { ok: false, reason: 'intent_expired' };
      }

      const registered = await client.query<{ env_key: string }>(
        `INSERT INTO client_environments (env_key,label,platform,source,created_at,updated_at)
         VALUES ($1,$2,$3,'auto',now(),now())
         ON CONFLICT (env_key) DO NOTHING
         RETURNING env_key`,
        [envKey, label, platform],
      );
      if (!registered.rows[0]) {
        await client.query('ROLLBACK');
        return { ok: false, reason: 'environment_already_registered' };
      }
      const assigned = await client.query<{
        env_key: string; label: string | null; platform: string | null; assigned_at: Date;
      }>(
        `INSERT INTO client_env_scope
           (user_id,env_key,label,platform,source,assigned_by,assigned_at)
         VALUES ($1,$2,$3,$4,'admin',$5,now())
         RETURNING env_key,label,platform,assigned_at`,
        [userId, envKey, label, platform, `client-provision:${intentId}`],
      );
      await client.query(
        `UPDATE client_env_provisioning_intents
            SET state='completed',completed_env_key=$2,completed_at=now()
          WHERE intent_id=$1 AND state='pending'`,
        [intentId, envKey],
      );
      await client.query('COMMIT');
      const row = assigned.rows[0];
      return { ok: true, idempotent: false, environment: { envKey: row.env_key, label: row.label,
        platform: row.platform, source: 'admin', assignedAt: row.assigned_at.getTime() } };
    } catch (error) {
      await client.query('ROLLBACK');
      if ((error as { code?: string; constraint?: string })?.code === '23505') {
        return { ok: false, reason: 'env_already_assigned' };
      }
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 客户是否显式拥有某环境。客户侧所有带 envKey 的业务请求必须先走这里；
   * 缺表、空参数或未归属一律 false，避免用全量环境列表做内存过滤而意外放宽权限。
   */
  async ownsEnv(userId: string, envKey: string): Promise<boolean> {
    const key = (envKey ?? '').trim();
    if (!userId || !key) return false;
    try {
      const { rows } = await this.pool.query<{ owned: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM client_env_scope
           WHERE user_id = $1 AND env_key = $2
             AND source = 'admin'
         ) AS owned`,
        [userId, key],
      );
      return rows[0]?.owned === true;
    } catch (err) {
      if (isMissingTable(err)) return false;
      throw err;
    }
  }

  /**
   * 在一个数据库事务和共享锁范围内校验客户 interaction 请求的完整边界：
   * enabled user + active authoritative env ownership + env/account/platform binding。
   * operation 在锁仍持有时执行，避免启停、换归属或账号重绑发生 TOCTOU。
   */
  async withAuthorizedInteractionScope<T>(
    userId: string,
    envKey: string,
    operation: (scope: { accountId: string }) => Promise<T>,
  ): Promise<InteractionScopeAuthorization<T>> {
    const key = (envKey ?? '').trim();
    if (!userId || !key) return { ok: false, reason: 'not_authorized' };
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const user = await client.query<{ status: string }>(
        `SELECT status FROM client_users WHERE user_id = $1 FOR SHARE`,
        [userId],
      );
      if (user.rows[0]?.status !== 'enabled') {
        await client.query('ROLLBACK');
        return { ok: false, reason: 'disabled' };
      }
      const binding = await client.query<{ account_id: string }>(
        `SELECT a.account_id
         FROM client_env_scope s
         JOIN client_environments e ON e.env_key = s.env_key
         JOIN interaction_auth_state a
           ON a.env_key = s.env_key AND a.platform = e.platform
         JOIN accounts acc
           ON acc.account_id = a.account_id AND acc.platform = a.platform
         WHERE s.user_id = $1 AND s.env_key = $2
           AND s.source = 'admin'
         FOR SHARE OF s, e, a, acc`,
        [userId, key],
      );
      const accountId = binding.rows[0]?.account_id;
      if (!accountId) {
        await client.query('ROLLBACK');
        return { ok: false, reason: 'not_authorized' };
      }
      const value = await operation({ accountId });
      await client.query('COMMIT');
      return { ok: true, accountId, value };
    } catch (err) {
      await client.query('ROLLBACK');
      if (isMissingTable(err)) return { ok: false, reason: 'not_authorized' };
      throw err;
    } finally {
      client.release();
    }
  }

  // ── 管理侧（供 panel /api/client-users*；受内部 JWT）────────────────────

  private async viewOf(userId: string): Promise<ClientUserView | null> {
    const { rows } = await this.pool.query<{
      user_id: string;
      name: string;
      status: string;
      rotated_at: Date | null;
      created_at: Date;
      updated_at: Date;
      env_count: string;
    }>(
      `SELECT u.user_id, u.name, u.status, u.rotated_at, u.created_at, u.updated_at,
              (SELECT count(*) FROM client_env_scope s
               WHERE s.user_id = u.user_id AND s.source = 'admin') AS env_count
       FROM client_users u WHERE u.user_id = $1`,
      [userId],
    );
    const r = rows[0];
    if (!r) return null;
    return {
      userId: r.user_id,
      name: r.name,
      status: r.status === 'disabled' ? 'disabled' : 'enabled',
      envCount: Number(r.env_count),
      rotatedAt: r.rotated_at ? r.rotated_at.getTime() : null,
      createdAt: r.created_at.getTime(),
      updatedAt: r.updated_at.getTime(),
    };
  }

  /** 列全部客户（**绝不含 key/hash**）；缺表回落空。 */
  async listUsers(): Promise<ClientUserView[]> {
    try {
      const { rows } = await this.pool.query<{ user_id: string }>(
        `SELECT user_id FROM client_users ORDER BY created_at ASC`,
      );
      const views: ClientUserView[] = [];
      for (const r of rows) {
        const v = await this.viewOf(r.user_id);
        if (v) views.push(v);
      }
      return views;
    } catch (err) {
      if (isMissingTable(err)) return [];
      throw err;
    }
  }

  /** 创建客户：生成明文 key（一次性回显）+ 落 hash；name 空 → invalid_name，重名 → name_taken。 */
  async createUser(name: string, createdBy: string | null): Promise<CreateUserResult> {
    const trimmed = (name ?? '').trim();
    if (!trimmed || trimmed.length > 64) return { ok: false, reason: 'invalid_name' };
    void createdBy; // 审计留缝：client_users 暂不存 created_by（YAGNI，需要时加列）
    const existing = await this.pool.query(`SELECT 1 FROM client_users WHERE name = $1`, [trimmed]);
    if (existing.rows.length > 0) return { ok: false, reason: 'name_taken' };
    const userId = crypto.randomUUID();
    const plainKey = generateKey();
    const { hash, salt } = hashKey(plainKey);
    try {
      await this.pool.query(
        `INSERT INTO client_users (user_id, name, key_hash, key_salt, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'enabled', now(), now())`,
        [userId, trimmed, hash, salt],
      );
    } catch (err) {
      // UNIQUE(name) 竞态兜底
      if ((err as { code?: string })?.code === '23505') return { ok: false, reason: 'name_taken' };
      throw err;
    }
    const user = await this.viewOf(userId);
    return { ok: true, user: user!, plainKey };
  }

  /** 改名 / 启停（补丁式，未传字段不动）。 */
  async updateUser(
    userId: string,
    patch: { name?: string; status?: 'enabled' | 'disabled' },
    updatedBy: string | null,
  ): Promise<MutateUserResult> {
    const offboards: ClientOffboardView[] = [];
    const cleanup: ClientCleanupReceipt[] = [];
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const locked = await client.query<{ name: string; status: 'enabled' | 'disabled' }>(
        `SELECT name,status FROM client_users WHERE user_id=$1 FOR UPDATE`, [userId],
      );
      const current = locked.rows[0];
      if (!current) {
        await client.query('ROLLBACK');
        return { ok: false, reason: 'not_found' };
      }
      let name = current.name;
      if (patch.name !== undefined) {
        const trimmed = patch.name.trim();
        if (!trimmed || trimmed.length > 64) {
          await client.query('ROLLBACK');
          return { ok: false, reason: 'invalid_name' };
        }
        const duplicate = await client.query(`SELECT 1 FROM client_users WHERE name=$1 AND user_id<>$2`, [trimmed, userId]);
        if (duplicate.rows[0]) {
          await client.query('ROLLBACK');
          return { ok: false, reason: 'name_taken' };
        }
        name = trimmed;
      }
      const status = patch.status ?? current.status;
      if (current.status === 'enabled' && status === 'disabled') {
        const scopes = await client.query<{
          env_key: string; label: string | null; platform: string | null; source: string;
          assigned_by: string | null; assigned_at: Date; registry_platform: string | null;
        }>(`SELECT s.env_key,s.label,s.platform,s.source,s.assigned_by,s.assigned_at,
                   e.platform AS registry_platform
              FROM client_env_scope s
              LEFT JOIN client_environments e ON e.env_key=s.env_key
             WHERE s.user_id=$1 AND s.source='admin' FOR UPDATE OF s`, [userId]);
        for (const envKey of scopes.rows.map((scope) => scope.env_key).sort()) {
          await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [`interaction-env:${envKey}`]);
        }
        for (const scope of scopes.rows) {
          if (scope.platform !== 'wechat_channels' && scope.registry_platform !== 'wechat_channels') continue;
          const binding = await client.query<{ account_id: string }>(
            `SELECT account_id FROM interaction_auth_state
              WHERE env_key=$1 AND platform='wechat_channels' FOR UPDATE`, [scope.env_key],
          );
          if (!binding.rows[0]) {
            cleanup.push(await this.enqueueCleanupHold(client, { userId, envKey: scope.env_key,
              reason: 'customer_terminated', actor: updatedBy }));
            continue;
          }
          const offboard = await this.enqueueOffboard(client, { userId, envKey: scope.env_key,
            accountId: binding.rows[0].account_id, reason: 'customer_terminated', actor: updatedBy });
          offboards.push(offboard);
          cleanup.push(this.offboardReceipt(offboard));
        }
        await client.query(
          `INSERT INTO client_env_scope_audit
             (user_id,env_key,label,platform,source,assigned_by,assigned_at,revoked_at,revoked_by,reason)
           SELECT user_id,env_key,label,platform,source,assigned_by,assigned_at,now(),$2,'customer_terminated'
             FROM client_env_scope WHERE user_id=$1 AND source='admin'
           ON CONFLICT (user_id,env_key,assigned_at,reason) DO NOTHING`, [userId, updatedBy],
        );
        await client.query(`DELETE FROM client_env_scope WHERE user_id=$1 AND source='admin'`, [userId]);
      }
      await client.query(`UPDATE client_users SET name=$2,status=$3,updated_at=now() WHERE user_id=$1`,
        [userId, name, status]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      if ((error as { code?: string })?.code === '23505') return { ok: false, reason: 'name_taken' };
      throw error;
    } finally { client.release(); }
    const user = await this.viewOf(userId);
    return { ok: true, user: user!, offboards, cleanup };
  }

  /** 轮换 key：换 hash+盐、bump rotated_at；旧 key 立即失效，回显一次新明文。 */
  async rotateKey(userId: string): Promise<RotateKeyResult> {
    const plainKey = generateKey();
    const { hash, salt } = hashKey(plainKey);
    const { rowCount } = await this.pool.query(
      `UPDATE client_users SET key_hash = $2, key_salt = $3, rotated_at = now(), updated_at = now() WHERE user_id = $1`,
      [userId, hash, salt],
    );
    if (!rowCount) return { ok: false, reason: 'not_found' };
    return { ok: true, plainKey };
  }

  /** 读某客户归属（管理端）。 */
  async getScope(userId: string): Promise<ClientEnvScopeRow[]> {
    return this.listEnvScope(userId);
  }

  /**
   * 批量登记环境进管理侧注册表（change client-user-env-registry）。**不涉及归属**——只是让环境「被系统认识」，
   * 从而出现在后台「待分配」池里供人工分配。用于：① 一次性导入存量环境（source='import'）；
   * ② 边缘一连上来自动登记（source='auto'，见 server.ts onEdgeRegistered）；③ 后台手动登记（source='admin'）。
   *
   * 幂等 upsert：已存在则只用**非空**新值补 label/platform（COALESCE，不拿 null 覆盖既有好值）、bump updated_at；
   * source 只在首次插入时定，冲突不降级。envKey 去空白 + 去重；空 envKey 跳过。返回实际写入的去重条数。
   * **不做任何归属推断**——绝不误把环境塞给某个客户（fail-closed 归属边界不破）。
   */
  async registerEnvironments(
    items: { envKey: string; label?: string | null; platform?: string | null }[],
    source: 'import' | 'auto' | 'admin' = 'import',
  ): Promise<number> {
    const seen = new Set<string>();
    const clean = items
      .map((i) => ({
        envKey: (i.envKey ?? '').trim(),
        label: (i.label ?? '')?.toString().trim() || null,
        platform: (i.platform ?? '')?.toString().trim() || null,
      }))
      .filter((i) => i.envKey && !seen.has(i.envKey) && (seen.add(i.envKey), true));
    if (!clean.length) return 0;
    for (const i of clean) {
      await this.pool.query(
        `INSERT INTO client_environments (env_key, label, platform, source, created_at, updated_at)
         VALUES ($1, $2, $3, $4, now(), now())
         ON CONFLICT (env_key) DO UPDATE
           SET label = COALESCE(EXCLUDED.label, client_environments.label),
               platform = COALESCE(EXCLUDED.platform, client_environments.platform),
               updated_at = now()`,
        [i.envKey, i.label, i.platform, source],
      );
    }
    return clean.length;
  }

  /**
   * 管理侧全局环境注册表：系统已知的全部环境 + 每个环境被归属到的客户清单（含名）+ 归属人数。
   * 环境全集 = 注册表 `client_environments` ∪ 已归属 `client_env_scope`（并集）——故**未分配给任何人的环境也会列出**
   * （assigneeCount=0），这正是后台「待分配」池要的。label/platform 优先取归属行的最新非空值，回落注册表登记值。
   *
   * **红线（N2）**：这是**跨用户聚合**读，与「客户可达读只有吃 userId 的 scoped 方法」直接冲突——
   * **只准接入受内部 JWT 的 panel 端点（GET /api/client-environments），绝不注入 client-auth-server**，
   * 否则客户可拿到跨客户归属、结构性泄漏。缺表（首启竞态）fail-closed 回落空数组。
   */
  async listAllEnvironments(): Promise<ClientEnvironmentView[]> {
    try {
      const { rows } = await this.pool.query<{
        env_key: string;
        label: string | null;
        platform: string | null;
        assignees: { userId: string; name: string }[] | null;
        hold_id: string | null;
        hold_reason: ClientCleanupHoldView['reason'] | null;
        hold_requested_at: Date | null;
        offboard_id: string | null;
        offboard_account_id: string | null;
        offboard_state: ClientOffboardView['state'] | null;
        offboard_reason: ClientOffboardView['reason'] | null;
        offboard_requested_at: Date | null;
        offboard_purge_due_at: Date | null;
      }>(
        `WITH keys AS (
           SELECT env_key FROM client_environments
           UNION
           SELECT env_key FROM client_env_scope
           UNION
           SELECT env_key FROM client_env_revocation_holds
           UNION
           SELECT env_key FROM interaction_offboards WHERE platform='wechat_channels' AND state <> 'purged'
         )
         SELECT k.env_key,
                COALESCE(
                  (array_agg(s.label ORDER BY s.assigned_at DESC) FILTER (WHERE s.label IS NOT NULL))[1],
                  max(e.label)
                ) AS label,
                COALESCE(
                  (array_agg(s.platform ORDER BY s.assigned_at DESC) FILTER (WHERE s.platform IS NOT NULL))[1],
                  max(e.platform)
                ) AS platform,
                json_agg(json_build_object('userId', u.user_id, 'name', u.name) ORDER BY u.name)
                  FILTER (WHERE u.user_id IS NOT NULL) AS assignees,
                h.revocation_id AS hold_id,h.reason AS hold_reason,h.requested_at AS hold_requested_at,
                o.offboard_id,o.account_id AS offboard_account_id,o.state AS offboard_state,
                o.reason AS offboard_reason,o.requested_at AS offboard_requested_at,
                o.purge_due_at AS offboard_purge_due_at
         FROM keys k
         LEFT JOIN client_environments e ON e.env_key = k.env_key
         LEFT JOIN client_env_scope s
           ON s.env_key = k.env_key AND s.source = 'admin'
         LEFT JOIN client_users u ON u.user_id = s.user_id
         LEFT JOIN client_env_revocation_holds h ON h.env_key = k.env_key
         LEFT JOIN interaction_offboards o
           ON o.env_key = k.env_key AND o.platform='wechat_channels' AND o.state <> 'purged'
         GROUP BY k.env_key,h.revocation_id,h.reason,h.requested_at,
                  o.offboard_id,o.account_id,o.state,o.reason,o.requested_at,o.purge_due_at
         ORDER BY k.env_key ASC`,
      );
      return rows.map((r) => {
        const assignees = (r.assignees ?? []).map((a) => ({ userId: a.userId, name: a.name }));
        const cleanup: ClientCleanupReceipt | null = r.hold_id && r.hold_reason && r.hold_requested_at
          ? {
              kind: 'binding_missing', revocationId: r.hold_id, envKey: r.env_key,
              state: 'binding_missing', reason: r.hold_reason, requestedAt: r.hold_requested_at.getTime(),
            }
          : r.offboard_id && r.offboard_account_id && r.offboard_state && r.offboard_reason &&
              r.offboard_requested_at && r.offboard_purge_due_at
            ? {
                kind: 'offboard_pending', offboardId: r.offboard_id, envKey: r.env_key,
                accountId: r.offboard_account_id, state: r.offboard_state, reason: r.offboard_reason,
                requestedAt: r.offboard_requested_at.getTime(), purgeDueAt: r.offboard_purge_due_at.getTime(),
              }
            : null;
        return {
          envKey: r.env_key,
          label: r.label,
          platform: r.platform,
          assignees,
          assigneeCount: assignees.length,
          cleanup,
        };
      });
    } catch (err) {
      if (isMissingTable(err)) return [];
      throw err;
    }
  }

  /**
   * 整批替换某客户归属。只接受权威注册表已有环境；label/platform 从注册表读取，
   * 不信任调用者提交的元数据。事务锁住 user + registry + active grants，保证一个环境
   * 只有一个 active owner，且不会与客户 interaction 请求发生 TOCTOU。
   */
  async setScope(
    userId: string,
    items: { envKey: string; label?: string | null; platform?: string | null }[],
    assignedBy: string | null,
  ): Promise<SetScopeResult> {
    const offboards: ClientOffboardView[] = [];
    const cleanup: ClientCleanupReceipt[] = [];
    const seen = new Set<string>();
    const clean = items
      .map((i) => (i.envKey ?? '').trim())
      .filter((envKey) => envKey && !seen.has(envKey) && (seen.add(envKey), true))
      .sort();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const user = await client.query(`SELECT 1 FROM client_users WHERE user_id = $1 FOR UPDATE`, [userId]);
      if (user.rows.length === 0) {
        await client.query('ROLLBACK');
        return { ok: false, reason: 'not_found' };
      }
      const current = await client.query<{
        env_key: string; label: string | null; platform: string | null; source: string;
        assigned_by: string | null; assigned_at: Date;
      }>(`SELECT env_key,label,platform,source,assigned_by,assigned_at
            FROM client_env_scope WHERE user_id=$1 AND source='admin' FOR UPDATE`, [userId]);
      const affectedEnvKeys = [...new Set([...current.rows.map((row) => row.env_key), ...clean])].sort();
      for (const envKey of affectedEnvKeys) {
        await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [`interaction-env:${envKey}`]);
      }
      const registered = clean.length
        ? await client.query<{ env_key: string; label: string | null; platform: string | null }>(
            `SELECT env_key, label, platform FROM client_environments
             WHERE env_key = ANY($1::text[]) ORDER BY env_key FOR UPDATE`,
            [clean],
          )
        : { rows: [] };
      const registeredByKey = new Map(registered.rows.map((row) => [row.env_key, row]));
      const unknown = clean.find((envKey) => !registeredByKey.has(envKey));
      if (unknown) {
        await client.query('ROLLBACK');
        return { ok: false, reason: 'unknown_environment', envKey: unknown };
      }
      if (clean.length) {
        const held = await client.query<{ env_key: string }>(
          `SELECT env_key FROM client_env_revocation_holds
            WHERE env_key=ANY($1::text[]) ORDER BY env_key LIMIT 1 FOR UPDATE`, [clean],
        );
        if (held.rows[0]) {
          await client.query('ROLLBACK');
          return { ok: false, reason: 'cleanup_in_progress', envKey: held.rows[0].env_key };
        }
        const purging = await client.query<{ env_key: string }>(
          `SELECT env_key FROM interaction_offboards
            WHERE env_key=ANY($1::text[]) AND platform='wechat_channels' AND state <> 'purged'
            ORDER BY env_key LIMIT 1 FOR UPDATE`, [clean],
        );
        if (purging.rows[0]) {
          await client.query('ROLLBACK');
          return { ok: false, reason: 'offboard_in_progress', envKey: purging.rows[0].env_key };
        }
        const conflict = await client.query<{ env_key: string }>(
          `SELECT env_key FROM client_env_scope
           WHERE env_key = ANY($1::text[]) AND user_id <> $2
             AND source = 'admin'
           ORDER BY env_key LIMIT 1 FOR UPDATE`,
          [clean, userId],
        );
        if (conflict.rows[0]) {
          await client.query('ROLLBACK');
          return { ok: false, reason: 'env_already_assigned', envKey: conflict.rows[0].env_key };
        }
      }
      const removed = current.rows.filter((row) => !clean.includes(row.env_key));
      for (const row of removed) {
        const registry = registeredByKey.get(row.env_key) ?? (await client.query<{ env_key: string; platform: string | null }>(
          `SELECT env_key,platform FROM client_environments WHERE env_key=$1 FOR UPDATE`, [row.env_key],
        )).rows[0];
        if (registry?.platform !== 'wechat_channels' && row.platform !== 'wechat_channels') continue;
        const binding = await client.query<{ account_id: string }>(
          `SELECT account_id FROM interaction_auth_state
            WHERE platform='wechat_channels' AND env_key=$1 FOR UPDATE`, [row.env_key],
        );
        if (!binding.rows[0]) {
          cleanup.push(await this.enqueueCleanupHold(client, { userId, envKey: row.env_key,
            reason: 'admin_revoked', actor: assignedBy }));
          continue;
        }
        const offboard = await this.enqueueOffboard(client, { userId, envKey: row.env_key,
          accountId: binding.rows[0].account_id, reason: 'admin_revoked', actor: assignedBy });
        offboards.push(offboard);
        cleanup.push(this.offboardReceipt(offboard));
      }
      await client.query(
        `INSERT INTO client_env_scope_audit
           (user_id, env_key, label, platform, source, assigned_by, assigned_at,
            revoked_at, revoked_by, reason)
         SELECT user_id, env_key, label, platform, source, assigned_by, assigned_at,
                now(), $2, CASE WHEN env_key = ANY($3::text[]) THEN 'scope_replaced' ELSE 'admin_revoked' END
         FROM client_env_scope WHERE user_id = $1 AND source = 'admin'
         ON CONFLICT (user_id, env_key, assigned_at, reason) DO NOTHING`,
        [userId, assignedBy, clean],
      );
      await client.query(`DELETE FROM client_env_scope WHERE user_id = $1 AND source = 'admin'`, [userId]);
      for (const envKey of clean) {
        const environment = registeredByKey.get(envKey)!;
        await client.query(
          `INSERT INTO client_env_scope
             (user_id, env_key, label, platform, source, assigned_by, assigned_at)
           VALUES ($1, $2, $3, $4, 'admin', $5, now())
           ON CONFLICT (user_id, env_key) DO UPDATE
             SET label = EXCLUDED.label,
                 platform = EXCLUDED.platform,
                 source = 'admin',
                 assigned_by = EXCLUDED.assigned_by,
                 assigned_at = now()`,
          [userId, envKey, environment.label, environment.platform, assignedBy],
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      if ((err as { code?: string; constraint?: string })?.code === '23505' &&
          (err as { constraint?: string })?.constraint === 'uq_client_env_scope_active_env') {
        return { ok: false, reason: 'env_already_assigned' };
      }
      if ((err as { code?: string; constraint?: string })?.code === '23514' &&
          (err as { constraint?: string })?.constraint === 'client_env_scope_cleanup_hold') {
        return { ok: false, reason: 'cleanup_in_progress' };
      }
      throw err;
    } finally {
      client.release();
    }
    return { ok: true, scope: await this.listEnvScope(userId), offboards, cleanup };
  }

  /**
   * A late auth status supplies the exact accountId that an access-first admin revocation lacked.
   * Materialize those holds into the existing offboard lifecycle; callers dispatch returned rows
   * through InteractionOffboardingService, keeping this store the only DB writer.
   */
  async reconcileRevocationHolds(limit = 50): Promise<ClientOffboardView[]> {
    const boundedLimit = Math.max(1, Math.min(200, Math.trunc(limit) || 50));
    const { rows: candidates } = await this.pool.query<{ env_key: string }>(
      `SELECT h.env_key
         FROM client_env_revocation_holds h
         JOIN interaction_auth_state a ON a.env_key=h.env_key AND a.platform='wechat_channels'
        ORDER BY h.requested_at,h.env_key LIMIT $1`, [boundedLimit],
    );
    const offboards: ClientOffboardView[] = [];
    for (const candidate of candidates) {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,
          [`interaction-env:${candidate.env_key}`]);
        const { rows } = await client.query<{
          revocation_id: string; env_key: string; user_id: string;
          reason: ClientCleanupHoldView['reason']; revoked_by: string | null; account_id: string;
        }>(
          `SELECT h.revocation_id,h.env_key,h.user_id,h.reason,h.revoked_by,a.account_id
             FROM client_env_revocation_holds h
             JOIN interaction_auth_state a ON a.env_key=h.env_key AND a.platform='wechat_channels'
            WHERE h.env_key=$1 FOR UPDATE OF h,a`, [candidate.env_key],
        );
        const row = rows[0];
        if (!row) {
          await client.query('COMMIT');
          continue;
        }
        const offboard = await this.enqueueOffboard(client, {
          userId: row.user_id, envKey: row.env_key, accountId: row.account_id,
          reason: row.reason, actor: row.revoked_by,
        });
        await client.query(`DELETE FROM client_env_revocation_holds WHERE revocation_id=$1`, [row.revocation_id]);
        await client.query('COMMIT');
        offboards.push(offboard);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    }
    return offboards;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
