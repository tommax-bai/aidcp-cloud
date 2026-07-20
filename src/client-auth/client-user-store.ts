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
import { RETIRED_ACCOUNT_ID } from '../account-store.js';
import { shanghaiDayStartMs } from '../time/shanghai-day.js';
import { resolveAccountDisplayName } from '../account-display-name.js';

const { Pool } = pg;

/**
 * 环境→账号绑定解析结果（change curated-envkey-account-binding）。
 *
 * **MUST 为判别式，MUST NOT 为 `string | null`**——null 会立刻退化回「不知道为什么，就当没有数据」，
 * 正是本 change 修的那个红线。四种不可解析各自诚实回报且**互相可区分**：
 * - environment_not_owned：该环境不归属该客户（403）
 * - binding_unknown：该环境尚未上报过登录账号 / 悬空绑定（accounts 无此行）→ 日常态（409），连一次云端即自愈
 * - binding_conflict：跨客户争用，fail-closed → **安全事件**（409，与 binding_unknown 分码，绝不埋进噪声）
 * - binding_unavailable：注册表读不到（缺表 42P01）（503）
 */
export type ResolvedBinding =
  | { ok: true; accountId: string }
  | { ok: false; reason: 'environment_not_owned' | 'binding_unknown' | 'binding_conflict' | 'binding_unavailable' };

/** 客户修改运营别名时使用的更窄绑定解析：悬空账号与尚未绑定必须可区分，便于诚实回滚。 */
export type ResolvedOperatorAliasBinding =
  | { ok: true; accountId: string }
  | { ok: false; reason:
      'environment_not_owned' | 'binding_unknown' | 'account_not_found' | 'binding_conflict' | 'binding_unavailable' };

export type EnvironmentSlowStartRecord =
  | {
      ok: true;
      envKey: string;
      slowStartSince: number | null;
      binding: 'bound';
      accountId: string;
    }
  | {
      ok: true;
      envKey: string;
      slowStartSince: number | null;
      binding: 'binding_unknown' | 'binding_conflict';
    }
  | { ok: false; reason: 'environment_not_owned' | 'binding_unavailable' };

/** D5 跨客户绑定冲突告警载荷（走既有告警通道，非仅 console.warn）。 */
export interface EnvBindingConflictAlert {
  envKey: string;
  accountId: string;
  /** 本次 env 的归属客户（未归属＝null）。 */
  ownerUserId: string | null;
}

/**
 * D5 读侧争用闸的核心谓词：某账号是否同时绑在**归属不同客户**的环境上。
 *
 * **正反两个方向（env→account 与 account→reachable）逐字复用这一段**，MUST NOT 各写一遍——两个方向都是
 * 裸 string，漂移了 typecheck 抓不到。`s2.user_id <> $userParam`：只认**已归属且 owner 不同**的环境（无 owner
 * 的环境没有 s2 行、不参与，与写闸口径一致——无主环境本就读不到任何东西）。
 */
function contendedAcrossCustomersSql(accountExpr: string, userParam: string): string {
  return `EXISTS (
    SELECT 1 FROM client_environments e2
    JOIN client_env_scope s2 ON s2.env_key = e2.env_key AND s2.source = 'admin'
    WHERE e2.account_id = ${accountExpr} AND s2.user_id <> ${userParam}
  )`;
}

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
-- 环境→账号绑定（change curated-envkey-account-binding）：每次成功握手把该环境**上一次登录声明的平台账号 id**
-- 落这里，使「这个环境上跑的是哪个账号」成为**不要求边缘此刻在线**即可回答的事实（envKey 与 accountId 是可证不交
-- 的两个键空间）。**故意不写 REFERENCES accounts(account_id)**：clientUserStore.init() 跑在 PgAccountStore 构造之前，
-- 全新库上 accounts 表尚不存在、加 FK 必抛——完整性改由**读侧每次 JOIN accounts**（悬空绑定读时 fail-closed）承担，
-- 见 resolveBoundAccountForEnv。这是真实取舍（少了写时完整性），不是「初始化顺序禁止加列」。
ALTER TABLE client_environments ADD COLUMN IF NOT EXISTS account_id TEXT;
-- 管理后台环境资产页的事实字段。环境名与账号展示名分离；删除只改变环境生命周期，绝不擦账号绑定审计。
ALTER TABLE client_environments ADD COLUMN IF NOT EXISTS environment_name TEXT;
ALTER TABLE client_environments ADD COLUMN IF NOT EXISTS binding_observed_at TIMESTAMPTZ;
ALTER TABLE client_environments ADD COLUMN IF NOT EXISTS lifecycle_state TEXT;
UPDATE client_environments SET lifecycle_state = 'active' WHERE lifecycle_state IS NULL;
ALTER TABLE client_environments ALTER COLUMN lifecycle_state SET DEFAULT 'active';
ALTER TABLE client_environments ALTER COLUMN lifecycle_state SET NOT NULL;
ALTER TABLE client_environments ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
-- 环境级慢启动事实源（change environment-level-slow-start）：NULL=关，非 NULL=上海自然日起点。
-- 旧 accounts.slow_start_since 暂留回滚，但运行时不再读取；迁移须等 accounts 表 init 后单独执行。
ALTER TABLE client_environments ADD COLUMN IF NOT EXISTS slow_start_since TIMESTAMPTZ;
-- 一次性迁移标记：NULL/false 只代表历史行尚未初始化；新环境默认 true，防止以后因复用旧账号而被回灌。
ALTER TABLE client_environments ADD COLUMN IF NOT EXISTS slow_start_initialized BOOLEAN;
UPDATE client_environments SET slow_start_initialized = false WHERE slow_start_initialized IS NULL;
ALTER TABLE client_environments ALTER COLUMN slow_start_initialized SET DEFAULT true;
ALTER TABLE client_environments ALTER COLUMN slow_start_initialized SET NOT NULL;
-- D5 跨客户争用闸要按 account_id 反查「还有哪些 env 也绑了同一账号」，故加账号索引。
CREATE INDEX IF NOT EXISTS client_environments_account_idx ON client_environments (account_id);
CREATE INDEX IF NOT EXISTS client_environments_lifecycle_idx ON client_environments (lifecycle_state, updated_at DESC);
-- Edge 常规 HTTP 拉取时上报“哪个稳定安装持有哪个环境”；只作责任归属观测，不进入 WebSocket 协议。
CREATE TABLE IF NOT EXISTS client_environment_installations (
  env_key         TEXT        NOT NULL,
  installation_id TEXT        NOT NULL,
  user_id         TEXT        NOT NULL,
  environment_name TEXT,
  last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (env_key, installation_id)
);
CREATE INDEX IF NOT EXISTS client_environment_installations_user_seen_idx
  ON client_environment_installations (user_id, last_seen_at DESC);
-- 管理员删除意图与 Edge 终态回执。request_id/idempotency_key 令轮询、认领与结果都可安全重试。
CREATE TABLE IF NOT EXISTS client_environment_deletion_requests (
  request_id              UUID        PRIMARY KEY,
  env_key                 TEXT        NOT NULL REFERENCES client_environments(env_key),
  idempotency_key         TEXT        NOT NULL,
  requested_by            TEXT        NOT NULL,
  requested_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  target_user_id          TEXT,
  version                 INTEGER     NOT NULL DEFAULT 1,
  state                   TEXT        NOT NULL DEFAULT 'waiting_edge'
    CHECK (state IN ('waiting_edge','deleting','delete_failed','deleted')),
  claimed_installation_id TEXT,
  claimed_at              TIMESTAMPTZ,
  result_key              TEXT,
  result_kind             TEXT        CHECK (result_kind IS NULL OR result_kind IN ('deleted','already_missing')),
  result_error            TEXT,
  result_at               TIMESTAMPTZ,
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (env_key, idempotency_key)
);
ALTER TABLE client_environment_deletion_requests ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE client_environment_deletion_requests ADD COLUMN IF NOT EXISTS result_kind TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS client_environment_deletion_active_idx
  ON client_environment_deletion_requests (env_key)
  WHERE state IN ('waiting_edge','deleting','delete_failed');
