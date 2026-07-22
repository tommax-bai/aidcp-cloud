-- aidcp:kind=expand
-- aidcp:objects=column:schema_migrations.applied_at,column:schema_migrations.applied_by,column:schema_migrations.applied_from_target,column:schema_migrations.baseline
-- aidcp:objects=column:schema_migrations.checksum,column:schema_migrations.duration_ms,column:schema_migrations.kind,column:schema_migrations.name
-- aidcp:objects=column:schema_migrations.version,table:schema_migrations
--
-- 迁移账本（change cloud-schema-migration-executor，design.md D1）。
--
-- 库级单表、一条序列。applied_from_target 只记「哪个目标的运维动作施加了这条迁移」，
-- 不进主键、不进唯一约束、不参与任何查询谓词 —— 它只是审计列。
-- CLAUDE.md §2 的 execution_target 隔离规则约束的是行级持久任务数据；
-- schema 是库的属性，dev 与 ol 共用同一个数据库就只能有一条版本序列。
-- 照抄 target 隔离范式给账本分区，会让同一张表被两套序列分别建，且两边都认为自己是对的。
--
-- 本文件同时是执行器的 bootstrap 源：scripts/migrate.ts 在读账本之前会先原样执行本文件
-- （全部语句幂等），再把本文件当作一条正常迁移记入账本。

CREATE TABLE IF NOT EXISTS schema_migrations (
  version              TEXT PRIMARY KEY,
  name                 TEXT NOT NULL,
  checksum             TEXT NOT NULL,
  kind                 TEXT NOT NULL CHECK (kind IN ('expand','contract')),
  applied_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  applied_by           TEXT,
  applied_from_target  TEXT,
  duration_ms          INTEGER,
  baseline             BOOLEAN NOT NULL DEFAULT false
);
