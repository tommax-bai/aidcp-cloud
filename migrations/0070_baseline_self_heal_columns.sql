-- aidcp:kind=expand
-- aidcp:objects=column:account_content_schedule.comment_mode,column:account_content_schedule.contact_comment_mode,column:account_content_schedule.post_mode,column:contact_comment_attempts.age_hours
-- aidcp:objects=column:contact_comment_attempts.note_id,column:contact_comment_attempts.source,column:contact_comment_attempts.velocity,column:delegated_tasks.origin_chat_id
-- aidcp:objects=column:publish_log.ai_enforced,column:publish_log.content_version,column:publish_log.edited_at,column:publish_log.edited_by
-- aidcp:objects=column:publish_log.image_url,column:publish_log.images_attached,column:publish_log.platform,column:publish_log.publish_metadata
-- aidcp:objects=index:idx_delegated_tasks_curated_publish_id,index:idx_delegated_tasks_curated_publish_source,index:idx_publish_log_platform
-- 补齐缺失迁移（第二批）：**已在迁移目录里的表**上、只由存储自愈 ALTER 补出来的那些列与索引
-- （change cloud-schema-migration-executor 任务 3.1/3.2 的续集）。
--
-- 第一批（0065–0068）补的是 24 张「整张表只由存储自建」的表。它漏了另一类缺口：表本身有迁移，
-- 但后来某个 change 只在存储的 SCHEMA_SQL 里加了一条 `ADD COLUMN IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`，
-- 没有配套迁移。旧库上这些列早已存在（存储启动时自己补的），所以**在 dev/ol 上完全看不出来**；
-- 只有「只跑迁移的全新空库」才会缺，而那一刻通常已经在部署现场。
--
-- 本文件由 test/schema/ddl-parity.test.ts 的「空库拉起静态前提」用例逐条找出，DDL 原样抽自存储常量。
-- 现网库上这些语句全部是 no-op。
--
-- 与第 5 节的关系：存储 init() 现在只探测不建表，探测要求正是从这些常量解析出来的。
-- 少这一条迁移，空库拉起会在 content_schedule / delegated_tasks / publish_log 三个能力上 fail-closed。

-- ==== 原样抽自 src/config/content-schedule-store.ts CONTENT_SCHEDULE_SCHEMA_SQL ====
-- 动作三档（change content-schedule-auto-approve-mode）。null 兼容旧库/旧代码，读侧从 boolean 推导。
ALTER TABLE account_content_schedule ADD COLUMN IF NOT EXISTS post_mode TEXT;
ALTER TABLE account_content_schedule ADD COLUMN IF NOT EXISTS comment_mode TEXT;
ALTER TABLE account_content_schedule ADD COLUMN IF NOT EXISTS contact_comment_mode TEXT;
UPDATE account_content_schedule SET post_mode = CASE WHEN post_enabled THEN 'review' ELSE 'off' END WHERE post_mode IS NULL;

-- 联系评论台账的审计维度（change feed-hot-lead-auto-group-comment）。可空、对既有行零回归。
ALTER TABLE contact_comment_attempts ADD COLUMN IF NOT EXISTS note_id TEXT;
ALTER TABLE contact_comment_attempts ADD COLUMN IF NOT EXISTS source TEXT;
ALTER TABLE contact_comment_attempts ADD COLUMN IF NOT EXISTS velocity DOUBLE PRECISION;
ALTER TABLE contact_comment_attempts ADD COLUMN IF NOT EXISTS age_hours DOUBLE PRECISION;

-- ==== 原样抽自 src/delegated-task/store.ts DELEGATED_TASK_SCHEMA_SQL ====
-- 命令来源会话（change restore-delegated-command-card-origin-chat）：NULL = 回落既有默认 / 团队路由。
ALTER TABLE delegated_tasks ADD COLUMN IF NOT EXISTS origin_chat_id TEXT;
-- 灵感库按账号判断是否曾触发精选洗稿（change split-curated-creation-status-filters）：两个局部表达式索引。
CREATE INDEX IF NOT EXISTS idx_delegated_tasks_curated_publish_id
  ON delegated_tasks(account_id, (source_constraints->>'curatedId'))
  WHERE action = 'publish_post';
CREATE INDEX IF NOT EXISTS idx_delegated_tasks_curated_publish_source
  ON delegated_tasks(account_id, (source_constraints->>'sourceId'))
  WHERE action = 'publish_post';

-- ==== 原样抽自 src/publish-agent/publish-log-store.ts PUBLISH_SCHEMA_SQL ====
-- A 阶段4 元数据落库 + 防篡改审计列。
ALTER TABLE publish_log ADD COLUMN IF NOT EXISTS publish_metadata JSONB;
ALTER TABLE publish_log ADD COLUMN IF NOT EXISTS ai_enforced BOOLEAN NOT NULL DEFAULT false;
-- 配图收口（change publish-media-upload）：审计用 image_url + 权威「真有图」信号 images_attached。
ALTER TABLE publish_log ADD COLUMN IF NOT EXISTS image_url TEXT;
ALTER TABLE publish_log ADD COLUMN IF NOT EXISTS images_attached BOOLEAN NOT NULL DEFAULT false;
-- 多平台发布历史（change publish-history-account-and-detail）。
ALTER TABLE publish_log ADD COLUMN IF NOT EXISTS platform TEXT NOT NULL DEFAULT 'xiaohongshu';
CREATE INDEX IF NOT EXISTS idx_publish_log_platform ON publish_log (platform);
-- 待审草稿就地编辑的「审=发」凭证 + 谁/何时审计（change edit-note-draft-before-publish）。
ALTER TABLE publish_log ADD COLUMN IF NOT EXISTS content_version INT NOT NULL DEFAULT 0;
ALTER TABLE publish_log ADD COLUMN IF NOT EXISTS edited_by TEXT;
ALTER TABLE publish_log ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ;
