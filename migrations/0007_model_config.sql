-- aidcp:kind=expand
-- aidcp:objects=column:model_config.id,column:model_config.image_model,column:model_config.text_model,column:model_config.updated_at
-- aidcp:objects=column:model_config.updated_by,column:provider_credentials.ciphertext,column:provider_credentials.field,column:provider_credentials.masked_hint
-- aidcp:objects=column:provider_credentials.provider,column:provider_credentials.updated_at,column:provider_credentials.updated_by,table:model_config
-- aidcp:objects=table:provider_credentials
-- 0007_model_config.sql — 模型配置 + 加密凭据（change console-model-provider-config）
--
-- model_config：单行（id=1）模型名配置，缺行回退代码默认（qwen-turbo / wan2.7-image-pro）。
-- provider_credentials：按 (provider, field) 唯一的加密凭据（AES-256-GCM 密文，主密钥读 env AIDCP_CRED_KEY）。
--   ciphertext = base64(iv‖authTag‖密文)；masked_hint 为写时算好的非敏感掩码（如 sk-1****cdef）。
--   明文密钥绝不落库；主密钥绝不入库/入仓。
-- 建表幂等，与 src/config/{model-config-store,credential-store}.ts 同源。

CREATE TABLE IF NOT EXISTS model_config (
  id          INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  text_model  TEXT,
  image_model TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  TEXT
);

CREATE TABLE IF NOT EXISTS provider_credentials (
  provider    TEXT NOT NULL,
  field       TEXT NOT NULL,
  ciphertext  TEXT NOT NULL,
  masked_hint TEXT NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  TEXT,
  PRIMARY KEY (provider, field)
);
