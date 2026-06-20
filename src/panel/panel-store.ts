/**
 * 面板只读查询层（PostgreSQL，纯 SELECT）。
 *
 * design D2/D4：面板是只读组合器——直接 SELECT 现有表（risk_counters / risk_state /
 * accounts / publish_log），绝不经 RiskController 写、绝不碰 edge。全部走已有索引的
 * 点查/范围查询，不阻塞事件循环。
 *
 * 归因缺口（task 3 未落地）：interaction.occurred 暂无 accountId，故 todayTotals/likeRate
 * 为**全局**聚合；调用方须以 attributionPending 标注，绝不冒充按账号（interaction-attribution 红线）。
 */

import pg from 'pg';
import { DEFAULT_PG_CONFIG } from '../cache/pg-anchor-cache.js';
import { RISK_ACTIONS, type RiskAction, type RiskStatus, type RiskQuotaLevel } from '../risk/index.js';

const { Pool } = pg;

export interface PanelAccount {
  accountId: string;
  label: string | null;
  platform: string;
  groupLabel: string | null;
  machineLabel: string | null;
  /** 运营暂停态（accounts.status，durable，区别于验证码 pausedEdges）。 */
  operatorStatus: 'active' | 'paused';
  pausedAt: number | null;
  /** 风控状态（risk_state；账号无风控行时为 null）。 */
  riskStatus: RiskStatus | null;
  riskQuotaLevel: RiskQuotaLevel | null;
  signalCount: number | null;
}

export interface PanelPublish {
  id: number;
  title: string | null;
  status: string;
  platformPostId: string | null;
  publishedAt: number;
}

export type TodayTotals = Record<RiskAction, number>;

export interface LikeRate {
  likes: number;
  views: number;
  /** likes/views；views=0 时 null。 */
  rate: number | null;
  /** 15%-35% 健康区间（risk-control §1.1）；rate=null 时 null。 */
  healthy: boolean | null;
}

/** 面板只读查询接口（便于 mock，不依赖真 PG）。 */
export interface PanelStoreReader {
  todayTotals(): Promise<TodayTotals>;
  todayPublishCount(): Promise<number>;
  likeRate(): Promise<LikeRate>;
  listAccounts(): Promise<PanelAccount[]>;
  getAccount(accountId: string): Promise<PanelAccount | null>;
  publishedHistory(limit: number): Promise<PanelPublish[]>;
}

export interface PgPanelStoreOptions {
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  pool?: pg.Pool;
}

interface AccountJoinRow {
  account_id: string;
  label: string | null;
  platform: string;
  group_label: string | null;
  machine_label: string | null;
  operator_status: string;
  paused_at: Date | null;
  risk_status: string | null;
  risk_quota_level: string | null;
  signal_count: number | null;
}

function toAccount(r: AccountJoinRow): PanelAccount {
  return {
    accountId: r.account_id,
    label: r.label,
    platform: r.platform,
    groupLabel: r.group_label,
    machineLabel: r.machine_label,
    operatorStatus: r.operator_status === 'paused' ? 'paused' : 'active',
    pausedAt: r.paused_at ? r.paused_at.getTime() : null,
    riskStatus: (r.risk_status as RiskStatus | null) ?? null,
    riskQuotaLevel: (r.risk_quota_level as RiskQuotaLevel | null) ?? null,
    signalCount: r.signal_count,
  };
}

const ACCOUNT_SELECT = `
  SELECT a.account_id, a.label, a.platform, a.group_label, a.machine_label,
         a.status AS operator_status, a.paused_at,
         r.status AS risk_status, r.quota_level AS risk_quota_level, r.signal_count
  FROM accounts a
  LEFT JOIN risk_state r ON r.account_id = a.account_id`;

export class PgPanelStore implements PanelStoreReader {
  private readonly pool: pg.Pool;

  constructor(options: PgPanelStoreOptions = {}) {
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

  /** 今日各 action 计数（SUM(count)，全局——归因落地前不可按账号拆分）。 */
  async todayTotals(): Promise<TodayTotals> {
    const { rows } = await this.pool.query<{ action: string; total: number }>(
      `SELECT action, COALESCE(SUM(count), 0)::int AS total
       FROM risk_counters
       WHERE occurred_at >= date_trunc('day', now())
       GROUP BY action`,
    );
    const totals = Object.fromEntries(RISK_ACTIONS.map((a) => [a, 0])) as TodayTotals;
    for (const row of rows) {
      if ((RISK_ACTIONS as readonly string[]).includes(row.action)) {
        totals[row.action as RiskAction] = row.total;
      }
    }
    return totals;
  }

  async todayPublishCount(): Promise<number> {
    const { rows } = await this.pool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM publish_log
       WHERE status = 'published' AND published_at >= date_trunc('day', now())`,
    );
    return rows[0]?.n ?? 0;
  }

  async likeRate(): Promise<LikeRate> {
    const { rows } = await this.pool.query<{ likes: number; views: number }>(
      `SELECT COALESCE(SUM(count) FILTER (WHERE action = 'like'), 0)::int AS likes,
              COALESCE(SUM(count) FILTER (WHERE action = 'view'), 0)::int AS views
       FROM risk_counters
       WHERE occurred_at >= date_trunc('day', now())`,
    );
    const likes = rows[0]?.likes ?? 0;
    const views = rows[0]?.views ?? 0;
    const rate = views > 0 ? likes / views : null;
    const healthy = rate === null ? null : rate >= 0.15 && rate <= 0.35;
    return { likes, views, rate, healthy };
  }

  async listAccounts(): Promise<PanelAccount[]> {
    const { rows } = await this.pool.query<AccountJoinRow>(`${ACCOUNT_SELECT} ORDER BY a.created_at`);
    return rows.map(toAccount);
  }

  async getAccount(accountId: string): Promise<PanelAccount | null> {
    const { rows } = await this.pool.query<AccountJoinRow>(`${ACCOUNT_SELECT} WHERE a.account_id = $1`, [
      accountId,
    ]);
    const r = rows[0];
    return r ? toAccount(r) : null;
  }

  async publishedHistory(limit: number): Promise<PanelPublish[]> {
    const { rows } = await this.pool.query<{
      id: number;
      title: string | null;
      status: string;
      platform_post_id: string | null;
      published_at: Date;
    }>(
      `SELECT id, title, status, platform_post_id, published_at
       FROM publish_log ORDER BY published_at DESC LIMIT $1`,
      [limit],
    );
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      status: r.status,
      platformPostId: r.platform_post_id,
      publishedAt: r.published_at.getTime(),
    }));
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
