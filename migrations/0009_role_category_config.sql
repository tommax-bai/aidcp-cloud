-- aidcp:kind=expand
-- aidcp:objects=column:category_config.account_id,column:category_config.category_id,column:category_config.model,column:category_config.updated_at
-- aidcp:objects=column:category_config.updated_by,index:uq_category_config_account,index:uq_category_config_global,table:category_config
-- change role-model-category-config：分类级模型默认（item 5/6）+ 账号维度数据缝（item 9，本期不接线）。
-- 与 src/config/category-config-store.ts 的 CREATE TABLE IF NOT EXISTS 同源（幂等，可重复执行）。
-- account_id NULL = 适用全部账号（本期恒 NULL）；非空 = 某账号专属（本期不写入、不读取非 NULL 行）。
-- model 为空/NULL = 该分类无默认覆盖，解析回落全局 textModel。
CREATE TABLE IF NOT EXISTS category_config (
  category_id TEXT NOT NULL,                 -- 稳定分类 key（与 role-catalog 导出的 category 一致）
  account_id  TEXT,                          -- NULL = 全部账号（本期恒 NULL）；预留按账号覆盖缝
  model       TEXT,                          -- 该分类默认模型；NULL/空 = 回落全局
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  TEXT
);
-- 唯一性：PostgreSQL 主键不容 NULL，而本设计要 NULL=全部账号，故用两个部分唯一索引。
-- 全局默认行（account_id IS NULL）每分类至多一行；账号专属行每 (分类,账号) 至多一行。
CREATE UNIQUE INDEX IF NOT EXISTS uq_category_config_global
  ON category_config (category_id) WHERE account_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_category_config_account
  ON category_config (category_id, account_id) WHERE account_id IS NOT NULL;
