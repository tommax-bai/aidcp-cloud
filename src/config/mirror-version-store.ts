/**
 * 跨进程配置镜像的版本表读写（change config-mirror-cross-process-invalidation，task 2.2）。
 *
 * 写方在**持久化配置的同一个事务内**调用 `bumpInTx`；消费方刷新器每轮一次 `readAll()` 比对。
 * 版本由库侧自增（`version = config_mirror_version.version + 1`），**绝不用任何主机时钟当版本**。
 *
 * ## 承重通道与加速器的分工（MUST 一起读）
 *
 * 唯一承重的失效通道是**轮询**：陈旧上限 ≤ 轮询周期 + 一次查询耗时，与通知是否送达无关。
 * `pg_notify` 只是**可选加速器**：它是 fire-and-forget，连接断开期间发出的通知永久丢失、无补偿、
 * 无痕迹；且 `pg` 的 Pool 不能用于 `LISTEN`（需独占长连 Client）。把它当唯一通道，一次网络抖动
 * 就原样复现「写方改了、读方永远看不到」。因此实现 MUST NOT 因为接了通知就放宽轮询周期。
 *
 * 建表幂等（CREATE TABLE IF NOT EXISTS），与 migrations/0062_config_mirror_version.sql 同源（勿漂移）。
 */

import type pg from 'pg';
import type { ConfigMirrorKey } from '../config-mirror-freshness.js';

