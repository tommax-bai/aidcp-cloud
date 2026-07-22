-- aidcp:kind=expand
-- aidcp:objects=column:publish_log.images_attached_count
-- change publish-multi-image：publish_log 多图配图。
-- 1) 复活 0004 已建但当前 store canonical SQL 未引用的休眠列 images TEXT[]（存全部成功配图 URL）。
--    0004 用 ADD COLUMN IF NOT EXISTS（无 NOT NULL），此处再次 IF NOT EXISTS 幂等无害；
--    并显式兜空，使存量旧行的 images 非 NULL（读侧虽统一 ?? [] 兜底，DB 侧也补齐避免歧义）。
-- 2) 新增 images_attached_count INT —— 真实附着张数（边缘成功上传条数 K）；images_attached 派生 = count>0。
-- additive，幂等，可重复执行；不加 NOT NULL（避免锁表/旧行风险）、不回填旧业务数据、无 down 迁移、前后向不 brick。
-- 注：0016 已被并发的 notification-contact-registry change 占用，本 change 用 0017。
-- 库：aidcp（user=aidcp）。

ALTER TABLE publish_log ADD COLUMN IF NOT EXISTS images TEXT[] NOT NULL DEFAULT '{}';
UPDATE publish_log SET images = '{}' WHERE images IS NULL;
ALTER TABLE publish_log ADD COLUMN IF NOT EXISTS images_attached_count INT NOT NULL DEFAULT 0;
