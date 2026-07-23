/**
 * 面板互动流存储（PostgreSQL，aidcp 库）。change interaction-feed-enrichment，迁移 0019。
 *
 * 写侧（本类）：把真实发生的互动落成「展示账本」，供管理后台「按笔记互动」表读取。
 *  - interaction_feed：事件账本（点赞/收藏/评论/关注）。笔记动作 target_id=noteId，关注 target_id=authorId。
 *    主键 (account_id, action, target_id)；recordEvent 用 ON CONFLICT DO NOTHING —— 同目标同动作去重为一行、
 *    保留**首次**时间（诚实审计，不被重复互动重排成「刚刚」）。
 *  - interaction_target_meta：标题/链接旁表（按 account_id+target_id）。upsertMeta 用 ON CONFLICT DO UPDATE + COALESCE：
 *    「看到笔记」上报补 title+url（笔记标题 + 带 xsec_token 详情页链接），「看到作者」上报补 title+url（昵称 + 主页链接），
 *    两源互不抹除、重开刷新最新 token。面板读时 LEFT JOIN（读侧在 PgPanelStore.listInteractions）。
 *
 * 红线：
 *  - 与 risk_interactions（去重台账）解耦——本表是纯展示账本、不参与去重/风控，写入不碰 RiskController 终态。
 *  - 诚实置空——title/url 缺失即落 NULL，绝不伪造（裸 id 拼链由边缘侧拦在源头）。
 *  - 记账被调用方 try/catch 包住、绝不拖垮浏览闭环。
 */

import pg from 'pg';
import { DEFAULT_PG_CONFIG } from './pg-anchor-cache.js';
import { ensureCapabilitySchema } from '../schema/schema-capability.js';

const { Pool } = pg;

/** 进入展示账本的四类动作（comment_like 刻意不进：无按笔记/作者语义）。 */
export type FeedAction = 'like' | 'collect' | 'comment' | 'follow';

export const INTERACTION_FEED_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS interaction_feed (
  account_id  TEXT        NOT NULL,
  action      TEXT        NOT NULL CHECK (action IN ('like','collect','comment','follow')),
  target_id   TEXT        NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, action, target_id)
);
CREATE INDEX IF NOT EXISTS idx_interaction_feed_account_time ON interaction_feed (account_id, occurred_at DESC);
-- 面板监控页「按笔记互动」全局视图不带 account 前缀、按 occurred_at 倒序取最新 N 条；
-- 上面 account 打头索引服务不了 → 补 occurred_at 打头索引消灭全表扫描（change console-cloud-panel-hardening #23）。
CREATE INDEX IF NOT EXISTS idx_interaction_feed_time ON interaction_feed (occurred_at DESC);