export const CONFIG_MIRROR_VERSION_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS config_mirror_version (
  mirror_key TEXT PRIMARY KEY,
  version    BIGINT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS config_mirror_stale_refusal (
  mirror_key       TEXT NOT NULL,
  hour_bucket      TIMESTAMPTZ NOT NULL,
  execution_target TEXT NOT NULL,
  refusal_count    BIGINT NOT NULL DEFAULT 0,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (mirror_key, hour_bucket, execution_target)
);
CREATE INDEX IF NOT EXISTS idx_config_mirror_stale_refusal_hour
  ON config_mirror_stale_refusal (hour_bucket DESC);
`;

/** `pg.Pool` 与 `pg.PoolClient` 的公共子集——写路径按需在两者间切换。 */
export interface MirrorQueryable {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(
    sql: string,
    params?: unknown[],
  ): Promise<pg.QueryResult<R>>;
}

/**
 * 版本推进器（写方依赖的最小接口）。注入式：**缺省即不推进**，行为逐位退回今日现状
 * （启动 + 本进程写入刷新），供单测与秒级回滚。
 */
export interface MirrorVersionBumper {
  /** 在**已开启的事务**内推进版本。MUST NOT 自开事务——它必须与配置写入同生共死。 */
  bumpInTx(client: MirrorQueryable, mirrorKey: ConfigMirrorKey): Promise<void>;
  /** 可选加速器：事务提交后发通知。非承重通道，失败只记日志。 */
  notifyAfterCommit?(mirrorKey: ConfigMirrorKey): void;
}

export interface MirrorVersionStoreOptions {
  /** MUST 复用组合根已有的 Pool，MUST NOT 另开连接池。 */
  pool: pg.Pool;
  /** 可选加速器开关，默认开；关掉不影响陈旧上限（轮询是唯一承重通道）。 */
  notifyEnabled?: boolean;
  logger?: Pick<Console, 'log' | 'warn'>;
}

interface VersionDbRow {
  mirror_key: string;
  version: string | number;
}

/** `pg_notify` 的频道名（可选加速器）。 */
export const CONFIG_MIRROR_NOTIFY_CHANNEL = 'aidcp_config_mirror';

export class MirrorVersionStore implements MirrorVersionBumper {
  private readonly pool: pg.Pool;
  private readonly notifyEnabled: boolean;
  private readonly logger: Pick<Console, 'log' | 'warn'>;

  constructor(options: MirrorVersionStoreOptions) {
    this.pool = options.pool;
    this.notifyEnabled = options.notifyEnabled ?? true;
    this.logger = options.logger ?? console;
  }

  /** 建表（幂等）。 */
  async init(): Promise<void> {
    await this.pool.query(CONFIG_MIRROR_VERSION_SCHEMA_SQL);
  }

  /**
   * 在已开启的事务内推进版本。版本自增在库侧完成（`version + 1`），首次写入落 1。
   * 写库失败 → 整个事务回滚 → 版本不进、镜像不刷（`account-persona-config` 既有不变量原样保住）。
   */
  async bumpInTx(client: MirrorQueryable, mirrorKey: ConfigMirrorKey): Promise<void> {
    await client.query(
      `INSERT INTO config_mirror_version (mirror_key, version, updated_at)
       VALUES ($1, 1, now())
       ON CONFLICT (mirror_key)
       DO UPDATE SET version = config_mirror_version.version + 1, updated_at = now()`,
      [mirrorKey],
    );
  }

  /**
   * 可选加速器：事务提交后发一条通知，消费方收到即提前触发一次比对。
   * fire-and-forget + 吞错：它**不承重**，失败绝不能连累配置写入本身。
   */
  notifyAfterCommit(mirrorKey: ConfigMirrorKey): void {
    if (!this.notifyEnabled) return;
    void this.pool
      .query(`SELECT pg_notify($1, $2)`, [CONFIG_MIRROR_NOTIFY_CHANNEL, mirrorKey])
      .catch((err: unknown) => {
        this.logger.warn(
          `[config-mirror] pg_notify 失败（非承重通道，轮询照常兜底）mirror=${mirrorKey}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
  }

  /** 整表读版本（十几行、走主键顺序扫）。 */
  async readAll(): Promise<Map<ConfigMirrorKey, number>> {
    const { rows } = await this.pool.query<VersionDbRow>(
      `SELECT mirror_key, version FROM config_mirror_version`,
    );
    const out = new Map<ConfigMirrorKey, number>();
    for (const r of rows) {
      const v = typeof r.version === 'string' ? Number(r.version) : r.version;
      if (!Number.isFinite(v)) continue;
      out.set(r.mirror_key as ConfigMirrorKey, v);
    }
    return out;
  }

  /**
   * 记一次「因镜像陈旧而拒绝真实平台动作」（按 mirrorKey、按小时、按 target 聚合）。
   * best-effort：记账失败只 warn，绝不连累停手判定本身。
   */
  async recordStaleRefusal(
    mirrorKey: ConfigMirrorKey,
    executionTarget: string,
    at: number,
    count = 1,
  ): Promise<void> {
    const hourBucket = new Date(Math.floor(at / 3_600_000) * 3_600_000).toISOString();
    await this.pool.query(
      `INSERT INTO config_mirror_stale_refusal (mirror_key, hour_bucket, execution_target, refusal_count, updated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (mirror_key, hour_bucket, execution_target)
       DO UPDATE SET refusal_count = config_mirror_stale_refusal.refusal_count + EXCLUDED.refusal_count,
                     updated_at = now()`,
      [mirrorKey, hourBucket, executionTarget, count],
    );
  }
}

/**
 * 配置写入的统一包装：**持久化与版本推进在同一个事务内**。
 *
 * - `bumper` 缺省（单测 / 秒级回滚）→ 直接在 pool 上跑 `run`，行为与本 change 之前**逐位一致**
 *   （不开事务、不推版本）。这条分支的存在是为了让既有的假 pool 单测无需实现 `connect()`。
 * - `bumper` 存在 → `BEGIN` → `run(client)` → `bumpInTx(client)` → `COMMIT`；任一步抛错
 *   → `ROLLBACK` 并原样抛出：写库失败 MUST NOT 推进版本，也 MUST NOT 刷新本进程镜像。
 */
export async function writeWithMirrorBump<T>(
  pool: pg.Pool,
  bumper: MirrorVersionBumper | undefined,
  mirrorKey: ConfigMirrorKey,
  run: (q: MirrorQueryable) => Promise<T>,
): Promise<T> {
  if (!bumper) return run(pool);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await run(client);
    await bumper.bumpInTx(client, mirrorKey);
    await client.query('COMMIT');
    bumper.notifyAfterCommit?.(mirrorKey);
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* 回滚失败时保留原始错误，绝不用回滚错误盖掉真因 */
    }
    throw err;
  } finally {
    client.release();
  }
}
