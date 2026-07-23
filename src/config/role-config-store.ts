/**
 * 角色配置存储（role_config 表，PostgreSQL）。
 *
 * change console-role-model-config：按角色覆盖文本模型名与温度，落库 + 内存镜像，
 * 供 LLM 客户端运行时按角色解析 —— PUT 后无需重启即热加载生效。
 *
 * 安全不变量：
 * - 绝不 brick：任一角色任一字段缺行 / 为空 / 无效，解析器回落（模型→全局 textModel、温度→构造默认），永不抛。
 * - 写库成功才刷新内存镜像（复刻 ModelConfigStore 时序，避免「镜像已变、库未变」不一致）。
 *
 * 建表幂等（CREATE TABLE IF NOT EXISTS），与 migrations/0008_role_config.sql 同源。
 */

import pg from 'pg';
import { DEFAULT_PG_CONFIG } from '../kernel/pg-config.js';
import { writeWithMirrorBump, type MirrorVersionBumper } from './mirror-version-store.js';
import { normalizeThinkingMode, type ThinkingMode } from './role-catalog.js';
import type { SchemaEnsurer } from '../kernel/schema-capability-contract.js';

const { Pool } = pg;

/** 单角色的覆盖值（null = 未覆盖，回落）。 */
export interface RoleConfigOverride {
  /** 模型名覆盖；null/空 = 回落全局 textModel。 */
  model: string | null;
  /**
   * 厂商覆盖（change model-config-volcengine-provider）；跟 model 同行：
   * model 非空时其 provider 生效（null/未知由解析器归一 dashscope），model 为空时该层不贡献 provider。
   */
  provider: string | null;
  /** 温度覆盖；null = 回落构造默认。 */
  temperature: number | null;
  /**
   * 思考模式覆盖（change role-thinking-mode-config）；'off'/'on' = 显式覆盖，null = 未覆盖（回落分类→default）。
   * 与 model/provider/temperature **相互独立**：写思考模式不动模型行，反之亦然。
   */
  thinkingMode: ThinkingMode | null;
}

/** 写回真态（含审计字段，供面板非乐观回显）。 */
export interface RoleConfigRow extends RoleConfigOverride {
  roleId: string;
  updatedAt: string | null;
  updatedBy: string | null;
}

