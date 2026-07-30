-- aidcp:kind=expand
-- aidcp:objects=table:tasks,table:task_revisions,table:execution_plans
-- aidcp:objects=index:idx_tasks_target_status,index:idx_tasks_target_account
-- aidcp:objects=index:uq_task_revisions_target_task_ordinal,index:idx_execution_plans_target_task
-- aidcp:objects=index:idx_execution_plans_target_revision
--
-- change add-managed-automation-runtime（期1-2 核心表第 1/4 条：授权面三张表；迁移 0106）。
--
-- 托管自动化运行时（src/managed-automation/，design §2/§3/§4）的持久底座第一批：
--   1. tasks           —— Task 的 automation 运行副本（API 授权后的 runtime projection，
--                          design §3：不复制客户可编辑全文成为第二事实源）；
--   2. task_revisions  —— **不可变**授权修订（design §4.4：Revise 产生新行并推进
--                          tasks.current_revision_id，绝不原地改写既有修订）；
--   3. execution_plans —— **不可变**编译产物（design §4.5：ReviseTask = 新 TaskRevision +
--                          新 ExecutionPlan；本表无 update 语义，修订即新行）。
--
-- execution_target 隔离（CLAUDE.md §2）：三张表都是行级持久任务数据，execution_target
-- 为第一业务列并带 CHECK，全部读写谓词按 target 过滤（store 层强制）。
--
-- 刻意不写任何 REFERENCES（照 automation_account_projection / 0077 的先例）：
--   - account_id / env_key 属 api 域主数据，共库期引外键 = 拆库时静默失效的库级机制
--     （见 test/acceptance/schema-db-scope.test.ts 的教训），守卫走 store 读侧 fail-closed；
--   - 模块内引用（task_id / revision_id / plan id）由 typed store 在创建路径上校验，
--     不引库级外键，避免给 db-scope 清单再添拆库时会静默消失的条目。
-- 本迁移不 ALTER / DROP 任何既有表；全部 additive。
CREATE TABLE IF NOT EXISTS tasks (
  task_id                  UUID PRIMARY KEY,
  execution_target         TEXT NOT NULL CHECK (execution_target IN ('dev','ol')),
  plan_id                  TEXT,
  cycle_id                 TEXT,
  account_id               TEXT NOT NULL,
  env_key                  TEXT NOT NULL,
  platform                 TEXT NOT NULL,
  task_definition_id       TEXT NOT NULL,
  task_definition_version  INTEGER NOT NULL,
  current_revision_id      UUID NOT NULL,
  capability_scope         JSONB NOT NULL,
  action_authorization     JSONB NOT NULL,
  constraints              JSONB NOT NULL DEFAULT '{}',
  budgets                  JSONB NOT NULL DEFAULT '{}',
  schedule                 JSONB NOT NULL,
  completion_condition_ref TEXT NOT NULL,
  status                   TEXT NOT NULL CHECK (status IN ('active','cancelled','completed')),
  conversation_message_id  TEXT,
  correlation_id           TEXT NOT NULL,
  aggregate_version        INTEGER NOT NULL DEFAULT 1,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 主要读路径：按 target 扫可派生 run 的 active 任务；按 target+账号列任务。
CREATE INDEX IF NOT EXISTS idx_tasks_target_status
  ON tasks (execution_target, status, created_at);
CREATE INDEX IF NOT EXISTS idx_tasks_target_account
  ON tasks (execution_target, account_id, status);

CREATE TABLE IF NOT EXISTS task_revisions (
  revision_id            UUID PRIMARY KEY,
  execution_target       TEXT NOT NULL CHECK (execution_target IN ('dev','ol')),
  task_id                UUID NOT NULL,
  revision_ordinal       INTEGER NOT NULL CHECK (revision_ordinal >= 1),
  cause                  TEXT NOT NULL CHECK (cause IN ('create','revise','cancel')),
  capability_scope       JSONB NOT NULL,
  action_authorization   JSONB NOT NULL,
  constraints            JSONB NOT NULL DEFAULT '{}',
  budgets                JSONB NOT NULL DEFAULT '{}',
  schedule               JSONB NOT NULL,
  authorization_ref      TEXT NOT NULL,
  supersedes_revision_id UUID,
  proposal_ref           TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 不可变修订链：同一任务的修订序号唯一（并发 Revise 只能有一个赢家），也是按任务列修订的读路径。
CREATE UNIQUE INDEX IF NOT EXISTS uq_task_revisions_target_task_ordinal
  ON task_revisions (execution_target, task_id, revision_ordinal);

CREATE TABLE IF NOT EXISTS execution_plans (
  execution_plan_id        UUID PRIMARY KEY,
  execution_target         TEXT NOT NULL CHECK (execution_target IN ('dev','ol')),
  task_id                  UUID NOT NULL,
  task_revision_id         UUID NOT NULL,
  task_definition_id       TEXT NOT NULL,
  task_definition_version  INTEGER NOT NULL,
  plan_id                  TEXT,
  plan_version             INTEGER,
  authorization_ref        TEXT NOT NULL,
  nodes                    JSONB NOT NULL,
  edges                    JSONB NOT NULL,
  entry_node_id            TEXT NOT NULL,
  bounds                   JSONB NOT NULL,
  completion_condition_ref TEXT NOT NULL,
  compiled_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_execution_plans_target_task
  ON execution_plans (execution_target, task_id, compiled_at);
CREATE INDEX IF NOT EXISTS idx_execution_plans_target_revision
  ON execution_plans (execution_target, task_revision_id);
