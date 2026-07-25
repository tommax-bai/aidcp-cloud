/**
 * api 侧的失效信号落地：**inbox 去重 + 推版本，一笔事务**
 * （change block3-l3-config-mirror-bump-decouple）。
 *
 * 生产方（automation）已经在**它自己的库**里把「配置改了」和「要发这条信号」原子提交完毕；
 * 中继把信号搬过来后，api 在**它自己的库**里做两件事，同样原子：
 *   1. 往 `config_mirror_bump_inbox` 插一条 `dedup_key`（`ON CONFLICT DO NOTHING`）；
 *   2. 插进去了才推 `config_mirror_version`。
 *
 * 两件事同一笔事务 ⇒ 去重记录与版本推进不可能各自成立一半。中继是 at-least-once 的
 * （投递成功但游标没落库、进程崩溃、网络重试都会重放），这条 inbox 就是把 at-least-once 收成
 * **恰好一次生效**的地方。
 *
 * 诚实失败：任何一步失败都原样抛出 → 中继不推游标 → 下一轮重放。**MUST NOT 吞错返回成功**。
 *
 * 表由 `migrations/0076_config_mirror_bump_inbox.sql` 建；本文件**不自建表**
 * （迁移执行器纪律，见 test/schema/runtime-ddl-allowlist.json 的「只减不增」）。
 */

import type pg from 'pg';
import type {
  ConfigMirrorBumpRequest,
  ConfigMirrorBumpResult,
  ConfigMirrorBumpSink,
  ConfigMirrorKey,
} from '../kernel/config-mirror-bump-types.js';
import { CONFIG_MIRRORS } from './mirror-registry.js';
import type { MirrorVersionStore } from './mirror-version-store.js';

/** 去重记录的保留窗口（天）。超期行由 {@link PgConfigMirrorBumpSink.pruneInbox} 清理。 */
export const CONFIG_MIRROR_BUMP_INBOX_RETENTION_DAYS = 30;

export interface PgConfigMirrorBumpSinkOptions {
  /** MUST 是 **api 属主池**（`config_mirror_version` 与 inbox 都在 api 的库里）。 */
  pool: pg.Pool;
  versionStore: MirrorVersionStore;
  logger?: Pick<Console, 'log' | 'warn'>;
}

export class PgConfigMirrorBumpSink implements ConfigMirrorBumpSink {
  private readonly pool: pg.Pool;
  private readonly versionStore: MirrorVersionStore;
  private readonly logger: Pick<Console, 'log' | 'warn'>;

  constructor(options: PgConfigMirrorBumpSinkOptions) {
    this.pool = options.pool;
    this.versionStore = options.versionStore;
    this.logger = options.logger ?? console;
  }

  async applyBump(request: ConfigMirrorBumpRequest): Promise<ConfigMirrorBumpResult> {
    const mirrorKey = request.mirrorKey as ConfigMirrorKey;
    if (CONFIG_MIRRORS[mirrorKey] === undefined) {
      // 未登记的 key：诚实抛错。吞掉它等于让一条真实的配置变更永久对别的进程不可见。
      throw new Error(`[config-mirror] 收到未登记的 mirrorKey=${request.mirrorKey}`);
    }
    if (typeof request.dedupKey !== 'string' || request.dedupKey.length === 0) {
      throw new Error('[config-mirror] applyBump 缺 dedupKey：没有幂等键就无法保证「恰好一次」');
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const inserted = await client.query(
        `INSERT INTO config_mirror_bump_inbox (dedup_key, mirror_key, applied_at)
         VALUES ($1, $2, now())
         ON CONFLICT (dedup_key) DO NOTHING`,
        [request.dedupKey, mirrorKey],
      );
      const applied = (inserted.rowCount ?? 0) > 0;
      if (applied) {
        await this.versionStore.applyRelayedBumpInTx(client, mirrorKey);
      }
      await client.query('COMMIT');
      return { applied };
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

  /**
   * 清理超期去重记录。best-effort：失败只 warn——它是空间维护，绝不能连累投递本身。
   * 保留窗口远大于任何可能的重放跨度（中继游标只在同一进程/同一库内前进）。
   */
  async pruneInbox(retentionDays = CONFIG_MIRROR_BUMP_INBOX_RETENTION_DAYS): Promise<void> {
    try {
      await this.pool.query(
        `DELETE FROM config_mirror_bump_inbox WHERE applied_at < now() - ($1 || ' days')::interval`,
        [String(retentionDays)],
      );
    } catch (err: unknown) {
      this.logger.warn(
        `[config-mirror] inbox 清理失败（不影响投递）: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

/**
 * 不可用态的 sink：**只在跑不到 api 库、也没配内部 HTTP 端点的进程里注入**。
 *
 * 它一律抛错而不是假装成功——中继因此保留 outbox 行与游标，信号原地堆着等通道恢复，
 * 而不是被一个「静默成功」的空实现吃掉。
 */
export class UnavailableConfigMirrorBumpSink implements ConfigMirrorBumpSink {
  constructor(private readonly reason: string) {}

  applyBump(request: ConfigMirrorBumpRequest): Promise<ConfigMirrorBumpResult> {
    return Promise.reject(
      new Error(
        `config_mirror_bump_sink_unavailable: ${this.reason}（mirror=${request.mirrorKey} ` +
          `dedup=${request.dedupKey} 仍留在 outbox 里等补投）`,
      ),
    );
  }
}
