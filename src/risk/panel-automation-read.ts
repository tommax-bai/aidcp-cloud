/**
 * 面板对 automation 域只读投影端口的**本地实现**（Block③ 物理拆库 L3）。
 *
 * 属主：automation。本类跑在 **automation 自己的连接池** 上（组合根注入 automationPool），
 * 是 kernel 端口 `PanelAutomationReader` 在单进程期的满足者：面板（api）只依赖该 kernel 接口、
 * 经本实现取 automation 域投影，**面板绝不直连 automation 的库、也不知道其表结构**。
 * 拆进程后（Block②）同一端口换 HTTP 客户端，本类留在 automation 服务侧。
 *
 * 读到的表全属 automation：risk_counters / risk_state（风控）、alerts（告警）、
 * interaction_feed / interaction_target_meta（互动收件箱）。这些 SQL 从 panel-store 逐字迁来，
 * 只把「面板的连接」换成「automation 的连接」，聚合 / 过滤 / 排序 / 语义逐字保持。
 *
 * 缺表（42P01）不在此吞：如实抛出，由面板层按其历史降级策略处理（listAlerts / listInteractions
 * 面板侧 catch 42P01 → 空数组）。风控计数 / 状态为核心表、恒在，不降级。
 */

import pg from 'pg';
import { SHANGHAI_DAY_START_SQL } from '../time/shanghai-day.js';
import type { FeedAction } from '../kernel/feed-action.js';
import type {
  PanelAccountActionTotal,
  PanelActionTotal,
  PanelAlertProjection,
  PanelAutomationReader,
  PanelInteractionProjection,
  PanelLikeViewTotal,
  PanelRiskStateProjection,
} from '../kernel/panel-automation-types.js';

export interface PgPanelAutomationReadOptions {
  /** automation 属主池（组合根注入）。 */
  pool: pg.Pool;
}

export class PgPanelAutomationRead implements PanelAutomationReader {
  private readonly pool: pg.Pool;

  constructor(options: PgPanelAutomationReadOptions) {
    this.pool = options.pool;
  }

  /** 今日各动作全局计数（原 panel-store.todayTotals 的 SQL，逐字迁移）。 */
  async todayActionTotals(): Promise<PanelActionTotal[]> {
    const { rows } = await this.pool.query<{ action: string; total: number }>(
      `SELECT action, COALESCE(SUM(count), 0)::int AS total
       FROM risk_counters
       WHERE occurred_at >= ${SHANGHAI_DAY_START_SQL}
       GROUP BY action`,
    );
    return rows.map((r) => ({ action: r.action, total: r.total }));
  }

  /** 今日各账号 × 动作计数（原 panel-store.todayTotalsByAccount 的 SQL）。 */
  async todayActionTotalsByAccount(): Promise<PanelAccountActionTotal[]> {
    const { rows } = await this.pool.query<{ account_id: string; action: string; total: number }>(
      `SELECT account_id, action, COALESCE(SUM(count), 0)::int AS total
       FROM risk_counters
       WHERE occurred_at >= ${SHANGHAI_DAY_START_SQL}
       GROUP BY account_id, action`,
    );
    return rows.map((r) => ({ accountId: r.account_id, action: r.action, total: r.total }));
  }

  /** 今日点赞 / 浏览计数（原 panel-store.likeRate 的 SQL）。 */
  async todayLikeViewTotal(): Promise<PanelLikeViewTotal> {
    const { rows } = await this.pool.query<{ likes: number; views: number }>(
      `SELECT COALESCE(SUM(count) FILTER (WHERE action = 'like'), 0)::int AS likes,
              COALESCE(SUM(count) FILTER (WHERE action = 'view'), 0)::int AS views
       FROM risk_counters
       WHERE occurred_at >= ${SHANGHAI_DAY_START_SQL}`,
    );
    return { likes: rows[0]?.likes ?? 0, views: rows[0]?.views ?? 0 };
  }

  /**
   * 批量风控态投影（原 panel-store ACCOUNT_SELECT 的 `LEFT JOIN risk_state` 侧）：
   * accountIds 省略=全部，给定=仅这些。只返回**有风控行**的账号，面板据缺失映射 null（等价 LEFT JOIN）。
   */
  async riskStateProjection(accountIds?: string[]): Promise<PanelRiskStateProjection[]> {
    const scoped = accountIds !== undefined;
    const { rows } = await this.pool.query<{
      account_id: string;
      status: string | null;
      quota_level: string | null;
      signal_count: number | null;
    }>(
      `SELECT account_id, status, quota_level, signal_count
       FROM risk_state${scoped ? ' WHERE account_id = ANY($1::text[])' : ''}`,
      scoped ? [accountIds] : [],
    );
    return rows.map((r) => ({
      accountId: r.account_id,
      status: r.status,
      quotaLevel: r.quota_level,
      signalCount: r.signal_count,
    }));
  }

  /** 告警列表（原 panel-store.listAlerts 的 SQL；去 edge_id 投影，时间戳 epoch ms）。 */
  async listAlerts(options: { limit?: number; includeResolved?: boolean } = {}): Promise<PanelAlertProjection[]> {
    const limit = options.limit ?? 100;
    const where = options.includeResolved ? '' : 'WHERE resolved_at IS NULL';
    const { rows } = await this.pool.query<{
      alert_id: string | number;
      severity: string;
      type: string;
      account_id: string | null;
      title: string;
      detail: string | null;
      created_at: Date;
      resolved_at: Date | null;
    }>(
      `SELECT alert_id, severity, type, account_id, title, detail, created_at, resolved_at
       FROM alerts ${where} ORDER BY created_at DESC LIMIT $1`,
      [limit],
    );
    return rows.map((r) => ({
      alertId: Number(r.alert_id),
      severity: r.severity,
      type: r.type,
      accountId: r.account_id,
      title: r.title,
      detail: r.detail,
      createdAt: r.created_at.getTime(),
      resolvedAt: r.resolved_at ? r.resolved_at.getTime() : null,
    }));
  }

  /** 互动流（原 panel-store.listInteractions 的 SQL；feed LEFT JOIN target_meta，时间戳 epoch ms）。 */
  async listInteractions(
    options: { limit?: number; accountId?: string } = {},
  ): Promise<PanelInteractionProjection[]> {
    const limit = options.limit ?? 100;
    const params: unknown[] = [];
    let where = '';
    if (options.accountId) {
      params.push(options.accountId);
      where = `WHERE f.account_id = $${params.length}`;
    }
    params.push(limit);
    const { rows } = await this.pool.query<{
      account_id: string;
      target_id: string;
      action: FeedAction;
      title: string | null;
      url: string | null;
      occurred_at: Date;
    }>(
      `SELECT f.account_id, f.target_id, f.action, m.title, m.url, f.occurred_at
       FROM interaction_feed f
       LEFT JOIN interaction_target_meta m
         ON m.account_id = f.account_id AND m.target_id = f.target_id
       ${where} ORDER BY f.occurred_at DESC LIMIT $${params.length}`,
      params,
    );
    return rows.map((r) => ({
      accountId: r.account_id,
      targetId: r.target_id,
      action: r.action,
      title: r.title,
      url: r.url,
      interactedAt: r.occurred_at.getTime(),
    }));
  }
}
