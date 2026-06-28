/**
 * 单场会话上限配置存储（session_config_global 表，PostgreSQL）—— 全局单例。
 *
 * change restore-auto-resume-and-global-safety-config（stream B）：把单场时长 + 单场互动预算从
 * **按账号**收敛为**全局单例**（用户 2026-06-27 拍板：取消账号维度、改全局通用，对所有账号生效）。
 * 落库（至多一行 id=1）+ 内存镜像；实现 SessionLimitProvider 供调度器 / 会话监测体每次现读（PUT 后无需重启）。
 *
 * 安全不变量（保持）：
 * - 绝不 brick：缺配置 / 字段非法 → 该项逐项回落写死默认（时长 10min + 现 freshBudget 数字）；永不抛。
 * - 写库成功才刷内存镜像（避免「镜像已变、库未变」不一致）。
 * - 零回归：全局表为空时取值与写死默认逐位一致（缺行全回落）。
 *
 * 红线：本 store 只读写 session_config_global；绝不碰风控状态单写路径（risk_state / setQuotaLevel / applySignal）、不经协议。
 * 建表幂等（CREATE TABLE IF NOT EXISTS），与 migrations/0022_global_safety_config.sql 同源。
 */

import pg from 'pg';
import { DEFAULT_PG_CONFIG } from '../cache/pg-anchor-cache.js';
import {
  DEFAULT_SESSION_BUDGET,
  DEFAULT_SESSION_DURATION_MIN,
  DEFAULT_SESSION_DURATION_MS,
  SESSION_BUDGET_KEYS,
  type SessionBudgetKey,
  type SessionInteractionBudget,
  type SessionLimitProvider,
} from '../risk/session-limits.js';

const { Pool } = pg;

/** 全局单场上限行：时长 + 六项预算 + 审计（面板回显用）。 */
export interface SessionConfigRow {
  maxDurationMin: number;
  budget: SessionInteractionBudget;
  updatedAt: string | null;
  updatedBy: string | null;
}

/** 写补丁：未传的字段保持原值（无原值则回落写死默认）。 */
export interface SessionConfigPatch {
  maxDurationMin?: number;
  likes?: number;
  collects?: number;
  follows?: number;
  searches?: number;
  comments?: number;
  comment_likes?: number;
}

