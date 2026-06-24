-- 0013_llm_token_usage.sql（change llm-token-usage-stats，迁移号 0013）
--
-- 按 (10 分钟桶, 账号, 角色, 模型) 预聚合的文本 LLM token 用量。每个维度组合一行，
-- 写入走 ON CONFLICT 累加（calls/ok_calls/*_tokens 都是 表.列 + EXCLUDED.列）。
-- bucket_start 由云端把调用时刻 floor 到 10 分钟 UTC 边界后以 to_timestamp($1::bigint/1000.0) 绑定。
--
-- 红线：token 量按 DashScope 响应体 usage 如实记，绝不因调用判失败而清零真实已计费 token。
-- 计数对齐：account 缺省 'default'（单租户真相）、role 缺省 'untagged'、探活 'system:model_probe'。
-- 所有计数列 NOT NULL DEFAULT 0（防 NULL + 累加 = 静默清零累加器）。
-- 与 src/metrics/token-usage-store.ts 内 TOKEN_USAGE_SCHEMA_SQL 同源、幂等（CREATE TABLE IF NOT EXISTS）。

CREATE TABLE IF NOT EXISTS llm_token_usage (
  bucket_start      TIMESTAMPTZ NOT NULL,   -- 10 分钟 UTC 桶起点
  account_id        TEXT        NOT NULL,   -- 'default' 单租户；多账号上线后为真实账号
  role              TEXT        NOT NULL,   -- 'browse:<role>' / 'publish:<Name>' / 'untagged' / 'system:model_probe'
  model             TEXT        NOT NULL,   -- 生效模型名（按角色解析后的实际值）
  prompt_tokens     BIGINT      NOT NULL DEFAULT 0,
  completion_tokens BIGINT      NOT NULL DEFAULT 0,
  total_tokens      BIGINT      NOT NULL DEFAULT 0,
  calls             BIGINT      NOT NULL DEFAULT 0,   -- 该桶该维度调用总次数（含失败）
  ok_calls          BIGINT      NOT NULL DEFAULT 0,   -- 其中成功次数（失败 = calls - ok_calls）
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (bucket_start, account_id, role, model)
);

CREATE INDEX IF NOT EXISTS idx_llm_token_usage_account_bucket
  ON llm_token_usage (account_id, bucket_start);
