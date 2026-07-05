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
import {
  RISK_ACTIONS,
  type RiskAction,
  type RiskStatus,
  type RiskQuotaLevel,
} from '../risk/index.js';
import type { FeedAction } from '../cache/interaction-feed-store.js';
import type { AlertSeverity } from '../feishu/types.js';

const { Pool } = pg;

/** PostgreSQL「关系不存在」错误码——表未迁移时面板降级为空而非崩塌（dashboard 不因新表缺失整体 500）。 */
const PG_UNDEFINED_TABLE = '42P01';

export interface PanelAccount {
  accountId: string;
  label: string | null;
  /** 登录账号平台真实昵称（change account-real-nickname；未采到为 null，console 回落 label/accountId）。 */
  nickname: string | null;
  platform: string;
  groupLabel: string | null;
  machineLabel: string | null;
  /** 关联群聊引流码（change account-group-chat-injection；verbatim，未配为 null）。供后台编辑 + /comment group:on 注入。 */
  groupChatInfo: string | null;
  /** 运营暂停态（accounts.status，durable，区别于验证码 pausedEdges）。 */
  operatorStatus: 'active' | 'paused';
  pausedAt: number | null;
  /** 风控状态（risk_state；账号无风控行时为 null）。 */
  riskStatus: RiskStatus | null;
  riskQuotaLevel: RiskQuotaLevel | null;
  signalCount: number | null;
  /**
   * 人设绑定状态（派生字段，multi-account-node-support）：以 persona_config 行存在且非空为唯一判据，
   * **不读死列 accounts.persona_ref**。
   */
  personaBound: boolean;
  /** 需设置人设（派生）：未绑人设且非 default（default 硬豁免）。后台据此标「需设置人设」+ 跳转人设页。 */
  needsPersonaSetup: boolean;
}

export interface PanelPublishSourceReference {
  kind: 'curated_reference';
  curatedContentId: number | null;
  accountId: string;
  sourceId: string;
  title: string | null;
  body: string | null;
  author: string | null;
  topics: string[];
  sourceUrl: string | null;
  capturedAt: number;
}

export type PanelImageReferenceAuditStatus = 'none' | 'used' | 'unsupported' | 'unavailable' | 'skipped';

export interface PanelImageReferenceAudit {
  requestedCount: number;
  usableCount: number;
  status: PanelImageReferenceAuditStatus;
  providerClaimedUsed: boolean;
  generatedCount: number;
}

export interface PanelPublish {
  id: number;
  title: string | null;
  status: string;
  platformPostId: string | null;
  publishedAt: number;
  /** 发布账号（change publish-history-account-and-detail）。 */
  accountId: string;
  /** 账号展示名（accounts.label ?? account_id；nickname 待 account-real-nickname 落地后并入）。 */
  accountLabel: string;
  /** 已发布正文全文（后台「查看」用）。 */
  content: string | null;
  /** 小红书详情页分享 URL（带 xsec_token）；抓不到为 null，后台显示「无链接」、不给坏链。 */
  postUrl: string | null;
  /**
   * 内容版本号（change edit-note-draft-before-publish）：0=未编辑，>0=已在控制台改过（原飞书卡片已失效）。
   * 控制台据此渲染生命周期标签，并在审批时快照此值随授权带回（「审=发」凭证）。
   */
  contentVersion: number;
  /**
   * 全部配图 URL（保序，[0]=封面；空数组=无图）。配了 OSS 转存后为公读永久链接可直接 <img>；
   * 更早的历史行存的是生图厂商临时签名 URL（约 24h 过期），前端须容忍死链、不在云端补签。
   */
  images: string[];
  /** 封面图 URL（= images[0]，向后兼容列）；无图为 null。 */
  imageUrl: string | null;
  /** 边端实际附着上传成功的图片张数（诚实信号：区分「生成了几张」与「真上传了几张」）。 */
  imagesAttachedCount: number;
  /** 参照洗稿参考图是否真实被图片 provider 使用的审计；普通发布/历史行为 null。 */
  imageReferenceAudit: PanelImageReferenceAudit | null;
  /** 参照洗稿来稿快照；普通发布为 null。 */
  sourceReference: PanelPublishSourceReference | null;
}

