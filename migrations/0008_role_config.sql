-- aidcp:kind=expand
-- aidcp:objects=column:role_config.model,column:role_config.role_id,column:role_config.temperature,column:role_config.updated_at
-- aidcp:objects=column:role_config.updated_by,table:role_config
-- change console-role-model-config：按角色覆盖文本模型名与温度。
-- 与 src/config/role-config-store.ts 的 CREATE TABLE IF NOT EXISTS 同源（幂等）。
-- role_id 含 browse:/publish: 前缀；model 为空/NULL = 回落全局 textModel；temperature NULL = 回落代码默认。
CREATE TABLE IF NOT EXISTS role_config (
  role_id     TEXT PRIMARY KEY,
  model       TEXT,
  temperature REAL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  TEXT
);
