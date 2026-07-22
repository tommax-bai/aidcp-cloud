-- aidcp:kind=expand
-- aidcp:objects=column:category_config.provider,column:model_config.text_provider,column:role_config.provider
-- 0018_text_provider.sql
-- change model-config-volcengine-provider：文本模型配置加 provider 维度（多厂商：dashscope + volcengine 火山方舟）。
-- 幂等可重跑；老行回填 'dashscope'（既有文本模型均为 Qwen/DashScope，provider 跟模型同行）。
-- provider_credentials 不动（已 PK(provider, field)，本就多厂商形状）。

ALTER TABLE model_config    ADD COLUMN IF NOT EXISTS text_provider TEXT NOT NULL DEFAULT 'dashscope';
ALTER TABLE role_config     ADD COLUMN IF NOT EXISTS provider TEXT;
ALTER TABLE category_config ADD COLUMN IF NOT EXISTS provider TEXT;

-- 回填：仅给"有模型覆盖"的行补 dashscope（纯温度覆盖行 model 为空 → provider 保持 NULL，解析器不取其 provider）。
UPDATE role_config     SET provider = 'dashscope' WHERE model IS NOT NULL AND model <> '' AND (provider IS NULL OR provider = '');
UPDATE category_config SET provider = 'dashscope' WHERE model IS NOT NULL AND model <> '' AND (provider IS NULL OR provider = '');