CREATE INDEX IF NOT EXISTS client_environment_deletion_target_idx
  ON client_environment_deletion_requests (target_user_id, state, requested_at);
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
  environmentName: string;
  label: string | null;
  platform: string | null;
  assignees: ClientEnvAssignee[];
  assigneeCount: number;
  cleanup: ClientCleanupReceipt | null;
  account: {
    accountId: string;
    label: string | null;
    nickname: string | null;
    operatorAlias: string | null;
    displayName: string;
    platform: string;
    groupLabel: string | null;
    riskStatus: string | null;
    riskQuotaLevel: string | null;
  } | null;
  bindingObservedAt: number | null;
  installation: { installationId: string; lastSeenAt: number; online: boolean } | null;
  lifecycle: {
    state: 'active' | 'waiting_edge' | 'deleting' | 'delete_failed' | 'deleted';
    requestId: string | null;
    requestedBy: string | null;
    requestedAt: number | null;
    resultKind: 'deleted' | 'already_missing' | null;
    resultError: string | null;
    resultAt: number | null;
    deletedAt: number | null;
  };
}

export interface ClientEnvironmentSummary {
  activeCount: number;
  deletingCount: number;
  onlineCount: number;
}

export interface ClientEnvironmentMaintenanceItem {
  requestId: string;
  version: number;
  envKey: string;
  environmentName: string;
  platform: string | null;
  state: 'waiting_edge' | 'deleting' | 'delete_failed';
  cleanupReady: boolean;
  cleanupReason: 'ready' | 'wechat_offboard_pending';
}

export type RequestEnvironmentDeletionResult =
  | { ok: true; requestId: string; version: number; envKey: string; platform: string | null; targetUserId: string | null;
      state: 'waiting_edge' | 'deleting' | 'delete_failed' | 'deleted'; idempotent: boolean }
  | { ok: false; reason: 'not_found' | 'already_deleted' | 'idempotency_conflict' };

export type ClaimEnvironmentDeletionResult =
  | { ok: true; requestId: string; version: number; envKey: string; environmentName: string; platform: string | null;
      state: 'deleting'; idempotent: boolean }
  | { ok: false; reason: 'not_found' | 'not_target' | 'request_version_mismatch' |
      'ambiguous_holder' | 'cleanup_pending' | 'already_completed' };

export type CompleteEnvironmentDeletionResult =
  | { ok: true; requestId: string; envKey: string; state: 'deleted' | 'delete_failed'; idempotent: boolean }
  | { ok: false; reason: 'not_found' | 'not_target' | 'request_version_mismatch' |
      'not_claimed' | 'result_conflict' };

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

