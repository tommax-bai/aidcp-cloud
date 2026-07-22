-- aidcp:kind=expand
-- aidcp:objects=column:accounts.execution_target,column:risk_counter_outbox.account_id,column:risk_counter_outbox.action,column:risk_counter_outbox.attempts
-- aidcp:objects=column:risk_counter_outbox.claim_expires_at,column:risk_counter_outbox.claim_token,column:risk_counter_outbox.created_at,column:risk_counter_outbox.dedupe_key
-- aidcp:objects=column:risk_counter_outbox.execution_target,column:risk_counter_outbox.id,column:risk_counter_outbox.last_error,column:risk_counter_outbox.occurred_at
-- aidcp:objects=column:risk_counter_outbox.status,column:risk_counter_outbox.updated_at,column:risk_counters.outbox_id,index:idx_risk_counter_outbox_claim
-- aidcp:objects=index:uq_risk_counter_outbox_target_dedupe,index:uq_risk_counters_outbox,table:risk_counter_outbox
-- risk-state-cross-process-integrity
--
-- 跨进程风控单写的持久底座。三件事，全部 additive（dev/ol 共库期间禁止破坏性 DDL）：
--   1. accounts.execution_target —— 账号归属哪个 target 的自动化驱动（风控写权谓词的唯一权威）。
--   2. risk_counter_outbox      —— 边缘确认的真实动作 → 风控记账的持久中转（跨重启不丢账）。
--   3. risk_counters.outbox_id  —— apply 的 exactly-once 由数据库唯一索引保证，不靠内存去重。
--
-- **MUST NOT 回填 accounts.execution_target 的默认值。** 回填 'dev' 会把 ol 的生产账号静默划给 dev
-- ——归属是「谁在真实驱动这个账号」，不是「谁先跑了这条迁移」。存量账号 MUST 保持 NULL 并由运行时
-- 首次真实握手自证占位（条件写：仅当归属为空才写入）。对照迁移 0052（delegated_tasks）刻意回填 'dev'：
-- 那次回填有用户显式确认「全部存量任务属 dev」这一事实，这里没有等价事实。
--
-- 本仓无迁移执行器：等价幂等 SQL 已同步进 src/account-store.ts 的 ACCOUNTS_SCHEMA_SQL 与
-- src/risk/pg-risk-store.ts 的 RISK_SCHEMA_SQL，init() 里那份才是实际生效路径。两处 MUST 同源。

BEGIN;

-- 1. 账号归属 target ----------------------------------------------------------

ALTER TABLE accounts ADD COLUMN IF NOT EXISTS execution_target TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'accounts'::regclass
       AND conname = 'accounts_execution_target_check'
  ) THEN
    ALTER TABLE accounts
      ADD CONSTRAINT accounts_execution_target_check
      CHECK (execution_target IS NULL OR execution_target IN ('dev','ol'));
  END IF;
END $$;

-- 2. 记账 outbox --------------------------------------------------------------
--
-- 形状照抄 delegated_tasks 的认领范式（claim_token + claim_expires_at + execution_target 过滤 +
-- FOR UPDATE SKIP LOCKED + 启动回收）。action 的 CHECK 复用 risk_counters 的十个动作全集。

CREATE TABLE IF NOT EXISTS risk_counter_outbox (
  id               BIGSERIAL PRIMARY KEY,
  account_id       TEXT NOT NULL,
  action           TEXT NOT NULL CHECK (action IN ('like','collect','comment','follow','publish','view','search','comment_like','join_group','dm_reply')),
  occurred_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  execution_target TEXT NOT NULL CHECK (execution_target IN ('dev','ol')),
  dedupe_key       TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','applied','dead')),
  attempts         INTEGER NOT NULL DEFAULT 0,
  claim_token      TEXT,
  claim_expires_at TIMESTAMPTZ,
  last_error       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 去重：同一 target 内同一 dedupe_key 只留一行（边缘重发同一信封天然去重）。
CREATE UNIQUE INDEX IF NOT EXISTS uq_risk_counter_outbox_target_dedupe
  ON risk_counter_outbox (execution_target, dedupe_key);

-- 认领扫描：target 打头（对齐 delegated_tasks 的认领索引形状）。
CREATE INDEX IF NOT EXISTS idx_risk_counter_outbox_claim
  ON risk_counter_outbox (execution_target, status, claim_expires_at, id);

-- 3. exactly-once 的数据库保证 -------------------------------------------------

ALTER TABLE risk_counters ADD COLUMN IF NOT EXISTS outbox_id BIGINT;

-- 部分唯一索引：一条 outbox 行最多产生一行计数。历史行 outbox_id IS NULL 不受约束。
CREATE UNIQUE INDEX IF NOT EXISTS uq_risk_counters_outbox
  ON risk_counters (outbox_id) WHERE outbox_id IS NOT NULL;

COMMIT;
