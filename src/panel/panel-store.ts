/**
 * 面板只读查询层（PostgreSQL，纯 SELECT）。
 *
 * design D2/D4：面板是只读组合器——就地 SELECT **api 属主**表（accounts / persona_config /
 * publish_log），绝不经 RiskController 写、绝不碰 edge。全部走已有索引的点查/范围查询，不阻塞事件循环。
 *
 * Block③ L3（物理拆库）：**automation 属主**的 risk_counters / risk_state / alerts /
 * interaction_feed / interaction_target_meta 不再由本层直读，改经 kernel 端口 `PanelAutomationReader`
 * 向 automation 域取投影（面板绝不直连别域的库）。原 `accounts LEFT JOIN risk_state` 已拆为
 * 「本地读 accounts + 端口批量取风控态 + 本地合入」，逐字等价 LEFT JOIN 语义。
 *
 * 归因缺口（task 3 未落地）：interaction.occurred 暂无 accountId，故 todayTotals/likeRate
 * 为**全局**聚合；调用方须以 attributionPending 标注，绝不冒充按账号（interaction-attribution 红线）。
 */

import pg from 'pg';
import { DEFAULT_PG_CONFIG } from '../kernel/pg-config.js';
import { SHANGHAI_DAY_START_SQL } from '../time/shanghai-day.js';
import {
  RISK_ACTIONS,
  type RiskAction,
  type RiskStatus,
  type RiskQuotaLevel,
} from '../risk/index.js';
import type { FeedAction } from '../kernel/feed-action.js';
import type { AlertSeverity } from '../feishu/types.js';
import type { VisualReferenceAudit } from '../kernel/visual-reference-types.js';
import type { PanelAutomationReader, PanelRiskStateProjection } from '../kernel/panel-automation-types.js';
import {
  resolveAccountDisplayName,
  type AccountDisplayNameSource,
} from '../account-display-name.js';

const { Pool } = pg;

/** PostgreSQL「关系不存在」错误码——表未迁移时面板降级为空而非崩塌（dashboard 不因新表缺失整体 500）。 */
const PG_UNDEFINED_TABLE = '42P01';