CREATE TABLE IF NOT EXISTS interaction_target_meta (
  account_id TEXT        NOT NULL,
  target_id  TEXT        NOT NULL,
  title      TEXT,
  url        TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, target_id)
);
`;

export interface InteractionFeedStoreOptions {
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  pool?: pg.Pool;
}

/** 把空白/空串归一为 null（诚实置空：缺失落 NULL，不落空串、不伪造）。 */
function nullIfBlank(s: string | undefined | null): string | null {
  const t = (s ?? '').trim();
  return t.length ? t : null;
}

export class InteractionFeedStore {
  private readonly pool: pg.Pool;
  private retentionTimer?: ReturnType<typeof setInterval>;

  constructor(options: InteractionFeedStoreOptions = {}) {
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

  /** schema 探测（不建表）。 */
  async init(): Promise<void> {
    // DDL 单一所有者（change cloud-schema-migration-executor 任务 5.x）：只探测、不建表。
    // 探不到即带 version id 明确报错并 fail-closed；MUST NOT 在这里把表建出来继续跑。
    await ensureCapabilitySchema(this.pool, {
      capability: 'interaction_feed',
      sinceVersion: '0019_interaction_feed',
      ddl: [INTERACTION_FEED_SCHEMA_SQL],
    });
    // 本地保留清理（change retention-local-purge）：interaction_feed 展示账本由本属主**自驱**日频 purge
    // ——不再由面板层 retention-sweeper 跨域伸手进来调（原先的跨界驱动方已撤）。内联而非抽跨层共享
    // helper，避免重新引入跨域依赖。默认保留 30 天，env AIDCP_RETENTION_FEED_DAYS 覆盖；周期 24h、
    // env AIDCP_RETENTION_INTERVAL_MS 覆盖。阈值/周期不变，删的数据（过期 feed 行 + 随之孤儿的 meta 行）不变。
    if (!this.retentionTimer) {
      this.retentionTimer = this.startRetentionTimer();
    }
  }

  /** 本地保留清理定时器（change retention-local-purge）。unref、runOnStart、每轮 try/catch、绝不逃逸。 */
  private startRetentionTimer(): ReturnType<typeof setInterval> {
    const d = Number(process.env.AIDCP_RETENTION_FEED_DAYS);
    const days = Number.isFinite(d) && d > 0 ? d : 30;
    const ei = Number(process.env.AIDCP_RETENTION_INTERVAL_MS);
    const intervalMs = Number.isFinite(ei) && ei > 0 ? ei : 24 * 60 * 60 * 1000;
    const runOnce = async (): Promise<void> => {
      try {
        const deleted = await this.purgeOlderThan(days);
        if (deleted > 0) console.log(`[retention] interaction_feed 保留清理完成：-${deleted}`);
      } catch (err) {
        console.warn(`[retention] interaction_feed 清理失败（跳过本轮，不拖累其它表）：${(err as Error).message}`);
      }
    };
    void runOnce();
    const timer = setInterval(() => {
      void runOnce();
    }, intervalMs);
    timer.unref?.();
    console.log(`[retention] interaction_feed 保留清理已启动（周期 ${Math.round(intervalMs / 3_600_000)}h；保留 ${days}d）`);
    return timer;
  }

  /**
   * 落一条互动事件（去重为一行、保留首次时间）。target_id：笔记动作=noteId，关注=authorId。
   * 空 target_id 直接忽略（无目标不记，诚实）。
   */
  async recordEvent(accountId: string, action: FeedAction, targetId: string, occurredAt: number): Promise<void> {
    const id = nullIfBlank(targetId);
    if (!id) return;
    await this.pool.query(
      `INSERT INTO interaction_feed (account_id, action, target_id, occurred_at)
       VALUES ($1, $2, $3, to_timestamp($4 / 1000.0))
       ON CONFLICT (account_id, action, target_id) DO NOTHING`,
      [accountId, action, id, occurredAt],
    );
  }

  /**
   * upsert 一个目标的标题/链接（COALESCE 合并，互不抹除；title/url 缺失保留旧值、不写空覆盖）。
   * 空 target_id 或 title/url 全空则不写（无可补充）。
   */
  async upsertMeta(accountId: string, targetId: string, meta: { title?: string | null; url?: string | null }): Promise<void> {
    const id = nullIfBlank(targetId);
    if (!id) return;
    const title = nullIfBlank(meta.title);
    const url = nullIfBlank(meta.url);
    if (!title && !url) return;
    await this.pool.query(
      `INSERT INTO interaction_target_meta (account_id, target_id, title, url, updated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (account_id, target_id) DO UPDATE
         SET title = COALESCE(EXCLUDED.title, interaction_target_meta.title),
             url   = COALESCE(EXCLUDED.url,   interaction_target_meta.url),
             updated_at = now()`,
      [accountId, id, title, url],
    );
  }

  /**
   * 数据保留：删早于 N 天的展示账本行 + 随之不再被任何 feed 行引用的孤儿 meta 旁表行
   * （change console-cloud-panel-hardening #23）。DELETE 走 idx_interaction_feed_time（occurred_at），不全表扫描。
   */
  async purgeOlderThan(days: number): Promise<number> {
    const res = await this.pool.query(
      `DELETE FROM interaction_feed WHERE occurred_at < now() - ($1::int * interval '1 day')`,
      [days],
    );
    await this.pool.query(
      `DELETE FROM interaction_target_meta m
        WHERE NOT EXISTS (
          SELECT 1 FROM interaction_feed f
           WHERE f.account_id = m.account_id AND f.target_id = m.target_id
        )`,
    );
    return res.rowCount ?? 0;
  }

  async close(): Promise<void> {
    if (this.retentionTimer) {
      clearInterval(this.retentionTimer);
      this.retentionTimer = undefined;
    }
    await this.pool.end();
  }
}
