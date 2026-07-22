-- aidcp:kind=expand
-- aidcp:objects=column:persona_config.account_id,column:persona_config.persona,column:persona_config.updated_at,column:persona_config.updated_by
-- aidcp:objects=table:persona_config
-- 0011_persona_config.sql（change account-persona-config，stream F，迁移号 0011）
--
-- 账号维度人设：把原先全局单份 soul.yaml 做成「按账号可配」。每账号一行，
-- persona 存 soul 文本（loadSoulFromValue 可解析）；缺行 / 空 = 回落打包 soul.yaml（永不 brick）。
--
-- 与 src/config/persona-store.ts 内 CREATE TABLE IF NOT EXISTS 同源、幂等。
-- FK 到 accounts(account_id)：人设行不能孤儿存在，账号删除连带清理。
-- 注意：accounts 表由 src/account-store.ts 在运行时建（非迁移），故此表的建立须在 accounts 之后
--（运行时由 server 装配顺序保证；对已上线库 accounts 已存在，DBA 手动应用本迁移亦安全）。

CREATE TABLE IF NOT EXISTS persona_config (
  account_id  TEXT PRIMARY KEY REFERENCES accounts(account_id) ON DELETE CASCADE,
  persona     TEXT NOT NULL,            -- soul 文本（loadSoulFromValue 可解析）
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  TEXT
);
