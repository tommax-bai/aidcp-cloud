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
 *
 * ## 环境清理的准入 / 执行分家（Block③ L3 最终一致改造）
 *
 * 环境注销这条链历史上是**一笔跨属主事务**：本文件在自己的 `BEGIN/COMMIT` 里既撤销归属（api 表），
 * 又把 api 池的事务句柄递给 automation 的离场写适配器去写离场四表。三库一拆，这笔事务不成立；
 * 更糟的是它顺带做的那几处跨库行锁**失效时没有任何错误信号**——两侧连不同库时两边各自加锁都会成功、
 * 互斥直接消失（同一教训写在 `src/db/environment-row-lock.ts` 文件头）。
 *
 * 现在拆成两件事：
 *
 * 1. **准入事实住在本域**：`client_env_revocation_holds` 由「只记缺绑定的撤权」升格为**环境清理准入表**
 *    —— 每一个未了结的清理在 api 库里有且只有一行（`UNIQUE(env_key)`），无论 automation 那边有没有
 *    台账行。于是「有清理在飞的环境不可改派」退化成**本域一张表上的条件写**（`setScope` 的那道闸），
 *    不再需要去锁 automation 的离场表。既有的 `client_env_scope_cleanup_hold_guard` 触发器随之
 *    自动覆盖整个清理窗口。`materialized_at IS NULL` = 已受理、尚未物化。
 * 2. **执行台账住在属主**：`interaction_offboards` 等四表退化为「边缘清理进行到哪一步」的执行台账，
 *    由 kernel 端口 `OffboardMaterializationOperations` 在 **automation 自己的事务**里落，
 *    幂等键是 `offboard_id`。
 *
 * 投递形态 = **事务型 outbox，且 outbox 行就是准入行本身**：准入行与归属撤销在同一笔 api 提交里落定
 * （原子），提交后由中继（`materializeAdmission` 立即推一次 + `reconcileCleanupAdmissions` 兜底轮询）
 * 交给属主，属主按 `offboard_id` 幂等落账。**刻意不另开一张通用 outbox 表**：`src/transport/event-outbox.ts`
 * 那张 `event_outbox` 属 automation 单写，api 拆出去后照样写不了它；而准入行本来就必须存在、
 * 且逐字携带属主需要的全部载荷，再复制一份等于凭空造出「两行必须一致」的新问题。
 *
 * **不一致窗口的上界** = 一次兜底轮询周期（组合根 60s）+ 一次属主事务；窗口内的表现是
 * 「api 侧已拒绝改派、automation 侧尚无台账」——**只多拒不误放**，方向安全。
 */

