/**
 * 单场会话上限配置存储（session_config 表，PostgreSQL）。
 *
 * change session-limits-to-quota-layer：把单场时长 + 单场互动预算从人设 / 写死常量搬进安全限额层，
 * 按账号可后台编辑 + 热加载。落库 + 内存镜像；实现 SessionLimitProvider 供调度器 / 会话监测体每次现读（PUT 后无需重启）。
 *
 * 安全不变量（复刻 QuotaConfigStore）：
 * - 绝不 brick：某账号缺行 / 字段非法 → 该项逐项回落写死默认（时长 10min + 现 freshBudget 数字）；永不抛。
 * - 写库成功才刷内存镜像（避免「镜像已变、库未变」不一致）。
 * - 零回归：表为空时按账号取值与写死默认逐位一致（缺行全回落）。
 *
 * 红线：本 store 只读写 session_config；绝不碰风控状态单写路径（risk_state / setQuotaLevel / applySignal）、不经协议。
 * 建表幂等（CREATE TABLE IF NOT EXISTS），与 migrations/0015_session_config.sql 同源。
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

/** 单账号行：时长 + 六项预算 + 审计（面板回显用）。 */
export interface SessionConfigRow {
  accountId: string;
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
CREATE TABLE IF NOT EXISTS session_config (
  account_id           TEXT PRIMARY KEY,
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
  account_id: string;
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
  private cache = new Map<string, SessionConfigRow>();

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
      `SELECT account_id, max_duration_min, budget_likes, budget_collects, budget_follows,
              budget_searches, budget_comments, budget_comment_likes, updated_at, updated_by
         FROM session_config`,
    );
    const next = new Map<string, SessionConfigRow>();
    for (const r of rows) {
      next.set(r.account_id, this.rowFromDb(r));
    }
    this.cache = next;
  }

  private rowFromDb(r: SessionDbRow): SessionConfigRow {
    return {
      accountId: r.account_id,
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
   * SessionLimitProvider：某账号单场时长（毫秒）。缺行 / 非法值 → 回落写死默认。永不抛。
   * 时长还需 >= 1 分钟（写死默认 10min 兜底），否则回落（防误存 0 致会话瞬时结束）。
   */
  sessionDurationMsFor(accountId: string): number {
    const row = this.cache.get(accountId);
    const min = validInt(row?.maxDurationMin);
    if (min === undefined || min < 1) return DEFAULT_SESSION_DURATION_MS;
    return min * 60_000;
  }

  /**
   * SessionLimitProvider：某账号单场互动预算（**新拷贝**，可被调用方扣减）。
   * 逐项：库内合法值优先；缺行 / 字段非法 → 该项回落写死默认。永不抛。
   */
  sessionBudgetFor(accountId: string): SessionInteractionBudget {
    const row = this.cache.get(accountId);
    const out = {} as SessionInteractionBudget;
    for (const key of SESSION_BUDGET_KEYS) {
      out[key] = validInt(row?.budget?.[key]) ?? DEFAULT_SESSION_BUDGET[key];
    }
    return out;
  }

  /** 取某账号覆盖行（缺行 undefined，面板审计用）。 */
  getRow(accountId: string): SessionConfigRow | undefined {
    return this.cache.get(accountId);
  }

  /** 全部覆盖行（面板列表用）。 */
  getAll(): Map<string, SessionConfigRow> {
    return this.cache;
  }

  /**
   * 写库 + 刷内存镜像（热加载）。未传的字段保持原值（无原值则回落写死默认，保证列 NOT NULL）。
   * 先写库成功、再刷镜像（写库失败镜像不变）。调用方（facade）应已校验数字合法。
   */
  async set(accountId: string, patch: SessionConfigPatch, updatedBy: string): Promise<SessionConfigRow> {
    const prev = this.cache.get(accountId);
    const nextDuration = patch.maxDurationMin ?? prev?.maxDurationMin ?? DEFAULT_SESSION_DURATION_MIN;
    const nextBudget = {} as SessionInteractionBudget;
    for (const key of SESSION_BUDGET_KEYS) {
      const fromPatch = patch[key as SessionBudgetKey];
      nextBudget[key] = fromPatch ?? prev?.budget?.[key] ?? DEFAULT_SESSION_BUDGET[key];
    }

    const { rows } = await this.pool.query<SessionDbRow>(
      `INSERT INTO session_config (account_id, max_duration_min, budget_likes, budget_collects,
              budget_follows, budget_searches, budget_comments, budget_comment_likes, updated_at, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now(), $9)
       ON CONFLICT (account_id)
       DO UPDATE SET max_duration_min = EXCLUDED.max_duration_min,
                     budget_likes = EXCLUDED.budget_likes, budget_collects = EXCLUDED.budget_collects,
                     budget_follows = EXCLUDED.budget_follows, budget_searches = EXCLUDED.budget_searches,
                     budget_comments = EXCLUDED.budget_comments, budget_comment_likes = EXCLUDED.budget_comment_likes,
                     updated_at = now(), updated_by = EXCLUDED.updated_by
       RETURNING account_id, max_duration_min, budget_likes, budget_collects, budget_follows,
                 budget_searches, budget_comments, budget_comment_likes, updated_at, updated_by`,
      [
        accountId,
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
      accountId,
      maxDurationMin: nextDuration,
      budget: nextBudget,
      updatedAt: null,
      updatedBy,
    };
    this.cache.set(accountId, result);
    return result;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
