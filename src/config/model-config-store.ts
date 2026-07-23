/**
 * 模型配置存储（model_config 单行表，PostgreSQL）。
 *
 * change console-model-provider-config：文本/图片模型名落库（缺行回退代码默认），
 * 内存镜像供 LLM 客户端运行时按需解析模型名 —— PUT 后无需重启即热加载生效。
 *
 * 建表幂等（CREATE TABLE IF NOT EXISTS），与 migrations/0007_model_config.sql 同源。
 */

import pg from 'pg';
import { DEFAULT_PG_CONFIG } from '../kernel/pg-config.js';
import { writeWithMirrorBump, type MirrorVersionBumper } from './mirror-version-store.js';
import type { SchemaEnsurer } from '../kernel/schema-capability-contract.js';

const { Pool } = pg;

/**
 * 缺行 / PG 不可用时的回退默认。
 * textModel 必须指向现役在售模型：qwen-turbo 百炼 2026-07-13 下架，兜底指向已下架模型 = 兜底即坏
 * （change llm-role-review-remediation）。qwen.ts 构造默认仍为 qwen-turbo，仅存于无解析器注入的单测路径。
 * imageModel 与 wanxiang-client.ts 构造默认一致。
 */
export const MODEL_CONFIG_DEFAULTS: ModelConfigValue = {
  textModel: 'qwen3.7-plus',
  // 全局文本厂商默认 dashscope（零回归基准）。change model-config-volcengine-provider。
  textProvider: 'dashscope',
  imageModel: 'wan2.7-image-pro',
  // 全局图片厂商默认 dashscope（万相；零回归基准）。change image-provider-volcengine-seedream。
  imageProvider: 'dashscope',
};

export interface ModelConfigValue {
  textModel: string;
  /** 全局文本厂商（change model-config-volcengine-provider）；缺/空回落 dashscope。 */
  textProvider: string;
  imageModel: string;
  /**
   * 全局图片厂商（change image-provider-volcengine-seedream）；缺/空回落 dashscope（万相）。
   * dashscope→通义万相（异步）、volcengine→即梦 Seedream（火山方舟 Ark 同步）。独立于 textProvider。
   */
  imageProvider: string;
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

/**
 * 自愈加列（change model-config-volcengine-provider）：ECS 上表已存在、CREATE TABLE IF NOT EXISTS 是 no-op、
 * 不补列；rsync 先于迁移时，若 reload 的 SELECT 含新列而列尚不存在会抛错并被 init 的 catch 静默回落。
 * 故 init() 在 reload 前额外跑此幂等 ALTER，使运行中的 store 永不领先于自己的 schema。与 migrations/0018 同源。
 */
export const MODEL_CONFIG_ALTER_SQL = `
ALTER TABLE model_config ADD COLUMN IF NOT EXISTS text_provider TEXT NOT NULL DEFAULT 'dashscope';
ALTER TABLE model_config ADD COLUMN IF NOT EXISTS image_provider TEXT NOT NULL DEFAULT 'dashscope';
`;

export interface ModelConfigStoreOptions {
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  pool?: pg.Pool;
  /** schema 保障能力注入端口（必填、无默认）：组合根传 automation 的 ensureCapabilitySchema，本文件只从 kernel 取类型。 */
  schemaEnsurer: SchemaEnsurer;
  /** 跨进程失效通道：写入与版本推进同事务。缺省 = 不推版本（行为逐位退回今日现状）。 */
  mirrorVersionBumper?: MirrorVersionBumper;
}

export class ModelConfigStore {
  private readonly pool: pg.Pool;
  private readonly mirrorVersionBumper?: MirrorVersionBumper;
  private cache: ModelConfigValue = { ...MODEL_CONFIG_DEFAULTS };

  private readonly schemaEnsurer: SchemaEnsurer;

  constructor(options: ModelConfigStoreOptions) {
    this.schemaEnsurer = options.schemaEnsurer;
    this.mirrorVersionBumper = options.mirrorVersionBumper;
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

  /** schema 探测（不建表；自愈加列已随 DDL 一并迁往 migrations/） + 载入内存镜像（缺行用默认）。 */
  async init(): Promise<void> {
    // DDL 单一所有者（change cloud-schema-migration-executor 任务 5.x）：只探测、不建表。
    // 探不到即带 version id 明确报错并 fail-closed；MUST NOT 在这里把表建出来继续跑。
    await this.schemaEnsurer(this.pool, {
      capability: 'model_config',
      sinceVersion: '0007_model_config',
      ddl: [MODEL_CONFIG_SCHEMA_SQL, MODEL_CONFIG_ALTER_SQL],
    });
    await this.reload();
  }

  /** 跨进程失效刷新入口（task 3.2）：只由刷新器在版本变化时调用；`reload()` 保持 private。 */
  async refreshFromAuthority(): Promise<void> {
    await this.reload();
  }

  private async reload(): Promise<void> {
    const { rows } = await this.pool.query<{
      text_model: string | null;
      text_provider: string | null;
      image_model: string | null;
      image_provider: string | null;
    }>(`SELECT text_model, text_provider, image_model, image_provider FROM model_config WHERE id = 1`);
    const row = rows[0];
    this.cache = {
      textModel: row?.text_model?.trim() || MODEL_CONFIG_DEFAULTS.textModel,
      textProvider: row?.text_provider?.trim() || MODEL_CONFIG_DEFAULTS.textProvider,
      imageModel: row?.image_model?.trim() || MODEL_CONFIG_DEFAULTS.imageModel,
      imageProvider: row?.image_provider?.trim() || MODEL_CONFIG_DEFAULTS.imageProvider,
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
      textProvider: patch.textProvider?.trim() || this.cache.textProvider,
      imageModel: patch.imageModel?.trim() || this.cache.imageModel,
      imageProvider: patch.imageProvider?.trim() || this.cache.imageProvider,
    };
    await writeWithMirrorBump(this.pool, this.mirrorVersionBumper, 'model_config', (q) =>
      q.query(
        `INSERT INTO model_config (id, text_model, text_provider, image_model, image_provider, updated_at, updated_by)
       VALUES (1, $1, $2, $3, $4, now(), $5)
       ON CONFLICT (id)
       DO UPDATE SET text_model = EXCLUDED.text_model, text_provider = EXCLUDED.text_provider,
                     image_model = EXCLUDED.image_model, image_provider = EXCLUDED.image_provider,
                     updated_at = now(), updated_by = EXCLUDED.updated_by`,
        [next.textModel, next.textProvider, next.imageModel, next.imageProvider, updatedBy],
      ),
    );
    this.cache = next;
    return next;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
