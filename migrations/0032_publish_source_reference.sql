-- aidcp:kind=expand
-- aidcp:objects=column:publish_log.source_reference
-- publish-reference-source-panel：参照洗稿来稿快照。
--
-- 文档伴随物，非执行脚本：本仓【无迁移执行器】；运行时 init() 会执行同源幂等 ALTER。
-- 普通发布保持 NULL；内容页展示只读 publish_log 快照，不 join 当前精选池。

ALTER TABLE publish_log ADD COLUMN IF NOT EXISTS source_reference JSONB;
