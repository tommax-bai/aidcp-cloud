-- aidcp:kind=expand
-- aidcp:objects=
--
-- change: Block③ 物理拆库前置脚手架 —— **全部跨属主外键**降级（UNWIRED / 未执行）。
--
-- 文件名里的 `account_fk` 是历史遗留：本脚本最初只处理 `REFERENCES accounts(account_id)` 那一族。
-- 现口径是**全部跨 owner 外键**（含指向 publish_log 与 interaction_reply_config_scopes 的 3 条）。
-- 名字保持不变，因为 scripts/db-split/0077_copy_owner_data.sh 的拒绝提示逐字点了这个路径。
--
-- 状态：本迁移是 **前置脚手架**，author 但不执行。它尚未进任何真库账本；adoption 前请读完
-- 本头「adoption 须知」。共库期本迁移不改任何现网读写行为（DROP CONSTRAINT 是放宽，见 kind 说明）。
--
-- ============================================================================
-- 为什么 kind=expand（而非 contract）
-- ============================================================================
-- migrations/README §5 与 test/schema/expand-only.test.ts 明确把 `DROP CONSTRAINT` 归为 **放宽**：
-- 删约束只移除一道限制，旧版本代码在其之后仍能正常 SELECT/INSERT/UPDATE/DELETE（不报错）。
-- 收缩标记（DROP TABLE / DROP COLUMN / DROP INDEX / RENAME / ALTER COLUMN TYPE / SET NOT NULL）
-- 刻意不含 DROP CONSTRAINT。故本迁移按仓内判据属 expand，执行器无需 --allow-contract。
--
-- 但「机械分类=expand」不等于「可随便应用」：见下「危险窗口」。
--
-- ============================================================================
-- 这条迁移干什么、为什么
-- ============================================================================
-- accounts 属 api。今天账号删除靠单库内 FK 级联：DELETE FROM accounts 一发，所有
-- `... REFERENCES accounts(account_id) ON DELETE CASCADE` 的子表在同一事务里被 PG 自动清掉。
-- 这些子表横跨 content / automation / api 三个属主。物理拆库后它们是三个物理库——PostgreSQL 外键
-- 不能跨库，凡「子表在 A 库、REFERENCES accounts 在 api 库」的跨 owner 外键必然失效。
-- 本迁移在 **共库期就先把这些跨 owner 外键拆掉**，为拆库让路；它们由应用层的 event-outbox 级联接管
-- （src/transport/account-delete-cascade.ts：api 删账号同事务 emit account.deleted →
--  relay 投递到各 owner 库 outbox → 各 owner 的 purge 消费者幂等 DELETE 本库 account 关联行）。
--
-- 库内父子外键（如 account_facebook_publish_image → _set 的 set_id、delegated_task_events → delegated_tasks
-- 的 task_id）**不动**：它们随表同库迁移、保留库内 CASCADE。本迁移只拆「跨 owner」的那一层。
--
-- ============================================================================
-- 拆哪些约束（15 条跨 owner FK；owner 口径见 boundaries/table-ownership.json）
-- ============================================================================
-- 数字来源：2026-07-25 在 dev 生产库上只读实测 pg_constraint（共 40 条外键，跨属主 15 条），
-- 而不是从源码 DDL 反推 —— 源码只是「新库会建成什么样」，现网真库才是「现在实际有什么」。
-- 12 条 automation→api + 3 条 content→api。段 A/B 是 accounts 族（12 条，脚本初版即覆盖），
-- 段 C 是**非 accounts** 的 3 条（后补，见下）。
--
-- 约束名是 PG 对列级内联外键自动生成的 <表名>_<列名>_fkey。accounts 自身属 api，故「跨 owner」=
-- 子表属 content / automation。api 属主的 account 关联表（persona_config / first_post_onboarding /
-- account_comment_approval_policy / interaction_reply_config* / reply_templates / reply_rules /
-- account_reply_profiles / interaction_audit_events 等）与 accounts 同库，外键 **不拆**、随本地 CASCADE 清。
--
-- A) 11 条 ON DELETE CASCADE（由 outbox 级联接管本库清理）：
--    automation 属主（10）：
--      interaction_threads            (migrations/0039)
--      interaction_messages           (migrations/0039)
--      interaction_sync_batches       (migrations/0039)
--      interaction_sync_cursors       (migrations/0039)
--      interaction_reply_jobs         (migrations/0039)
--      interaction_send_attempts      (migrations/0039)
--      interaction_auth_state         (migrations/0039)
--      interaction_runtime_controls   (migrations/0039)
--      interaction_api_requests       (migrations/0039)
--      facebook_group_membership      (migrations/0067)
--    content 属主（1）：
--      account_facebook_publish_image_set (migrations/0067)
-- B) 1 条普通外键（无 ON DELETE CASCADE；默认 NO ACTION/RESTRICT，物理拆库同样不可能跨库）：
--    automation 属主（1）：
--      delegated_tasks                (migrations/0038)  —— 由应用层「删账号前查 api 账号存在性 +
--                                        应用层清理」接管（存在性校验从跨库 FK 改为应用层查 api）。
-- C) 3 条**不指向 accounts** 的跨 owner 外键（2026-07-25 dev 实测补入；旧版脚本漏了它们，
--    而 0077 的前置自检查的是「属主表指向本属主之外的表」，漏一条就整批拒绝执行）：
--    content 属主（2）——两条都指向 api 的 publish_log：
--      account_facebook_publish_image_set.used_by_publish_log_id (migrations/0067)
--          可空、纯审计指针（记「这组图被哪条发布记录用掉」），ON DELETE SET NULL。
--          它今天挡不住任何东西：唯一写点 markUsed() 的 publishLogId 来自刚落库的那条 publish_log；
--          publish_log 全仓零 DELETE，SET NULL 从不触发。读侧只原样透出 id，悬空亦无害。
--      publish_draft_refinement_jobs.record_id                   (migrations/0057)
--          ON DELETE CASCADE。插入期完整性的等价守卫在应用层上游：唯一创建入口
--          src/client-auth/client-auth-server.ts:981 之前先读一次 publish_log（:938），读不到即 404。
--          CASCADE 同样从不触发（publish_log 零 DELETE）。
--    automation 属主（1）——指向 api 的 interaction_reply_config_scopes：
--      interaction_reply_jobs.config_scope_id                    (migrations/0048)
--          无 ON DELETE 子句（默认 NO ACTION）。两点须知：
--          (a) 这条只活在 migrations/0048，**src/ 的自建 DDL 里没有它**（src/interactions/ 的存储不建这条
--              外键）——所以源码侧门禁 AC-SPLIT-02 看不见它，只能靠本脚本 + 真库实测兜住。
--          (b) 它是 b46708b 把 interaction_reply_config_scopes 的属主从 automation 改判 api **之后**
--              才变成跨 owner 的。属主一改判就可能凭空多出要降的外键，这正是本脚本必须按真库
--              pg_constraint 实测复核、而不是只跟着源码 DDL 走的理由。
--
-- ============================================================================
-- 危险窗口（adoption 铁律）：本迁移 MUST 与应用层 outbox 级联接线 **成对** 上线
-- ============================================================================
-- 拆掉 FK 后、outbox 级联未接线前，若发生账号删除：CASCADE 子表不再被自动清 → 残留孤儿行；
-- delegated_tasks 的 RESTRICT 也随之消失（删账号不再被有残留任务挡住）。因此：
--   * 共库期先接好 src/transport/account-delete-cascade.ts 的 relay + 各 owner purge 消费者（可先在
--     单库多消费者形态验收），确认级联幂等清理跑通，**再** 应用本迁移拆 FK。
--   * dev-first：先在 dev 走完拆 FK + 级联验收，OL 押最后（OL 每张表迁移前先 pg_dump 快照留档）。
--   * 绝不碰同机 isales。
--
-- 段 C 的 3 条**不在这个危险窗口里**，理由是它们的父表从不被删：publish_log 与
-- interaction_reply_config_scopes 全仓零 DELETE（grep 零命中），故其 ON DELETE 子句今天从不触发，
-- 拆掉不产生任何需要 outbox 接管的级联。它们剩下的唯一真实作用是**插入期引用完整性**，
-- 两条 content 侧的等价应用层守卫见段 C 逐条说明（自 aidcp-cloud 本 change 起，源码 DDL 也已同步降级）。
--
-- ============================================================================
-- 可逆性
-- ============================================================================
-- 共库期本迁移完全可逆：回滚 = 重新 ADD 跨 owner 外键（下方每条附等价的重建语句，注释保留）。
-- 因所有子表与 accounts 仍在同一物理库，重建外键即可恢复原级联。物理拆库真正发生后无法重建
-- （跨库外键不存在），届时级联只由 outbox 承载。
--
-- ============================================================================
-- adoption 须知（本迁移进真库账本前）
-- ============================================================================
--   1. src/schema/schema-contract.ts 的 KNOWN_MAX_SCHEMA_VERSION 须抬到
--      '0076_downgrade_cross_owner_account_fk'（否则 test/schema/schema-contract.test.ts 失败，
--      且启动契约门会把本版本判为 schema_ahead_of_code）。REQUIRED_SCHEMA_VERSION 不必抬——没有存储
--      「依赖 FK 不存在」才能启动。
--   2. migrations/ 里 0075 号是 **有意留空的洞**：0075 归 scripts/db-split/0075_create_per_service_databases.sql
--      这份「建空库」运维脚本（CREATE DATABASE 不能进迁移执行器，见该文件头），不是迁移。
--   3. 应用前先按上「危险窗口」接好 outbox 级联。
--
-- objects 段有意留空（`-- aidcp:objects=`）：本迁移不新增/删除 table/column/index，只 DROP 跨属主外键约束；
-- 约束名按 README §4「约束名不机械登记」不进 objects 声明。空 objects 是仓内既有范式
-- （见 0069_identity_not_null_constraints / 0051_retire_account_reply_configs）；verify 对本版本无对象可校验，符合预期。
-- ============================================================================

