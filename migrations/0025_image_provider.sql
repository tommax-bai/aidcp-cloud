-- aidcp:kind=expand
-- aidcp:objects=column:model_config.image_provider
-- 0025_image_provider.sql
-- change image-provider-volcengine-seedream：图片模型配置加 provider 维度（多厂商：dashscope 通义万相 + volcengine 即梦 Seedream）。
-- 幂等可重跑；老行回填 'dashscope'（既有图片模型均为万相/DashScope）。图片 provider 独立于文本 text_provider。
-- 与 model-config-store.ts 的自愈 MODEL_CONFIG_ALTER_SQL 同源（rsync 先于迁移时 store.init 也会补此列）。

ALTER TABLE model_config ADD COLUMN IF NOT EXISTS image_provider TEXT NOT NULL DEFAULT 'dashscope';
