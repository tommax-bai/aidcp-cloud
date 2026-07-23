-- aidcp:kind=expand
-- aidcp:objects=column:account_content_schedule.group_comment_daily_cap,column:account_content_schedule.group_comment_enabled,column:accounts.group_chat_info
-- 补齐缺失迁移（第三批·列）：三列「库里有、任何迁移都没声明」的存活孤儿列
-- （change cloud-schema-migration-executor 任务 3.1/3.2 的收尾——a6c00c1 漏了它们，dev `migrate verify` 实测发现）。
--
-- 三列都由 0027/0030 建过，0036（generalize-contact-info，contract）本应把它们 RENAME 为 contact_*。
-- 共库上 store 先按新名自愈补出 contact_* 列，0036 的 `IF EXISTS(old) AND NOT EXISTS(new)` 守卫遇到
-- 「新名已存在」直接跳过 RENAME，旧列遂原地存活；这些列在库里但迁移目录再无任何头声明覆盖它们。
--
-- DDL 原样抽自权威来源，零运行时行为变化（共库上三条 ADD COLUMN IF NOT EXISTS 全是 no-op；全新空库上补齐以对齐声明）：
--   - accounts.group_chat_info：migrations/0027_account_group_chat_info.sql
--   - account_content_schedule.group_comment_enabled / group_comment_daily_cap：
--     migrations/0030_content_schedule_group_comments.sql
-- accounts 由 0000 建、account_content_schedule 由 0028 建，均排在本文件之前，复合序无前置问题。

-- ==== 原样抽自 migrations/0027_account_group_chat_info.sql（关联群聊引流码 verbatim 长文本）====
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS group_chat_info TEXT;

-- ==== 原样抽自 migrations/0030_content_schedule_group_comments.sql（群评开关 + 每日上限，fail-closed 默认）====
ALTER TABLE account_content_schedule ADD COLUMN IF NOT EXISTS group_comment_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE account_content_schedule ADD COLUMN IF NOT EXISTS group_comment_daily_cap INTEGER NOT NULL DEFAULT 0;
