-- =============================================================================
-- 0075 · 建三个属主空库（Block③ 物理拆库前置脚手架 · 运维脚本，非迁移）
-- =============================================================================
--
-- 状态：UNWIRED / 未执行。本文件只被人手用 psql 单发，绝不进迁移执行器（见下「为什么不是迁移」）。
--
-- 目的：在同一个 PostgreSQL 实例上，为三个拆库属主各建一个 **空** 库：
--
--     owner        目标库名             env 变量（配了才生效）
--     content      aidcp_content       AIDCP_PG_CONTENT_URL
--     automation   aidcp_automation    AIDCP_PG_AUTOMATION_URL
--     api          aidcp_api           AIDCP_PG_API_URL
--
-- 建完只是三个空库摆在那：无表、无数据、无人连（除非有人显式把上面的 URL 指过去）。
-- 连接解析器（src/transport/pg-owner-connection-resolver.ts，另一分支）在这些 URL 未配时
-- 一律回落现有单库 `aidcp`，所以「建了空库」这一步对现网行为 **零影响**。
--
-- -----------------------------------------------------------------------------
-- 为什么非破坏、不动 OL
-- -----------------------------------------------------------------------------
--   * CREATE DATABASE 只在实例系统目录里登记一个新库，不触碰任何已有库的字节。
--     现有 aidcp 库的表、行、连接、权限全部原样不动。
--   * 纯 additive：本文件不含任何 DROP / ALTER / TRUNCATE，也不在现有库里建/改/删任何对象。
--   * 无人连 = 无行为变更：cloud 进程仍按连接解析器默认回落连 aidcp 单库（三属主 URL 都没配）。
--   * OL 完全无感：OL 跑旧代码、连旧 aidcp 库，不认识这三个新库、也不会连它们。
--
-- -----------------------------------------------------------------------------
-- 前置检查（务必先做）
-- -----------------------------------------------------------------------------
--   1. 只在目标 ECS 的 PG 实例上执行；先 `scripts/deploy-target <dev|ol> --check` 命名 target。
--   2. 绝不影响同机 isales：本脚本只发 CREATE DATABASE，不碰任何 isales 的库/表/连接。
--   3. dev-first：先在 dev 实例建、验证回落仍连旧库、三空库可连但无表，再考虑是否在 OL 预建。
--      （OL 预建同样零影响，但按红线「OL 必先备份」，即便无损也先做实例级 pg_dump 快照留档。）
--
-- -----------------------------------------------------------------------------
-- 为什么不是 .sql 迁移（不进 migrations/ 执行器）
-- -----------------------------------------------------------------------------
--   * 迁移执行器（scripts/migrate.ts）在「一个库、一个连接」上按序跑迁移，逐条包在事务里。
--     CREATE DATABASE 不能在事务块内执行（PG 限制），也天然是「跨库、库外」动作——建的是执行器
--     当前所连库之外的新库。硬塞进 migrations/ 会炸执行器（且违反 migrations/README「唯一 schema 所有者」纪律）。
--   * 因此建库是实例级一次性运维动作，用 psql 以具备 CREATEDB 权限的角色单发；
--     各新库 **内部** 的表结构，才在各自库里由该库自己的迁移序建立（属 L3 迁移剧本，不在本步）。
--
-- -----------------------------------------------------------------------------
-- 运行方式
-- -----------------------------------------------------------------------------
--   以具 CREATEDB 权限的角色连到维护库（如 postgres），整段可重复安全执行：
--       psql "postgres://<admin>@<host>:<port>/postgres" -f scripts/db-split/0075_create_per_service_databases.sql
--   PG 无 CREATE DATABASE IF NOT EXISTS；下面用「先探 pg_database 再 \gexec」的守卫式幂等写法，
--   库已存在则 SELECT 返 0 行、什么都不执行（不会误报 42P04 database already exists 为失败）。
--   OWNER 里的角色名 `aidcp` 是占位——按实例实际角色名填；口令等敏感值绝不写进本文件。
-- =============================================================================

-- content 库
SELECT 'CREATE DATABASE aidcp_content OWNER aidcp'
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'aidcp_content')
\gexec

-- automation 库
SELECT 'CREATE DATABASE aidcp_automation OWNER aidcp'
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'aidcp_automation')
\gexec

-- api 库
SELECT 'CREATE DATABASE aidcp_api OWNER aidcp'
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'aidcp_api')
\gexec

-- -----------------------------------------------------------------------------
-- 验证（只读，不改状态）
-- -----------------------------------------------------------------------------
--   三库应都在，datname 各一行：
--       SELECT datname FROM pg_database
--        WHERE datname IN ('aidcp_content','aidcp_automation','aidcp_api') ORDER BY 1;
--   每个新库应为空（连进去 public schema 无用户表）：
--       psql -d aidcp_content    -c "\dt"   -> Did not find any relations.
--       psql -d aidcp_automation -c "\dt"
--       psql -d aidcp_api        -c "\dt"
--
-- 回滚：本步是加空库。确认无人连（三 owner URL 未指过去、无残留会话）后
--       DROP DATABASE aidcp_content; 等即可，对 aidcp 旧库与 OL 均无影响。
--       只要没往新库迁数据、没把任何 URL 指过去，删空库是无损的。