-- ── A) ON DELETE CASCADE 跨 owner 外键（11 条）──────────────────────────────────
-- automation 属主
ALTER TABLE interaction_threads          DROP CONSTRAINT IF EXISTS interaction_threads_account_id_fkey;
ALTER TABLE interaction_messages         DROP CONSTRAINT IF EXISTS interaction_messages_account_id_fkey;
ALTER TABLE interaction_sync_batches     DROP CONSTRAINT IF EXISTS interaction_sync_batches_account_id_fkey;
ALTER TABLE interaction_sync_cursors     DROP CONSTRAINT IF EXISTS interaction_sync_cursors_account_id_fkey;
ALTER TABLE interaction_reply_jobs       DROP CONSTRAINT IF EXISTS interaction_reply_jobs_account_id_fkey;
ALTER TABLE interaction_send_attempts    DROP CONSTRAINT IF EXISTS interaction_send_attempts_account_id_fkey;
ALTER TABLE interaction_auth_state       DROP CONSTRAINT IF EXISTS interaction_auth_state_account_id_fkey;
ALTER TABLE interaction_runtime_controls DROP CONSTRAINT IF EXISTS interaction_runtime_controls_account_id_fkey;
ALTER TABLE interaction_api_requests     DROP CONSTRAINT IF EXISTS interaction_api_requests_account_id_fkey;
ALTER TABLE facebook_group_membership    DROP CONSTRAINT IF EXISTS facebook_group_membership_account_id_fkey;
-- content 属主
ALTER TABLE account_facebook_publish_image_set
  DROP CONSTRAINT IF EXISTS account_facebook_publish_image_set_account_id_fkey;