export const SESSION_CONFIG_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS session_config_global (
  id                   INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  max_duration_min     INTEGER NOT NULL,
  budget_likes         INTEGER NOT NULL,
  budget_collects      INTEGER NOT NULL,
  budget_follows       INTEGER NOT NULL,
  budget_searches      INTEGER NOT NULL,
  budget_comments      INTEGER NOT NULL,
  budget_comment_likes INTEGER NOT NULL,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by           TEXT
);
`;

export interface SessionConfigStoreOptions {
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  pool?: pg.Pool;
}

interface SessionDbRow {
  max_duration_min: number | string;
  budget_likes: number | string;
  budget_collects: number | string;
  budget_follows: number | string;
  budget_searches: number | string;
  budget_comments: number | string;
  budget_comment_likes: number | string;
  updated_at: Date | string | null;
  updated_by: string | null;
}

/** 非负有限整数才算有效覆盖值，否则视作缺（回落写死默认）。 */
function validInt(raw: number | string | null | undefined): number | undefined {
  if (raw === null || raw === undefined) return undefined;
  const n = typeof raw === 'string' ? Number(raw) : raw;
  if (!Number.isInteger(n) || n < 0) return undefined;
  return n;
}

export class SessionConfigStore implements SessionLimitProvider {
  private readonly pool: pg.Pool;
  /** 全局单行镜像；null = 库无行（全回落写死默认）。 */
  private cache: SessionConfigRow | null = null;

  constructor(options: SessionConfigStoreOptions = {}) {
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

  /** 建表 + 载入内存镜像。 */
  async init(): Promise<void> {
    await this.pool.query(SESSION_CONFIG_SCHEMA_SQL);
    await this.reload();
  }

  private async reload(): Promise<void> {
    const { rows } = await this.pool.query<SessionDbRow>(
      `SELECT max_duration_min, budget_likes, budget_collects, budget_follows,
              budget_searches, budget_comments, budget_comment_likes, updated_at, updated_by
         FROM session_config_global WHERE id = 1`,
    );
    this.cache = rows[0] ? this.rowFromDb(rows[0]) : null;
  }

  private rowFromDb(r: SessionDbRow): SessionConfigRow {
    return {
      maxDurationMin: Number(r.max_duration_min),
      budget: {
        likes: Number(r.budget_likes),
        collects: Number(r.budget_collects),
        follows: Number(r.budget_follows),
        searches: Number(r.budget_searches),
        comments: Number(r.budget_comments),
        comment_likes: Number(r.budget_comment_likes),
      },
      updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null,
      updatedBy: r.updated_by ?? null,
    };
  }

  /**
   * SessionLimitProvider：全局单场时长（毫秒）。缺行 / 非法值 → 回落写死默认。永不抛。
   * 时长还需 >= 1 分钟（写死默认 10min 兜底），否则回落（防误存 0 致会话瞬时结束）。
   */
  sessionDurationMs(): number {
    const min = validInt(this.cache?.maxDurationMin);
    if (min === undefined || min < 1) return DEFAULT_SESSION_DURATION_MS;
    return min * 60_000;
  }

  /**
   * SessionLimitProvider：全局单场互动预算（**新拷贝**，可被调用方扣减）。
   * 逐项：库内合法值优先；缺行 / 字段非法 → 该项回落写死默认。永不抛。
   */
  sessionBudget(): SessionInteractionBudget {
    const out = {} as SessionInteractionBudget;
    for (const key of SESSION_BUDGET_KEYS) {
      out[key] = validInt(this.cache?.budget?.[key]) ?? DEFAULT_SESSION_BUDGET[key];
    }
    return out;
  }

  /** 取全局覆盖行（无行 undefined，面板审计 / overridden 判定用）。 */
  getRow(): SessionConfigRow | undefined {
    return this.cache ?? undefined;
  }

  /**
   * 写库 + 刷内存镜像（热加载）。未传的字段保持原值（无原值则回落写死默认，保证列 NOT NULL）。
   * 先写库成功、再刷镜像（写库失败镜像不变）。调用方（facade）应已校验数字合法。
   */
  async set(patch: SessionConfigPatch, updatedBy: string): Promise<SessionConfigRow> {
    const prev = this.cache;
    const nextDuration = patch.maxDurationMin ?? prev?.maxDurationMin ?? DEFAULT_SESSION_DURATION_MIN;
    const nextBudget = {} as SessionInteractionBudget;
    for (const key of SESSION_BUDGET_KEYS) {
      const fromPatch = patch[key as SessionBudgetKey];
      nextBudget[key] = fromPatch ?? prev?.budget?.[key] ?? DEFAULT_SESSION_BUDGET[key];
    }

    const { rows } = await this.pool.query<SessionDbRow>(
      `INSERT INTO session_config_global (id, max_duration_min, budget_likes, budget_collects,
              budget_follows, budget_searches, budget_comments, budget_comment_likes, updated_at, updated_by)
       VALUES (1, $1, $2, $3, $4, $5, $6, $7, now(), $8)
       ON CONFLICT (id)
       DO UPDATE SET max_duration_min = EXCLUDED.max_duration_min,
                     budget_likes = EXCLUDED.budget_likes, budget_collects = EXCLUDED.budget_collects,
                     budget_follows = EXCLUDED.budget_follows, budget_searches = EXCLUDED.budget_searches,
                     budget_comments = EXCLUDED.budget_comments, budget_comment_likes = EXCLUDED.budget_comment_likes,
                     updated_at = now(), updated_by = EXCLUDED.updated_by
       RETURNING max_duration_min, budget_likes, budget_collects, budget_follows,
                 budget_searches, budget_comments, budget_comment_likes, updated_at, updated_by`,
      [
        nextDuration,
        nextBudget.likes,
        nextBudget.collects,
        nextBudget.follows,
        nextBudget.searches,
        nextBudget.comments,
        nextBudget.comment_likes,
        updatedBy,
      ],
    );
    const result = rows[0] ? this.rowFromDb(rows[0]) : {
      maxDurationMin: nextDuration,
      budget: nextBudget,
      updatedAt: null,
      updatedBy,
    };
    this.cache = result;
    return result;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
