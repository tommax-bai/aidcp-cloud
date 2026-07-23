-- aidcp:kind=expand
-- aidcp:objects=column:group_comment_attempts.account_id,column:group_comment_attempts.attempted_at,column:group_comment_attempts.id,column:hot_lead_queue.account_id
-- aidcp:objects=column:hot_lead_queue.age_hours,column:hot_lead_queue.discovered_at,column:hot_lead_queue.id,column:hot_lead_queue.note_id
-- aidcp:objects=column:hot_lead_queue.snapshot_json,column:hot_lead_queue.status,column:hot_lead_queue.velocity,index:idx_group_comment_attempts_account
-- aidcp:objects=index:idx_hot_lead_queue_pending,index:uq_hot_lead_queue_pending,table:group_comment_attempts,table:hot_lead_queue
-- 补齐缺失迁移（第三批·表）：两张「库里有、任何迁移都没声明」的存活孤儿表
-- （change cloud-schema-migration-executor 任务 3.1/3.2 的收尾——a6c00c1 漏了它们，dev `migrate verify` 实测发现）。
--
-- 这两张表都由存储在启动期自建过、随后被上层 change「改名/删存储」抹掉了声明，但物理表在**共库**上存活：
--   - group_comment_attempts：0030 建（群评每日尝试台账），0036（generalize-contact-info，contract）
--     本应 RENAME 为 contact_comment_attempts。共库上 store 先按新名自愈建出 contact_comment_attempts，
--     0036 的 `IF EXISTS(old) AND NOT EXISTS(new)` 守卫遇到「新名已存在」直接跳过 RENAME，旧表遂原地存活。
--     0030 的原始 `CREATE TABLE group_comment_attempts` 文本还在，故它早已在边界门禁 table 全集内、
--     boundaries/table-ownership.json 也已登记属主；缺的只是**迁移头声明**（verify 只读头、不读裸 SQL）。
--   - hot_lead_queue：由已删存储 src/hot-lead/hot-lead-queue.ts 的 PgHotLeadQueue（HOT_LEAD_SCHEMA_SQL）建，
--     change feed-hot-lead-auto-group-comment（1bb0406）删掉该存储、浏览闭环改为直接自动联系评论。
--     存储没了但共库上的表存活，迁移目录里从此再无任何地方声明它。
--
-- DDL 原样抽自权威来源，零运行时行为变化（共库上两条 CREATE 全是 no-op；全新空库上重建以对齐声明）：
--   - group_comment_attempts + idx_group_comment_attempts_account：migrations/0030_content_schedule_group_comments.sql
--   - hot_lead_queue + 两索引：src/hot-lead/hot-lead-queue.ts@1bb0406^ 的 HOT_LEAD_SCHEMA_SQL 常量
-- 两张表均无外键，排在此处对复合序无前置依赖。

-- ==== 原样抽自 migrations/0030_content_schedule_group_comments.sql（群评每日自动尝试台账）====
CREATE TABLE IF NOT EXISTS group_comment_attempts (
  id           BIGSERIAL PRIMARY KEY,
  account_id   TEXT NOT NULL,
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_group_comment_attempts_account ON group_comment_attempts (account_id, attempted_at);

-- ==== 原样抽自 src/hot-lead/hot-lead-queue.ts@1bb0406^ HOT_LEAD_SCHEMA_SQL（引流待评队列，存储已删）====
CREATE TABLE IF NOT EXISTS hot_lead_queue (
  id            BIGSERIAL PRIMARY KEY,
  account_id    TEXT NOT NULL,
  note_id       TEXT NOT NULL,
  snapshot_json JSONB NOT NULL,
  velocity      DOUBLE PRECISION NOT NULL,
  age_hours     DOUBLE PRECISION NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending',
  discovered_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_hot_lead_queue_pending ON hot_lead_queue (account_id, status, discovered_at);
-- 队列内 pending 去重：同账号同 noteId 至多一条 pending（dismissed/actioned 后可再入队）。
CREATE UNIQUE INDEX IF NOT EXISTS uq_hot_lead_queue_pending ON hot_lead_queue (account_id, note_id) WHERE status = 'pending';
