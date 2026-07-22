-- aidcp:kind=expand
-- aidcp:objects=
-- 0027_account_group_chat_info.sql（change account-group-chat-injection，迁移号 0027；0026 已被 role_thinking_mode 占用）
--
-- 每账号「关联群聊引流码」：后台粘贴录入的长文本（含 emoji / 换行），供飞书 /comment group:on 注入到评论末尾引流。
-- 维度 = 按账号（accounts 主表加一列，与 nickname / group_label 同表；非旁挂表）。
-- verbatim 存储：写入**不 trim、不设长度上限、保留 emoji / 换行 / 首尾空白**（与 group_label 的 trim+64 截断刻意相反，
-- 见 src/account-store.ts setGroupChatInfo）。空 / 纯空白输入归 NULL（清空）。缺列 / 缺行 / NULL = 该账号无码。
--
-- 本仓无迁移执行器：真正执行的是 src/account-store.ts 的 ACCOUNTS_SCHEMA_SQL 里这条**幂等自愈 ALTER**
-- （init() 时对已存在的 accounts 表补列；CREATE TABLE IF NOT EXISTS 不改既有表）。本文件仅人审台账，须与之逐字同源。
--
-- 红线：本列只读写自身 + 经账号存储一等单写方法 setGroupChatInfo（面板绝不 raw UPDATE / 乐观假成功）；
-- 绝不触风控状态单写路径（risk_state / setQuotaLevel / applySignal）；不经边-云协议（注入走既有 interaction.comment 信封）。

ALTER TABLE accounts ADD COLUMN IF NOT EXISTS group_chat_info TEXT;
