/**
 * 自动续场护栏 + 看门狗阈值配置存储（resume_config 表，PostgreSQL）。
 *
 * change session-auto-resume-with-excursions：按账号可后台编辑 + 热加载；实现 ResumeConfigProvider
 * 供调度器（续场闸 + 休息时长）/ 会话监测体（看门狗阈值）每次现读（PUT 后无需重启）。
 *
 * 安全不变量（复刻 SessionConfigStore）：
 * - 绝不 brick：某账号缺行 / 字段非法 → 该项逐项回落写死默认；永不抛。
 * - 写库成功才刷内存镜像。
 * - 零回归：表为空时取值与写死默认逐位一致（缺行全回落）。
 *
 * 红线：本 store 只读写 resume_config；绝不碰风控状态单写路径（risk_state / setQuotaLevel / applySignal）、不经协议。
 * 建表幂等（CREATE TABLE IF NOT EXISTS），与 migrations/0020_resume_config.sql 同源。
 */

import pg from 'pg';
import { DEFAULT_PG_CONFIG } from '../cache/pg-anchor-cache.js';
import {
  DEFAULT_ACTIVE_WINDOW,
  DEFAULT_DAILY_MAX_MINUTES,
  DEFAULT_DAILY_MAX_SESSIONS,
  DEFAULT_IDLE_END_MS,
  DEFAULT_IDLE_NUDGE_MS,
  DEFAULT_REST_RATIO_PCT,
  IDLE_NUDGE_MIN_MS,
  MINUTES_PER_DAY,
  type ActiveWindow,
  type DailyCaps,
  type ResumeConfigProvider,
} from '../risk/resume-limits.js';

const { Pool } = pg;

/** 单账号行：续场护栏 + 看门狗阈值 + 审计（面板回显用）。null 表示该列未覆盖（回落写死默认）。 */
export interface ResumeConfigRow {
  accountId: string;
  restRatioPct: number | null;
  activeWindowStartMin: number | null;
  activeWindowEndMin: number | null;
  dailyMaxSessions: number | null;
  dailyMaxMinutes: number | null;
  idleNudgeMs: number | null;
  idleEndMs: number | null;
  updatedAt: string | null;
  updatedBy: string | null;
}

/** 写补丁：未传的字段保持原值（无原值则该列写 null = 回落写死默认）。 */
export interface ResumeConfigPatch {
  restRatioPct?: number;
  activeWindowStartMin?: number;
  activeWindowEndMin?: number;
  dailyMaxSessions?: number;
  dailyMaxMinutes?: number;
  idleNudgeMs?: number;
  idleEndMs?: number;
}

