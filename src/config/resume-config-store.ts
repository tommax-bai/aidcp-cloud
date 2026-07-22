/**
 * 自动续场护栏 + 看门狗阈值配置存储（resume_config_global 表，PostgreSQL）—— 全局单例。
 *
 * change restore-auto-resume-and-global-safety-config（stream B）：把续场护栏 + 看门狗阈值从
 * **按账号**收敛为**全局单例**（用户 2026-06-27 拍板：取消账号维度、改全局通用，对所有账号生效）。
 * 落库（至多一行 id=1）+ 热加载；实现 ResumeConfigProvider 供调度器（续场闸 + 休息时长）/
 * 会话监测体（看门狗阈值）每次现读（PUT 后无需重启）。
 *
 * 安全不变量（保持）：
 * - 绝不 brick：缺配置 / 字段非法 → 该项逐项回落写死默认；永不抛。
 * - 写库成功才刷内存镜像。
 * - 零回归：表为空时取值与写死默认逐位一致（缺行全回落）。
 *
 * 红线：本 store 只读写 resume_config_global；绝不碰风控状态单写路径（risk_state / setQuotaLevel / applySignal）、不经协议。
 * 建表幂等（CREATE TABLE IF NOT EXISTS），与 migrations/0022_global_safety_config.sql 同源。
 *
 * ## 模块归属：本 store 归 aidcp-automation（change config-mirror-cross-process-invalidation task 1.2）
 *
 * 依据：`src/risk/` 对 `src/config/` 的 import 命中数为 **0**，反向 **13 处**（本文件对
 * `../risk/resume-limits.js` 的 import 即其一）——依赖方向已单向倒置，运行时消费者只有调度 / 监测层。
 * 归属对齐是纯划线、零代码成本。定稿方案 §11.4 要求一。归属对齐 MUST NOT 被读作跨进程可见性已消失
 * （dev/ol 两进程共库），故写入路径仍接 `writeWithMirrorBump`（同事务推进版本）。
 */

import pg from 'pg';
import { DEFAULT_PG_CONFIG } from '../cache/pg-anchor-cache.js';
import { writeWithMirrorBump, type MirrorVersionBumper } from './mirror-version-store.js';
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
import { ensureCapabilitySchema } from '../schema/schema-capability.js';

const { Pool } = pg;

/** 全局续场护栏 + 看门狗阈值行 + 审计（面板回显用）。null 表示该列未覆盖（回落写死默认）。 */
export interface ResumeConfigRow {
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
CREATE TABLE IF NOT EXISTS resume_config_global (
  id                      INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
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
  /** 跨进程失效通道：写入与版本推进同事务。缺省 = 不推版本（行为逐位退回今日现状）。 */
  mirrorVersionBumper?: MirrorVersionBumper;
}

interface ResumeDbRow {
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
  private readonly mirrorVersionBumper?: MirrorVersionBumper;
  /** 全局单行镜像；null = 库无行（全回落写死默认）。 */
  private cache: ResumeConfigRow | null = null;