export const ROLE_CONFIG_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS role_config (
  role_id     TEXT PRIMARY KEY,
  model       TEXT,
  temperature REAL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  TEXT
);
`;

/** 自愈加列（change model-config-volcengine-provider）：见 ModelConfigStore 同名注释。与 migrations/0018 同源。 */
export const ROLE_CONFIG_ALTER_SQL = `
ALTER TABLE role_config ADD COLUMN IF NOT EXISTS provider TEXT;
ALTER TABLE role_config ADD COLUMN IF NOT EXISTS thinking_mode TEXT;
`;

export interface RoleConfigStoreOptions {
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

interface RoleConfigDbRow {
  role_id: string;
  model: string | null;
  provider: string | null;
  temperature: number | string | null;
  thinking_mode: string | null;
  updated_at: Date | string | null;
  updated_by: string | null;
}

export class RoleConfigStore {
  private readonly pool: pg.Pool;
  private readonly mirrorVersionBumper?: MirrorVersionBumper;
  private cache = new Map<string, RoleConfigRow>();

  private readonly schemaEnsurer: SchemaEnsurer;

  constructor(options: RoleConfigStoreOptions) {
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

  /** schema 探测（不建表；自愈加列已随 DDL 一并迁往 migrations/） + 载入内存镜像。 */
  async init(): Promise<void> {
    // DDL 单一所有者（change cloud-schema-migration-executor 任务 5.x）：只探测、不建表。
    // 探不到即带 version id 明确报错并 fail-closed；MUST NOT 在这里把表建出来继续跑。
    await this.schemaEnsurer(this.pool, {
      capability: 'role_config',
      sinceVersion: '0008_role_config',
      ddl: [ROLE_CONFIG_SCHEMA_SQL, ROLE_CONFIG_ALTER_SQL],
    });
    await this.reload();
  }

  /** 跨进程失效刷新入口（task 3.2）：只由刷新器在版本变化时调用；`reload()` 保持 private。 */
  async refreshFromAuthority(): Promise<void> {
    await this.reload();
  }

  private async reload(): Promise<void> {
    const { rows } = await this.pool.query<RoleConfigDbRow>(
      `SELECT role_id, model, provider, temperature, thinking_mode, updated_at, updated_by FROM role_config`,
    );
    const next = new Map<string, RoleConfigRow>();
    for (const r of rows) {
      next.set(r.role_id, {
        roleId: r.role_id,
        model: r.model?.trim() ? r.model.trim() : null,
        provider: r.provider?.trim() ? r.provider.trim() : null,
        temperature: normalizeTemp(r.temperature),
        thinkingMode: normalizeThinkingMode(r.thinking_mode),
        updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null,
        updatedBy: r.updated_by ?? null,
      });
    }
    this.cache = next;
  }

  /**
   * 同步取某角色的生效覆盖（客户端每次调用解析用）。
   * 缺行 / 字段无效一律返回 null（回落由调用方处理）；永不抛。
   */
  getForRole(roleId: string): RoleConfigOverride {
    const v = this.cache.get(roleId);
    if (!v) return { model: null, provider: null, temperature: null, thinkingMode: null };
    return {
      model: v.model,
      provider: v.provider,
      temperature: v.temperature,
      thinkingMode: v.thinkingMode,
    };
  }

  /** 全部行（面板列表回显当前生效值 + 审计用）。 */
  getAll(): Map<string, RoleConfigRow> {
    return this.cache;
  }

  /**
   * 写库 + 刷新内存镜像（热加载）。只改传入字段，未传保持原值；显式传 null/'' 清除覆盖（回落）。
   * 先写库成功、再刷镜像（写库失败则镜像不变，绝不出现镜像与库不一致）。
   */
  async set(
    roleId: string,
    patch: {
      model?: string | null;
      provider?: string | null;
      temperature?: number | null;
      /** 思考模式（change role-thinking-mode-config）：'off'/'on' 覆盖，'default'/null/'' 清除（回落）；undefined = 不动。独立于 model 行。 */
      thinkingMode?: string | null;
    },
    updatedBy: string,
  ): Promise<RoleConfigRow> {
    const prev = this.cache.get(roleId) ?? {
      model: null,
      provider: null,
      temperature: null,
      thinkingMode: null,
    };
    const nextModel =
      patch.model === undefined ? prev.model : patch.model?.trim() ? patch.model.trim() : null;
    // provider 跟 model 同行（change model-config-volcengine-provider）：不动 model → 不动 provider；
    // 清 model → 清 provider；写 model → provider 跟着写（缺省回落 dashscope，未知由解析器再归一）。
    let nextProvider: string | null;
    if (patch.model === undefined) nextProvider = prev.provider;
    else if (nextModel === null) nextProvider = null;
    else nextProvider = patch.provider?.trim() || 'dashscope';
    const nextTemp =
      patch.temperature === undefined ? prev.temperature : normalizeTemp(patch.temperature);
    // 思考模式独立于 model 行（change role-thinking-mode-config）：不传 → 保持；传 'default'/空/脏串 → null（清除）。
    const nextThinking =
      patch.thinkingMode === undefined ? prev.thinkingMode : normalizeThinkingMode(patch.thinkingMode);

    const { rows } = await writeWithMirrorBump(this.pool, this.mirrorVersionBumper, 'role_config', (q) =>
      q.query<RoleConfigDbRow>(
        `INSERT INTO role_config (role_id, model, provider, temperature, thinking_mode, updated_at, updated_by)
       VALUES ($1, $2, $3, $4, $5, now(), $6)
       ON CONFLICT (role_id)
       DO UPDATE SET model = EXCLUDED.model, provider = EXCLUDED.provider, temperature = EXCLUDED.temperature,
                     thinking_mode = EXCLUDED.thinking_mode,
                     updated_at = now(), updated_by = EXCLUDED.updated_by
       RETURNING role_id, model, provider, temperature, thinking_mode, updated_at, updated_by`,
        [roleId, nextModel, nextProvider, nextTemp, nextThinking, updatedBy],
      ),
    );
    const row = rows[0];
    const result: RoleConfigRow = {
      roleId,
      model: nextModel,
      provider: nextProvider,
      temperature: nextTemp,
      thinkingMode: nextThinking,
      updatedAt: row?.updated_at ? new Date(row.updated_at).toISOString() : null,
      updatedBy: row?.updated_by ?? updatedBy,
    };
    this.cache.set(roleId, result);
    return result;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

/** 温度归一：仅接受 [0,1] 的有限数，否则视作无覆盖（null）。 */
function normalizeTemp(raw: number | string | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  const n = typeof raw === 'string' ? Number(raw) : raw;
  if (!Number.isFinite(n) || n < 0 || n > 1) return null;
  return n;
}
