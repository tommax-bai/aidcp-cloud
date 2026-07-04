/**
 * 操作兜底 floor 配置存储（pacing_floor_config 表，PostgreSQL）。
 *
 * change pacing-floor-config-min-interval（cloud 业务层）：把四类操作（action/scroll/card_gap/
 * detail_dwell）的最小间隔兜底区间 `{minMs,maxMs}` 做成后台可编辑 + 热加载。落库 + 内存镜像；
 * 实现 `PacingFloorProvider` 供 `buildPacingSnapshot` 每次现读（PUT 后下次握手即新值、无需重启）。
 *
 * 安全不变量（复刻 QuotaConfigStore）：
 * - 绝不 brick：某 op 缺行 / 字段非法 → 该 op 回落 `BUILTIN_FLOOR[op]`（非零内置默认）；`floorFor` 永不抛。
 * - 绝不零延迟：`floorFor` 在**读出口** clamp 到 `[OP_MIN_FLOOR[op], CAP_MS]`（权威夹点）——即便有人
 *   绕过面板 psql 直插 0/负数/超界，离开云端进程前已被夹成非零合法。配置只能抬高延迟、抬不穿非零下限。
 * - 半填竞态防护：`reload()` **构建新 Map → 原子替换 `this.cache` 引用**（非原地 clear+fill），
 *   `floorFor` 只读引用快照——握手绝不读到半填 Map 导致某 op 误缺回落。
 * - 写库成功才刷内存镜像（避免「镜像已变、库未变」不一致）。
 *
 * 红线：本 store 只读写 pacing_floor_config；绝不碰风控状态单写路径、绝不经协议以外的通道。
 * 建表幂等（CREATE TABLE IF NOT EXISTS），与 migrations/0031_pacing_floor_config.sql 同源（勿漂移）。
 */

import pg from 'pg';
import { DEFAULT_PG_CONFIG } from '../cache/pg-anchor-cache.js';
import {
  BUILTIN_FLOOR,
  PACING_OPS,
  clampFloorRange,
  type PacingFloorProvider,
} from '../risk/pacing.js';
import type { PacingOp, PacingFloorPayload } from '../comm/protocol.js';

const { Pool } = pg;

/** 单 op 行的兜底区间 + 审计（面板回显用）。 */
export interface PacingConfigRow {
  operation: PacingOp;
  minMs: number;
  maxMs: number;
  updatedAt: string | null;
  updatedBy: string | null;
}

/** 写补丁：两值须成对给（校验在 facade 完成，store 只落库）。 */
export interface PacingConfigPatch {
  minMs: number;
  maxMs: number;
}

export const PACING_FLOOR_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS pacing_floor_config (
  operation   TEXT PRIMARY KEY,
  min_ms      INTEGER NOT NULL,
  max_ms      INTEGER NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  TEXT
);
`;

export interface PacingConfigStoreOptions {
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  pool?: pg.Pool;
}

interface PacingDbRow {
  operation: string;
  min_ms: number | string;
  max_ms: number | string;
  updated_at: Date | string | null;
  updated_by: string | null;
}

/** 非负有限整数才算有效覆盖值，否则视作缺（回落内置默认）。 */
function validInt(raw: number | string | null | undefined): number | undefined {
  if (raw === null || raw === undefined) return undefined;
  const n = typeof raw === 'string' ? Number(raw) : raw;
  if (!Number.isInteger(n) || n < 0) return undefined;
  return n;
}

const isKnownOp = (op: string): op is PacingOp => (PACING_OPS as readonly string[]).includes(op);

export class PacingConfigStore implements PacingFloorProvider {
  private readonly pool: pg.Pool;
  private cache = new Map<PacingOp, PacingConfigRow>();

  constructor(options: PacingConfigStoreOptions = {}) {
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
    await this.pool.query(PACING_FLOOR_SCHEMA_SQL);
    await this.reload();
  }

  private async reload(): Promise<void> {
    const { rows } = await this.pool.query<PacingDbRow>(
      `SELECT operation, min_ms, max_ms, updated_at, updated_by FROM pacing_floor_config`,
    );
    // 构建新 Map → 原子替换引用（禁止原地 clear+fill，防握手读到半填快照）。
    const next = new Map<PacingOp, PacingConfigRow>();
    for (const r of rows) {
      if (!isKnownOp(r.operation)) continue; // 脏行/未知 op 忽略，回落内置默认
      const minMs = validInt(r.min_ms);
      const maxMs = validInt(r.max_ms);
      if (minMs === undefined || maxMs === undefined) continue; // 字段非法 → 视作缺（回落）
      next.set(r.operation, {
        operation: r.operation,
        minMs,
        maxMs,
        updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null,
        updatedBy: r.updated_by ?? null,
      });
    }
    this.cache = next;
  }

  /**
   * PacingFloorProvider 实现：某 op 生效兜底区间（现读、零 IO）。
   * 库内合法值优先；缺行/非法 → 回落 `BUILTIN_FLOOR[op]`。**并在此读出口 clamp**（权威夹点）到
   * `[OP_MIN_FLOOR[op], CAP_MS]`——离开云端进程前恒非零合法。永不抛。
   */
  floorFor(op: PacingOp): PacingFloorPayload {
    const builtin = BUILTIN_FLOOR[op];
    const row = this.cache.get(op);
    const rawMin = validInt(row?.minMs) ?? builtin.minMs;
    const rawMax = validInt(row?.maxMs) ?? builtin.maxMs;
    return clampFloorRange(op, rawMin, rawMax);
  }

  /** 取某 op 覆盖行（缺行 undefined，面板审计用）。 */
  getRow(op: PacingOp): PacingConfigRow | undefined {
    return this.cache.get(op);
  }

  /** 全部覆盖行（面板列表用）。 */
  getAll(): Map<PacingOp, PacingConfigRow> {
    return this.cache;
  }

  /**
   * 写库 + 刷内存镜像（热加载）。先写库成功、再刷镜像（写库失败镜像不变）。
   * 调用方（facade）应已校验区间合法（非负整数、min≤max、min 展宽、≤CAP）。
   */
  async set(op: PacingOp, patch: PacingConfigPatch, updatedBy: string): Promise<PacingConfigRow> {
    const { rows } = await this.pool.query<PacingDbRow>(
      `INSERT INTO pacing_floor_config (operation, min_ms, max_ms, updated_at, updated_by)
       VALUES ($1, $2, $3, now(), $4)
       ON CONFLICT (operation)
       DO UPDATE SET min_ms = EXCLUDED.min_ms, max_ms = EXCLUDED.max_ms,
                     updated_at = now(), updated_by = EXCLUDED.updated_by
       RETURNING operation, min_ms, max_ms, updated_at, updated_by`,
      [op, patch.minMs, patch.maxMs, updatedBy],
    );
    const row = rows[0];
    const result: PacingConfigRow = {
      operation: op,
      minMs: patch.minMs,
      maxMs: patch.maxMs,
      updatedAt: row?.updated_at ? new Date(row.updated_at).toISOString() : null,
      updatedBy: row?.updated_by ?? updatedBy,
    };
    this.cache.set(op, result);
    return result;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