export type TodayTotals = Record<RiskAction, number>;

/** 按账号今日计数切片（V1 task 9.6：归因已流通，上真按账号数字，去「归因待补」）。 */
export interface AccountTotals {
  accountId: string;
  totals: TodayTotals;
  /**
   * 当前 day 窗口生效配额上限（每动作，change decouple-quota-hit-from-risk）：取自该账号
   * `RiskController.effectiveQuotas().day`，随风控态 / 档位变化（restricted 互动上限为 0）。
   * 面板只读组合、绝不写风控态；拿不到 controller 时诚实缺省（不编造上限）。
   */
  quotas?: TodayTotals;
  /** 今日已撞当日上限（used >= cap）的动作，供前端把该格标红（节奏用量、非平台风险）。 */
  saturated?: RiskAction[];
}

/** 告警事件（V1 task 9.5；面板直接 SELECT alerts 表，design D2）。 */
export interface PanelAlert {
  id: number;
  severity: AlertSeverity;
  type: string;
  accountId: string | null;
  title: string;
  detail: string | null;
  createdAt: number;
  resolvedAt: number | null;
}

/**
 * 互动流一行（change interaction-feed-enrichment：读 interaction_feed LEFT JOIN interaction_target_meta）。
 * 四类动作；目标 = 笔记动作 noteId / 关注 authorId；title/url 诚实置空（缺失 undefined，绝不伪造）。
 */
export interface PanelInteraction {
  accountId: string;
  /** 目标 id：笔记动作=noteId，关注=authorId。 */
  targetId: string;
  action: FeedAction;
  /** 标题（笔记标题 / 作者昵称）；元数据未到则 undefined。 */
  title?: string;
  /** 可点链接（带 token 详情页 / 作者主页）；无真实链接则 undefined（前端不渲染死链）。 */
  url?: string;
  interactedAt: number;
}

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
  /** 今日各 action 计数按账号切片（V1 task 9.6）。 */
  todayTotalsByAccount(): Promise<AccountTotals[]>;
  todayPublishCount(): Promise<number>;
  likeRate(): Promise<LikeRate>;
  listAccounts(): Promise<PanelAccount[]>;
  getAccount(accountId: string): Promise<PanelAccount | null>;
  /** 已发布历史；可选按账号过滤（change publish-history-account-and-detail）。 */
  publishedHistory(limit: number, accountId?: string): Promise<PanelPublish[]>;
  /** 告警列表（V1 task 9.5）；默认仅未解决。 */
  listAlerts(options?: { limit?: number; includeResolved?: boolean }): Promise<PanelAlert[]>;
  /** 按笔记互动历史（V1 task 9.2）；可按账号过滤。 */
  listInteractions(options?: { limit?: number; accountId?: string }): Promise<PanelInteraction[]>;
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
  nickname: string | null;
  platform: string;
  group_label: string | null;
  machine_label: string | null;
  group_chat_info: string | null;
  operator_status: string;
  paused_at: Date | null;
  risk_status: string | null;
  risk_quota_level: string | null;
  signal_count: number | null;
  persona_bound: boolean | null;
}

function toAccount(r: AccountJoinRow): PanelAccount {
  const accountId = r.account_id;
  const personaBound = r.persona_bound === true;
  return {
    accountId,
    label: r.label,
    nickname: r.nickname,
    platform: r.platform,
    groupLabel: r.group_label,
    machineLabel: r.machine_label,
    groupChatInfo: r.group_chat_info,
    operatorStatus: r.operator_status === 'paused' ? 'paused' : 'active',
    pausedAt: r.paused_at ? r.paused_at.getTime() : null,
    riskStatus: (r.risk_status as RiskStatus | null) ?? null,
    riskQuotaLevel: (r.risk_quota_level as RiskQuotaLevel | null) ?? null,
    signalCount: r.signal_count,
    personaBound,
    // retire-default-account / persona-driven-content-pipeline：default 账号已删，不再特判——是否需补人设仅看 personaBound。
    needsPersonaSetup: !personaBound,
  };
}

function strOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function parseJsonObject(raw: unknown): Record<string, unknown> | null {
  if (raw == null) return null;
  let obj: unknown = raw;
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return obj && typeof obj === 'object' ? (obj as Record<string, unknown>) : null;
}

function parseImageReferenceAudit(raw: unknown): PanelImageReferenceAudit | null {
  const meta = parseJsonObject(raw);
  const audit = parseJsonObject(meta?.referenceImageAudit);
  if (!audit) return null;
  const status = typeof audit.status === 'string' ? audit.status : '';
  if (!['none', 'used', 'unsupported', 'unavailable', 'skipped'].includes(status)) return null;
  const requestedCount = Number(audit.requestedCount);
  const usableCount = Number(audit.usableCount);
  const generatedCount = Number(audit.generatedCount);
  return {
    requestedCount: Number.isFinite(requestedCount) ? requestedCount : 0,
    usableCount: Number.isFinite(usableCount) ? usableCount : 0,
    status: status as PanelImageReferenceAuditStatus,
    providerClaimedUsed: audit.providerClaimedUsed === true,
    generatedCount: Number.isFinite(generatedCount) ? generatedCount : 0,
  };
}

function parseSourceReference(raw: unknown): PanelPublishSourceReference | null {
  if (raw == null) return null;
  let obj: unknown = raw;
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!obj || typeof obj !== 'object') return null;
  const r = obj as Record<string, unknown>;
  if (r.kind !== 'curated_reference' || typeof r.sourceId !== 'string' || r.sourceId.length === 0) return null;
  const capturedAt = Number(r.capturedAt);
  const curatedContentId =
    typeof r.curatedContentId === 'number' || typeof r.curatedContentId === 'string'
      ? Number(r.curatedContentId)
      : NaN;
  return {
    kind: 'curated_reference',
    curatedContentId: Number.isFinite(curatedContentId) ? curatedContentId : null,
    accountId: typeof r.accountId === 'string' && r.accountId.length > 0 ? r.accountId : '',
    sourceId: r.sourceId,
    title: strOrNull(r.title),
    body: strOrNull(r.body),
    author: strOrNull(r.author),
    topics: Array.isArray(r.topics) ? r.topics.filter((t): t is string => typeof t === 'string') : [],
    sourceUrl: strOrNull(r.sourceUrl),
    capturedAt: Number.isFinite(capturedAt) ? capturedAt : 0,
  };
}

