/**
 * 模型配置存储（model_config 单行表，PostgreSQL）。
 *
 * change console-model-provider-config：文本/图片模型名落库（缺行回退代码默认），
 * 内存镜像供 LLM 客户端运行时按需解析模型名 —— PUT 后无需重启即热加载生效。
 *
 * 建表幂等（CREATE TABLE IF NOT EXISTS），与 migrations/0007_model_config.sql 同源。
 */

import pg from 'pg';
import { DEFAULT_PG_CONFIG } from '../cache/pg-anchor-cache.js';

const { Pool } = pg;

/** 缺行 / PG 不可用时的回退默认（与 qwen.ts / wanxiang-client.ts 构造默认一致）。 */
export const MODEL_CONFIG_DEFAULTS: ModelConfigValue = {
  textModel: 'qwen-turbo',
  imageModel: 'wan2.7-image-pro',
};

export interface ModelConfigValue {
  textModel: string;
  imageModel: string;
}

export const MODEL_CONFIG_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS model_config (
  id          INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  text_model  TEXT,
  image_model TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  TEXT
);
`;

export interface ModelConfigStoreOptions {
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  pool?: pg.Pool;
}

export class ModelConfigStore {
  private readonly pool: pg.Pool;
  private cache: ModelConfigValue = { ...MODEL_CONFIG_DEFAULTS };

  constructor(options: ModelConfigStoreOptions = {}) {
    this.pool =
      options.pool ??
      new Pool({
        host: options.host ?? DEFAULT_PG_CONFIG.host,
        port: options.port ?? DEFAULT_PG_CONFIG.port,
        database: options.database ?? DEFAULT_PG_CONFIG.database,
        user: options.user ?? DEFAULT_PG_CONFIG.user,
        password: options.password ?? DEFAULT_PG_CONFIG.password,
      });
  }

  /** 建表 + 载入内存镜像（缺行用默认）。 */
  async init(): Promise<void> {
    await this.pool.query(MODEL_CONFIG_SCHEMA_SQL);
    await this.reload();
  }

  private async reload(): Promise<void> {
    const { rows } = await this.pool.query<{ text_model: string | null; image_model: string | null }>(
      `SELECT text_model, image_model FROM model_config WHERE id = 1`,
    );
    const row = rows[0];
    this.cache = {
      textModel: row?.text_model?.trim() || MODEL_CONFIG_DEFAULTS.textModel,
      imageModel: row?.image_model?.trim() || MODEL_CONFIG_DEFAULTS.imageModel,
    };
  }

  /** 同步取当前配置（客户端每次调用按需解析模型名用）。 */
  getCached(): ModelConfigValue {
    return this.cache;
  }

  async get(): Promise<ModelConfigValue> {
    return this.cache;
  }

  /** 写库 + 刷新内存镜像（热加载）。只改传入的字段，未传保持原值。 */
  async set(patch: Partial<ModelConfigValue>, updatedBy: string): Promise<ModelConfigValue> {
    const next: ModelConfigValue = {
      textModel: patch.textModel?.trim() || this.cache.textModel,
      imageModel: patch.imageModel?.trim() || this.cache.imageModel,
    };
    await this.pool.query(
      `INSERT INTO model_config (id, text_model, image_model, updated_at, updated_by)
       VALUES (1, $1, $2, now(), $3)
       ON CONFLICT (id)
       DO UPDATE SET text_model = EXCLUDED.text_model, image_model = EXCLUDED.image_model,
                     updated_at = now(), updated_by = EXCLUDED.updated_by`,
      [next.textModel, next.imageModel, updatedBy],
    );
    this.cache = next;
    return next;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
