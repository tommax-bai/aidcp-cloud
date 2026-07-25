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
import type { MirrorQueryable, MirrorVersionBumper } from '../kernel/config-mirror-bump-types.js';
import { CONFIG_MIRRORS } from './mirror-registry.js';

/**
 * 抽象与「同一笔提交」的包装随 change block3-l3-config-mirror-bump-decouple 抬进 kernel
 * （automation 侧的四个限频配置 store 也要用它们，留在 api 属主域会造出跨域 import）。
 * 本模块等值再导出，api 侧全部既有 import 路径逐字不变。
 */
export { writeWithMirrorBump, CONFIG_MIRROR_BUMP_TOPIC } from '../kernel/config-mirror-bump-types.js';
export type {
  MirrorQueryable,
  MirrorVersionBumper,
  ConfigMirrorBumpRequest,
  ConfigMirrorBumpResult,
  ConfigMirrorBumpSink,
} from '../kernel/config-mirror-bump-types.js';

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
  /** 本实现写的是 api 属主的 `config_mirror_version`，故只能跑在 api 库的连接上。 */
  readonly bumpDomain = 'api' as const;

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
   *
   * 🔴 **属主闸（change block3-l3-config-mirror-bump-decouple 新增）**：只接受**属 api** 的
   *    mirrorKey。这条断言堵的正是属主门禁的天然盲点——四个 automation 配置 store 曾在自己的写
   *    事务里调本方法，走的是**方法调用而非自己的 SQL 字面量**，`AC-OWN-*` 的源码扫描看不见它，
   *    于是「automation 的事务里写 api 的表」可以一路绿灯合进主干，直到物理拆库当天原子性静默断裂。
   *    非 api 属主的镜像 MUST 走本域 outbox + 中继（`src/config/mirror-bump-outbox.ts`），
   *    由 {@link applyRelayedBumpInTx} 在 **api 自己的事务**里落地。
   */
  async bumpInTx(client: MirrorQueryable, mirrorKey: ConfigMirrorKey): Promise<void> {
    const owner = CONFIG_MIRRORS[mirrorKey]?.owner;
    if (owner !== 'api') {
      throw new Error(
        `[config-mirror] 拒绝在写事务内直接推进版本：mirror=${mirrorKey} 属主=${owner ?? 'unknown'}，` +
          `而 config_mirror_version 属 api —— 同事务推进等于跨库两阶段提交。` +
          `非 api 属主的配置写入 MUST 用 OutboxMirrorVersionBumper（本域 outbox + 中继）。`,
      );
    }
    await this.bumpVersionInTx(client, mirrorKey);
  }

  /**
   * 由**中继**投递过来的失效信号在 api 自己的事务里落地（`src/config/mirror-bump-sink.ts` 唯一调用点）。
   *
   * 与 {@link bumpInTx} 的区别只在「这条事务属于谁」：这里的 `client` 一定取自 api 池，
   * 生产方的业务写早已在**它自己的库**里提交完毕，两者不再需要同一笔事务。
   * 对称地只接受**非 api 属主**的 key：api 属主的配置本就同库同事务推进，绕一圈 outbox 说明接线错了。
   */
  async applyRelayedBumpInTx(client: MirrorQueryable, mirrorKey: ConfigMirrorKey): Promise<void> {
    const owner = CONFIG_MIRRORS[mirrorKey]?.owner;
    if (owner === undefined) {
      throw new Error(`[config-mirror] 中继投递了未登记的 mirrorKey=${mirrorKey}`);
    }
    if (owner === 'api') {
      throw new Error(
        `[config-mirror] 拒绝把 api 属主的 mirror=${mirrorKey} 当作跨域中继信号处理：` +
          `它与版本表同库，MUST 走同事务的 bumpInTx。`,
      );
    }
    await this.bumpVersionInTx(client, mirrorKey);
  }

  /** 版本推进的唯一 SQL 出口（两条入口共用，防语句漂移）。 */
  private async bumpVersionInTx(client: MirrorQueryable, mirrorKey: ConfigMirrorKey): Promise<void> {
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