export const RESUME_CONFIG_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS resume_config (
  account_id              TEXT PRIMARY KEY,
  rest_ratio_pct          INTEGER,
  active_window_start_min INTEGER,
  active_window_end_min   INTEGER,
  daily_max_sessions      INTEGER,
  daily_max_minutes       INTEGER,
  idle_nudge_ms           INTEGER,
  idle_end_ms             INTEGER,
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by              TEXT
);
`;

export interface ResumeConfigStoreOptions {
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  pool?: pg.Pool;
}

interface ResumeDbRow {
  account_id: string;
  rest_ratio_pct: number | string | null;
  active_window_start_min: number | string | null;
  active_window_end_min: number | string | null;
  daily_max_sessions: number | string | null;
  daily_max_minutes: number | string | null;
  idle_nudge_ms: number | string | null;
  idle_end_ms: number | string | null;
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

/** 分钟数夹到 [0,1440]，越界视作缺。 */
function validMinuteOfDay(raw: number | string | null | undefined): number | undefined {
  const n = validInt(raw);
  if (n === undefined || n > MINUTES_PER_DAY) return undefined;
  return n;
}

export class ResumeConfigStore implements ResumeConfigProvider {
  private readonly pool: pg.Pool;
  private cache = new Map<string, ResumeConfigRow>();

  constructor(options: ResumeConfigStoreOptions = {}) {
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
    await this.pool.query(RESUME_CONFIG_SCHEMA_SQL);
    await this.reload();
  }

  private async reload(): Promise<void> {
    const { rows } = await this.pool.query<ResumeDbRow>(
      `SELECT account_id, rest_ratio_pct, active_window_start_min, active_window_end_min,
              daily_max_sessions, daily_max_minutes, idle_nudge_ms, idle_end_ms, updated_at, updated_by
         FROM resume_config`,
    );
    const next = new Map<string, ResumeConfigRow>();
    for (const r of rows) next.set(r.account_id, this.rowFromDb(r));
    this.cache = next;
  }

  private numOrNull(raw: number | string | null): number | null {
    return raw === null || raw === undefined ? null : Number(raw);
  }

  private rowFromDb(r: ResumeDbRow): ResumeConfigRow {
    return {
      accountId: r.account_id,
      restRatioPct: this.numOrNull(r.rest_ratio_pct),
      activeWindowStartMin: this.numOrNull(r.active_window_start_min),
      activeWindowEndMin: this.numOrNull(r.active_window_end_min),
      dailyMaxSessions: this.numOrNull(r.daily_max_sessions),
      dailyMaxMinutes: this.numOrNull(r.daily_max_minutes),
      idleNudgeMs: this.numOrNull(r.idle_nudge_ms),
      idleEndMs: this.numOrNull(r.idle_end_ms),
      updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null,
      updatedBy: r.updated_by ?? null,
    };
  }

  // ─── ResumeConfigProvider（逐项回落写死默认、永不抛） ───────────────────────

  restRatioFor(accountId: string): number {
    const pct = validInt(this.cache.get(accountId)?.restRatioPct ?? undefined);
    return (pct ?? DEFAULT_REST_RATIO_PCT) / 100;
  }

  activeWindowFor(accountId: string): ActiveWindow {
    const row = this.cache.get(accountId);
    const startMin = validMinuteOfDay(row?.activeWindowStartMin ?? undefined);
    const endMin = validMinuteOfDay(row?.activeWindowEndMin ?? undefined);
    if (startMin === undefined || endMin === undefined) return { ...DEFAULT_ACTIVE_WINDOW };
    return { startMin, endMin };
  }

  dailyCapsFor(accountId: string): DailyCaps {
    const row = this.cache.get(accountId);
    return {
      maxSessions: validInt(row?.dailyMaxSessions ?? undefined) ?? DEFAULT_DAILY_MAX_SESSIONS,
      maxMinutes: validInt(row?.dailyMaxMinutes ?? undefined) ?? DEFAULT_DAILY_MAX_MINUTES,
    };
  }

  idleNudgeMsFor(accountId: string): number {
    const ms = validInt(this.cache.get(accountId)?.idleNudgeMs ?? undefined);
    // 缺 / 非法 / 低于详情页停留上限 → 回落写死默认（绝不让 nudge 在正常长停留中误触）。
    if (ms === undefined || ms < IDLE_NUDGE_MIN_MS) return DEFAULT_IDLE_NUDGE_MS;
    return ms;
  }

  idleEndMsFor(accountId: string): number {
    const ms = validInt(this.cache.get(accountId)?.idleEndMs ?? undefined);
    const nudge = this.idleNudgeMsFor(accountId);
    // 缺 / 非法 / 不大于轻推 → 回落写死默认（且默认 1h 必 > 任何合法 nudge）。
    if (ms === undefined || ms <= nudge) return Math.max(DEFAULT_IDLE_END_MS, nudge + 1);
    return ms;
  }

  /** 取某账号覆盖行（缺行 undefined，面板审计用）。 */
  getRow(accountId: string): ResumeConfigRow | undefined {
    return this.cache.get(accountId);
  }

  /** 全部覆盖行（面板列表用）。 */
  getAll(): Map<string, ResumeConfigRow> {
    return this.cache;
  }

  /**
   * 写库 + 刷内存镜像（热加载）。未传的字段保持原值（无原值则写 null = 回落写死默认）。
   * 先写库成功、再刷镜像。调用方（facade）应已校验数字合法。
   */
  async set(accountId: string, patch: ResumeConfigPatch, updatedBy: string): Promise<ResumeConfigRow> {
    const prev = this.cache.get(accountId);
    const pick = (
      key: keyof ResumeConfigPatch,
      prevVal: number | null | undefined,
    ): number | null => (patch[key] ?? prevVal ?? null);

    const next = {
      restRatioPct: pick('restRatioPct', prev?.restRatioPct),
      activeWindowStartMin: pick('activeWindowStartMin', prev?.activeWindowStartMin),
      activeWindowEndMin: pick('activeWindowEndMin', prev?.activeWindowEndMin),
      dailyMaxSessions: pick('dailyMaxSessions', prev?.dailyMaxSessions),
      dailyMaxMinutes: pick('dailyMaxMinutes', prev?.dailyMaxMinutes),
      idleNudgeMs: pick('idleNudgeMs', prev?.idleNudgeMs),
      idleEndMs: pick('idleEndMs', prev?.idleEndMs),
    };

    const { rows } = await this.pool.query<ResumeDbRow>(
      `INSERT INTO resume_config (account_id, rest_ratio_pct, active_window_start_min, active_window_end_min,
              daily_max_sessions, daily_max_minutes, idle_nudge_ms, idle_end_ms, updated_at, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now(), $9)
       ON CONFLICT (account_id)
       DO UPDATE SET rest_ratio_pct = EXCLUDED.rest_ratio_pct,
                     active_window_start_min = EXCLUDED.active_window_start_min,
                     active_window_end_min = EXCLUDED.active_window_end_min,
                     daily_max_sessions = EXCLUDED.daily_max_sessions,
                     daily_max_minutes = EXCLUDED.daily_max_minutes,
                     idle_nudge_ms = EXCLUDED.idle_nudge_ms, idle_end_ms = EXCLUDED.idle_end_ms,
                     updated_at = now(), updated_by = EXCLUDED.updated_by
       RETURNING account_id, rest_ratio_pct, active_window_start_min, active_window_end_min,
                 daily_max_sessions, daily_max_minutes, idle_nudge_ms, idle_end_ms, updated_at, updated_by`,
      [
        accountId,
        next.restRatioPct,
        next.activeWindowStartMin,
        next.activeWindowEndMin,
        next.dailyMaxSessions,
        next.dailyMaxMinutes,
        next.idleNudgeMs,
        next.idleEndMs,
        updatedBy,
      ],
    );
    const result = rows[0]
      ? this.rowFromDb(rows[0])
      : { accountId, ...next, updatedAt: null, updatedBy };
    this.cache.set(accountId, result);
    return result;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