const ACCOUNT_SELECT = `
  SELECT a.account_id, a.label, a.nickname, a.platform, a.group_label, a.machine_label,
         a.group_chat_info,
         a.status AS operator_status, a.paused_at,
         r.status AS risk_status, r.quota_level AS risk_quota_level, r.signal_count,
         (pc.account_id IS NOT NULL AND btrim(pc.persona) <> '') AS persona_bound
  FROM accounts a
  LEFT JOIN risk_state r ON r.account_id = a.account_id
  LEFT JOIN persona_config pc ON pc.account_id = a.account_id`;

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

  /** 今日各 action 计数按账号切片（GROUP BY account_id, action；归因已流通，真按账号）。 */
  async todayTotalsByAccount(): Promise<AccountTotals[]> {
    const { rows } = await this.pool.query<{ account_id: string; action: string; total: number }>(
      `SELECT account_id, action, COALESCE(SUM(count), 0)::int AS total
       FROM risk_counters
       WHERE occurred_at >= date_trunc('day', now())
       GROUP BY account_id, action`,
    );
    const byAccount = new Map<string, TodayTotals>();
    for (const row of rows) {
      let totals = byAccount.get(row.account_id);
      if (!totals) {
        totals = Object.fromEntries(RISK_ACTIONS.map((a) => [a, 0])) as TodayTotals;
        byAccount.set(row.account_id, totals);
      }
      if ((RISK_ACTIONS as readonly string[]).includes(row.action)) {
        totals[row.action as RiskAction] = row.total;
      }
    }
    return [...byAccount.entries()].map(([accountId, totals]) => ({ accountId, totals }));
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

  /**
   * 已发布历史（change publish-history-account-and-detail）：带账号 + 正文 + 详情页链接；可选按账号过滤。
   * LEFT JOIN accounts 取展示名（label ?? account_id）；按账号过滤走 publish_log.account_id 索引（迁移 0005）。
   */
  async publishedHistory(limit: number, accountId?: string): Promise<PanelPublish[]> {
    const params: unknown[] = [];
    let where = '';
    if (accountId) {
      params.push(accountId);
      where = `WHERE pl.account_id = $${params.length}`;
    }
    params.push(limit);
    const { rows } = await this.pool.query<{
      id: number;
      title: string | null;
      status: string;
      platform_post_id: string | null;
      published_at: Date;
      account_id: string;
      account_label: string | null;
      account_nickname: string | null;
      content: string | null;
      post_url: string | null;
      content_version: number | string | null;
      images: string[] | null;
      image_url: string | null;
      images_attached_count: number | string | null;
      publish_metadata: unknown;
      source_reference: unknown;
    }>(
      `SELECT pl.id, pl.title, pl.status, pl.platform_post_id, pl.published_at,
              pl.account_id, a.label AS account_label, a.nickname AS account_nickname, pl.content, pl.post_url,
              pl.content_version, pl.images, pl.image_url, pl.images_attached_count, pl.publish_metadata, pl.source_reference
       FROM publish_log pl
       LEFT JOIN accounts a ON a.account_id = pl.account_id
       ${where} ORDER BY pl.published_at DESC LIMIT $${params.length}`,
      params,
    );
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      status: r.status,
      platformPostId: r.platform_post_id,
      publishedAt: r.published_at.getTime(),
      accountId: r.account_id,
      // 真名优先（change account-real-nickname）：nickname → label → account_id，绝不显示假名。
      accountLabel: r.account_nickname ?? r.account_label ?? r.account_id,
      content: r.content,
      postUrl: r.post_url,
      contentVersion: Number(r.content_version ?? 0),
      images: r.images ?? [],
      imageUrl: r.image_url,
      imagesAttachedCount: Number(r.images_attached_count ?? 0),
      imageReferenceAudit: parseImageReferenceAudit(r.publish_metadata),
      sourceReference: parseSourceReference(r.source_reference),
    }));
  }

  async listAlerts(options: { limit?: number; includeResolved?: boolean } = {}): Promise<PanelAlert[]> {
    const limit = options.limit ?? 100;
    const where = options.includeResolved ? '' : 'WHERE resolved_at IS NULL';
    try {
      const { rows } = await this.pool.query<{
        alert_id: string | number;
        severity: AlertSeverity;
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
        id: Number(r.alert_id),
        severity: r.severity,
        type: r.type,
        accountId: r.account_id,
        title: r.title,
        detail: r.detail,
        createdAt: r.created_at.getTime(),
        resolvedAt: r.resolved_at ? r.resolved_at.getTime() : null,
      }));
    } catch (err) {
      // 表未迁移时降级为空（dashboard 不因新表缺失整体 500）；其他错误上抛。
      if ((err as { code?: string }).code === PG_UNDEFINED_TABLE) return [];
      throw err;
    }
  }

  async listInteractions(options: { limit?: number; accountId?: string } = {}): Promise<PanelInteraction[]> {
    const limit = options.limit ?? 100;
    const params: unknown[] = [];
    let where = '';
    if (options.accountId) {
      params.push(options.accountId);
      where = `WHERE f.account_id = $${params.length}`;
    }
    params.push(limit);
    try {
      // change interaction-feed-enrichment：读展示账本 + 读时 LEFT JOIN 元数据（标题/链接）。
      // title/url 为 NULL → 映射成 undefined（诚实置空，前端不渲染死链）。
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
        ...(r.title ? { title: r.title } : {}),
        ...(r.url ? { url: r.url } : {}),
        interactedAt: r.occurred_at.getTime(),
      }));
    } catch (err) {
      if ((err as { code?: string }).code === PG_UNDEFINED_TABLE) return [];
      throw err;
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
