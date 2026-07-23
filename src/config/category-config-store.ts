/**
 * 分类默认模型存储（category_config 表，PostgreSQL）。
 *
 * change role-model-category-config（item 5/6）：按「角色分类」覆盖文本模型默认，落库 + 内存镜像，
 * 供解析器在 per-role 覆盖缺失时回落到分类默认 —— PUT 后无需重启即热加载生效。
 *
 * 安全不变量（复刻 RoleConfigStore）：
 * - 绝不 brick：任一分类缺行 / model 为空 / 异常一律返回「无覆盖」，解析器继续向下回落（全局 textModel → 代码默认），永不抛。
 * - 写库成功才刷新内存镜像（避免「镜像已变、库未变」不一致）。
 *
 * 账号维度（item 9 缝，本期不接线）：读路径**恒** `account_id IS NULL`（全局默认行）；
 * 账号专属行（account_id 非空）本期不写入、不读取。启用按账号覆盖时只需把读路径改为
 * 「先查账号行、miss 再查 NULL 行」，无需改表（见 migrations/0009 与 design.md §2）。
 *
 * 建表幂等（CREATE TABLE IF NOT EXISTS），与 migrations/0009_role_category_config.sql 同源。
 */

import pg from 'pg';
import { DEFAULT_PG_CONFIG } from '../kernel/pg-config.js';
import { writeWithMirrorBump, type MirrorVersionBumper } from './mirror-version-store.js';
import { normalizeThinkingMode, type ThinkingMode } from './role-catalog.js';
import type { SchemaEnsurer } from '../kernel/schema-capability-contract.js';

const { Pool } = pg;

/** 单分类的默认覆盖（null = 未覆盖，回落）。 */
export interface CategoryConfigOverride {
  /** 分类默认模型名；null/空 = 回落全局 textModel。 */
  model: string | null;
  /** 厂商覆盖（change model-config-volcengine-provider）；跟 model 同行（model 为空时不贡献 provider）。 */
  provider: string | null;
  /**
   * 分类默认思考模式（change role-thinking-mode-config）；'off'/'on' 覆盖，null = 未覆盖（回落 default）。
   * 与 model/provider **相互独立**：写分类思考模式不动分类模型行。
   */
  thinkingMode: ThinkingMode | null;
}

/** 写回真态（含审计字段，供面板非乐观回显）。 */
export interface CategoryConfigRow extends CategoryConfigOverride {
  categoryId: string;
  updatedAt: string | null;
  updatedBy: string | null;
}

