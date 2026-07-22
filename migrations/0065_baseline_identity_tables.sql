-- aidcp:kind=expand
-- aidcp:objects=column:accounts.account_id,column:accounts.created_at,column:accounts.group_label,column:accounts.label
-- aidcp:objects=column:accounts.machine_label,column:accounts.nickname,column:accounts.operator_alias,column:accounts.paused_at
-- aidcp:objects=column:accounts.persona_ref,column:accounts.platform,column:accounts.quota_level,column:accounts.status
-- aidcp:objects=column:client_env_revocation_holds.env_key,column:client_env_revocation_holds.reason,column:client_env_revocation_holds.requested_at,column:client_env_revocation_holds.revocation_id
-- aidcp:objects=column:client_env_revocation_holds.revoked_by,column:client_env_revocation_holds.updated_at,column:client_env_revocation_holds.user_id,column:client_env_scope.assigned_at
-- aidcp:objects=column:client_env_scope.assigned_by,column:client_env_scope.env_key,column:client_env_scope.label,column:client_env_scope.platform
-- aidcp:objects=column:client_env_scope.source,column:client_env_scope.user_id,column:client_environment_deletion_requests.claimed_at,column:client_environment_deletion_requests.claimed_installation_id
-- aidcp:objects=column:client_environment_deletion_requests.env_key,column:client_environment_deletion_requests.idempotency_key,column:client_environment_deletion_requests.request_id,column:client_environment_deletion_requests.requested_at
-- aidcp:objects=column:client_environment_deletion_requests.requested_by,column:client_environment_deletion_requests.result_at,column:client_environment_deletion_requests.result_error,column:client_environment_deletion_requests.result_key
-- aidcp:objects=column:client_environment_deletion_requests.result_kind,column:client_environment_deletion_requests.state,column:client_environment_deletion_requests.target_user_id,column:client_environment_deletion_requests.updated_at
-- aidcp:objects=column:client_environment_deletion_requests.version,column:client_environment_installations.created_at,column:client_environment_installations.env_key,column:client_environment_installations.environment_name
-- aidcp:objects=column:client_environment_installations.installation_id,column:client_environment_installations.last_seen_at,column:client_environment_installations.user_id,column:client_environments.account_id
-- aidcp:objects=column:client_environments.binding_observed_at,column:client_environments.created_at,column:client_environments.deleted_at,column:client_environments.env_key
-- aidcp:objects=column:client_environments.environment_name,column:client_environments.label,column:client_environments.lifecycle_state,column:client_environments.platform
-- aidcp:objects=column:client_environments.slow_start_initialized,column:client_environments.slow_start_since,column:client_environments.source,column:client_environments.updated_at
-- aidcp:objects=column:client_users.created_at,column:client_users.key_hash,column:client_users.key_salt,column:client_users.name
-- aidcp:objects=column:client_users.rotated_at,column:client_users.status,column:client_users.updated_at,column:client_users.user_id
-- aidcp:objects=index:client_env_revocation_holds_requested_idx,index:client_env_scope_env_idx,index:client_environment_deletion_active_idx,index:client_environment_deletion_target_idx
-- aidcp:objects=index:client_environment_installations_user_seen_idx,index:client_environments_account_idx,index:client_environments_lifecycle_idx,table:accounts
-- aidcp:objects=table:client_env_revocation_holds,table:client_env_scope,table:client_environment_deletion_requests,table:client_environment_installations
-- aidcp:objects=table:client_environments,table:client_users
-- 补齐缺失迁移：身份与账号域（change cloud-schema-migration-executor 任务 3.1/3.2）。
--
-- 这些表今天只由存储在启动期自建，迁移目录从未创建过它们 —— 于是「迁移目录」不是真实 schema 的事实源，
-- verify 永远查不全，全新空库也永远只能靠存储自建拉起来。本文件把 DDL 原样抽出，保留 CREATE TABLE IF NOT EXISTS
-- 与全部幂等自愈 ALTER / CREATE INDEX（少抄一条自愈加列，新库建出的表就会缺列）。
--
-- 本节 MUST NOT 改任何存储代码、MUST NOT 改变启动行为：现网库上这些对象已存在，本文件全部语句是 no-op。
-- 存储侧 DDL 的删除在本 change 第 5 节按批推进，不在这里。
--
-- 说明：client_env_scope_audit 与 client_env_provisioning_intents 已由 0040 / 0043 建过，
-- 这里因「原样抽出存储常量」而一并出现；语句幂等，重复无副作用，对象声明仍归最先建它的那条迁移。