import crypto from 'node:crypto';
import pg from 'pg';
import { resolveEnvPgConfig } from '../kernel/pg-config.js';
import { lockEnvironmentRow } from '../db/environment-row-lock.js';
import { generateKey, hashKey, verifyKey, decoyVerify } from './key.js';
import { RETIRED_ACCOUNT_ID } from '../account-store.js';
import { shanghaiDayStartMs } from '../time/shanghai-day.js';
import { resolveAccountDisplayName } from '../account-display-name.js';
import { isMirrorStale, type ConfigMirrorKey } from '../config-mirror-freshness.js';
import { writeWithMirrorBump, type MirrorVersionBumper } from '../config/mirror-version-store.js';
import type { SchemaEnsurer } from '../kernel/schema-capability-contract.js';
import type { ClientEnvAutomationReader, OffboardProjection } from '../kernel/client-env-automation-types.js';
import type { OffboardCleanupGrantOperations } from '../kernel/offboard-cleanup-grant-types.js';
import type { OffboardMaterializationOperations } from '../kernel/offboard-materialization-types.js';

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
-- 环境清理**准入表**（api 属主的权威事实：这个环境是不是正在清理 / 已被撤权）。
-- 历史名字 client_env_revocation_holds 保留（改名要动生产表，代价远大于收益），但含义已升格：
-- 每一个未了结的清理在本库里有且只有一行（UNIQUE(env_key)），无论 automation 那边有没有执行台账行。
-- 于是「有清理在飞的环境不可改派」是本域一张表上的条件写，不再需要跨库锁 automation 的离场表；
-- 下方那个触发器也因此自动覆盖整个清理窗口。改造前 reason 只有两值、user_id 不可空，见 0075。
-- 新列一律**内联在建表语句里**（不另起 ALTER）：运行时 DDL 是只减不增的棘轮，
-- 加列的权威动作在 migrations/0075；这里只是「本存储需要什么形状」的声明，供启动期探测。
CREATE TABLE IF NOT EXISTS client_env_revocation_holds (
  revocation_id       UUID        PRIMARY KEY,
  env_key             TEXT        NOT NULL UNIQUE,
  user_id             TEXT,
  reason              TEXT        NOT NULL CHECK (reason IN ('environment_unbind','customer_terminated','admin_revoked')),
  revoked_by          TEXT,
  -- 属主台账里那条离场记录的 id（api 侧预生成，同时是投递幂等键）。
  offboard_id         TEXT,
  -- NULL = 已受理、尚未物化（属主尚未落台账）。对外状态 'accepted' 就读这一列。
  materialized_at     TIMESTAMPTZ,
  -- 无互动绑定时是否允许属主直接落终态 tombstone（只有客户自助建号那条路允许）。
  unbound_terminal_ok BOOLEAN     NOT NULL DEFAULT false,
  requested_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
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

/**
 * 一条离场的对外视图。
 *
 * `state: 'accepted'` = **已受理、尚未物化**：api 侧已经原子地落下准入并撤销归属，属主侧台账还没写成。
 * 这个词是本 change 新增的，补的正是「对一笔已经被接受的离场答 404」这个静默假成功的镜像——
 * 让调用方以为什么都没发生。它出现在两种情形：投递刚提交尚未落账（毫秒级），或属主暂时不可达。
 *
 * accepted 态下 `accountId` / `purgeDueAt` 为 **null**：这两个字段是属主在自己的事务里解析出来的，
 * api 侧此刻不知道，**MUST NOT 编造**（拿一个可能过期的快照值填进去，比 null 更糟）。
 */
export interface ClientOffboardView {
  offboardId: string;
  envKey: string;
  /** null = 尚未物化，属主还没解析出绑定账号。绝不编造。 */
  accountId: string | null;
  state: 'accepted' | 'pending_edge' | 'dispatched' | 'tombstoned' | 'purged';
  reason: 'environment_unbind' | 'customer_terminated' | 'admin_revoked';
  requestedAt: number;
  /** null = 尚未物化（清除期限由属主写台账时定）。 */
  purgeDueAt: number | null;
}

/**
 * 清理准入已落、但还没有执行台账行的回执。
 *
 * `state` 两值：`binding_missing` = 属主已确认该环境**确实没有互动授权绑定**（今天唯一的取值）；
 * `accepted` = 本次没能问到属主（端口报错），**未知不当作已知**，等对账循环重试。
 * `kind` 保持 `binding_missing` 不变以免打断既有面板消费方。
 */
export interface ClientCleanupHoldView {
  kind: 'binding_missing';
  revocationId: string;
  envKey: string;
  state: 'binding_missing' | 'accepted';
  reason: 'environment_unbind' | 'customer_terminated' | 'admin_revoked';
  requestedAt: number;
}

export type ClientCleanupReceipt =
  | ClientCleanupHoldView
  | ({ kind: 'offboard_pending' } & ClientOffboardView);

/**
 * 环境清理准入行（api 属主 `client_env_revocation_holds` 的裸行）。
 * 它同时是**投递载荷**：属主物化台账所需的每个字段都在这里，故不另开 outbox 表（见文件头）。
 * `user_id` 可空——从执行台账反向认领来的准入行不知道发起客户，而 MUST NOT 编造一个。
 */
interface AdmissionRow {
  revocation_id: string;
  env_key: string;
  user_id: string | null;
  reason: ClientOffboardView['reason'];
  revoked_by: string | null;
  offboard_id: string;
  unbound_terminal_ok: boolean;
  materialized_at: Date | null;
  requested_at: Date;
}

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
  /** schema 保障能力注入端口（必填、无默认）：组合根传 automation 的 ensureCapabilitySchema，本文件只从 kernel 取类型。 */
  schemaEnsurer: SchemaEnsurer;
  /**
   * 跨进程失效通道（change config-mirror-cross-process-invalidation task 2.4）：
   * 环境慢启动锚点与环境自动化出口闸都是**闸门镜像**，写入须在同事务推进版本。
   * 缺省 = 不推版本（行为逐位退回今日现状）。
   */
  mirrorVersionBumper?: MirrorVersionBumper;
  /**
   * 离场**执行台账**的属主侧操作端口（Block③ L3 最终一致改造）。生产由组合根 server.ts 注入
   * automation 的实现（持 automation 池、自开事务）；缺省 = 不注入，只有真正走到物化路径时才当场
   * 抛错（fail-loud，绝非静默假成功）。不触发离场路径的调用方无需注入。
   *
   * 与改造前 `offboardWrites` 的关键差别：那个端口的方法**接调用方的事务句柄**（于是 api 的连接
   * 去跑 automation 的 SQL，拆库即崩或写进错的库）；本端口不接句柄、自成一笔事务。
   */
  offboardMaterialization?: OffboardMaterializationOperations;
  /**
   * automation 属主表（离场记录 / 微信互动授权绑定 / 风控态）的**只读投影端口**
   * （Block③ 物理拆库 L3）。生产由组合根 server.ts 按运行模式注入；本文件只从 kernel 取类型，
   * **绝不直连 automation 的库、也不知道其表结构**。
   *
   * 缺省 = 不注入，只有真正走到跨域读路径时才当场抛具名错（fail-loud，绝非静默假成功 / 假空集）——
   * 与同类 `offboardWrites` 逐字同范式：本类构造点 30+（多数只碰 api 属主表、从不触达跨域读），
   * 必填只会把噪声摊到全部构造点，而端口缺失的失败模式在两种写法下都是「当场响亮报错」。
   */
  automationReads?: ClientEnvAutomationReader;
  /**
   * 离场清理授权的**属主侧操作**端口（Block③ L3）。签发 / 烧票这两笔事务碰的表全是 automation 属主，
   * 故整体收回属主域：由属主自己开事务、跑自己的池，本类只转调、不再持有事务。
   * 与 `offboardWrites` 的区别：那个端口的方法接调用方事务句柄（那些写与 api 侧归属收权共提交、
   * 是真跨域事务，仍待最终一致重设计）；本端口不接句柄、自成一笔事务。
   *
   * 缺省 = 不注入，走到该路径即当场抛具名错（fail-loud）。
   * ⚠️ 与改动前的一处差异（**非生产路径**）：改动前 `consumeOffboardCleanupGrant` 对一个不存在的
   * offboardId 会在完全不触达端口的情况下返回 `not_found`；现在整个方法一进门就要端口，
   * 未注入时抛错而非返 `not_found`。生产组合根恒注入，故现网无影响。
   */
  cleanupGrantOps?: OffboardCleanupGrantOperations;
}

/**
 * 环境自动化出口闸读取结果（三态，task 4.7）。
 * `unknown` = 出口闸副本已超过陈旧上限，无法确认该环境是否正处于删除生命周期 →
 * MUST NOT 向该环境下发普通自动化命令（把未知当"允许"就是对一个正在被删的环境继续发指令）。
 */
export type EnvironmentAutomationGate = 'allowed' | 'blocked' | 'unknown';

export type ClientApprovalReachability =
  | { reachable: true; reason: 'reachable' }
  | { reachable: false; reason: 'no_enabled_client_binding' | 'unavailable' };

export interface ClientApprovalGroupCoverage {
  groupLabel: string;
  activeAccountCount: number;
  reachableAccountCount: number;
}

export class ClientUserStore {
  private readonly pool: pg.Pool;
  private readonly mirrorVersionBumper?: MirrorVersionBumper;
  private readonly offboardMaterialization?: OffboardMaterializationOperations;
  private readonly automationReads?: ClientEnvAutomationReader;
  private readonly cleanupGrantOperations?: OffboardCleanupGrantOperations;
  /** 同步 WS 出口闸镜像：删除生命周期中的 AdsPower env 不再接收普通自动化命令。 */
  private blockedAutomationEnvKeys = new Set<string>();
  /** RiskController 同步热路径镜像：只收录当前恰好绑定一个环境的账号。 */
  private environmentSlowStartByAccount = new Map<string, number | null>();
  private ambiguousEnvironmentAccounts = new Set<string>();

  private readonly schemaEnsurer: SchemaEnsurer;

  constructor(options: ClientUserStoreOptions) {
    this.schemaEnsurer = options.schemaEnsurer;
    this.mirrorVersionBumper = options.mirrorVersionBumper;
    this.pool = options.pool ?? new Pool(resolveEnvPgConfig());
    this.offboardMaterialization = options.offboardMaterialization;
    this.automationReads = options.automationReads;
    this.cleanupGrantOperations = options.cleanupGrantOps;
  }