export type ConsumeOffboardCleanupGrantResult =
  | { ok: true; offboard: ClientOffboardView; edgeId: string }
  | { ok: false; reason: 'not_found' | 'scope_mismatch' | 'expired' | 'already_used' | 'not_pending' };

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
  /** 同步 WS 出口闸镜像：删除生命周期中的 AdsPower env 不再接收普通自动化命令。 */
  private blockedAutomationEnvKeys = new Set<string>();
  /** RiskController 同步热路径镜像：只收录当前恰好绑定一个环境的账号。 */
  private environmentSlowStartByAccount = new Map<string, number | null>();
  private ambiguousEnvironmentAccounts = new Set<string>();

  constructor(options: ClientUserStoreOptions = {}) {
    this.pool = options.pool ?? new Pool(resolveEnvPgConfig());
  }

  private offboardReceipt(offboard: ClientOffboardView): ClientCleanupReceipt {
    return { kind: 'offboard_pending', ...offboard };
  }

  private async revokeInteractionAccess(
    client: pg.PoolClient,
    input: { accountId: string; actor: string | null; requireAuthState: boolean },
  ): Promise<void> {
    const controls = await client.query(
      `UPDATE interaction_runtime_controls SET comments_read_enabled=false,comments_reply_enabled=false,
          dm_read_enabled=false,dm_send_text_enabled=false,dm_send_image_enabled=false,write_paused=true,
          version=version+1,updated_at=now(),updated_by=$2
        WHERE platform='wechat_channels' AND account_id=$1
        RETURNING account_id`,
      [input.accountId, input.actor ?? 'offboarding'],
    );
    if ((controls.rowCount ?? 0) === 0) {
      const existing = await client.query(
        `SELECT 1 FROM interaction_runtime_controls
          WHERE platform='wechat_channels' AND account_id=$1 FOR UPDATE`,
        [input.accountId],
      );
      if (existing.rows[0]) throw new Error('interaction_runtime_controls_revoke_missed');
    }

    const auth = await client.query(
      `UPDATE interaction_auth_state SET status='disabled',capabilities=$2::jsonb,
          reason_code='INTERACTION_FEATURE_DISABLED',checked_at=now(),updated_at=now()
        WHERE platform='wechat_channels' AND account_id=$1
        RETURNING account_id`,
      [input.accountId, JSON.stringify({ commentsRead: false, commentsReply: false,
        dmRead: false, dmSendText: false, dmSendImage: false })],
    );
    if ((auth.rowCount ?? 0) === 0 && input.requireAuthState) {
      throw new Error('interaction_auth_state_revoke_missed');
    }
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
    const identities = await client.query<{ account_id: string }>(
      `SELECT account_id FROM interaction_runtime_controls
        WHERE platform='wechat_channels' AND env_key=$1
        ORDER BY account_id LIMIT 2 FOR UPDATE`,
      [input.envKey],
    );
    if (identities.rows.length === 1) {
      await this.revokeInteractionAccess(client, {
        accountId: identities.rows[0].account_id,
        actor: input.actor,
        requireAuthState: false,
      });
    }
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
    await this.revokeInteractionAccess(client, {
      accountId: input.accountId,
      actor: input.actor,
      requireAuthState: true,
    });
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

  /** Persist only a hash of the signed grant identity; the bearer token never enters PostgreSQL or audit rows. */
  async registerOffboardCleanupGrant(input: {
    userId: string;
    offboardId: string;
    edgeId: string;
    jtiHash: string;
    expiresAt: number;
  }): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const updated = await client.query<{ account_id: string; env_key: string }>(
        `UPDATE interaction_offboards
            SET cleanup_grant_jti_hash=$4,cleanup_grant_edge_id=$3,
                cleanup_grant_expires_at=to_timestamp($5 / 1000.0),cleanup_grant_used_at=NULL,updated_at=now()
          WHERE offboard_id=$1 AND user_id=$2 AND state IN ('pending_edge','dispatched')
          RETURNING account_id,env_key`,
        [input.offboardId, input.userId, input.edgeId, input.jtiHash, input.expiresAt],
      );
      const row = updated.rows[0];
      if (!row) {
        await client.query('ROLLBACK');
        return false;
      }
      await client.query(
        `INSERT INTO interaction_offboard_audit
           (event_id,offboard_id,platform,account_id,env_key,user_id,event,status)
         VALUES ($1,$2,'wechat_channels',$3,$4,$5,'cleanup_grant_issued','issued')`,
        [crypto.randomUUID(), input.offboardId, row.account_id, row.env_key, input.userId],
      );
      await client.query('COMMIT');
      return true;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /** Atomically validates every binding and burns the grant before returning the account bootstrap. */
  async consumeOffboardCleanupGrant(input: {
    userId: string;
    offboardId: string;
    envKey: string;
    accountId: string;
    edgeId: string;
    jtiHash: string;
    now?: number;
  }): Promise<ConsumeOffboardCleanupGrantResult> {
    const now = input.now ?? Date.now();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const selected = await client.query<{
        offboard_id: string; env_key: string; account_id: string; state: ClientOffboardView['state'];
        reason: ClientOffboardView['reason']; requested_at: Date; purge_due_at: Date;
        user_id: string | null; cleanup_grant_jti_hash: string | null; cleanup_grant_edge_id: string | null;
        cleanup_grant_expires_at: Date | null; cleanup_grant_used_at: Date | null;
      }>(
        `SELECT offboard_id,env_key,account_id,state,reason,requested_at,purge_due_at,user_id,
                cleanup_grant_jti_hash,cleanup_grant_edge_id,cleanup_grant_expires_at,cleanup_grant_used_at
           FROM interaction_offboards WHERE offboard_id=$1 FOR UPDATE`,
        [input.offboardId],
      );
      const row = selected.rows[0];
      let failure: Exclude<ConsumeOffboardCleanupGrantResult, { ok: true }>['reason'] | null = null;
      if (!row) failure = 'not_found';
      else if (row.user_id !== input.userId || row.env_key !== input.envKey || row.account_id !== input.accountId
        || row.cleanup_grant_edge_id !== input.edgeId || row.cleanup_grant_jti_hash !== input.jtiHash) failure = 'scope_mismatch';
      else if (row.cleanup_grant_used_at) failure = 'already_used';
      else if (!row.cleanup_grant_expires_at || row.cleanup_grant_expires_at.getTime() <= now) failure = 'expired';
      else if (row.state !== 'pending_edge' && row.state !== 'dispatched') failure = 'not_pending';

      if (failure) {
        if (row) {
          await client.query(
            `INSERT INTO interaction_offboard_audit
               (event_id,offboard_id,platform,account_id,env_key,user_id,event,status)
             VALUES ($1,$2,'wechat_channels',$3,$4,$5,'cleanup_grant_rejected',$6)`,
            [crypto.randomUUID(), row.offboard_id, row.account_id, row.env_key, input.userId, failure],
          );
        }
        await client.query('COMMIT');
        return { ok: false, reason: failure };
      }

      await client.query(
        `UPDATE interaction_offboards SET cleanup_grant_used_at=now(),updated_at=now() WHERE offboard_id=$1`,
        [row!.offboard_id],
      );
      await client.query(
        `INSERT INTO interaction_offboard_audit
           (event_id,offboard_id,platform,account_id,env_key,user_id,event,status)
         VALUES ($1,$2,'wechat_channels',$3,$4,$5,'cleanup_grant_consumed','consumed')`,
        [crypto.randomUUID(), row!.offboard_id, row!.account_id, row!.env_key, input.userId],
      );
      await client.query('COMMIT');
      return {
        ok: true,
        edgeId: input.edgeId,
        offboard: {
          offboardId: row!.offboard_id,
          envKey: row!.env_key,
          accountId: row!.account_id,
          state: row!.state,
          reason: row!.reason,
          requestedAt: row!.requested_at.getTime(),
          purgeDueAt: row!.purge_due_at.getTime(),
        },
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async init(): Promise<void> {
    await this.pool.query(CLIENT_USERS_SCHEMA_SQL);
    const blocked = await this.pool.query<{ env_key: string }>(
      `SELECT env_key FROM client_environments WHERE lifecycle_state <> 'active'`,
    );
    this.blockedAutomationEnvKeys = new Set(blocked.rows.map((row) => row.env_key));
    await this.refreshEnvironmentSlowStartMirror();
  }

  /** WebSocket 传输层同步闸；不产生删除命令，只在 Cloud 内部抑制删除环境的普通自动化下发。 */
  isAutomationAllowedForEdgeId(edgeId: string): boolean {
    const normalized = edgeId.trim();
    if (!normalized.startsWith('ads-')) return true;
    return !this.blockedAutomationEnvKeys.has(normalized.slice('ads-'.length));
  }

  /**
   * 从旧账号字段一次性初始化历史环境。initialized=false 可重跑；用户明确关闭后的 NULL 永不再次回灌。
   * 必须在 accounts 表完成 init 后调用；旧列只用于迁移，不参与后续运行时读取或双写。
   */
  async migrateEnvironmentSlowStartFromAccounts(): Promise<number> {
    const result = await this.pool.query(
      `WITH pending AS (
         SELECT e.env_key, a.slow_start_since AS legacy_since
           FROM client_environments e
           LEFT JOIN accounts a ON a.account_id=e.account_id
          WHERE e.slow_start_initialized=false
       )
       UPDATE client_environments e
          SET slow_start_since = COALESCE(e.slow_start_since, pending.legacy_since),
              slow_start_initialized = true,
              updated_at = now()
         FROM pending
        WHERE e.env_key=pending.env_key
       RETURNING e.env_key`,
    );
    await this.refreshEnvironmentSlowStartMirror();
    return result.rowCount ?? result.rows.length;
  }

  /**
   * 重建环境配置→当前账号的同步镜像。一个账号异常出现在多个环境时不任取一行；该账号无显式环境 anchor。
   */
  async refreshEnvironmentSlowStartMirror(): Promise<void> {
    const { rows } = await this.pool.query<{
      env_key: string;
      account_id: string;
      slow_start_since: Date | null;
    }>(`SELECT env_key, account_id, slow_start_since
          FROM client_environments
         WHERE account_id IS NOT NULL
         ORDER BY account_id, env_key`);
    const grouped = new Map<string, { envKey: string; since: number | null }[]>();
    for (const row of rows) {
      const accountId = String(row.account_id ?? '').trim();
      if (!accountId || accountId === RETIRED_ACCOUNT_ID) continue;
      const entries = grouped.get(accountId) ?? [];
      entries.push({
        envKey: row.env_key,
        since: row.slow_start_since ? row.slow_start_since.getTime() : null,
      });
      grouped.set(accountId, entries);
    }
    const next = new Map<string, number | null>();
    const ambiguous = new Set<string>();
    for (const [accountId, entries] of grouped) {
      if (entries.length === 1) {
        next.set(accountId, entries[0].since);
        continue;
      }
      ambiguous.add(accountId);
      console.warn(
        `[client-env] 环境级慢启动绑定歧义：账号 ${accountId} 同时出现在 ${entries.length} 个环境，拒绝任取配置`,
      );
    }
    this.environmentSlowStartByAccount = next;
    this.ambiguousEnvironmentAccounts = ambiguous;
  }

  /** RiskController 同步、零 IO 现读；无绑定/歧义/关闭均返回 null。 */
  slowStartSinceFor(accountId: string): number | null {
    if (this.ambiguousEnvironmentAccounts.has(accountId)) return null;
    return this.environmentSlowStartByAccount.get(accountId) ?? null;
  }

  hasAmbiguousEnvironmentBinding(accountId: string): boolean {
    return this.ambiguousEnvironmentAccounts.has(accountId);
  }

  /**
   * 读取环境自己的慢启动配置，并只在绑定唯一、账号存在且无跨客户争用时向服务层提供 accountId。
   */
  async getEnvironmentSlowStart(userId: string, envKey: string): Promise<EnvironmentSlowStartRecord> {
    const key = (envKey ?? '').trim();
    if (!userId || !key) return { ok: false, reason: 'environment_not_owned' };
    try {
      const { rows } = await this.pool.query<{
        owned: boolean;
        slow_start_since: Date | null;
        bound_account: string | null;
        account_exists: boolean;
        contended: boolean;
        duplicate_count: number | string;
      }>(
        `SELECT
           EXISTS(SELECT 1 FROM client_env_scope s
                   WHERE s.user_id=$1 AND s.env_key=$2 AND s.source='admin') AS owned,
           e.slow_start_since,
           e.account_id AS bound_account,
           CASE WHEN e.account_id IS NOT NULL
                THEN EXISTS(SELECT 1 FROM accounts a WHERE a.account_id=e.account_id)
                ELSE false END AS account_exists,
           CASE WHEN e.account_id IS NOT NULL
                THEN ${contendedAcrossCustomersSql('e.account_id', '$1')}
                ELSE false END AS contended,
           CASE WHEN e.account_id IS NOT NULL
                THEN (SELECT count(*) FROM client_environments e3 WHERE e3.account_id=e.account_id)
                ELSE 0 END AS duplicate_count
         FROM (SELECT $2::text AS env_key) k
         LEFT JOIN client_environments e ON e.env_key=k.env_key`,
        [userId, key],
      );
      const row = rows[0];
      if (!row?.owned) return { ok: false, reason: 'environment_not_owned' };
      const slowStartSince = row.slow_start_since ? row.slow_start_since.getTime() : null;
      if (row.contended || Number(row.duplicate_count) > 1) {
        return { ok: true, envKey: key, slowStartSince, binding: 'binding_conflict' };
      }
      if (!row.bound_account || !row.account_exists) {
        return { ok: true, envKey: key, slowStartSince, binding: 'binding_unknown' };
      }
      return { ok: true, envKey: key, slowStartSince, binding: 'bound', accountId: row.bound_account };
    } catch (err) {
      if (isMissingTable(err)) return { ok: false, reason: 'binding_unavailable' };
      throw err;
    }
  }

  /** 环境级单写：ownership 与 UPDATE 同一语句，先库后镜像；账号字段完全不参与写入。 */
  async setEnvironmentSlowStart(
    userId: string,
    envKey: string,
    enabled: boolean,
    now: number,
  ): Promise<EnvironmentSlowStartRecord> {
    const key = (envKey ?? '').trim();
    if (!userId || !key) return { ok: false, reason: 'environment_not_owned' };
    const value = enabled ? new Date(shanghaiDayStartMs(now)) : null;
    try {
      const result = await this.pool.query(
        `UPDATE client_environments e
            SET slow_start_since=$3, slow_start_initialized=true, updated_at=now()
          WHERE e.env_key=$2
            AND EXISTS(SELECT 1 FROM client_env_scope s
                        WHERE s.user_id=$1 AND s.env_key=e.env_key AND s.source='admin')
        RETURNING e.env_key`,
        [userId, key, value],
      );
      if ((result.rowCount ?? result.rows.length) === 0) {
        return { ok: false, reason: 'environment_not_owned' };
      }
      await this.refreshEnvironmentSlowStartMirror();
      return this.getEnvironmentSlowStart(userId, key);
    } catch (err) {
      if (isMissingTable(err)) return { ok: false, reason: 'binding_unavailable' };
      throw err;
    }
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
        `SELECT s.env_key, s.label, s.platform, s.source, s.assigned_at
         FROM client_env_scope s
         JOIN client_environments e ON e.env_key = s.env_key
         WHERE s.user_id = $1 AND s.source = 'admin' AND e.lifecycle_state = 'active'
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
    input: {
      intentId: string;
      proof: string;
      envKey: string;
      label?: string | null;
      platform?: string | null;
      slowStartEnabled?: boolean;
    },
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
    if (input.slowStartEnabled === true && platform !== 'facebook') {
      return { ok: false, reason: 'invalid_environment' };
    }
    const slowStartSince = input.slowStartEnabled === true
      ? new Date(shanghaiDayStartMs(Date.now()))
      : null;

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
        `INSERT INTO client_environments
           (env_key,label,environment_name,platform,source,slow_start_since,slow_start_initialized,created_at,updated_at)
         VALUES ($1,$2,$2,$3,'auto',$4,true,now(),now())
         ON CONFLICT (env_key) DO NOTHING
         RETURNING env_key`,
        [envKey, label, platform, slowStartSince],
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
           SELECT 1 FROM client_env_scope s
           JOIN client_environments e ON e.env_key = s.env_key
           WHERE s.user_id = $1 AND s.env_key = $2
             AND s.source = 'admin' AND e.lifecycle_state = 'active'
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
           AND s.source = 'admin' AND e.lifecycle_state = 'active'
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
   *
   * 环境→账号绑定（change curated-envkey-account-binding）：item 可带 accountId（握手声明的平台账号 id）。
   * 合并语义 = **「来了新值才覆盖」**：`account_id = COALESCE(EXCLUDED.account_id, current)`。
   * **MUST NOT** 写成 `COALESCE(current, EXCLUDED.account_id)`（=「当前为空才写」）——那是 2026-07-12 修掉的
   * FB 昵称回归的形状，会把环境永远钉死在第一个登录账号上，而换号登录是常规运营动作。
   * 退役保留账号 id（'default'）归一为「没有新值」（不写成绑定、也不擦既有绑定）。
   * D5 写闸：绑定写前若该账号已绑在**归属不同客户**的另一 env 上 → 拒写绑定（label/platform 照常登记）+ 告警。
   */
  async registerEnvironments(
    items: { envKey: string; label?: string | null; platform?: string | null; accountId?: string | null }[],
    source: 'import' | 'auto' | 'admin' = 'import',
  ): Promise<number> {
    const seen = new Set<string>();
    const clean = items
      .map((i) => ({
        envKey: (i.envKey ?? '').trim(),
        label: (i.label ?? '')?.toString().trim() || null,
        platform: (i.platform ?? '')?.toString().trim() || null,
        // 退役保留账号 id 归一为 null ⇒ 在 COALESCE 下等价「没有新值」（与 account-store 拒登记退役 id 一致）。
        accountId: this.normalizeBindingAccountId(i.accountId),
      }))
      .filter((i) => i.envKey && !seen.has(i.envKey) && (seen.add(i.envKey), true));
    if (!clean.length) return 0;
    for (const i of clean) {
      let accountId = i.accountId;
      if (accountId) {
        // D5 写闸：同一事务内先查跨客户争用，冲突则拒写绑定（accountId→null，label/platform 照常）+ 告警。
        const client = await this.pool.connect();
        try {
          await client.query('BEGIN');
          const owner = await this.ownerOfEnv(client, i.envKey);
          const conflicted = await this.bindingConflictsAcrossCustomers(client, i.envKey, accountId, owner);
          if (conflicted) {
            this.emitBindingConflict({ envKey: i.envKey, accountId, ownerUserId: owner });
            accountId = null;
          }
          await this.upsertEnvironment(client, i.envKey, i.label, i.platform, source, accountId);
          await client.query('COMMIT');
        } catch (err) {
          await client.query('ROLLBACK');
          throw err;
        } finally {
          client.release();
        }
      } else {
        await this.upsertEnvironment(this.pool, i.envKey, i.label, i.platform, source, null);
      }
    }
    // 只有真实 accountId 到来时绑定才可能变化；null 在 COALESCE 语义下不会擦除既有绑定。
    if (clean.some((item) => item.accountId != null)) {
      await this.refreshEnvironmentSlowStartMirror();
    }
    return clean.length;
  }

  /** 绑定账号 id 归一：去空白，退役保留账号（'default'）视作「没有新值」→ null。 */
  private normalizeBindingAccountId(accountId?: string | null): string | null {
    const v = (accountId ?? '').toString().trim();
    if (!v || v === RETIRED_ACCOUNT_ID) return null;
    return v;
  }

  /** 环境的归属客户（`client_env_scope` source='admin'，0-或-1）；无主返回 null。 */
  private async ownerOfEnv(exec: pg.Pool | pg.PoolClient, envKey: string): Promise<string | null> {
    const { rows } = await exec.query<{ user_id: string }>(
      `SELECT user_id FROM client_env_scope WHERE env_key = $1 AND source = 'admin'`,
      [envKey],
    );
    return rows[0]?.user_id ?? null;
  }

  /**
   * D5 写闸判据：该 accountId 是否已绑在**另一个** env 上、且那个 env 的 owner 与本次 owner **不同**。
   * 用 `IS DISTINCT FROM` 处理无主（NULL=⊥）：⊥ 与任何真实客户都判不同（fail-closed）；两个 ⊥ 判相同
   * （无所谓——无主环境读侧本就读不到任何东西，读闸兜底）。
   */
  private async bindingConflictsAcrossCustomers(
    exec: pg.Pool | pg.PoolClient, envKey: string, accountId: string, owner: string | null,
  ): Promise<boolean> {
    const { rows } = await exec.query<{ conflict: boolean }>(
      `SELECT EXISTS (
         SELECT 1
         FROM client_environments e2
         WHERE e2.account_id = $1
           AND e2.env_key <> $2
           AND (SELECT user_id FROM client_env_scope s2 WHERE s2.env_key = e2.env_key AND s2.source = 'admin')
               IS DISTINCT FROM $3::text
       ) AS conflict`,
      [accountId, envKey, owner],
    );
    return rows[0]?.conflict === true;
  }

  /** 单环境 upsert（含账号绑定合并）；exec 可为 pool 或事务 client。 */
  private async upsertEnvironment(
    exec: pg.Pool | pg.PoolClient,
    envKey: string, label: string | null, platform: string | null,
    source: 'import' | 'auto' | 'admin', accountId: string | null,
  ): Promise<void> {
    await exec.query(
      `INSERT INTO client_environments
         (env_key, label, environment_name, platform, source, account_id, binding_observed_at, created_at, updated_at)
       VALUES ($1, $2, $2, $3, $4, $5, CASE WHEN $5::text IS NULL THEN NULL ELSE now() END, now(), now())
       ON CONFLICT (env_key) DO UPDATE
         SET label = COALESCE(EXCLUDED.label, client_environments.label),
             environment_name = COALESCE(EXCLUDED.environment_name, client_environments.environment_name),
             platform = COALESCE(EXCLUDED.platform, client_environments.platform),
             account_id = COALESCE(EXCLUDED.account_id, client_environments.account_id),
             binding_observed_at = CASE WHEN EXCLUDED.account_id IS NULL
               THEN client_environments.binding_observed_at ELSE now() END,
             updated_at = now()`,
      [envKey, label, platform, source, accountId],
    );
  }

  private bindingConflictSink?: (alert: EnvBindingConflictAlert) => void;

  /**
   * 注入 D5 跨客户绑定冲突告警通道（走既有告警存储，非仅 console.warn）。
   * clientUserStore 在 alertStore 之前构造，故用 setter 事后接线（server.ts 在 alertStore 就绪后调用）。
   */
  setBindingConflictAlertSink(sink: (alert: EnvBindingConflictAlert) => void): void {
    this.bindingConflictSink = sink;
  }

  private emitBindingConflict(alert: EnvBindingConflictAlert): void {
    console.warn(
      `[client-env] D5 跨客户绑定冲突：拒绝把账号 ${alert.accountId} 绑到 env=${alert.envKey}`
      + `（owner=${alert.ownerUserId ?? '⊥'}）——既有绑定不变`,
    );
    try {
      this.bindingConflictSink?.(alert);
    } catch (err) {
      console.warn(`[client-env] 绑定冲突告警下发失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * 环境→账号绑定解析（change curated-envkey-account-binding，正向）。
   *
   * **一条现读查询同时做四件事**：① 归属闸（client_env_scope source='admin'）② 取绑定 ③ JOIN accounts 让悬空绑定
   * 读时 fail-closed（替代做不到的 FK）④ 跨客户争用（读闸，与写闸正交——写闸看不见事后改归属造出的冲突）。
   * 每次请求现读，对齐「改归属即时生效」（范围绝不内嵌令牌）。返回判别式，绝不返回 string|null。
   */
  async resolveBoundAccountForEnv(userId: string, envKey: string): Promise<ResolvedBinding> {
    const key = (envKey ?? '').trim();
    if (!userId || !key) return { ok: false, reason: 'environment_not_owned' };
    try {
      const { rows } = await this.pool.query<{
        owned: boolean; bound_account: string | null; account_exists: boolean; contended: boolean;
      }>(
        `SELECT
           EXISTS(SELECT 1 FROM client_env_scope s
                  WHERE s.user_id = $1 AND s.env_key = $2 AND s.source = 'admin'
                    AND e.lifecycle_state = 'active') AS owned,
           e.account_id AS bound_account,
           CASE WHEN e.account_id IS NOT NULL
                THEN EXISTS(SELECT 1 FROM accounts acc WHERE acc.account_id = e.account_id)
                ELSE false END AS account_exists,
           CASE WHEN e.account_id IS NOT NULL
                THEN ${contendedAcrossCustomersSql('e.account_id', '$1')}
                ELSE false END AS contended
         FROM (SELECT $2::text AS env_key) k
         LEFT JOIN client_environments e ON e.env_key = k.env_key`,
        [userId, key],
      );
      const r = rows[0];
      if (!r || !r.owned) return { ok: false, reason: 'environment_not_owned' };
      if (r.bound_account == null) return { ok: false, reason: 'binding_unknown' };
      // 争用是安全事件，优先于悬空 fail-closed 报出（两者都 fail-closed，但争用要被运维识别）。
      if (r.contended) return { ok: false, reason: 'binding_conflict' };
      // 悬空绑定（accounts 无此行）：读时 fail-closed，归入日常态 binding_unknown（下次握手 ensureAccount 重建即自愈）。
      if (!r.account_exists) return { ok: false, reason: 'binding_unknown' };
      return { ok: true, accountId: r.bound_account };
    } catch (err) {
      if (isMissingTable(err)) return { ok: false, reason: 'binding_unavailable' };
      throw err;
    }
  }

  /**
   * 客户环境运营别名写入口的专用解析。它比通用读取更严格地保留 `account_not_found`，从而让客户端知道
   * 本地乐观值并未保存到 Cloud；归属与跨客户争用仍在同一条现读 SQL 内 fail-closed。
   */
  async resolveOperatorAliasAccountForEnv(userId: string, envKey: string): Promise<ResolvedOperatorAliasBinding> {
    const key = (envKey ?? '').trim();
    if (!userId || !key) return { ok: false, reason: 'environment_not_owned' };
    try {
      const { rows } = await this.pool.query<{
        owned: boolean; bound_account: string | null; account_exists: boolean; contended: boolean;
      }>(
        `SELECT
           EXISTS(SELECT 1 FROM client_env_scope s
                  WHERE s.user_id = $1 AND s.env_key = $2 AND s.source = 'admin') AS owned,
           e.account_id AS bound_account,
           CASE WHEN e.account_id IS NOT NULL
                THEN EXISTS(SELECT 1 FROM accounts acc WHERE acc.account_id = e.account_id)
                ELSE false END AS account_exists,
           CASE WHEN e.account_id IS NOT NULL
                THEN ${contendedAcrossCustomersSql('e.account_id', '$1')}
                ELSE false END AS contended
         FROM (SELECT $2::text AS env_key) k
         LEFT JOIN client_environments e ON e.env_key = k.env_key`,
        [userId, key],
      );
      const r = rows[0];
      if (!r || !r.owned) return { ok: false, reason: 'environment_not_owned' };
      if (r.bound_account == null) return { ok: false, reason: 'binding_unknown' };
      if (r.contended) return { ok: false, reason: 'binding_conflict' };
      if (!r.account_exists) return { ok: false, reason: 'account_not_found' };
      return { ok: true, accountId: r.bound_account };
    } catch (err) {
      if (isMissingTable(err)) return { ok: false, reason: 'binding_unavailable' };
      throw err;
    }
  }

  /**
   * 反向：某账号是否可被该客户经其某个环境触达（供委托任务动作的归属判定）。
   * **MUST 由与 resolveBoundAccountForEnv 相同的绑定+归属+争用逻辑派生**（复用 contendedAcrossCustomersSql），
   * MUST NOT 另写一份——两个方向都是裸 string，漂移了 typecheck 抓不到。争用时 fail-closed（binding_conflict）。
   */
  async isAccountReachableByUser(userId: string, accountId: string): Promise<ResolvedBinding> {
    const acct = (accountId ?? '').trim();
    if (!userId || !acct) return { ok: false, reason: 'environment_not_owned' };
    try {
      const { rows } = await this.pool.query<{ owned_bound: boolean; contended: boolean }>(
        `SELECT
           EXISTS(SELECT 1 FROM client_environments e
                  JOIN client_env_scope s ON s.env_key = e.env_key AND s.source = 'admin'
                  WHERE e.account_id = $2 AND s.user_id = $1) AS owned_bound,
           ${contendedAcrossCustomersSql('$2', '$1')} AS contended`,
        [userId, acct],
      );
      const r = rows[0];
      if (r?.contended) return { ok: false, reason: 'binding_conflict' };
      if (r?.owned_bound) return { ok: true, accountId: acct };
      return { ok: false, reason: 'environment_not_owned' };
    } catch (err) {
      if (isMissingTable(err)) return { ok: false, reason: 'binding_unavailable' };
      throw err;
    }
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
        environment_name: string | null;
        label: string | null;
        platform: string | null;
        assignees: { userId: string; name: string }[] | null;
        account_id: string | null;
        account_label: string | null;
        account_nickname: string | null;
        account_operator_alias: string | null;
        account_platform: string | null;
        group_label: string | null;
        risk_status: string | null;
        risk_quota_level: string | null;
        binding_observed_at: Date | null;
        lifecycle_state: ClientEnvironmentView['lifecycle']['state'] | null;
        deleted_at: Date | null;
        request_id: string | null;
        deletion_requested_by: string | null;
        deletion_requested_at: Date | null;
        result_kind: 'deleted' | 'already_missing' | null;
        result_error: string | null;
        result_at: Date | null;
        installation_id: string | null;
        installation_seen_at: Date | null;
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
                COALESCE(max(e.environment_name),
                  (array_agg(s.label ORDER BY s.assigned_at DESC) FILTER (WHERE s.label IS NOT NULL))[1],
                  k.env_key) AS environment_name,
                COALESCE(
                  (array_agg(s.platform ORDER BY s.assigned_at DESC) FILTER (WHERE s.platform IS NOT NULL))[1],
                  max(e.platform)
                ) AS platform,
                json_agg(json_build_object('userId', u.user_id, 'name', u.name) ORDER BY u.name)
                  FILTER (WHERE u.user_id IS NOT NULL) AS assignees,
                max(e.account_id) AS account_id,max(a.label) AS account_label,max(a.nickname) AS account_nickname,
                max(a.operator_alias) AS account_operator_alias,max(a.platform) AS account_platform,
                max(a.group_label) AS group_label,max(r.status) AS risk_status,max(r.quota_level) AS risk_quota_level,
                max(e.binding_observed_at) AS binding_observed_at,
                COALESCE(max(e.lifecycle_state), 'active') AS lifecycle_state,max(e.deleted_at) AS deleted_at,
                d.request_id,d.requested_by AS deletion_requested_by,d.requested_at AS deletion_requested_at,
                d.result_kind,d.result_error,d.result_at,
                i.installation_id,i.last_seen_at AS installation_seen_at,
                h.revocation_id AS hold_id,h.reason AS hold_reason,h.requested_at AS hold_requested_at,
                o.offboard_id,o.account_id AS offboard_account_id,o.state AS offboard_state,
                o.reason AS offboard_reason,o.requested_at AS offboard_requested_at,
                o.purge_due_at AS offboard_purge_due_at
         FROM keys k
         LEFT JOIN client_environments e ON e.env_key = k.env_key
         LEFT JOIN client_env_scope s
           ON s.env_key = k.env_key AND s.source = 'admin'
         LEFT JOIN client_users u ON u.user_id = s.user_id
         LEFT JOIN accounts a ON a.account_id = e.account_id
         LEFT JOIN risk_state r ON r.account_id = a.account_id
         LEFT JOIN LATERAL (
           SELECT request_id,requested_by,requested_at,result_kind,result_error,result_at
           FROM client_environment_deletion_requests d0 WHERE d0.env_key=k.env_key
           ORDER BY requested_at DESC LIMIT 1
         ) d ON true
         LEFT JOIN LATERAL (
           SELECT installation_id,last_seen_at
           FROM client_environment_installations i0 WHERE i0.env_key=k.env_key
           ORDER BY last_seen_at DESC LIMIT 1
         ) i ON true
         LEFT JOIN client_env_revocation_holds h ON h.env_key = k.env_key
         LEFT JOIN interaction_offboards o
           ON o.env_key = k.env_key AND o.platform='wechat_channels' AND o.state <> 'purged'
         GROUP BY k.env_key,h.revocation_id,h.reason,h.requested_at,
                  o.offboard_id,o.account_id,o.state,o.reason,o.requested_at,o.purge_due_at,
                  d.request_id,d.requested_by,d.requested_at,d.result_kind,d.result_error,d.result_at,
                  i.installation_id,i.last_seen_at
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
          environmentName: r.environment_name ?? r.env_key,
          label: r.label,
          platform: r.platform,
          assignees,
          assigneeCount: assignees.length,
          cleanup,
          account: r.account_id && r.account_platform
            ? (() => {
                const display = resolveAccountDisplayName({
                  accountId: r.account_id!, label: r.account_label,
                  nickname: r.account_nickname, operatorAlias: r.account_operator_alias,
                });
                return {
                  accountId: r.account_id!, label: r.account_label, nickname: r.account_nickname,
                  operatorAlias: r.account_operator_alias, displayName: display.name,
                  platform: r.account_platform!, groupLabel: r.group_label,
                  riskStatus: r.risk_status, riskQuotaLevel: r.risk_quota_level,
                };
              })()
            : null,
          bindingObservedAt: r.binding_observed_at?.getTime() ?? null,
          installation: r.installation_id && r.installation_seen_at
            ? {
                installationId: r.installation_id,
                lastSeenAt: r.installation_seen_at.getTime(),
                online: r.installation_seen_at.getTime() >= Date.now() - 120_000,
              }
            : null,
          lifecycle: {
            state: r.lifecycle_state ?? 'active', requestId: r.request_id ?? null,
            requestedBy: r.deletion_requested_by ?? null,
            requestedAt: r.deletion_requested_at?.getTime() ?? null,
            resultKind: r.result_kind ?? null, resultError: r.result_error ?? null,
            resultAt: r.result_at?.getTime() ?? null, deletedAt: r.deleted_at?.getTime() ?? null,
          },
        };
      });
    } catch (err) {
      if (isMissingTable(err)) return [];
      throw err;
    }
  }

  /** 账号页的加法投影：环境生命周期独立，账号本身不因环境删除而删除或重置。 */
  async environmentSummariesByAccount(): Promise<Record<string, ClientEnvironmentSummary>> {
    try {
      const { rows } = await this.pool.query<{
        account_id: string; active_count: number | string; deleting_count: number | string; online_count: number | string;
      }>(
        `SELECT e.account_id,
                count(*) FILTER (WHERE e.lifecycle_state='active')::int AS active_count,
                count(*) FILTER (WHERE e.lifecycle_state IN ('waiting_edge','deleting','delete_failed'))::int AS deleting_count,
                count(*) FILTER (WHERE e.lifecycle_state='active' AND EXISTS (
                  SELECT 1 FROM client_environment_installations i
                  WHERE i.env_key=e.env_key AND i.last_seen_at >= now()-interval '2 minutes'
                ))::int AS online_count
         FROM client_environments e
         WHERE e.account_id IS NOT NULL AND e.lifecycle_state <> 'deleted'
         GROUP BY e.account_id`,
      );
      return Object.fromEntries(rows.map((r) => [r.account_id, {
        activeCount: Number(r.active_count), deletingCount: Number(r.deleting_count), onlineCount: Number(r.online_count),
      }]));
    } catch (err) {
      if (isMissingTable(err)) return {};
      throw err;
    }
  }

  /** 内部管理员只写删除意图；实际 AdsPower 删除必须由唯一持有该环境的 Edge 经 HTTP 拉取执行。 */
  async requestEnvironmentDeletion(
    envKey: string, requestedBy: string, idempotencyKey: string,
  ): Promise<RequestEnvironmentDeletionResult> {
    const key = envKey.trim();
    const idem = idempotencyKey.trim();
    if (!key) return { ok: false, reason: 'not_found' };
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const env = await client.query<{
        env_key: string; platform: string | null; lifecycle_state: string; target_user_id: string | null;
      }>(
        `SELECT e.env_key,e.platform,e.lifecycle_state,
                COALESCE(s.user_id, i.user_id) AS target_user_id
         FROM client_environments e
         LEFT JOIN client_env_scope s ON s.env_key=e.env_key AND s.source='admin'
         LEFT JOIN LATERAL (
           SELECT user_id FROM client_environment_installations i0
           WHERE i0.env_key=e.env_key ORDER BY last_seen_at DESC LIMIT 1
         ) i ON true
         WHERE e.env_key=$1 FOR UPDATE OF e`,
        [key],
      );
      const row = env.rows[0];
      if (!row) {
        await client.query('ROLLBACK');
        return { ok: false, reason: 'not_found' };
      }
      const existing = await client.query<{
        request_id: string; version: number;
        state: RequestEnvironmentDeletionResult extends { ok: true; state: infer S } ? S : never;
        target_user_id: string | null; idempotency_key: string;
      }>(
        `SELECT request_id,version,state,target_user_id,idempotency_key
         FROM client_environment_deletion_requests
         WHERE env_key=$1 AND (idempotency_key=$2 OR state IN ('waiting_edge','deleting','delete_failed'))
         ORDER BY requested_at DESC LIMIT 1`,
        [key, idem],
      );
      if (existing.rows[0]) {
        const prior = existing.rows[0];
        await client.query('COMMIT');
        this.blockedAutomationEnvKeys.add(key);
        return { ok: true, requestId: prior.request_id, version: prior.version, envKey: key, platform: row.platform,
          targetUserId: prior.target_user_id, state: prior.state, idempotent: true };
      }
      if (row.lifecycle_state === 'deleted') {
        await client.query('ROLLBACK');
        return { ok: false, reason: 'already_deleted' };
      }
      const requestId = crypto.randomUUID();
      await client.query(
        `INSERT INTO client_environment_deletion_requests
           (request_id,env_key,idempotency_key,requested_by,target_user_id,state)
         VALUES ($1,$2,$3,$4,$5,'waiting_edge')`,
        [requestId, key, idem || requestId, requestedBy, row.target_user_id],
      );
      await client.query(
        `UPDATE client_environments SET lifecycle_state='waiting_edge',updated_at=now() WHERE env_key=$1`, [key],
      );
      await client.query('COMMIT');
      this.blockedAutomationEnvKeys.add(key);
      return { ok: true, requestId, version: 1, envKey: key, platform: row.platform,
        targetUserId: row.target_user_id, state: 'waiting_edge', idempotent: false };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /** Edge 的常规 HTTP 心跳：上报本安装持有的环境，并只读取属于该客户的删除候选。 */
  async observeAndListEnvironmentMaintenance(
    userId: string,
    installationId: string,
    environments: { envKey: string; environmentName?: string | null }[],
  ): Promise<ClientEnvironmentMaintenanceItem[]> {
    const install = installationId.trim();
    if (!userId || !install) return [];
    const seen = new Set<string>();
    for (const item of environments.slice(0, 500)) {
      const envKey = item.envKey.trim();
      if (!envKey || seen.has(envKey)) continue;
      seen.add(envKey);
      const environmentName = item.environmentName?.trim() || null;
      await this.pool.query(
        `INSERT INTO client_environment_installations
           (env_key,installation_id,user_id,environment_name,last_seen_at)
         SELECT e.env_key,$2,$3,$4,now() FROM client_environments e
         WHERE e.env_key=$1 AND (
           EXISTS (SELECT 1 FROM client_env_scope s WHERE s.env_key=e.env_key AND s.user_id=$3 AND s.source='admin')
           OR EXISTS (SELECT 1 FROM client_environment_deletion_requests d
                      WHERE d.env_key=e.env_key AND d.target_user_id=$3 AND d.state<>'deleted')
         )
         ON CONFLICT (env_key,installation_id) DO UPDATE
           SET user_id=EXCLUDED.user_id,environment_name=COALESCE(EXCLUDED.environment_name,
             client_environment_installations.environment_name),last_seen_at=now()`,
        [envKey, install, userId, environmentName],
      );
      if (environmentName) {
        await this.pool.query(
          `UPDATE client_environments SET environment_name=$2,updated_at=now()
           WHERE env_key=$1 AND lifecycle_state<>'deleted'`, [envKey, environmentName],
        );
      }
    }
    const { rows } = await this.pool.query<{
      request_id: string; version: number; env_key: string; environment_name: string; platform: string | null;
      state: 'waiting_edge' | 'deleting' | 'delete_failed'; cleanup_ready: boolean;
    }>(
      `SELECT d.request_id,d.version,d.env_key,COALESCE(e.environment_name,e.label,e.env_key) AS environment_name,
              e.platform,d.state,
              CASE WHEN e.platform='wechat_channels' THEN EXISTS (
                SELECT 1 FROM interaction_offboards o
                WHERE o.env_key=e.env_key AND o.platform='wechat_channels' AND o.state IN ('tombstoned','purged')
              ) ELSE true END AS cleanup_ready
       FROM client_environment_deletion_requests d
       JOIN client_environments e ON e.env_key=d.env_key
       WHERE d.target_user_id=$1 AND d.state IN ('waiting_edge','deleting','delete_failed')
         AND EXISTS (
           SELECT 1 FROM client_environment_installations mine
           WHERE mine.env_key=d.env_key AND mine.user_id=$1 AND mine.installation_id=$2
             AND mine.last_seen_at >= now()-interval '2 minutes'
         )
       ORDER BY d.requested_at ASC`,
      [userId, install],
    );
    return rows.map((r) => ({
      requestId: r.request_id, version: r.version, envKey: r.env_key, environmentName: r.environment_name,
      platform: r.platform, state: r.state, cleanupReady: r.cleanup_ready,
      cleanupReason: r.cleanup_ready ? 'ready' : 'wechat_offboard_pending',
    }));
  }

  /** 唯一、新鲜持有者认领；多安装或无新鲜观测都 fail-closed，Cloud 不猜目标。 */
  async claimEnvironmentDeletion(
    userId: string, requestId: string, version: number, installationId: string,
  ): Promise<ClaimEnvironmentDeletionResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const request = await client.query<{
        request_id: string; version: number; env_key: string; environment_name: string; platform: string | null; state: string;
        target_user_id: string | null; claimed_installation_id: string | null; cleanup_ready: boolean;
      }>(
        `SELECT d.request_id,d.version,d.env_key,COALESCE(e.environment_name,e.label,e.env_key) AS environment_name,
                e.platform,d.state,d.target_user_id,d.claimed_installation_id,
                CASE WHEN e.platform='wechat_channels' THEN EXISTS (
                  SELECT 1 FROM interaction_offboards o
                  WHERE o.env_key=e.env_key AND o.platform='wechat_channels' AND o.state IN ('tombstoned','purged')
                ) ELSE true END AS cleanup_ready
         FROM client_environment_deletion_requests d
         JOIN client_environments e ON e.env_key=d.env_key
         WHERE d.request_id=$1 FOR UPDATE OF d,e`,
        [requestId],
      );
      const row = request.rows[0];
      if (!row) { await client.query('ROLLBACK'); return { ok: false, reason: 'not_found' }; }
      if (row.target_user_id !== userId) { await client.query('ROLLBACK'); return { ok: false, reason: 'not_target' }; }
      if (row.version !== version) {
        await client.query('ROLLBACK'); return { ok: false, reason: 'request_version_mismatch' };
      }
      if (row.state === 'deleted') { await client.query('ROLLBACK'); return { ok: false, reason: 'already_completed' }; }
      if (row.state === 'deleting' && row.claimed_installation_id === installationId) {
        await client.query('COMMIT');
        return { ok: true, requestId: row.request_id, version: row.version, envKey: row.env_key,
          environmentName: row.environment_name, platform: row.platform, state: 'deleting', idempotent: true };
      }
      if (!row.cleanup_ready) { await client.query('ROLLBACK'); return { ok: false, reason: 'cleanup_pending' }; }
      const holders = await client.query<{ installation_id: string }>(
        `SELECT installation_id FROM client_environment_installations
         WHERE env_key=$1 AND user_id=$2 AND last_seen_at >= now()-interval '2 minutes'
         ORDER BY installation_id`, [row.env_key, userId],
      );
      if (holders.rows.length !== 1 || holders.rows[0]?.installation_id !== installationId) {
        await client.query('ROLLBACK');
        return { ok: false, reason: 'ambiguous_holder' };
      }
      await client.query(
        `UPDATE client_environment_deletion_requests
         SET state='deleting',claimed_installation_id=$2,claimed_at=now(),updated_at=now()
         WHERE request_id=$1`, [requestId, installationId],
      );
      await client.query(
        `UPDATE client_environments SET lifecycle_state='deleting',updated_at=now() WHERE env_key=$1`, [row.env_key],
      );
      await client.query('COMMIT');
      return { ok: true, requestId: row.request_id, version: row.version, envKey: row.env_key,
        environmentName: row.environment_name, platform: row.platform, state: 'deleting', idempotent: false };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /** Edge 终态回执：只有同一认领安装可写；成功后软删除环境并撤销 scope，账号/风控/分组保持原样。 */
  async completeEnvironmentDeletion(
    userId: string,
    requestId: string,
    version: number,
    installationId: string,
    input: { resultKey: string; status: 'succeeded' | 'failed'; resultKind?: 'deleted' | 'already_missing'; error?: string | null },
  ): Promise<CompleteEnvironmentDeletionResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const request = await client.query<{
        env_key: string; version: number; state: string; target_user_id: string | null; claimed_installation_id: string | null;
        result_key: string | null;
      }>(
        `SELECT env_key,version,state,target_user_id,claimed_installation_id,result_key
         FROM client_environment_deletion_requests WHERE request_id=$1 FOR UPDATE`, [requestId],
      );
      const row = request.rows[0];
      if (!row) { await client.query('ROLLBACK'); return { ok: false, reason: 'not_found' }; }
      if (row.target_user_id !== userId) { await client.query('ROLLBACK'); return { ok: false, reason: 'not_target' }; }
      if (row.version !== version) {
        await client.query('ROLLBACK'); return { ok: false, reason: 'request_version_mismatch' };
      }
      if (row.state === 'deleted') {
        await client.query('COMMIT');
        return row.result_key === input.resultKey
          ? { ok: true, requestId, envKey: row.env_key, state: 'deleted', idempotent: true }
          : { ok: false, reason: 'result_conflict' };
      }
      if (row.state === 'delete_failed' && row.result_key === input.resultKey) {
        await client.query('COMMIT');
        return { ok: true, requestId, envKey: row.env_key, state: 'delete_failed', idempotent: true };
      }
      if (row.claimed_installation_id !== installationId || row.state !== 'deleting') {
        await client.query('ROLLBACK');
        return { ok: false, reason: 'not_claimed' };
      }
      if (input.status === 'failed') {
        await client.query(
          `UPDATE client_environment_deletion_requests
           SET state='delete_failed',result_key=$2,result_error=$3,result_at=now(),
               claimed_installation_id=NULL,claimed_at=NULL,updated_at=now() WHERE request_id=$1`,
          [requestId, input.resultKey, (input.error ?? 'adspower_delete_failed').slice(0, 1000)],
        );
        await client.query(
          `UPDATE client_environments SET lifecycle_state='delete_failed',updated_at=now() WHERE env_key=$1`, [row.env_key],
        );
        await client.query('COMMIT');
        return { ok: true, requestId, envKey: row.env_key, state: 'delete_failed', idempotent: false };
      }
      if (input.resultKind !== 'deleted' && input.resultKind !== 'already_missing') {
        await client.query('ROLLBACK');
        return { ok: false, reason: 'result_conflict' };
      }
      await client.query(
        `INSERT INTO client_env_scope_audit
           (user_id,env_key,label,platform,source,assigned_by,assigned_at,revoked_by,reason)
         SELECT user_id,env_key,label,platform,source,assigned_by,assigned_at,$2,'admin_revoked'
         FROM client_env_scope WHERE env_key=$1 AND source='admin'
         ON CONFLICT (user_id,env_key,assigned_at,reason) DO NOTHING`,
        [row.env_key, `environment-delete:${requestId}`],
      );
      await client.query(`DELETE FROM client_env_scope WHERE env_key=$1 AND source='admin'`, [row.env_key]);
      await client.query(
        `UPDATE client_environment_deletion_requests
         SET state='deleted',result_key=$2,result_kind=$3,result_error=NULL,result_at=now(),updated_at=now()
         WHERE request_id=$1`,
        [requestId, input.resultKey, input.resultKind],
      );
      await client.query(
        `UPDATE client_environments SET lifecycle_state='deleted',deleted_at=now(),updated_at=now() WHERE env_key=$1`,
        [row.env_key],
      );
      await client.query('COMMIT');
      return { ok: true, requestId, envKey: row.env_key, state: 'deleted', idempotent: false };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
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

  async hasPendingRevocationHold(accountId: string): Promise<boolean> {
    const { rows } = await this.pool.query<{ present: boolean }>(
      `SELECT EXISTS (
         SELECT 1
           FROM interaction_auth_state a
           JOIN client_env_revocation_holds h ON h.env_key=a.env_key
          WHERE a.platform='wechat_channels' AND a.account_id=$1
       ) AS present`,
      [accountId],
    );
    return rows[0]?.present === true;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