export interface PanelAccount {
  accountId: string;
  label: string | null;
  /** 登录账号平台真实昵称（change account-real-nickname；未采到为 null，console 回落 label/accountId）。 */
  nickname: string | null;
  /** 运营人工别名；与平台昵称分列，人工清除时为 null。 */
  operatorAlias: string | null;
  /** Cloud 唯一解析器产出的首选展示名。 */
  displayName: string;
  displayNameSource: AccountDisplayNameSource;
  platform: string;
  groupLabel: string | null;
  machineLabel: string | null;
  /** 联系方式（change account-group-chat-injection → generalize-contact-info；verbatim，未配为 null）。供后台编辑 + /comment --contact 注入。 */
  contactInfo: string | null;
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
  /**
   * 当前 / 最近由哪个目标驱动（change risk-target-follows-active-session）：直接取 accounts.execution_target，
   * `dev` / `ol` / null=从未驱动过。归属跟随当次连接，故这是「最近一次握手的目标」的只读展示，
   * **不代表写权限**（写已改回账号级、不按归属禁用）。
   */
  currentDriverTarget: 'dev' | 'ol' | null;
  /** 环境资产独立生命周期的只读摘要；删除环境不改变账号本身。 */
  environmentSummary?: { activeCount: number; deletingCount: number; onlineCount: number };
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

/** 封面形态审计（change textcard-cover-form）：null-safe 解析，历史行为 null。 */
export interface PanelCoverFormAudit {
  coverForm: string;
  sensedForm: string;
  sensedSource: string;
  gateReason: string;
  renderStatus: string;
  renderMeta: { themeKey: string; truncated: boolean; sanitized: boolean; reductions: string[] } | null;
}

export interface PanelPublish {
  id: number;
  title: string | null;
  status: string;
  platform: string;
  platformPostId: string | null;
  publishedAt: number;
  publishMode: 'immediate' | 'draft' | 'scheduled';
  publishTime: number | null;
  scheduledAt: number | null;
  scheduledPlatformId: string | null;
  /** 发布账号（change publish-history-account-and-detail）。 */
  accountId: string;
  /** 统一解析后的账号展示名。 */
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
  /** 封面形态审计（change textcard-cover-form）；普通发布/历史行为 null。 */
  coverFormAudit: PanelCoverFormAudit | null;
  /** source→slot→output 与产后视觉核验；普通发布/历史行为 null。 */
  visualReferenceAudit?: VisualReferenceAudit | null;
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

/** 告警事件（V1 task 9.5；Block③ L3 起经 automation 只读端口取 alerts 投影，面板不直读该表，design D2）。 */
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
  /** 已发布历史；可选按账号/状态过滤（change publish-history-account-and-detail；status 见 parallel-rewrite-drafts）。 */
  publishedHistory(limit: number, accountId?: string, status?: string): Promise<PanelPublish[]>;
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
  /** 面板自己的（api 属主）连接池：accounts / persona_config / publish_log 就地读。 */
  pool?: pg.Pool;
  /**
   * automation 域只读投影端口（Block③ L3，必填）：风控计数 / 风控态 / 告警 / 互动流经此取，
   * 面板绝不直连 automation 的库。组合根按运行模式注入（monolith/core=automation 池本地实现；
   * api 模式=HTTP 客户端，待 Block② 补，暂 fail-closed）。
   */
  automation: PanelAutomationReader;
}

interface AccountJoinRow {
  account_id: string;
  label: string | null;
  nickname: string | null;
  operator_alias: string | null;
  platform: string;
  group_label: string | null;
  machine_label: string | null;
  contact_info: string | null;
  operator_status: string;
  paused_at: Date | null;
  persona_bound: boolean | null;
  execution_target: string | null;
}

/**
 * 组装面板账号视图。风控态（riskStatus / riskQuotaLevel / signalCount）不再随本行 JOIN 来，
 * 而由 automation 只读端口的批量投影 `risk` 合入（Block③ L3：面板不直读 risk_state）。
 * `risk` 缺失（该账号无风控行）→ 三项全 null，逐字等价原 `LEFT JOIN risk_state`。
 */
function toAccount(r: AccountJoinRow, risk: PanelRiskStateProjection | undefined): PanelAccount {
  const accountId = r.account_id;
  const personaBound = r.persona_bound === true;
  const display = resolveAccountDisplayName({
    accountId, operatorAlias: r.operator_alias, nickname: r.nickname, label: r.label,
  });
  return {
    accountId,
    label: r.label,
    nickname: r.nickname,
    operatorAlias: r.operator_alias,
    displayName: display.name,
    displayNameSource: display.source,
    platform: r.platform,
    groupLabel: r.group_label,
    machineLabel: r.machine_label,
    contactInfo: r.contact_info,
    operatorStatus: r.operator_status === 'paused' ? 'paused' : 'active',
    pausedAt: r.paused_at ? r.paused_at.getTime() : null,
    riskStatus: (risk?.status as RiskStatus | null) ?? null,
    riskQuotaLevel: (risk?.quotaLevel as RiskQuotaLevel | null) ?? null,
    signalCount: risk?.signalCount ?? null,
    currentDriverTarget: r.execution_target === 'dev' || r.execution_target === 'ol' ? r.execution_target : null,
    personaBound,
    // retire-default-account / persona-driven-content-pipeline：default 账号已删，不再特判——是否需补人设仅看 personaBound。
    needsPersonaSetup: !personaBound,
    environmentSummary: { activeCount: 0, deletingCount: 0, onlineCount: 0 },
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

function parsePublishSchedule(raw: unknown): {
  publishMode: 'immediate' | 'draft' | 'scheduled';
  publishTime: number | null;
} {
  const meta = parseJsonObject(raw);
  const publishMode = meta?.mode === 'immediate' || meta?.mode === 'scheduled' || meta?.mode === 'draft'
    ? meta.mode
    : 'draft';
  const rawTime = typeof meta?.publishTime === 'number' ? meta.publishTime : NaN;
  return {
    publishMode,
    publishTime: publishMode === 'scheduled' && Number.isFinite(rawTime) ? rawTime : null,
  };
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

function parseCoverFormAudit(raw: unknown): PanelCoverFormAudit | null {
  const meta = parseJsonObject(raw);
  const audit = parseJsonObject(meta?.coverFormAudit);
  if (!audit) return null;
  const coverForm = typeof audit.coverForm === 'string' ? audit.coverForm : '';
  const renderStatus = typeof audit.renderStatus === 'string' ? audit.renderStatus : '';
  if (!coverForm || !renderStatus) return null;
  const rawMeta = parseJsonObject(audit.renderMeta);
  return {
    coverForm,
    sensedForm: typeof audit.sensedForm === 'string' ? audit.sensedForm : 'unknown',
    sensedSource: typeof audit.sensedSource === 'string' ? audit.sensedSource : 'none',
    gateReason: typeof audit.gateReason === 'string' ? audit.gateReason : '',
    renderStatus,
    renderMeta: rawMeta
      ? {
          themeKey: typeof rawMeta.themeKey === 'string' ? rawMeta.themeKey : '',
          truncated: rawMeta.truncated === true,
          sanitized: rawMeta.sanitized === true,
          reductions: Array.isArray(rawMeta.reductions) ? rawMeta.reductions.map((r) => String(r)) : [],
        }
      : null,
  };
}

function parseVisualReferenceAudit(raw: unknown): VisualReferenceAudit | null {
  const meta = parseJsonObject(raw);
  const audit = parseJsonObject(meta?.visualReferenceAudit);
  if (!audit || !Array.isArray(audit.slots)) return null;
  if (!['disabled', 'none', 'analyzed', 'partial', 'unavailable'].includes(String(audit.analysisStatus))) return null;
  if (!['slot', 'legacy_all', 'none'].includes(String(audit.bindingMode))) return null;
  // 逐槽字段由发布域强类型生成；面板只做顶层白名单和 null-safe，避免历史脏行拖垮整页。
  return audit as unknown as VisualReferenceAudit;
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

// accounts / persona_config 均 api 属主，就地 JOIN 于面板自己的（api）池。
// risk_state（automation 属主）已从此 JOIN 移除 —— 改由 automation 只读端口批量取投影后本地合入
// （Block③ L3：面板不直连 automation 的库）。
const ACCOUNT_SELECT = `
  SELECT a.account_id, a.label, a.nickname, a.operator_alias, a.platform, a.group_label, a.machine_label,
         a.contact_info, a.execution_target,
         a.status AS operator_status, a.paused_at,
         (pc.account_id IS NOT NULL AND btrim(pc.persona) <> '') AS persona_bound
  FROM accounts a
  LEFT JOIN persona_config pc ON pc.account_id = a.account_id`;

export class PgPanelStore implements PanelStoreReader {
  private readonly pool: pg.Pool;
  /**
   * automation 域只读投影端口（Block③ L3）：风控计数 / 风控态 / 告警 / 互动流经此取，
   * 面板绝不直读 automation 的表。单进程期 = 跑在 automation 池上的本地实现；拆进程后换 HTTP。
   */
  private readonly automation: PanelAutomationReader;

  constructor(options: PgPanelStoreOptions) {
    this.automation = options.automation;
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
    const rows = await this.automation.todayActionTotals();
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
    const rows = await this.automation.todayActionTotalsByAccount();
    const byAccount = new Map<string, TodayTotals>();
    for (const row of rows) {
      let totals = byAccount.get(row.accountId);
      if (!totals) {
        totals = Object.fromEntries(RISK_ACTIONS.map((a) => [a, 0])) as TodayTotals;
        byAccount.set(row.accountId, totals);
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
       WHERE status IN ('submitted', 'published') AND published_at >= ${SHANGHAI_DAY_START_SQL}`,
    );
    return rows[0]?.n ?? 0;
  }

  async likeRate(): Promise<LikeRate> {
    const { likes, views } = await this.automation.todayLikeViewTotal();
    const rate = views > 0 ? likes / views : null;
    const healthy = rate === null ? null : rate >= 0.15 && rate <= 0.35;
    return { likes, views, rate, healthy };
  }

  async listAccounts(): Promise<PanelAccount[]> {
    // accounts + persona_config 就地读（api 池）；风控态从 automation 端口批量取后按 accountId 合入。
    const [{ rows }, risk] = await Promise.all([
      this.pool.query<AccountJoinRow>(`${ACCOUNT_SELECT} ORDER BY a.created_at`),
      this.automation.riskStateProjection(),
    ]);
    const riskById = new Map(risk.map((x) => [x.accountId, x]));
    return rows.map((row) => toAccount(row, riskById.get(row.account_id)));
  }

  async getAccount(accountId: string): Promise<PanelAccount | null> {
    const [{ rows }, risk] = await Promise.all([
      this.pool.query<AccountJoinRow>(`${ACCOUNT_SELECT} WHERE a.account_id = $1`, [accountId]),
      this.automation.riskStateProjection([accountId]),
    ]);
    const r = rows[0];
    return r ? toAccount(r, risk[0]) : null;
  }

  /**
   * 已发布历史（change publish-history-account-and-detail）：带账号 + 正文 + 详情页链接；可选按账号过滤。
   * LEFT JOIN accounts 后复用统一解析器生成展示名；按账号过滤走 publish_log.account_id 索引（迁移 0005）。
   * status 服务端过滤（change parallel-rewrite-drafts）：多候选草稿世界待审集合必须完整可见——
   * 「全局最近 N 条再客户端过滤」的窗口会把老 pending 挤出视野，挑选入口面残缺。
   */
  async publishedHistory(limit: number, accountId?: string, status?: string): Promise<PanelPublish[]> {
    const params: unknown[] = [];
    const conds: string[] = [];
    if (accountId) {
      params.push(accountId);
      conds.push(`pl.account_id = $${params.length}`);
    }
    if (status) {
      params.push(status);
      conds.push(`pl.status = $${params.length}`);
    }
    const where = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '';
    params.push(limit);
    const { rows } = await this.pool.query<{
      id: number;
      title: string | null;
      status: string;
      platform: string;
      platform_post_id: string | null;
      published_at: Date;
      scheduled_at: Date | null;
      scheduled_platform_id: string | null;
      account_id: string;
      account_label: string | null;
      account_nickname: string | null;
      account_operator_alias: string | null;
      content: string | null;
      post_url: string | null;
      content_version: number | string | null;
      images: string[] | null;
      image_url: string | null;
      images_attached_count: number | string | null;
      publish_metadata: unknown;
      source_reference: unknown;
    }>(
      `SELECT pl.id, pl.title, pl.status, pl.platform, pl.platform_post_id, pl.published_at,
              pl.scheduled_at, pl.scheduled_platform_id,
              pl.account_id, a.label AS account_label, a.nickname AS account_nickname,
              a.operator_alias AS account_operator_alias, pl.content, pl.post_url,
              pl.content_version, pl.images, pl.image_url, pl.images_attached_count, pl.publish_metadata, pl.source_reference
       FROM publish_log pl
       LEFT JOIN accounts a ON a.account_id = pl.account_id
       ${where} ORDER BY pl.published_at DESC LIMIT $${params.length}`,
      params,
    );
    return rows.map((r) => {
      const schedule = parsePublishSchedule(r.publish_metadata);
      return {
        id: r.id,
        title: r.title,
        status: r.status,
        platform: r.platform,
        platformPostId: r.platform_post_id,
        publishedAt: r.published_at.getTime(),
        publishMode: schedule.publishMode,
        publishTime: schedule.publishTime,
        scheduledAt: r.scheduled_at ? r.scheduled_at.getTime() : null,
        scheduledPlatformId: r.scheduled_platform_id,
        accountId: r.account_id,
        accountLabel: resolveAccountDisplayName({
          accountId: r.account_id,
          operatorAlias: r.account_operator_alias,
          nickname: r.account_nickname,
          label: r.account_label,
        }).name,
        content: r.content,
        postUrl: r.post_url,
        contentVersion: Number(r.content_version ?? 0),
        images: r.images ?? [],
        imageUrl: r.image_url,
        imagesAttachedCount: Number(r.images_attached_count ?? 0),
        imageReferenceAudit: parseImageReferenceAudit(r.publish_metadata),
        coverFormAudit: parseCoverFormAudit(r.publish_metadata),
        visualReferenceAudit: parseVisualReferenceAudit(r.publish_metadata),
        sourceReference: parseSourceReference(r.source_reference),
      };
    });
  }

  async listAlerts(options: { limit?: number; includeResolved?: boolean } = {}): Promise<PanelAlert[]> {
    try {
      const rows = await this.automation.listAlerts(options);
      return rows.map((r) => ({
        id: r.alertId,
        severity: r.severity as AlertSeverity,
        type: r.type,
        accountId: r.accountId,
        title: r.title,
        detail: r.detail,
        createdAt: r.createdAt,
        resolvedAt: r.resolvedAt,
      }));
    } catch (err) {
      // 表未迁移时降级为空（dashboard 不因新表缺失整体 500）；其他错误上抛。降级策略保留在面板层（历史行为）。
      if ((err as { code?: string }).code === PG_UNDEFINED_TABLE) return [];
      throw err;
    }
  }

  async listInteractions(options: { limit?: number; accountId?: string } = {}): Promise<PanelInteraction[]> {
    try {
      // change interaction-feed-enrichment：读展示账本 + 读时 LEFT JOIN 元数据（标题/链接）。
      // title/url 为 NULL → 映射成 undefined（诚实置空，前端不渲染死链）。
      const rows = await this.automation.listInteractions(options);
      return rows.map((r) => ({
        accountId: r.accountId,
        targetId: r.targetId,
        action: r.action as FeedAction,
        ...(r.title ? { title: r.title } : {}),
        ...(r.url ? { url: r.url } : {}),
        interactedAt: r.interactedAt,
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