  constructor(options: ResumeConfigStoreOptions = {}) {
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

  /** schema 探测（不建表） + 载入内存镜像。 */
  async init(): Promise<void> {
    // DDL 单一所有者（change cloud-schema-migration-executor 任务 5.x）：只探测、不建表。
    // 探不到即带 version id 明确报错并 fail-closed；MUST NOT 在这里把表建出来继续跑。
    await ensureCapabilitySchema(this.pool, {
      capability: 'resume_config',
      sinceVersion: '0020_resume_config',
      ddl: [RESUME_CONFIG_SCHEMA_SQL],
    });
    await this.reload();
  }

  /** 跨进程失效刷新入口（task 3.2）：只由刷新器在版本变化时调用；`reload()` 保持 private。 */
  async refreshFromAuthority(): Promise<void> {
    await this.reload();
  }

  private async reload(): Promise<void> {
    const { rows } = await this.pool.query<ResumeDbRow>(
      `SELECT rest_ratio_pct, active_window_start_min, active_window_end_min,
              daily_max_sessions, daily_max_minutes, idle_nudge_ms, idle_end_ms, updated_at, updated_by
         FROM resume_config_global WHERE id = 1`,
    );
    this.cache = rows[0] ? this.rowFromDb(rows[0]) : null;
  }

  private numOrNull(raw: number | string | null): number | null {
    return raw === null || raw === undefined ? null : Number(raw);
  }

  private rowFromDb(r: ResumeDbRow): ResumeConfigRow {
    return {
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

  restRatio(): number {
    const pct = validInt(this.cache?.restRatioPct ?? undefined);
    return (pct ?? DEFAULT_REST_RATIO_PCT) / 100;
  }

  activeWindow(): ActiveWindow {
    const startMin = validMinuteOfDay(this.cache?.activeWindowStartMin ?? undefined);
    const endMin = validMinuteOfDay(this.cache?.activeWindowEndMin ?? undefined);
    if (startMin === undefined || endMin === undefined) return { ...DEFAULT_ACTIVE_WINDOW };
    return { startMin, endMin };
  }

  dailyCaps(): DailyCaps {
    return {
      maxSessions: validInt(this.cache?.dailyMaxSessions ?? undefined) ?? DEFAULT_DAILY_MAX_SESSIONS,
      maxMinutes: validInt(this.cache?.dailyMaxMinutes ?? undefined) ?? DEFAULT_DAILY_MAX_MINUTES,
    };
  }

  idleNudgeMs(): number {
    const ms = validInt(this.cache?.idleNudgeMs ?? undefined);
    // 缺 / 非法 / 低于轻推下限（≥单次模型天花板 180s，change raise-model-call-timeouts-for-thinking-models）→ 回落写死默认。
    // 读时钳制：即使 DB 里存着旧值（如 130s/91s），也自动抬到 DEFAULT_IDLE_NUDGE_MS，守「轻推 > 模型天花板」不变量、绝不误触。
    if (ms === undefined || ms < IDLE_NUDGE_MIN_MS) return DEFAULT_IDLE_NUDGE_MS;
    return ms;
  }

  idleEndMs(): number {
    const ms = validInt(this.cache?.idleEndMs ?? undefined);
    const nudge = this.idleNudgeMs();
    // 缺 / 非法 / 不大于轻推 → 回落写死默认（且默认 1h 必 > 任何合法 nudge）。
    if (ms === undefined || ms <= nudge) return Math.max(DEFAULT_IDLE_END_MS, nudge + 1);
    return ms;
  }

  /** 取全局覆盖行（无行 undefined，面板审计 / overridden 判定用）。 */
  getRow(): ResumeConfigRow | undefined {
    return this.cache ?? undefined;
  }

  /**
   * 写库 + 刷内存镜像（热加载）。未传的字段保持原值（无原值则写 null = 回落写死默认）。
   * 先写库成功、再刷镜像。调用方（facade）应已校验数字合法。
   */
  async set(patch: ResumeConfigPatch, updatedBy: string): Promise<ResumeConfigRow> {
    const prev = this.cache;
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

    // 写库与版本推进同事务：写库失败 → 整体回滚 → 版本不进、镜像不刷。
    const { rows } = await writeWithMirrorBump(
      this.pool,
      this.mirrorVersionBumper,
      'resume_config_global',
      (q) =>
        q.query<ResumeDbRow>(
      `INSERT INTO resume_config_global (id, rest_ratio_pct, active_window_start_min, active_window_end_min,
              daily_max_sessions, daily_max_minutes, idle_nudge_ms, idle_end_ms, updated_at, updated_by)
       VALUES (1, $1, $2, $3, $4, $5, $6, $7, now(), $8)
       ON CONFLICT (id)
       DO UPDATE SET rest_ratio_pct = EXCLUDED.rest_ratio_pct,
                     active_window_start_min = EXCLUDED.active_window_start_min,
                     active_window_end_min = EXCLUDED.active_window_end_min,
                     daily_max_sessions = EXCLUDED.daily_max_sessions,
                     daily_max_minutes = EXCLUDED.daily_max_minutes,
                     idle_nudge_ms = EXCLUDED.idle_nudge_ms, idle_end_ms = EXCLUDED.idle_end_ms,
                     updated_at = now(), updated_by = EXCLUDED.updated_by
       RETURNING rest_ratio_pct, active_window_start_min, active_window_end_min,
                 daily_max_sessions, daily_max_minutes, idle_nudge_ms, idle_end_ms, updated_at, updated_by`,
      [
        next.restRatioPct,
        next.activeWindowStartMin,
        next.activeWindowEndMin,
        next.dailyMaxSessions,
        next.dailyMaxMinutes,
        next.idleNudgeMs,
        next.idleEndMs,
        updatedBy,
      ],
        ),
    );
    const result = rows[0]
      ? this.rowFromDb(rows[0])
      : { ...next, updatedAt: null, updatedBy };
    this.cache = result;
    return result;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
