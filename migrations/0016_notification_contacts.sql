-- aidcp:kind=expand
-- aidcp:objects=column:notification_contact_meta.account_id,column:notification_contact_meta.note,column:notification_contact_meta.sender_key,column:notification_contact_meta.tags
-- aidcp:objects=column:notification_contact_meta.updated_at,column:notification_contact_meta.updated_by,column:notification_contact_meta.wechat,column:notification_event.account_id
-- aidcp:objects=column:notification_event.content,column:notification_event.dedup_key,column:notification_event.from_user,column:notification_event.from_user_id
-- aidcp:objects=column:notification_event.note_title,column:notification_event.reason,column:notification_event.seen_at,index:idx_notification_event_account_seen
-- aidcp:objects=index:idx_notification_event_account_user,table:notification_contact_meta,table:notification_event
-- 0016_notification_contacts.sql（change notification-contact-registry，迁移号 0016）
--
-- 通知发送者「联系人名册」存储，按账号隔离。两张表：
--  1) notification_event —— 只追加的通知事件流水 = 真相（机器写）。每条评论/@/点赞/收藏/关注一行，
--     主键 (account_id, dedup_key)，ON CONFLICT DO NOTHING 保证重扫/重启幂等。
--     dedup_key 由云端按 kind 计算（评论/@ 含内容判别防同人同篇不同评论撞键丢失、点赞/收藏含笔记锚点、
--     关注按人），**与飞书去重水位解耦**（目的不同）。
--  2) notification_contact_meta —— 人工字段（微信预留 / 标签 / 备注）唯一落点（只有人能改）。
--     与事件流水物理隔离：巡视写入绝不碰本表；人工编辑绝不碰事件流水。标签用 TEXT[] 列
--     （绝不另起一对多标签表——否则读时投影二次一对多连接会把 COUNT(*) 放大）。
--
-- 「联系人列表」= 读时按 COALESCE(from_user_id, from_user, dedup_key) 分组聚合算出（不物化）。
-- PII：流水存别人昵称 + 评论原文 + 主页ID —— 均为平台公开内容（与飞书通知同源外发），
--      带每账号留存上限（见 notification-contact-store.ts retentionMax），超额删最旧。
-- 与 src/cache/notification-contact-store.ts 内 NOTIFICATION_CONTACT_SCHEMA_SQL 同源、幂等。

CREATE TABLE IF NOT EXISTS notification_event (
  account_id   TEXT        NOT NULL,                  -- 按账号隔离（连接真实账号），永远第一位
  dedup_key    TEXT        NOT NULL,                  -- 按 kind 计算；含内容判别/笔记锚点，绝不撞键丢真实事件
  reason       TEXT        NOT NULL,                  -- = NotificationItem.kind：comment/mention/like/collect/follow
  from_user    TEXT,                                  -- 昵称，可空（诚实缺失，不伪造）
  from_user_id TEXT,                                  -- 主页ID（稳定身份），可空
  content      TEXT,                                  -- 评论正文（点赞/关注为空）
  note_title   TEXT,                                  -- 目标笔记标题（评论类 V1 恒空、点赞类可填）
  seen_at      TIMESTAMPTZ NOT NULL DEFAULT now(),    -- 云端首次扫到时间 = 「添加时间」
  PRIMARY KEY (account_id, dedup_key)                 -- 幂等点（重扫/重启折叠）
);
CREATE INDEX IF NOT EXISTS idx_notification_event_account_seen ON notification_event (account_id, seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_notification_event_account_user ON notification_event (account_id, from_user_id);

CREATE TABLE IF NOT EXISTS notification_contact_meta (
  account_id TEXT        NOT NULL,
  sender_key TEXT        NOT NULL,                     -- = COALESCE(from_user_id, from_user, dedup_key)，与投影分组键同口径
  wechat     TEXT,                                     -- RESERVED：人工后补，可空，系统绝不自动写
  note       TEXT,                                     -- 人工备注
  tags       TEXT[]      NOT NULL DEFAULT '{}',        -- 人工标签（数组列，对齐本仓 TEXT[] 惯例）
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by TEXT,                                     -- 审计 = JWT sub
  PRIMARY KEY (account_id, sender_key)
);
