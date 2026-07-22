-- aidcp:kind=expand
-- aidcp:objects=
-- 0021_account_nickname.sql（change account-real-nickname）
--
-- 文档伴随物，非执行脚本：本仓【无迁移执行器】（package.json 无 migrate、无处 readdir migrations/）。
-- 真正生效的是 src/account-store.ts 的 ACCOUNTS_SCHEMA_SQL 在 init() 里跑的幂等内联 DDL
-- （CREATE TABLE 含 nickname 列 + 幂等 ALTER ADD COLUMN IF NOT EXISTS），自愈补列到 ECS 既有表。
-- 此文件仅供人审/留痕，与代码 DDL 同源、逐字对齐。
--
-- 迁移号：0020 已被并发 change（session-auto-resume-with-excursions 的 0020_resume_config）占用，
-- 故本 change 取下一空号 0021（号仅文档用途、不影响实际应用顺序）。
--
-- 列：登录账号自身平台真实昵称。可空、无 DEFAULT、不回填——缺失即 NULL，console 回落 label/account_id，绝不造假名。

ALTER TABLE accounts ADD COLUMN IF NOT EXISTS nickname TEXT;