export const CATEGORY_CONFIG_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS category_config (
  category_id TEXT NOT NULL,
  account_id  TEXT,
  model       TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_category_config_global
  ON category_config (category_id) WHERE account_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_category_config_account
  ON category_config (category_id, account_id) WHERE account_id IS NOT NULL;
`;

/** 自愈加列（change model-config-volcengine-provider）：见 ModelConfigStore 同名注释。与 migrations/0018 同源。 */
export const CATEGORY_CONFIG_ALTER_SQL = `
ALTER TABLE category_config ADD COLUMN IF NOT EXISTS provider TEXT;
ALTER TABLE category_config ADD COLUMN IF NOT EXISTS thinking_mode TEXT;
`;

export interface CategoryConfigStoreOptions {
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

interface CategoryConfigDbRow {
  category_id: string;
  model: string | null;
  provider: string | null;
  thinking_mode: string | null;
  updated_at: Date | string | null;
  updated_by: string | null;
}

export class CategoryConfigStore {
  private readonly pool: pg.Pool;
  private readonly mirrorVersionBumper?: MirrorVersionBumper;
  /** 仅缓存全局默认行（account_id IS NULL）。 */
  private cache = new Map<string, CategoryConfigRow>();

  private readonly schemaEnsurer: SchemaEnsurer;

  constructor(options: CategoryConfigStoreOptions) {
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

  /** schema 探测（不建表；自愈加列已随 DDL 一并迁往 migrations/） + 载入内存镜像（全局默认行）。 */
  async init(): Promise<void> {
    // DDL 单一所有者（change cloud-schema-migration-executor 任务 5.x）：只探测、不建表。
    // 探不到即带 version id 明确报错并 fail-closed；MUST NOT 在这里把表建出来继续跑。
    await this.schemaEnsurer(this.pool, {
      capability: 'category_config',
      sinceVersion: '0009_role_category_config',
      ddl: [CATEGORY_CONFIG_SCHEMA_SQL, CATEGORY_CONFIG_ALTER_SQL],
    });
    await this.reload();
  }

  /** 跨进程失效刷新入口（task 3.2）：只由刷新器在版本变化时调用；`reload()` 保持 private。 */
  async refreshFromAuthority(): Promise<void> {
    await this.reload();
  }

  private async reload(): Promise<void> {
    const { rows } = await this.pool.query<CategoryConfigDbRow>(
      `SELECT category_id, model, provider, thinking_mode, updated_at, updated_by
         FROM category_config
        WHERE account_id IS NULL`,
    );
    const next = new Map<string, CategoryConfigRow>();
    for (const r of rows) {
      next.set(r.category_id, {
        categoryId: r.category_id,
        model: r.model?.trim() ? r.model.trim() : null,
        provider: r.provider?.trim() ? r.provider.trim() : null,
        thinkingMode: normalizeThinkingMode(r.thinking_mode),
        updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null,
        updatedBy: r.updated_by ?? null,
      });
    }
    this.cache = next;
  }

  /**
   * 同步取某分类的生效默认（解析器在 per-role 缺失时调用）。
   * 缺行 / model 为空一律返回 null（回落由调用方处理）；永不抛。
   */
  getForCategory(categoryId: string): CategoryConfigOverride {
    const v = this.cache.get(categoryId);
    if (!v) return { model: null, provider: null, thinkingMode: null };
    return { model: v.model, provider: v.provider, thinkingMode: v.thinkingMode };
  }

  /** 全部全局默认行（面板列表回显当前生效值 + 审计用）。 */
  getAll(): Map<string, CategoryConfigRow> {
    return this.cache;
  }

  /**
   * 写库 + 刷新内存镜像（热加载）。写全局默认行（account_id IS NULL）。
   * model 传 null/'' 清除覆盖（回落）。先写库成功、再刷镜像（写库失败镜像不变）。
   * 用部分唯一索引 uq_category_config_global 做冲突目标（account_id IS NULL 的 upsert）。
   */
  async set(
    categoryId: string,
    patch: {
      model?: string | null;
      provider?: string | null;
      /** 分类思考模式（change role-thinking-mode-config）：'off'/'on' 覆盖，'default'/null/'' 清除；undefined = 不动。独立于 model 行。 */
      thinkingMode?: string | null;
    },
    updatedBy: string,
  ): Promise<CategoryConfigRow> {
    const prev = this.cache.get(categoryId) ?? { model: null, provider: null, thinkingMode: null };
    const nextModel =
      patch.model === undefined ? prev.model : patch.model?.trim() ? patch.model.trim() : null;
    // provider 跟 model 同行（change model-config-volcengine-provider）：不动 model → 不动 provider；
    // 清 model → 清 provider；写 model → provider 跟着写（缺省回落 dashscope，未知由解析器再归一）。
    let nextProvider: string | null;
    if (patch.model === undefined) nextProvider = prev.provider;
    else if (nextModel === null) nextProvider = null;
    else nextProvider = patch.provider?.trim() || 'dashscope';
    // 思考模式独立于 model 行（change role-thinking-mode-config）：不传 → 保持；传 'default'/空/脏串 → null（清除）。
    const nextThinking =
      patch.thinkingMode === undefined ? prev.thinkingMode : normalizeThinkingMode(patch.thinkingMode);
    const { rows } = await writeWithMirrorBump(this.pool, this.mirrorVersionBumper, 'category_config', (q) =>
      q.query<CategoryConfigDbRow>(
        `INSERT INTO category_config (category_id, account_id, model, provider, thinking_mode, updated_at, updated_by)
       VALUES ($1, NULL, $2, $3, $4, now(), $5)
       ON CONFLICT (category_id) WHERE account_id IS NULL
       DO UPDATE SET model = EXCLUDED.model, provider = EXCLUDED.provider, thinking_mode = EXCLUDED.thinking_mode,
                     updated_at = now(), updated_by = EXCLUDED.updated_by
       RETURNING category_id, model, provider, thinking_mode, updated_at, updated_by`,
        [categoryId, nextModel, nextProvider, nextThinking, updatedBy],
      ),
    );
    const row = rows[0];
    const result: CategoryConfigRow = {
      categoryId,
      model: nextModel,
      provider: nextProvider,
      thinkingMode: nextThinking,
      updatedAt: row?.updated_at ? new Date(row.updated_at).toISOString() : null,
      updatedBy: row?.updated_by ?? updatedBy,
    };
    this.cache.set(categoryId, result);
    return result;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