  /**
   * automation 属主表的只读投影端口（Block③ L3）：未注入即当场抛错，
   * 绝不静默回落到「直连本地池自己查 automation 的表」，也绝不假装空集。
   */
  private automationRead(): ClientEnvAutomationReader {
    if (!this.automationReads) throw new Error('client_env_automation_read_port_not_configured');
    return this.automationReads;
  }

  /** 离场清理授权操作端口（automation 属主）：未注入即当场抛错，绝不静默跳过授权副作用。 */
  private cleanupGrantOps(): OffboardCleanupGrantOperations {
    if (!this.cleanupGrantOperations) throw new Error('offboard_cleanup_grant_ops_not_configured');
    return this.cleanupGrantOperations;
  }

  /** 离场执行台账的属主侧操作端口：未注入即当场抛错，绝不静默跳过离场副作用。 */
  private offboardOps(): OffboardMaterializationOperations {
    if (!this.offboardMaterialization) throw new Error('offboard_materialization_port_not_configured');
    return this.offboardMaterialization;
  }

  private mapProjection(row: OffboardProjection): ClientOffboardView {
    return {
      offboardId: row.offboardId, envKey: row.envKey, accountId: row.accountId,
      state: row.state, reason: row.reason, requestedAt: row.requestedAt, purgeDueAt: row.purgeDueAt,
    };
  }

  /** 已受理、尚未物化的对外视图：属主还没解析出账号与清除期限，这两项 MUST 为 null。 */
  private acceptedView(row: AdmissionRow): ClientOffboardView {
    return {
      offboardId: row.offboard_id, envKey: row.env_key, accountId: null,
      state: 'accepted', reason: row.reason, requestedAt: row.requested_at.getTime(), purgeDueAt: null,
    };
  }

  private holdView(row: AdmissionRow, state: ClientCleanupHoldView['state']): ClientCleanupHoldView {
    return {
      kind: 'binding_missing', revocationId: row.revocation_id, envKey: row.env_key,
      state, reason: row.reason, requestedAt: row.requested_at.getTime(),
    };
  }

  /**
   * 在调用方的 **api 事务**里写下一条环境清理准入（本域权威事实 + 投递载荷，同一笔提交 ⇒ 原子）。
   *
   * `ON CONFLICT (env_key) DO UPDATE SET updated_at=（原值）` 是**幂等命中**：该环境已有未了结的清理时
   * 原样交回既有那条（含它的 offboard_id 与 reason），既不覆盖也不新建——与改造前 hold 的写法逐字同。
   * 本方法只碰 api 属主表，不做任何跨域调用；物化在**提交之后**才发生。
   */
  private async enqueueAdmission(
    client: pg.PoolClient,
    input: { userId: string; envKey: string; reason: ClientOffboardView['reason']; actor: string | null;
      unboundTerminalOk: boolean },
  ): Promise<AdmissionRow> {
    const { rows } = await client.query<AdmissionRow>(
      `INSERT INTO client_env_revocation_holds
         (revocation_id,env_key,user_id,reason,revoked_by,offboard_id,unbound_terminal_ok,requested_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,now(),now())
       ON CONFLICT (env_key) DO UPDATE
         SET updated_at=client_env_revocation_holds.updated_at
       RETURNING revocation_id,env_key,user_id,reason,revoked_by,offboard_id,unbound_terminal_ok,
                 materialized_at,requested_at`,
      [crypto.randomUUID(), input.envKey, input.userId, input.reason, input.actor,
        crypto.randomUUID(), input.unboundTerminalOk],
    );
    const row = rows[0];
    if (!row) throw new Error('revocation_hold_insert_failed');
    return row;
  }

  /**
   * 中继：把一条已提交的准入交给属主物化，并把回执记回 api 侧准入行。
   *
   * 三种结局都**如实**回报，绝无第四种「看起来成功」：
   *   - 属主落了台账 → 记回 offboard_id + materialized_at，回 `offboard` 视图；
   *   - 属主确认该环境尚无互动绑定 → 保留准入行不动，回 `binding_missing` 回执（等对账重试）；
   *   - 端口不可达 / 抛错 → **未知不当作已知**，回 `accepted` 回执，准入行留着让对账循环重放。
   *
   * 幂等：属主侧按 `(platform, env_key)` 与 `offboard_id` 幂等；本侧回执写入是单条 UPDATE。
   * 「属主已提交、回执没记上」的窗口由对账循环收敛（它会重放同一条准入，属主原样交回同一行）。
   */
  private async materializeAdmission(
    row: AdmissionRow,
  ): Promise<{ offboard?: ClientOffboardView; receipt: ClientCleanupReceipt }> {
    let outcome: Awaited<ReturnType<OffboardMaterializationOperations['materializeEnvironmentOffboard']>>;
    try {
      outcome = await this.offboardOps().materializeEnvironmentOffboard({
        offboardId: row.offboard_id,
        envKey: row.env_key,
        userId: row.user_id ?? '',
        reason: row.reason,
        actor: row.revoked_by,
        unboundTerminalAllowed: row.unbound_terminal_ok,
      });
    } catch (error) {
      console.warn(
        `[client-env] 离场台账物化未完成（准入已落，稍后由对账循环重放）env=${row.env_key}: `
        + `${error instanceof Error ? error.message : String(error)}`,
      );
      return { receipt: this.holdView(row, 'accepted') };
    }
    if (!outcome.materialized) return { receipt: this.holdView(row, 'binding_missing') };
    await this.pool.query(
      `UPDATE client_env_revocation_holds
          SET offboard_id=$2,materialized_at=now(),updated_at=now()
        WHERE revocation_id=$1`,
      [row.revocation_id, outcome.offboard.offboardId],
    );
    const offboard = this.mapProjection(outcome.offboard);
    return { offboard, receipt: { kind: 'offboard_pending', ...offboard } };
  }

