/**
 * 引流线索热度过滤阈值配置（hot_lead_config_global 表，PostgreSQL）—— 全局单例。
 *
 * change feed-hot-lead-group-comment：三个过滤闸阈值（帖龄上限 / 每小时点赞速率阈值 / 最小绝对赞数）
 * 做全局后台可配、热加载。落「安全」页一张卡片，判定角色（hot_lead_detector）每次现读（PUT 后无需重启）。
 *
 * 刻意**独立小表**（不并进 session_config_global）：与并发在改 session/quota 配置的其它 change 物理隔离、
 * 近零集成冲突；每列可空（NULL = 回落代码写死保守默认）。
 *
 * 安全不变量（仿 session-config-store）：绝不 brick——缺配置/非法 → 逐项回落 DEFAULT_HOT_LEAD_GATE_CONFIG；永不抛。
 * 写库成功才刷内存镜像。红线：只读写本表，绝不碰风控状态单写路径、不经协议。
 * **纠偏**：速率阈值是「候选帖每小时被点多少赞」（帖子热度），与风控 quota_config.per_hour[like]（本账号限频）
 * 语义不同，故独立于限频表、绝不混用。
 */
import pg from 'pg';
import { DEFAULT_PG_CONFIG } from '../kernel/pg-config.js';
import { writeWithMirrorBump, type MirrorVersionBumper } from './mirror-version-store.js';
import {
  DEFAULT_HOT_LEAD_GATE_CONFIG,
  type HotLeadGateConfig,
} from '../hot-lead/heat-velocity.js';
import type { SchemaEnsurer } from '../kernel/schema-capability-contract.js';

const { Pool } = pg;

/** 全局阈值行（面板回显用）；null 列 = 未覆盖、回落写死默认。floorHours 不进 UI、恒用代码默认。 */
export interface HotLeadConfigRow {
  postAgeMaxHours: number | null;
  velocityMin: number | null;
  minLikeFloor: number | null;
  updatedAt: string | null;
  updatedBy: string | null;
}

/** 写补丁：未传的字段保持原值（无原值则回落写死默认）。 */
export interface HotLeadConfigPatch {
  postAgeMaxHours?: number;
  velocityMin?: number;
  minLikeFloor?: number;
}

export const HOT_LEAD_CONFIG_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS hot_lead_config_global (
  id                 INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  post_age_max_hours INTEGER,
  velocity_min       INTEGER,
  min_like_floor     INTEGER,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by         TEXT
);
`;

export interface HotLeadConfigStoreOptions {
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

interface DbRow {
  post_age_max_hours: number | string | null;
  velocity_min: number | string | null;
  min_like_floor: number | string | null;
  updated_at: Date | string | null;
  updated_by: string | null;
}

/** 有效覆盖值：>= 1 的有限整数（0/负数/非整/NaN 视作缺 → 回落写死默认）。 */
export function validPositiveInt(raw: number | string | null | undefined): number | undefined {
  if (raw === null || raw === undefined) return undefined;
  const n = typeof raw === 'string' ? Number(raw) : raw;
  if (!Number.isInteger(n) || n < 1) return undefined;
  return n;
}

export class HotLeadConfigStore {
  private readonly pool: pg.Pool;
  private readonly mirrorVersionBumper?: MirrorVersionBumper;
  private cache: HotLeadConfigRow | null = null;

  private readonly schemaEnsurer: SchemaEnsurer;

  constructor(options: HotLeadConfigStoreOptions) {
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

  async init(): Promise<void> {
    // DDL 单一所有者（change cloud-schema-migration-executor 任务 5.x）：只探测、不建表。
    // 探不到即带 version id 明确报错并 fail-closed；MUST NOT 在这里把表建出来继续跑。
    await this.schemaEnsurer(this.pool, {
      capability: 'hot_lead_config_global',
      sinceVersion: '0066_baseline_cache_corpus_tables',
      ddl: [HOT_LEAD_CONFIG_SCHEMA_SQL],
    });
    await this.reload();
  }

  /** 跨进程失效刷新入口（task 3.2）：只由刷新器在版本变化时调用；`reload()` 保持 private。 */
  async refreshFromAuthority(): Promise<void> {
    await this.reload();
  }

  private async reload(): Promise<void> {
    const { rows } = await this.pool.query<DbRow>(
      `SELECT post_age_max_hours, velocity_min, min_like_floor, updated_at, updated_by
         FROM hot_lead_config_global WHERE id = 1`,
    );
    this.cache = rows[0] ? this.rowFromDb(rows[0]) : null;
  }

  private rowFromDb(r: DbRow): HotLeadConfigRow {
    return {
      postAgeMaxHours: r.post_age_max_hours == null ? null : Number(r.post_age_max_hours),
      velocityMin: r.velocity_min == null ? null : Number(r.velocity_min),
      minLikeFloor: r.min_like_floor == null ? null : Number(r.min_like_floor),
      updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null,
      updatedBy: r.updated_by ?? null,
    };
  }

  /** 判定角色现读的过滤闸配置：库内合法覆盖优先、逐项回落写死默认（floorHours 恒用代码默认）。永不抛。 */
  getGateConfig(): HotLeadGateConfig {
    return {
      maxAgeHours: validPositiveInt(this.cache?.postAgeMaxHours) ?? DEFAULT_HOT_LEAD_GATE_CONFIG.maxAgeHours,
      velocityMin: validPositiveInt(this.cache?.velocityMin) ?? DEFAULT_HOT_LEAD_GATE_CONFIG.velocityMin,
      minLikeFloor: validPositiveInt(this.cache?.minLikeFloor) ?? DEFAULT_HOT_LEAD_GATE_CONFIG.minLikeFloor,
      floorHours: DEFAULT_HOT_LEAD_GATE_CONFIG.floorHours,
    };
  }

  /** 取全局覆盖行（无行 undefined，面板审计 / overridden 判定用）。 */
  getRow(): HotLeadConfigRow | undefined {
    return this.cache ?? undefined;
  }

  /** 写库 + 刷镜像（热加载）。未传字段保持原值（含原 null）。调用方（facade）应已校验数字合法。 */
  async set(patch: HotLeadConfigPatch, updatedBy: string): Promise<HotLeadConfigRow> {
    const prev = this.cache;
    const nextAge = patch.postAgeMaxHours ?? prev?.postAgeMaxHours ?? null;
    const nextVel = patch.velocityMin ?? prev?.velocityMin ?? null;
    const nextLike = patch.minLikeFloor ?? prev?.minLikeFloor ?? null;
    const { rows } = await writeWithMirrorBump(this.pool, this.mirrorVersionBumper, 'hot_lead_config', (q) =>
      q.query<DbRow>(
        `INSERT INTO hot_lead_config_global (id, post_age_max_hours, velocity_min, min_like_floor, updated_at, updated_by)
       VALUES (1, $1, $2, $3, now(), $4)
       ON CONFLICT (id) DO UPDATE SET
         post_age_max_hours = EXCLUDED.post_age_max_hours,
         velocity_min = EXCLUDED.velocity_min,
         min_like_floor = EXCLUDED.min_like_floor,
         updated_at = now(), updated_by = EXCLUDED.updated_by
       RETURNING post_age_max_hours, velocity_min, min_like_floor, updated_at, updated_by`,
        [nextAge, nextVel, nextLike, updatedBy],
      ),
    );
    const result = rows[0]
      ? this.rowFromDb(rows[0])
      : { postAgeMaxHours: nextAge, velocityMin: nextVel, minLikeFloor: nextLike, updatedAt: null, updatedBy };
    this.cache = result;
    return result;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