-- ==== 原样抽自 src/account-store.ts ACCOUNTS_SCHEMA_SQL ====
CREATE TABLE IF NOT EXISTS accounts (
  account_id    TEXT PRIMARY KEY,
  label         TEXT,
  platform      TEXT NOT NULL DEFAULT 'xiaohongshu',
  persona_ref   TEXT,
  quota_level   TEXT NOT NULL DEFAULT 'normal'
                CHECK (quota_level IN ('conservative','normal','aggressive')),
  status        TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('active','paused')),
  paused_at     TIMESTAMPTZ,
  machine_label TEXT,
  group_label   TEXT,
  nickname      TEXT,
  operator_alias TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- 自愈式加列（change account-real-nickname，迁移 0020 文档伴随）：本仓无迁移执行器，
-- 已存在的 accounts 表靠这条幂等 ALTER 在 init() 时补上 nickname 列（CREATE TABLE IF NOT EXISTS 不改既有表）。
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS nickname TEXT;
-- 账号级运营别名（change unified-account-display-name）：与平台 nickname 物理分离，空值为 NULL。
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS operator_alias TEXT;
-- 自愈式加列（change platform-abstraction-layer）：accounts.platform 是运行时平台事实源。
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS platform TEXT NOT NULL DEFAULT 'xiaohongshu';
-- 自愈式加列（change account-group-chat-injection → generalize-contact-info，物理改名迁移 0036）：每账号「联系方式」，
-- 供 /comment --contact 注入。verbatim 存储——写入不 trim / 不截断（见 setContactInfo），与 nickname / group_label 刻意相反。
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS contact_info TEXT;
-- 旧账号级慢启动列：environment-level-slow-start 后仅保留一次性迁移与代码回滚数据，不再参与运行时读写。
-- NULL = 关（默认）；非 NULL = 开，且该时刻即爬坡第 1 天的起点（写入时已对齐上海日起点）。
-- 一列同时表达开关 / 起点 / 三态 → 结构上不可能出现 enabled=true && since=NULL 这种非法组合。
-- MUST NOT 用 created_at 当起点：那是「第一次连上本云端库」，cookie 导入的三年老号会被算「第 1 天」。
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS slow_start_since TIMESTAMPTZ;
-- retire-default-account：不再 seed 'default' 占位行。账号父行由真实账号握手时 ensureAccount 幂等登记产生。

-- ==== 原样抽自 src/client-auth/client-user-store.ts CLIENT_USERS_SCHEMA_SQL ====
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
ALTER TABLE client_environments ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
-- 环境级慢启动事实源（change environment-level-slow-start）：NULL=关，非 NULL=上海自然日起点。
-- 旧 accounts.slow_start_since 暂留回滚，但运行时不再读取；迁移须等 accounts 表 init 后单独执行。
ALTER TABLE client_environments ADD COLUMN IF NOT EXISTS slow_start_since TIMESTAMPTZ;
-- 一次性迁移标记：NULL/false 只代表历史行尚未初始化；新环境默认 true，防止以后因复用旧账号而被回灌。
ALTER TABLE client_environments ADD COLUMN IF NOT EXISTS slow_start_initialized BOOLEAN;
UPDATE client_environments SET slow_start_initialized = false WHERE slow_start_initialized IS NULL;
ALTER TABLE client_environments ALTER COLUMN slow_start_initialized SET DEFAULT true;
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