  /** Customer-authorized relinquish: revoke scope and stop Cloud sync/write in the same transaction as durable offboard creation. */
  async beginEnvironmentOffboard(userId: string, envKey: string): Promise<BeginOffboardResult> {
    const key = (envKey ?? '').trim();
    if (!userId || !key) return { ok: false, reason: 'not_authorized' };
    // 「无绑定且非自助建号 ⇒ 拒绝解绑」这一判定要读 automation 的绑定。改造前它是事务内的跨库行锁，
    // 拆库后那把锁会无声失效；现在改成**事务外、无锁**的端口读，互斥由下方本域准入行的条件写承担。
    // 端口读失败 MUST 抛（不 catch）：把它降级成「没绑定」会让一次连接抖动看起来像一条业务事实。
    const boundAccountId = await this.automationRead().boundAccountForEnv(key, 'wechat_channels');
    const client = await this.pool.connect();
    let admission: AdmissionRow;
    try {
      await client.query('BEGIN');
      const user = await client.query<{ status: string }>(
        `SELECT status FROM client_users WHERE user_id=$1 FOR UPDATE`, [userId],
      );
      if (user.rows[0]?.status !== 'enabled') {
        await client.query('ROLLBACK');
        return { ok: false, reason: user.rows[0] ? 'disabled' : 'not_authorized' };
      }
      // 环境级串行（change publish-approval-signal-to-database §5）：用**被保护数据所在表的行锁**，
      // 不用库级 advisory lock（后者两侧连不同库时两边都能加上、互斥无声消失）。
      // 注：本路径下方 JOIN 了 client_environments，故该行必然存在；无注册环境 = 无可串行的对手。
      await lockEnvironmentRow(client, key);
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
      if (!boundAccountId) {
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
      }
      admission = await this.enqueueAdmission(client, {
        userId, envKey: key, reason: 'environment_unbind', actor: `client:${userId}`,
        // 终态 tombstone 只在「确无绑定」这一支放行；有绑定时属主必须走真离场。
        unboundTerminalOk: !boundAccountId,
      });
      await client.query(
        `INSERT INTO client_env_scope_audit
           (user_id,env_key,label,platform,source,assigned_by,assigned_at,revoked_at,revoked_by,reason)
         VALUES ($1,$2,$3,$4,$5,$6,$7,now(),$8,'environment_unbind')
         ON CONFLICT (user_id,env_key,assigned_at,reason) DO NOTHING`,
        [userId, key, row.label, row.platform, row.source, row.assigned_by, row.assigned_at, `client:${userId}`],
      );
      await client.query(`DELETE FROM client_env_scope WHERE user_id=$1 AND env_key=$2 AND source='admin'`, [userId, key]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
    // 提交之后立刻推一次（进程内中继）：常态下响应里仍是物化完成的真视图，与改造前逐字同形。
    const materialized = await this.materializeAdmission(admission);
    return { ok: true, offboard: materialized.offboard ?? this.acceptedView(admission) };
  }

  /**
   * 单条离场的对外状态。
   *
   * 先问属主台账（物化后的真态）；台账没有再看 **api 侧准入行** —— 那条准入若还在且尚未物化，
   * 答案是 `accepted`（已受理、尚未物化），**MUST NOT 答 not_found**。对一笔已经被接受的离场答
   * 「查无此项」是静默假成功的镜像：让调用方以为什么都没发生，而归属其实已经撤销了。
   *
   * 顺序不可颠倒：台账优先保证物化后拿到的是真状态；准入行在物化后仍在（它要一直挡住改派直到清除），
   * 先读它会把已物化的离场也报成 accepted。
   */
  async getOffboard(userId: string, offboardId: string): Promise<ClientOffboardView | null> {
    const row = await this.automationRead().offboardForUser(offboardId, userId);
    if (row) return this.mapProjection(row);
    const { rows } = await this.pool.query<AdmissionRow>(
      `SELECT revocation_id,env_key,user_id,reason,revoked_by,offboard_id,unbound_terminal_ok,
              materialized_at,requested_at
         FROM client_env_revocation_holds
        WHERE offboard_id=$1 AND user_id=$2 AND materialized_at IS NULL`,
      [offboardId, userId],
    );
    return rows[0] ? this.acceptedView(rows[0]) : null;
  }

  /**
   * 签发离场清理授权（Block③ L3：整个操作已收回 automation 属主域）。
   *
   * 这两笔事务碰的表**全是 automation 属主**（离场记录 + 离场审计），一张 api 表都没有——
   * 它们原本是「由 api 的代码 BEGIN 出一条 api 连接、再把句柄递给 automation 写适配器」的形态，
   * 拆库后那条连接跑不了 automation 的 SQL。故整体经端口下沉：由属主自己开事务、跑自己的池。
   * 本层只做参数转发与对外判别式映射，**不再持有任何事务**。
   *
   * 明文票据绝不落库、绝不进审计行；这里只传票据身份的哈希。
   */
  async registerOffboardCleanupGrant(input: {
    userId: string;
    offboardId: string;
    edgeId: string;
    jtiHash: string;
    expiresAt: number;
  }): Promise<boolean> {
    return this.cleanupGrantOps().issueCleanupGrant({
      offboardId: input.offboardId, userId: input.userId, edgeId: input.edgeId,
      jtiHash: input.jtiHash, expiresAt: input.expiresAt,
    });
  }

  /**
   * 原子核验并烧掉离场清理授权（同上，已收回属主域）。
   *
   * 判定顺序、失败也提交（拒绝审计留痕）、以及「取行加锁与烧票同事务」这三条不变量落在属主实现里
   * （见 kernel/offboard-cleanup-grant-types.ts 文件头）。本层只把属主投影映射成对外判别式，
   * 并把 `edgeId` 原样回填——它是本次请求的入参，不从库里读回。
   */
  async consumeOffboardCleanupGrant(input: {
    userId: string;
    offboardId: string;
    envKey: string;
    accountId: string;
    edgeId: string;
    jtiHash: string;
    now?: number;
  }): Promise<ConsumeOffboardCleanupGrantResult> {
    const outcome = await this.cleanupGrantOps().consumeCleanupGrant({
      userId: input.userId, offboardId: input.offboardId, envKey: input.envKey,
      accountId: input.accountId, edgeId: input.edgeId, jtiHash: input.jtiHash,
      now: input.now ?? Date.now(),
    });
    if (!outcome.ok) return { ok: false, reason: outcome.reason };
    return { ok: true, edgeId: input.edgeId, offboard: { ...outcome.offboard } };
  }

  async init(): Promise<void> {
    // DDL 单一所有者（change cloud-schema-migration-executor 任务 5.x）：只探测、不建表。
    // 探不到即带 version id 明确报错并 fail-closed；MUST NOT 在这里把表建出来继续跑。
    await this.schemaEnsurer(this.pool, {
      capability: 'client_identity',
      sinceVersion: '0065_baseline_identity_tables',
      ddl: [CLIENT_USERS_SCHEMA_SQL],
    });
    await this.refreshAutomationGateMirror();
    await this.refreshEnvironmentSlowStartMirror();
  }

  /**
   * 独立事务推进一次镜像版本——**仅供本身不在事务内的批量维护写**（如一次性回灌迁移）使用。
   * 常规配置写入 MUST 走 `writeWithMirrorBump`（同事务），绝不用本方法代替。
   */
  private async bumpMirrorBestEffort(mirrorKey: ConfigMirrorKey): Promise<void> {
    if (!this.mirrorVersionBumper) return;
    try {
      await this.mirrorVersionBumper.bumpInTx(this.pool, mirrorKey);
      this.mirrorVersionBumper.notifyAfterCommit?.(mirrorKey);
    } catch (err) {
      console.warn(
        `[client-env] 镜像版本推进失败 mirror=${mirrorKey}（其它进程将等到下一次写入才失效）: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /** 重建环境自动化出口闸镜像（构建新 Set → 原子替换引用，防并发现读撞上半填）。 */
  async refreshAutomationGateMirror(): Promise<void> {
    const blocked = await this.pool.query<{ env_key: string }>(
      `SELECT env_key FROM client_environments WHERE lifecycle_state <> 'active'`,
    );
    this.blockedAutomationEnvKeys = new Set(blocked.rows.map((row) => row.env_key));
  }

  /** 跨进程失效刷新入口（task 3.2）：出口闸镜像。只由刷新器在版本变化时调用。 */
  async refreshAutomationGateFromAuthority(): Promise<void> {
    await this.refreshAutomationGateMirror();
  }

  /** 跨进程失效刷新入口（task 3.2）：慢启动锚点镜像。只由刷新器在版本变化时调用。 */
  async refreshSlowStartFromAuthority(): Promise<void> {
    await this.refreshEnvironmentSlowStartMirror();
  }

  /**
   * WebSocket 传输层同步闸（**三态**，task 4.7）；不产生删除命令，只在 Cloud 内部抑制删除环境的
   * 普通自动化下发。
   *
   * 副本陈旧 → `unknown`：跨进程副本下「副本里没有这个 env」≠「库里它还是 active」。把未知当允许，
   * 等于对一个正处于删除生命周期的环境继续下发自动化命令。调用方 MUST 按停手处理。
   *
   * **本方法是纯取值口，不记账**：它被每一条出站信封调用（热路径），而拒绝记账每次要落一条 PG 写；
   * 而且这里返回 `unknown` 并不等于真的拒绝了什么——调用方对控制/收尾类信封仍会放行。记账收口在
   * 真正的拒绝点（`server.ts` 的出口闸只在拦下时记一次），否则指标会被纯读取值淹没、且写压会在
   * 权威不可达时堆到刷新器自我恢复所依赖的同一个连接池上。
   */
  automationGateForEdgeId(edgeId: string): EnvironmentAutomationGate {
    const normalized = edgeId.trim();
    if (!normalized.startsWith('ads-')) return 'allowed'; // 非 AdsPower 环境不在本闸作用域内
    if (isMirrorStale('client_environment_automation_gate')) return 'unknown';
    return this.blockedAutomationEnvKeys.has(normalized.slice('ads-'.length)) ? 'blocked' : 'allowed';
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
    // 慢启动锚点是闸门镜像：一次性回灌同样要推进版本，否则另一 target 的进程到重启前看不到。
    await this.bumpMirrorBestEffort('client_environment_slow_start');
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

  /**
   * RiskController 同步、零 IO 现读；无绑定/歧义/关闭均返回 null。
   *
   * **本方法保持二值返回**（`AccountNurtureProvider` 契约在 `src/risk/types.ts`，属并行 change
   * `risk-state-cross-process-integrity` 的独占范围，本 change 不动它）。副本陈旧这一态由
   * `RiskController.resolveNurtureAnchor()` 直接经 `mirrorStateOf('client_environment_slow_start')`
   * 判读——见那里的注释：读不到 MUST NOT 被当成「未开启慢启动」（= 满配额）。
   */
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
      // 写库与版本推进同事务：写库失败 → 回滚 → 版本不进、镜像不刷。
      const result = await writeWithMirrorBump(
        this.pool,
        this.mirrorVersionBumper,
        'client_environment_slow_start',
        (q) =>
          q.query(
            `UPDATE client_environments e
            SET slow_start_since=$3, slow_start_initialized=true, updated_at=now()
          WHERE e.env_key=$2
            AND EXISTS(SELECT 1 FROM client_env_scope s
                        WHERE s.user_id=$1 AND s.env_key=e.env_key AND s.source='admin')
        RETURNING e.env_key`,
            [userId, key, value],
          ),
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
      // 新环境带 slow_start_since 落库 = 慢启动锚点这个**闸门镜像**变了：同事务推进版本，
      // 否则另一 target 的进程到重启前都把这个新号当「未开启慢启动」= 满配额跑。
      await this.mirrorVersionBumper?.bumpInTx(client, 'client_environment_slow_start');
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
   * 管理/发送侧反向判据：账号是否存在一条客户稿件审核可达链。
   *
   * customer-auth 的真实边界是 enabled user + admin scope + active environment +
   * authoritative environment.account_id。这里只证明持久 HTTP 数据面可达，不检查
   * WebSocket、浏览器或自动化引擎在线状态。
   */
  async hasEnabledClientApprovalReachability(accountId: string): Promise<ClientApprovalReachability> {
    const account = (accountId ?? '').trim();
    if (!account) return { reachable: false, reason: 'no_enabled_client_binding' };
    try {
      const { rows } = await this.pool.query<{ reachable: boolean }>(
        `SELECT EXISTS (
           SELECT 1
             FROM client_environments e
             JOIN client_env_scope s ON s.env_key=e.env_key AND s.source='admin'
             JOIN client_users u ON u.user_id=s.user_id AND u.status='enabled'
             JOIN accounts a ON a.account_id=e.account_id
            WHERE e.account_id=$1 AND e.lifecycle_state='active'
         ) AS reachable`,
        [account],
      );
      return rows[0]?.reachable === true
        ? { reachable: true, reason: 'reachable' }
        : { reachable: false, reason: 'no_enabled_client_binding' };
    } catch (error) {
      if (isMissingTable(error)) return { reachable: false, reason: 'unavailable' };
      throw error;
    }
  }

  /** JWT panel only: group policy coverage summary, derived from the same reachability facts. */
  async listClientApprovalCoverageByGroup(): Promise<ClientApprovalGroupCoverage[]> {
    try {
      const { rows } = await this.pool.query<{
        group_label: string; active_account_count: string | number; reachable_account_count: string | number;
      }>(
        `SELECT btrim(a.group_label) AS group_label,
                count(*) AS active_account_count,
                count(*) FILTER (WHERE EXISTS (
                  SELECT 1
                    FROM client_environments e
                    JOIN client_env_scope s ON s.env_key=e.env_key AND s.source='admin'
                    JOIN client_users u ON u.user_id=s.user_id AND u.status='enabled'
                   WHERE e.account_id=a.account_id AND e.lifecycle_state='active'
                )) AS reachable_account_count
           FROM accounts a
          WHERE a.status='active' AND a.group_label IS NOT NULL AND btrim(a.group_label)<>''
          GROUP BY btrim(a.group_label)
          ORDER BY btrim(a.group_label)`,
      );
      return rows.map((row) => ({
        groupLabel: row.group_label,
        activeAccountCount: Number(row.active_account_count),
        reachableAccountCount: Number(row.reachable_account_count),
      }));
    } catch (error) {
      if (isMissingTable(error)) return [];
      throw error;
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
      // 改造前这里是一条四表 JOIN + `FOR SHARE OF s,e,a,acc` —— 全仓唯一一处一次钉住跨两个属主
      // 四张表的语句。拆库后 a（automation 的授权绑定）那一段既连不到、锁也不可能成立，
      // 故拆成两步：**本域三张表照旧在事务里钉住**，绑定改经端口问属主要。
      const scope = await client.query<{ platform: string | null }>(
        `SELECT e.platform
         FROM client_env_scope s
         JOIN client_environments e ON e.env_key = s.env_key
         WHERE s.user_id = $1 AND s.env_key = $2
           AND s.source = 'admin' AND e.lifecycle_state = 'active'
         FOR SHARE OF s, e`,
        [userId, key],
      );
      const platform = scope.rows[0]?.platform;
      if (!platform) {
        await client.query('ROLLBACK');
        return { ok: false, reason: 'not_authorized' };
      }
      // 端口读失败 MUST 抛（下方 catch 只吞 42P01 缺表，不吞端口错）：这一步的返回值是**授权判定**，
      // 把它降级成「没绑定」只是从放行变成拒绝，看着安全，实则把故障伪装成业务事实、藏住真原因。
      const accountId = await this.automationRead().boundAccountForEnv(key, platform);
      if (!accountId) {
        await client.query('ROLLBACK');
        return { ok: false, reason: 'not_authorized' };
      }
      // 账号主数据属 api：存在性与平台一致性照旧在**本事务内**钉住（原查询的 acc 这一段）。
      const account = await client.query(
        `SELECT 1 FROM accounts WHERE account_id = $1 AND platform = $2 FOR SHARE`,
        [accountId, platform],
      );
      if (!account.rows[0]) {
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
    const admissions: AdmissionRow[] = [];
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
        // 逐个按 env_key 升序取行锁：**取锁顺序与改动前逐字相同**（死锁序不回归）。
        // 注：本查询对注册表是 **LEFT JOIN**，故注册行缺失时下方循环照样继续；那种情形下环境行锁取不到，
        // 与首写侧的互斥改由上面这条 `FOR UPDATE OF s` 持有的归属行承担（首写侧会回落去锁同一批行）。
        for (const envKey of scopes.rows.map((scope) => scope.env_key).sort()) {
          await lockEnvironmentRow(client, envKey);
        }
        // 改造前这里每个环境都要在 api 事务里**跨库**取一次绑定并加行锁，据此分「建离场」还是「挂 hold」。
        // 现在一律只写本域准入行（两种情形本来就共用同一张表），由谁来分叉交给属主在自己的事务里判——
        // 它是唯一能对绑定加锁的一方。物化在提交之后。
        for (const scope of scopes.rows) {
          if (scope.platform !== 'wechat_channels' && scope.registry_platform !== 'wechat_channels') continue;
          admissions.push(await this.enqueueAdmission(client, {
            userId, envKey: scope.env_key, reason: 'customer_terminated', actor: updatedBy,
            unboundTerminalOk: false,
          }));
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
    // 提交之后逐条推给属主（进程内中继）；推不动的留在准入表里由对账循环重放，回执如实降级。
    for (const admission of admissions) {
      const materialized = await this.materializeAdmission(admission);
      if (materialized.offboard) offboards.push(materialized.offboard);
      cleanup.push(materialized.receipt);
    }
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
   * 环境花名册窄写口的 **api 侧实现**（change env-table-write-collection）。
   *
   * 归属：`client_environments`（环境花名册与绑定事实）按拆分方案 §5.1 由 **aidcp-api 单写**；
   * §5.1 明确「**自动化握手回写 MUST 改为经 api 的窄内部接口，MUST NOT 直写该表**」。本方法即那个
   * 「窄内部接口」在 api 侧的落点：automation 侧（边缘网关握手路径）经 `EnvironmentRegistryPort`
   * （`src/comm/ws-server.ts`，形态同构 `AccountOwnershipPort`）调用它、**绝不自拼本表 SQL**。
   * 拆进程后本方法退到 aidcp-api 服务内、由一次内部 HTTP 触达，automation 调用点不变。
   *
   * 语义 = 单条观测走既有 `registerEnvironments([obs], 'auto')`（幂等 upsert + 「来了新值才覆盖」
   * 的账号绑定合并 + D5 跨客户写闸），**行为与收口前逐字等价**——只是把「automation 直调宽方法」
   * 换成「经窄口调本方法」。写入条数由内部统计，调用方不需要。
   */
  async registerHandshakeEnvironment(observation: {
    envKey: string;
    label: string | null;
    platform: string | null;
    accountId: string | null;
  }): Promise<void> {
    await this.registerEnvironments([observation], 'auto');
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
      // 绑定变化 → 慢启动锚点按账号的解析结果随之变化（含「歧义」判定）。本进程刷镜像之外，
      // 还要推进版本让别的 target 的进程失效重载。
      await this.bumpMirrorBestEffort('client_environment_slow_start');
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
   * 账号 → 环境键（`resolveBoundAccountForEnv` 的反向；给授权记录补 `envKey` 用，
   * change publish-approval-signal-to-database）。
   *
   * **有且仅有一个活跃绑定时才返回**：一个账号绑在多个活跃环境上是歧义（也是既有的跨环境争用告警形态），
   * 此时返回 null 让 `env_key` 留空 —— 猜一个写进审计记录比留空更坏。表缺失同样返回 null（读侧降级，
   * 绝不因此阻断授权写入）。
   */
  async envKeyForAccount(accountId: string): Promise<string | null> {
    const id = (accountId ?? '').trim();
    if (!id) return null;
    try {
      const { rows } = await this.pool.query<{ env_key: string }>(
        `SELECT env_key FROM client_environments
          WHERE account_id = $1 AND lifecycle_state = 'active'
          ORDER BY env_key
          LIMIT 2`,
        [id],
      );
      return rows.length === 1 ? rows[0].env_key : null;
    } catch (err) {
      if (isMissingTable(err)) return null;
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
   *
   * **Block③ L3（读侧解耦）**：本读原是一条横跨 api 与 automation 两域表的巨型聚合。现拆为三步——
   * ① 经端口取 automation 的未清除离场记录（既作环境键并集的一支，也作清理回执的来源）；
   * ② 本地只聚合 api 属主表（注册表 / 归属 / 客户 / 账号 / 删除请求 / 安装 / 撤权 hold）；
   * ③ 经端口批量取风控态，按 accountId 本地合入。
   * 等价性：离场表对 (platform, env_key) 在未清除态上唯一、`risk_state` 以 account_id 为主键 ⇒
   * 原两处 LEFT JOIN 均 1:1、不放大行数，故「缺行 = null / 无回执」的语义逐字保留，行数与排序不变。
   * 快照：三次查询不再是同一快照，但环境键并集与清理回执取自**同一份**离场投影，两者自洽；
   * 风控态是纯展示字段，读偏差最多让某账号的风控徽章晚一拍。唯一可见的窗口是 hold 与离场记录
   * **分属两次读**：撤权对账恰好在两次读之间把 hold 换成离场记录时，本页该环境的清理回执可能短暂为空
   * （原单快照下必现其一）。纯展示、下次刷新即自愈；**注册表本身的行不会因此消失**——环境键并集里
   * 那一支取自离场投影，注册行已删的环境照样列出，与原 CTE 分支同。
   */
  async listAllEnvironments(): Promise<ClientEnvironmentView[]> {
    try {
      // automation 属主：未清除的微信离场记录。环境键并集的第四支 + 下方清理回执，共用这一份。
      const activeOffboards = await this.automationRead().activeWechatOffboards();
      const offboardByEnvKey = new Map(activeOffboards.map((row) => [row.envKey, row]));
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
      }>(
        // 第四支环境键由端口提供（原为 `SELECT env_key FROM interaction_offboards WHERE …`），
        // 谓词与那份投影同源；空数组时 unnest 产 0 行，与原「无未清除离场记录」逐字同。
        `WITH keys AS (
           SELECT env_key FROM client_environments
           UNION
           SELECT env_key FROM client_env_scope
           UNION
           SELECT env_key FROM client_env_revocation_holds
           UNION
           SELECT unnest($1::text[]) AS env_key
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
                max(a.group_label) AS group_label,
                max(e.binding_observed_at) AS binding_observed_at,
                COALESCE(max(e.lifecycle_state), 'active') AS lifecycle_state,max(e.deleted_at) AS deleted_at,
                d.request_id,d.requested_by AS deletion_requested_by,d.requested_at AS deletion_requested_at,
                d.result_kind,d.result_error,d.result_at,
                i.installation_id,i.last_seen_at AS installation_seen_at,
                h.revocation_id AS hold_id,h.reason AS hold_reason,h.requested_at AS hold_requested_at
         FROM keys k
         LEFT JOIN client_environments e ON e.env_key = k.env_key
         LEFT JOIN client_env_scope s
           ON s.env_key = k.env_key AND s.source = 'admin'
         LEFT JOIN client_users u ON u.user_id = s.user_id
         LEFT JOIN accounts a ON a.account_id = e.account_id
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
         LEFT JOIN client_env_revocation_holds h
           ON h.env_key = k.env_key AND h.materialized_at IS NULL
         GROUP BY k.env_key,h.revocation_id,h.reason,h.requested_at,
                  d.request_id,d.requested_by,d.requested_at,d.result_kind,d.result_error,d.result_at,
                  i.installation_id,i.last_seen_at
         ORDER BY k.env_key ASC`,
        [activeOffboards.map((row) => row.envKey)],
      );
      // 风控态：只对**账号行确实存在**（account_platform 非空）的绑定取，与原
      // `accounts LEFT JOIN risk_state` 的连接链逐字同——悬空绑定在原查询里也拿不到风控态。
      const riskAccountIds = [...new Set(
        rows.filter((r) => r.account_id && r.account_platform).map((r) => r.account_id as string),
      )];
      const riskByAccountId = new Map(
        (await this.automationRead().riskStateProjection(riskAccountIds)).map((row) => [row.accountId, row]),
      );
      return rows.map((r) => {
        const assignees = (r.assignees ?? []).map((a) => ({ userId: a.userId, name: a.name }));
        // 离场回执从端口那份投影按 envKey 索引取（原 LEFT JOIN o 的 1:1 命中/缺失）。
        const offboard = offboardByEnvKey.get(r.env_key);
        const cleanup: ClientCleanupReceipt | null = r.hold_id && r.hold_reason && r.hold_requested_at
          ? {
              kind: 'binding_missing', revocationId: r.hold_id, envKey: r.env_key,
              state: 'binding_missing', reason: r.hold_reason, requestedAt: r.hold_requested_at.getTime(),
            }
          : offboard
            ? {
                kind: 'offboard_pending', offboardId: offboard.offboardId, envKey: r.env_key,
                accountId: offboard.accountId, state: offboard.state, reason: offboard.reason,
                requestedAt: offboard.requestedAt, purgeDueAt: offboard.purgeDueAt,
              }
            : null;
        const risk = r.account_id ? riskByAccountId.get(r.account_id) : undefined;
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
                  riskStatus: risk?.status ?? null, riskQuotaLevel: risk?.quotaLevel ?? null,
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
    const admissions: AdmissionRow[] = [];
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
      // 逐个按 env_key 升序取行锁：**取锁顺序与改动前逐字相同**（死锁序不回归）。
      for (const envKey of affectedEnvKeys) {
        await lockEnvironmentRow(client, envKey);
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
        // 「有清理在飞的环境不可改派」这道闸，改造前分居两库：hold（api）+ 离场台账非 purged（automation），
        // 靠同一笔事务才原子。拆库后两闸各在一库、跨库锁无声失效 ⇒ 正在清理的环境会被改派给新客户。
        // 现在两闸合成**本域一张准入表上的一次条件读**：一行即拒，`materialized_at` 只决定回哪个原因码
        // （尚未物化 = cleanup_in_progress，已物化 = offboard_in_progress，与改造前逐字同）。
        const admitted = await client.query<{ env_key: string; materialized_at: Date | null }>(
          `SELECT env_key,materialized_at FROM client_env_revocation_holds
            WHERE env_key=ANY($1::text[]) ORDER BY env_key LIMIT 1 FOR UPDATE`, [clean],
        );
        if (admitted.rows[0]) {
          await client.query('ROLLBACK');
          return {
            ok: false,
            reason: admitted.rows[0].materialized_at ? 'offboard_in_progress' : 'cleanup_in_progress',
            envKey: admitted.rows[0].env_key,
          };
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
        // 同 updateUser：只写本域准入行，「建离场 还是 挂 hold」交给唯一能对绑定加锁的一方（属主）判。
        admissions.push(await this.enqueueAdmission(client, {
          userId, envKey: row.env_key, reason: 'admin_revoked', actor: assignedBy, unboundTerminalOk: false,
        }));
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
    // 提交之后逐条推给属主（进程内中继）；推不动的留在准入表里由对账循环重放。
    for (const admission of admissions) {
      const materialized = await this.materializeAdmission(admission);
      if (materialized.offboard) offboards.push(materialized.offboard);
      cleanup.push(materialized.receipt);
    }
    return { ok: true, scope: await this.listEnvScope(userId), offboards, cleanup };
  }

  /**
   * 环境清理准入的**对账循环**（承重兜底通道；替代原 `reconcileRevocationHolds`）。组合根每 60s 跑一次。
   *
   * 三件事，顺序即语义：
   *   1. **认领**（adopt）—— 属主台账里有未清除的离场、api 侧却没有准入行时补一行。这是拆库切换当天
   *      与任何回执丢失后的收敛路径：没有它，那些环境在 api 侧看起来「无人清理」、会被改派出去。
   *      认领来的行 `user_id` 为 NULL（台账不一定有发起客户，而 MUST NOT 编造一个）。
   *   2. **释放**（release）—— 已物化、但属主台账里已经清除（purged / 行不在）的准入行删掉，
   *      环境重新可改派。**只在拿到属主投影时才释放**：读不到就什么都不做（fail-closed，宁可多拒）。
   *   3. **物化**（materialize）—— 「已受理、尚未物化」的准入逐条推给属主（at-least-once 重放）。
   *      返回被物化出来的离场行供调用方派发给边缘。
   *
   * 端口读失败 MUST 抛：`activeWechatOffboards` 拿不到就整轮放弃，绝不把空集当成「一条都没有」，
   * 那会把 1 的认领变成空操作、把 2 变成**误删全部准入行** = 正在清理的环境全部重新可改派。
   */
  async reconcileCleanupAdmissions(limit = 50): Promise<ClientOffboardView[]> {
    const boundedLimit = Math.max(1, Math.min(200, Math.trunc(limit) || 50));
    // 拿不到属主投影就整轮抛出去（调用方 warn 后下一轮重来），绝不假空集。
    const active = await this.automationRead().activeWechatOffboards();
    const activeByEnvKey = new Map(active.map((row) => [row.envKey, row]));

    // 1. 认领：台账有、准入没有 ⇒ 补一行已物化的准入（env_key 冲突时不覆盖既有那条）。
    //    revocation_id 由 (env_key, offboard_id) 派生而非随机：重复认领得到同一个 id，且不依赖
    //    gen_random_uuid()（那是 PG13+ 才内置的函数，本仓迁移一处都没用过，不在这里引入新前提）。
    if (active.length) {
      await this.pool.query(
        `INSERT INTO client_env_revocation_holds
           (revocation_id,env_key,user_id,reason,revoked_by,offboard_id,unbound_terminal_ok,
            materialized_at,requested_at,updated_at)
         SELECT md5('cleanup-admission:' || k.env_key || ':' || k.offboard_id)::uuid,
                k.env_key,NULL,k.reason,NULL,k.offboard_id,false,now(),k.requested_at,now()
           FROM unnest($1::text[],$2::text[],$3::text[],$4::timestamptz[])
                AS k(env_key,offboard_id,reason,requested_at)
         ON CONFLICT (env_key) DO NOTHING`,
        [
          active.map((row) => row.envKey),
          active.map((row) => row.offboardId),
          active.map((row) => row.reason),
          active.map((row) => new Date(row.requestedAt).toISOString()),
        ],
      );
    }

    // 2. 释放：已物化、且台账里已无未清除记录 ⇒ 清理结束，环境重新可改派。
    await this.pool.query(
      `DELETE FROM client_env_revocation_holds
        WHERE materialized_at IS NOT NULL AND NOT (env_key = ANY($1::text[]))`,
      [[...activeByEnvKey.keys()]],
    );

    // 3. 物化：已受理、尚未物化的准入逐条重放（顺序与改造前候选序一致：requested_at, env_key）。
    const { rows: pending } = await this.pool.query<AdmissionRow>(
      `SELECT revocation_id,env_key,user_id,reason,revoked_by,offboard_id,unbound_terminal_ok,
              materialized_at,requested_at
         FROM client_env_revocation_holds
        WHERE materialized_at IS NULL
        ORDER BY requested_at,env_key
        LIMIT $1`,
      [boundedLimit],
    );
    const offboards: ClientOffboardView[] = [];
    for (const row of pending) {
      const materialized = await this.materializeAdmission(row);
      if (materialized.offboard) offboards.push(materialized.offboard);
    }
    return offboards;
  }

  /**
   * 该账号是否还挂着**尚未物化**的清理准入（原名 hold；语义逐字保持不变）。
   *
   * `materialized_at IS NULL` 这个谓词是刻意的：准入行现在会一直留到清理结束（它兼任改派闸），
   * 而本方法的历史含义是「已撤权、但还没转成离场记录」。不加这个谓词，语义会悄悄扩大成
   * 「已撤权且尚未清除」——那是另一件事。
   *
   * 等价性：属主表 (platform, account_id) 为主键 ⇒ 原 JOIN 1:1；账号无绑定 ⇒ 原 JOIN 空集 ⇒ false。
   *
   * **失败方向必须是抛，MUST NOT 吞成 false**：本方法的消费方把 `!hasPendingRevocationHold`
   * 当作放行条件（互动读 / 回复 / 私信的闸），false 是「没有 hold、可以放行」。把跨域读失败降级成
   * false，等于给一个正在被撤权的环境重新放开互动写——比读失败严重得多。故这里既不 catch 缺表、
   * 也不 catch 端口错误；调用侧（握手路径）自己有 fail-closed 兜底。
   */
  async hasPendingRevocationHold(accountId: string): Promise<boolean> {
    const envKeys = await this.automationRead().wechatEnvKeysForAccount(accountId);
    if (!envKeys.length) return false;
    const { rows } = await this.pool.query<{ present: boolean }>(
      `SELECT EXISTS (
         SELECT 1
           FROM client_env_revocation_holds h
          WHERE h.env_key = ANY($1::text[]) AND h.materialized_at IS NULL
       ) AS present`,
      [envKeys],
    );
    return rows[0]?.present === true;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
