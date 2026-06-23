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
import { DEFAULT_PG_CONFIG } from '../cache/pg-anchor-cache.js';

const { Pool } = pg;

/** 单分类的默认覆盖（null = 未覆盖，回落）。 */
export interface CategoryConfigOverride {
  /** 分类默认模型名；null/空 = 回落全局 textModel。 */
  model: string | null;
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

export interface CategoryConfigStoreOptions {
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  pool?: pg.Pool;
}

interface CategoryConfigDbRow {
  category_id: string;
  model: string | null;
  updated_at: Date | string | null;
  updated_by: string | null;
}

export class CategoryConfigStore {
  private readonly pool: pg.Pool;
  /** 仅缓存全局默认行（account_id IS NULL）。 */
  private cache = new Map<string, CategoryConfigRow>();

  constructor(options: CategoryConfigStoreOptions = {}) {
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

  /** 建表 + 载入内存镜像（全局默认行）。 */
  async init(): Promise<void> {
    await this.pool.query(CATEGORY_CONFIG_SCHEMA_SQL);
    await this.reload();
  }

  private async reload(): Promise<void> {
    const { rows } = await this.pool.query<CategoryConfigDbRow>(
      `SELECT category_id, model, updated_at, updated_by
         FROM category_config
        WHERE account_id IS NULL`,
    );
    const next = new Map<string, CategoryConfigRow>();
    for (const r of rows) {
      next.set(r.category_id, {
        categoryId: r.category_id,
        model: r.model?.trim() ? r.model.trim() : null,
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
    if (!v) return { model: null };
    return { model: v.model };
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
  async set(categoryId: string, model: string | null, updatedBy: string): Promise<CategoryConfigRow> {
    const nextModel = model?.trim() ? model.trim() : null;
    const { rows } = await this.pool.query<CategoryConfigDbRow>(
      `INSERT INTO category_config (category_id, account_id, model, updated_at, updated_by)
       VALUES ($1, NULL, $2, now(), $3)
       ON CONFLICT (category_id) WHERE account_id IS NULL
       DO UPDATE SET model = EXCLUDED.model, updated_at = now(), updated_by = EXCLUDED.updated_by
       RETURNING category_id, model, updated_at, updated_by`,
      [categoryId, nextModel, updatedBy],
    );
    const row = rows[0];
    const result: CategoryConfigRow = {
      categoryId,
      model: nextModel,
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
