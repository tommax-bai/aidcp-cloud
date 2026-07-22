-- aidcp:kind=expand
-- aidcp:objects=column:publish_log.post_url
-- change publish-history-account-and-detail：
-- publish_log 加 post_url —— 发布成功后回写「带 xsec_token 的完整小红书详情页分享 URL」，供后台点开真实笔记。
-- additive，幂等（ADD COLUMN IF NOT EXISTS，可重复执行）；抓不到 URL 时存 NULL（诚实置空，绝不伪造打不开的链接）。
-- 注：account_id 列已于 0005 加好，本变更开始在 insert 时真正写入真实账号（不再恒为 DEFAULT）。
-- 库：aidcp（user=aidcp）。

ALTER TABLE publish_log ADD COLUMN IF NOT EXISTS post_url TEXT;