-- ── B) 普通（无 CASCADE）跨 owner 外键（1 条）──────────────────────────────────
-- automation 属主
ALTER TABLE delegated_tasks              DROP CONSTRAINT IF EXISTS delegated_tasks_account_id_fkey;

-- ── C) 不指向 accounts 的跨 owner 外键（3 条；2026-07-25 dev 实测补入）──────────
-- content 属主 → api 的 publish_log
ALTER TABLE account_facebook_publish_image_set
  DROP CONSTRAINT IF EXISTS account_facebook_publish_image_set_used_by_publish_log_id_fkey;
ALTER TABLE publish_draft_refinement_jobs
  DROP CONSTRAINT IF EXISTS publish_draft_refinement_jobs_record_id_fkey;
-- automation 属主 → api 的 interaction_reply_config_scopes
ALTER TABLE interaction_reply_jobs
  DROP CONSTRAINT IF EXISTS interaction_reply_jobs_config_scope_id_fkey;

-- ── 回滚（共库期可逆；物理拆库后不可重建，此处仅留档，MUST NOT 与上面同批执行）─────────────
-- ALTER TABLE interaction_threads          ADD CONSTRAINT interaction_threads_account_id_fkey          FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE;
-- ALTER TABLE interaction_messages         ADD CONSTRAINT interaction_messages_account_id_fkey         FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE;
-- ALTER TABLE interaction_sync_batches     ADD CONSTRAINT interaction_sync_batches_account_id_fkey     FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE;
-- ALTER TABLE interaction_sync_cursors     ADD CONSTRAINT interaction_sync_cursors_account_id_fkey     FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE;
-- ALTER TABLE interaction_reply_jobs       ADD CONSTRAINT interaction_reply_jobs_account_id_fkey       FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE;
-- ALTER TABLE interaction_send_attempts    ADD CONSTRAINT interaction_send_attempts_account_id_fkey    FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE;
-- ALTER TABLE interaction_auth_state       ADD CONSTRAINT interaction_auth_state_account_id_fkey       FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE;
-- ALTER TABLE interaction_runtime_controls ADD CONSTRAINT interaction_runtime_controls_account_id_fkey FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE;
-- ALTER TABLE interaction_api_requests     ADD CONSTRAINT interaction_api_requests_account_id_fkey     FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE;
-- ALTER TABLE facebook_group_membership    ADD CONSTRAINT facebook_group_membership_account_id_fkey    FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE;
-- ALTER TABLE account_facebook_publish_image_set ADD CONSTRAINT account_facebook_publish_image_set_account_id_fkey FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE;
-- ALTER TABLE delegated_tasks              ADD CONSTRAINT delegated_tasks_account_id_fkey              FOREIGN KEY (account_id) REFERENCES accounts(account_id);
-- ALTER TABLE account_facebook_publish_image_set ADD CONSTRAINT account_facebook_publish_image_set_used_by_publish_log_id_fkey FOREIGN KEY (used_by_publish_log_id) REFERENCES publish_log(id) ON DELETE SET NULL;
-- ALTER TABLE publish_draft_refinement_jobs ADD CONSTRAINT publish_draft_refinement_jobs_record_id_fkey FOREIGN KEY (record_id) REFERENCES publish_log(id) ON DELETE CASCADE;
-- ALTER TABLE interaction_reply_jobs        ADD CONSTRAINT interaction_reply_jobs_config_scope_id_fkey  FOREIGN KEY (config_scope_id) REFERENCES interaction_reply_config_scopes(scope_id);
