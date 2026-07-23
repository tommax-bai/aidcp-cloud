/**
 * 内容排期存储（content_schedule_global 单例表 + account_content_schedule 旁挂 1:1 侧表，PostgreSQL）。
 *
 * change content-schedule-auto-publish（Phase 1，只做发帖）：多账号「按时段自动发帖」的配置层。
 * - 全局「内容可自动时段」168 格周历掩码（与浏览掩码 session_config_global.active_week_mask **物理分开**）；
 * - 每账号排期（总开关 / 动作模式 / 日上限 / 可选活跃与内容时段覆盖）。
 *
 * 安全不变量：
 * - **fail-closed**：全局掩码缺失 / 非法 = 不自动（≠ 浏览掩码的「缺失=全天活跃」）；账号无行 / 总开关关 = 完全不自动（零回归）。
 * - 每账号写为 UPSERT，但**写前先校验 accounts 有该账号行**（无行 → account_not_found，绝不造幽灵排期行）；退役 `default` 拒。
 * - 非法值整块拒（掩码非 168 位 '0'/'1'、日上限非非负整数），绝不部分落库；写后 RETURNING 回读真态，诚实非乐观。
 * - 账号活跃与内容生效掩码（各自 override ?? global）只在本 store 解析，供调度器与面板同源消费。
 *
 * 红线：本 store 只读写自己那两张表 + 读 accounts 存在性；全局活跃掩码仅经只读 provider 注入，
 * 绝不写 session_config_global、绝不碰风控状态单写、不经协议。
 * 建表幂等（CREATE TABLE IF NOT EXISTS），与 migrations/0028_content_schedule.sql 同源。
 */

import pg from 'pg';
import { DEFAULT_PG_CONFIG } from '../kernel/pg-config.js';
import { writeWithMirrorBump, type MirrorVersionBumper } from './mirror-version-store.js';
import { RETIRED_ACCOUNT_ID } from '../account-store.js';
import { resolveAccountDisplayName, type AccountDisplayNameSource } from '../account-display-name.js';
import { SHANGHAI_DAY_START_SQL } from '../time/shanghai-day.js';
import { isValidWeekActiveMask } from '../risk/session-limits.js';
import type { DeploymentTarget } from '../deployment-target.js';
import {
  availableScheduledAutomationActionsForPlatform,
  normalizePlatformForCatalog,
  platformRegistryEntry,
  SCHEDULED_CONTACT_COMMENT_DAILY_CAP_MAX,
  SCHEDULED_CONTENT_DAILY_CAP_MAX,
  type AvailableScheduledAutomationAction,
  type ScheduledAutomationAction,
} from '../platform/index.js';
import type { SchemaEnsurer } from '../kernel/schema-capability-contract.js';
import {
  CONTENT_SCHEDULE_ACTION_MODES,
  type ContentScheduleActionMode,
  type ContentScheduleApprovalMode,
} from '../kernel/content-schedule-mode.js';

const { Pool } = pg;

/** 发帖日上限防御性上界（与 console CAP_MAX 对齐；防异常大值）。 */
export const CONTENT_POST_DAILY_CAP_MAX = SCHEDULED_CONTENT_DAILY_CAP_MAX;
/** 联系评论日上限硬上界（change content-schedule-group-comments）：协同 spam 敏感动作，与 50 刻意分开；UI 建议 ≤3。 */
export const CONTACT_COMMENT_DAILY_CAP_MAX = SCHEDULED_CONTACT_COMMENT_DAILY_CAP_MAX;

export { CONTENT_SCHEDULE_ACTION_MODES };
export type { ContentScheduleActionMode, ContentScheduleApprovalMode };

/** 全局「内容可自动时段」行。contentActiveMask：168 格 '0'/'1'；null = 未配 = 全 0 = 不自动（fail-closed）。 */
export interface ContentScheduleGlobalRow {
  contentActiveMask: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
}

/** 每账号内容排期行。两个 mask 均以 null 表示独立继承各自全局值。 */
export interface AccountContentScheduleRow {
  accountId: string;
  autoEnabled: boolean;
  postEnabled: boolean;
  postMode: ContentScheduleActionMode;
  postDailyCap: number;
  /** 自动评论开关（change content-schedule-comments）。 */
  commentEnabled: boolean;
  commentMode: ContentScheduleActionMode;
  /** 评论日上限；0 = 不自动（与开关双保险）。 */
  commentDailyCap: number;
  /** 自动联系评论开关（change content-schedule-group-comments；开启须过一码一号硬校验）。 */
  contactCommentEnabled: boolean;
  contactCommentMode: ContentScheduleActionMode;
  /** 联系评论每日自动尝试上限（0..10 硬上限；尝试型：被拒/无目标也占额度）。 */
  contactCommentDailyCap: number;
  activeWeekMask: string | null;
  contentActiveMask: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
}

/** 面板 catalog 一行（LEFT JOIN accounts 补展示名 + 来源徽标 + configured）。 */
export interface ContentScheduleCatalogRow {
  accountId: string;
  /** 已知别名归一；未知值保留可诊断事实且 availableActions 为空。 */
  platform: string;
  label: string | null;
  groupLabel: string | null;
  nickname: string | null;
  operatorAlias: string | null;
  displayName: string;
  displayNameSource: AccountDisplayNameSource;
  /** 服务端 registry 权威投影；Console 不维护第二份动作矩阵。 */
  availableActions: AvailableScheduledAutomationAction[];
  autoEnabled: boolean;
  postEnabled: boolean;
  postMode: ContentScheduleActionMode;
  postDailyCap: number;
  commentEnabled: boolean;
  commentMode: ContentScheduleActionMode;
  commentDailyCap: number;
  contactCommentEnabled: boolean;
  contactCommentMode: ContentScheduleActionMode;
  contactCommentDailyCap: number;
  /** 该账号是否已配联系方式（accounts.contact_info IS NOT NULL；联系评论开关的前置徽标）。 */
  hasContactInfo: boolean;
  /** 原始账号覆盖；null = 对应层继承全局。 */
  activeWeekMask: string | null;
  contentActiveMask: string | null;
  /** 解析后的生效值；活跃 null=全天开放，内容 null=完全不自动。 */
  effectiveActiveWeekMask: string | null;
  effectiveContentActiveMask: string | null;
  activeMaskSource: 'override' | 'global';
  contentMaskSource: 'override' | 'global';
  hasActiveOverrideMask: boolean;
  hasContentOverrideMask: boolean;
  /** 旧字段兼容：等价于内容时段来源。 */
  maskSource: 'override' | 'global';
  /** 旧字段兼容：等价于 hasContentOverrideMask。 */
  hasOverrideMask: boolean;
  /** 侧表有行（false = 纯默认 = 未配 = 不自动）。 */
  configured: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
  /** 仅 Facebook 行聚合；领域配置仍由独立 store 持久化。 */
  joinGroupAutomation?: FacebookJoinGroupAutomationCatalogView;
}

export interface FacebookJoinGroupAutomationCatalogView {
  enabled: boolean;
  dailyCap: number;
  effectiveDailyCap: number;
  weekMask: string | null;
  weekMaskSource: 'content' | 'custom';
  effectiveWeekMask: string | null;
  accountGroupLabel: string | null;
  scopedTargetCount: number;
  scopeReady: boolean;
  recentResult: {
    outcome: string;
    reason: string | null;
    groupUrl: string | null;
    createdAt: string;
  } | null;
  updatedAt: string | null;
  updatedBy: string | null;
}

/** 调度器每 tick 现读的生效排期（effectiveMask 已解析：override ?? global）。 */
export interface EffectiveContentSchedule {
  autoEnabled: boolean;
  postEnabled: boolean;
  postMode: ContentScheduleActionMode;
  postDailyCap: number;
  commentEnabled: boolean;
  commentMode: ContentScheduleActionMode;
  commentDailyCap: number;
  contactCommentEnabled: boolean;
  contactCommentMode: ContentScheduleActionMode;
  contactCommentDailyCap: number;
  /** 账号生效活跃掩码；null = 全周全天活跃。 */
  effectiveActiveWeekMask: string | null;
  /** 账号生效内容掩码；旧名保留以避免调度协议面漂移。 */
  effectiveMask: string | null;
}

export interface ContentScheduleGlobalPatch {
  contentActiveMask?: string | null;
}

export interface AccountContentSchedulePatch {
  autoEnabled?: boolean;
  postEnabled?: boolean;
  postMode?: ContentScheduleActionMode;
  postDailyCap?: number;
  commentEnabled?: boolean;
  commentMode?: ContentScheduleActionMode;
  commentDailyCap?: number;
  contactCommentEnabled?: boolean;
  contactCommentMode?: ContentScheduleActionMode;
  contactCommentDailyCap?: number;
  /** 每账号活跃时段覆盖：168 位 '0'/'1'，或 null=清空覆盖=继承全局。 */
  activeWeekMask?: string | null;
  /** 每账号时段覆盖：168 位 '0'/'1'，或 null=清空覆盖=继承全局。 */
  contentActiveMask?: string | null;
}

export type SetContentGlobalResult =
  | { ok: true; row: ContentScheduleGlobalRow }
  | { ok: false; reason: 'invalid_value' | 'no_valid_fields' };

export type SetAccountContentScheduleResult =
  | {
      ok: true;
      row: AccountContentScheduleRow;
      /**
       * 开启自动联系评论时该联系方式与其它账号共用（一码一号从「硬阻断」放松为「放行 + 提示」，
       * change loosen-group-comment-shared-code）。true 时上层须回一条防关联风险提示、绝不静默。
       */
      sharedContactInfoWarning?: boolean;
    }
  | {
      ok: false;
      reason:
        | 'account_not_found'
        | 'retired_account'
        | 'invalid_value'
        | 'no_valid_fields'
        | 'no_contact_info'
        | 'unsupported_automation_action';
    };

export const CONTENT_SCHEDULE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS content_schedule_global (
  id                  INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  content_active_mask TEXT,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by          TEXT
);
CREATE TABLE IF NOT EXISTS account_content_schedule (
  account_id          TEXT PRIMARY KEY,
  auto_enabled        BOOLEAN NOT NULL DEFAULT false,
  post_enabled        BOOLEAN NOT NULL DEFAULT false,
  post_daily_cap      INTEGER NOT NULL DEFAULT 0,
  active_week_mask    TEXT,
  content_active_mask TEXT,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by          TEXT
);
-- 账号活跃周历覆盖（change account-activity-content-schedule）：NULL=继承 session_config_global.active_week_mask。
-- 只新增 nullable 列、不回填，存量账号行为逐位不变。
ALTER TABLE account_content_schedule ADD COLUMN IF NOT EXISTS active_week_mask TEXT;
-- 自愈加列（change content-schedule-comments，迁移 0029 文档伴随）：Phase 2 评论动作两列，
-- 既有表靠幂等 ALTER 在 init() 补上；默认 false / 0 = 不自动（fail-closed，零回归）。
ALTER TABLE account_content_schedule ADD COLUMN IF NOT EXISTS comment_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE account_content_schedule ADD COLUMN IF NOT EXISTS comment_daily_cap INTEGER NOT NULL DEFAULT 0;
-- 自愈加列（change content-schedule-group-comments → generalize-contact-info，物理改名迁移 0036 文档伴随）：Phase 3 联系评论两列，默认 false/0 = 不自动。
ALTER TABLE account_content_schedule ADD COLUMN IF NOT EXISTS contact_comment_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE account_content_schedule ADD COLUMN IF NOT EXISTS contact_comment_daily_cap INTEGER NOT NULL DEFAULT 0;
-- 自愈加列（change content-schedule-auto-approve-mode）：动作三档。null 兼容旧库/旧代码，读侧从 boolean 推导；新代码写入时同步 boolean 视图。
ALTER TABLE account_content_schedule ADD COLUMN IF NOT EXISTS post_mode TEXT;
ALTER TABLE account_content_schedule ADD COLUMN IF NOT EXISTS comment_mode TEXT;
ALTER TABLE account_content_schedule ADD COLUMN IF NOT EXISTS contact_comment_mode TEXT;
UPDATE account_content_schedule SET post_mode = CASE WHEN post_enabled THEN 'review' ELSE 'off' END WHERE post_mode IS NULL;
UPDATE account_content_schedule SET comment_mode = CASE WHEN comment_enabled THEN 'review' ELSE 'off' END WHERE comment_mode IS NULL;
UPDATE account_content_schedule SET contact_comment_mode = CASE WHEN contact_comment_enabled THEN 'review' ELSE 'off' END WHERE contact_comment_mode IS NULL;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'account_content_schedule_post_mode_check') THEN
    ALTER TABLE account_content_schedule ADD CONSTRAINT account_content_schedule_post_mode_check CHECK (post_mode IN ('off', 'review', 'auto_approve'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'account_content_schedule_comment_mode_check') THEN
    ALTER TABLE account_content_schedule ADD CONSTRAINT account_content_schedule_comment_mode_check CHECK (comment_mode IN ('off', 'review', 'auto_approve'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'account_content_schedule_contact_comment_mode_check') THEN
    ALTER TABLE account_content_schedule ADD CONSTRAINT account_content_schedule_contact_comment_mode_check CHECK (contact_comment_mode IN ('off', 'review', 'auto_approve'));
  END IF;
END $$;
-- 联系评论每日自动尝试台账（尝试型持久日上限：触发回执 ok 即记；重启不清零、绝不超发）。
CREATE TABLE IF NOT EXISTS contact_comment_attempts (
  id           BIGSERIAL PRIMARY KEY,
  account_id   TEXT NOT NULL,
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_contact_comment_attempts_account ON contact_comment_attempts (account_id, attempted_at);
-- 自愈加列（change feed-hot-lead-auto-group-comment）：审计维度——台账兼作「系统自动给哪些帖、因多热发了联系评论」记录。
-- source: 'scheduled_comment' | 'scheduled_contact' | 'hot_lead'；浏览触发带 note_id + 速率快照，排期传 null。可空、对既有行零回归。
ALTER TABLE contact_comment_attempts ADD COLUMN IF NOT EXISTS note_id TEXT;
ALTER TABLE contact_comment_attempts ADD COLUMN IF NOT EXISTS source TEXT;
ALTER TABLE contact_comment_attempts ADD COLUMN IF NOT EXISTS velocity DOUBLE PRECISION;
ALTER TABLE contact_comment_attempts ADD COLUMN IF NOT EXISTS age_hours DOUBLE PRECISION;
-- 自动发帖小时格幂等台账：每账号只保留最新格；不是待消费队列，也不积累历史。
CREATE TABLE IF NOT EXISTS content_schedule_hour_claims (
  account_id       TEXT NOT NULL,
  action           TEXT NOT NULL CHECK (action = 'post'),
  hour_cell        TEXT NOT NULL,
  execution_target TEXT NOT NULL CHECK (execution_target IN ('dev', 'ol')),
  env_key          TEXT NOT NULL,
  claimed_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, action)
);
`;

export interface ContentScheduleStoreOptions {
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  pool?: pg.Pool;
  /** schema 保障能力注入端口（必填、无默认）：组合根传 automation 的 ensureCapabilitySchema，本文件只从 kernel 取类型。 */
  schemaEnsurer: SchemaEnsurer;
  /**
   * 全局活跃周历只读 provider；缺失/非法沿浏览既有语义回落 null=全天活跃。
   *
   * **归属连带约束（change config-mirror-cross-process-invalidation task 1.4 / 5.3）**：
   * 这个 provider 背后是 `session_config_global`，该表随其消费方归 **aidcp-automation**。
   * 本 store 的 `effectiveActiveWeekMaskFor()`（automation 侧现读）与 `listCatalog()`
   *（api 侧面板目录投影）**必须经同一个 provider、同一次求值**取生效掩码：
   * api 侧 MUST NOT 另建一份 `session_config_global` 副本自行合成——展示值与生效值一旦分两处求值，
   * 就一定会出现「后台显示的数字」与「闸实际按的数字」不一致，而这类不一致在界面上完全看不出来
   *（同 `interaction-risk-gating` 里「慢启动投影与 clamp MUST 同一解析函数、同一次时钟」）。
   */
  globalActiveWeekMask?: () => string | null;
  /** 跨进程失效通道：写入与版本推进同事务。缺省 = 不推版本（行为逐位退回今日现状）。 */
  mirrorVersionBumper?: MirrorVersionBumper;
}

interface GlobalDbRow {
  content_active_mask: string | null;
  updated_at: Date | string | null;
  updated_by: string | null;
}

interface AccountDbRow {
  account_id: string;
  auto_enabled: boolean;
  post_enabled: boolean;
  post_mode: string | null;
  post_daily_cap: number | string;
  comment_enabled: boolean;
  comment_mode: string | null;
  comment_daily_cap: number | string;
  contact_comment_enabled: boolean;
  contact_comment_mode: string | null;
  contact_comment_daily_cap: number | string;
  active_week_mask: string | null;
  content_active_mask: string | null;
  updated_at: Date | string | null;
  updated_by: string | null;
}

const toIso = (v: Date | string | null): string | null =>
  v ? new Date(v).toISOString() : null;

/** 日上限有效值：0..CAP_MAX 的整数。否则视作非法。 */
function validCap(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= CONTENT_POST_DAILY_CAP_MAX;
}

/** 掩码补丁有效：null（清空）或 168 位 '0'/'1'。 */
function validMaskPatch(m: unknown): m is string | null {
  return m === null || isValidWeekActiveMask(m);
}

export function isContentScheduleActionMode(v: unknown): v is ContentScheduleActionMode {
  return typeof v === 'string' && (CONTENT_SCHEDULE_ACTION_MODES as readonly string[]).includes(v);
}

export function actionModeFromEnabled(enabled: boolean): ContentScheduleActionMode {
  return enabled ? 'review' : 'off';
}

export function actionModeEnabled(mode: ContentScheduleActionMode): mode is ContentScheduleApprovalMode {
  return mode !== 'off';
}

const ACTION_PATCH_FIELDS: Record<
  Exclude<ScheduledAutomationAction, 'join_group'>,
  {
    enabled: 'postEnabled' | 'commentEnabled' | 'contactCommentEnabled';
    mode: 'postMode' | 'commentMode' | 'contactCommentMode';
    cap: 'postDailyCap' | 'commentDailyCap' | 'contactCommentDailyCap';
  }
> = {
  post: { enabled: 'postEnabled', mode: 'postMode', cap: 'postDailyCap' },
  comment: { enabled: 'commentEnabled', mode: 'commentMode', cap: 'commentDailyCap' },
  contact_comment: {
    enabled: 'contactCommentEnabled',
    mode: 'contactCommentMode',
    cap: 'contactCommentDailyCap',
  },
};

/**
 * 只校验本次显式提交的动作字段簇：未知/不支持动作可 false/off/0 清脏，任何开启意图 fail closed。
 * 公共总开关与周历补丁不读取历史脏动作，因此不会被误伤。
 */
function scheduledAutomationPatchSupported(
  platform: string | null | undefined,
  patch: AccountContentSchedulePatch,
): boolean {
  let declarations: ReturnType<typeof platformRegistryEntry>['scheduledAutomation'] | null = null;
  try {
    declarations = platformRegistryEntry(platform).scheduledAutomation;
  } catch {
    declarations = null;
  }

  for (const action of Object.keys(ACTION_PATCH_FIELDS) as Array<Exclude<ScheduledAutomationAction, 'join_group'>>) {
    const fields = ACTION_PATCH_FIELDS[action];
    const hasEnabled = fields.enabled in patch;
    const hasMode = fields.mode in patch;
    const hasCap = fields.cap in patch;
    if (!hasEnabled && !hasMode && !hasCap) continue;

    const enabled = patch[fields.enabled];
    const mode = patch[fields.mode];
    const cap = patch[fields.cap];
    const support = declarations?.[action];
    if (!support?.supported) {
      if (enabled === true || (mode !== undefined && mode !== 'off') || (cap !== undefined && cap > 0)) return false;
      continue;
    }
    if (mode !== undefined && mode !== 'off' && !support.allowedModes.includes(mode)) return false;
    if (cap !== undefined && cap > support.maxDailyCap) return false;
  }
  return true;
}

function actionModeFromDb(mode: string | null | undefined, enabled: boolean | null | undefined): ContentScheduleActionMode {
  if (isContentScheduleActionMode(mode)) return mode;
  return actionModeFromEnabled(enabled === true);
}

export class ContentScheduleStore {
  private readonly pool: pg.Pool;
  private readonly globalActiveWeekMask: () => string | null;
  private readonly mirrorVersionBumper?: MirrorVersionBumper;
  private globalCache: ContentScheduleGlobalRow | null = null;
  /**
   * 账号排期镜像。**引用可替换**（非 readonly）：跨进程刷新器会在任意时刻触发重载，
   * 原地 clear + fill 会让并发的同步现读撞上「空/半填」的中途态 → 一个已配好排期的账号被当成未配。
   */
  private accountCache = new Map<string, AccountContentScheduleRow>();

  private readonly schemaEnsurer: SchemaEnsurer;

  constructor(options: ContentScheduleStoreOptions) {
    this.schemaEnsurer = options.schemaEnsurer;
    this.mirrorVersionBumper = options.mirrorVersionBumper;
    this.globalActiveWeekMask = options.globalActiveWeekMask ?? (() => null);
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

  /** 建两张表 + 载入内存镜像（供调度器每 tick 现读，无 PG 往返）。 */
  async init(): Promise<void> {
    // DDL 单一所有者（change cloud-schema-migration-executor 任务 5.x）：只探测、不建表。
    // 探不到即带 version id 明确报错并 fail-closed；MUST NOT 在这里把表建出来继续跑。
    await this.schemaEnsurer(this.pool, {
      capability: 'content_schedule',
      sinceVersion: '0028_content_schedule',
      ddl: [CONTENT_SCHEDULE_SCHEMA_SQL],
    });
    await this.reload();
  }

  /**
   * 自动发帖命中格的跨进程原子占位。只允许同账号的 hourCell 向新值推进；相同格返回 false。
   * 占位成功即视为本格已触发，后续生成失败也不释放，避免高成本自动重做。
   */
  async claimAutoPostHourCell(input: {
    accountId: string;
    hourCell: string;
    executionTarget: DeploymentTarget;
    envKey: string;
  }): Promise<boolean> {
    const accountId = input.accountId.trim();
    const hourCell = input.hourCell.trim();
    const envKey = input.envKey.trim();
    if (!accountId || !hourCell || !envKey) throw new Error('invalid_content_schedule_hour_claim');

    const { rows } = await this.pool.query<{ account_id: string }>(
      `INSERT INTO content_schedule_hour_claims
         (account_id, action, hour_cell, execution_target, env_key)
       VALUES ($1, 'post', $2, $3, $4)
       ON CONFLICT (account_id, action) DO UPDATE
         SET hour_cell = EXCLUDED.hour_cell,
             execution_target = EXCLUDED.execution_target,
             env_key = EXCLUDED.env_key,
             claimed_at = now()
       WHERE content_schedule_hour_claims.hour_cell <> EXCLUDED.hour_cell
       RETURNING account_id`,
      [accountId, hourCell, input.executionTarget, envKey],
    );
    return rows.length === 1;
  }

  /** 跨进程失效刷新入口（task 3.2）：只由刷新器在版本变化时调用；`reload()` 保持 private。 */
  async refreshFromAuthority(): Promise<void> {
    await this.reload();
  }

  private async reload(): Promise<void> {
    const g = await this.pool.query<GlobalDbRow>(
      `SELECT content_active_mask, updated_at, updated_by FROM content_schedule_global WHERE id = 1`,
    );
    this.globalCache = g.rows[0] ? this.globalFromDb(g.rows[0]) : null;

    const a = await this.pool.query<AccountDbRow>(
      `SELECT account_id, auto_enabled, post_enabled, post_daily_cap, comment_enabled, comment_daily_cap,
              contact_comment_enabled, contact_comment_daily_cap,
              post_mode, comment_mode, contact_comment_mode,
              active_week_mask, content_active_mask, updated_at, updated_by
         FROM account_content_schedule`,
    );
    // 构建新 Map → 原子替换引用（禁止原地 clear+fill，防并发现读撞上半填快照）。
    const nextAccounts = new Map<string, AccountContentScheduleRow>();
    for (const r of a.rows) nextAccounts.set(r.account_id, this.accountFromDb(r));
    this.accountCache = nextAccounts;
  }

  private globalFromDb(r: GlobalDbRow): ContentScheduleGlobalRow {
    return {
      contentActiveMask: r.content_active_mask ?? null,
      updatedAt: toIso(r.updated_at),
      updatedBy: r.updated_by ?? null,
    };
  }

  private accountFromDb(r: AccountDbRow): AccountContentScheduleRow {
    const postMode = actionModeFromDb(r.post_mode, r.post_enabled);
    const commentMode = actionModeFromDb(r.comment_mode, r.comment_enabled);
    const contactCommentMode = actionModeFromDb(r.contact_comment_mode, r.contact_comment_enabled);
    return {
      accountId: r.account_id,
      autoEnabled: r.auto_enabled === true,
      postEnabled: actionModeEnabled(postMode),
      postMode,
      postDailyCap: Number(r.post_daily_cap),
      commentEnabled: actionModeEnabled(commentMode),
      commentMode,
      commentDailyCap: Number(r.comment_daily_cap),
      contactCommentEnabled: actionModeEnabled(contactCommentMode),
      contactCommentMode,
      contactCommentDailyCap: Number(r.contact_comment_daily_cap),
      activeWeekMask: r.active_week_mask ?? null,
      contentActiveMask: r.content_active_mask ?? null,
      updatedAt: toIso(r.updated_at),
      updatedBy: r.updated_by ?? null,
    };
  }

  /** 全局行（无行 = 未配，null）。面板 overridden / 展示用。 */
  getGlobal(): ContentScheduleGlobalRow | null {
    return this.globalCache;
  }

  /** 单账号行（无行 = 未配，null）。 */
  getAccount(accountId: string): AccountContentScheduleRow | null {
    return this.accountCache.get(accountId) ?? null;
  }

  /**
   * 全局活跃周历的**唯一解析点**（task 5.3）：automation 侧现读与 api 侧面板目录投影共用它，
   * 保证「面板显示的生效掩码」= 「闸实际按的生效掩码」。MUST NOT 在别处另写一份等价逻辑。
   */
  private resolveGlobalActiveWeekMask(): string | null {
    const globalMask = this.globalActiveWeekMask();
    return isValidWeekActiveMask(globalMask) ? globalMask : null;
  }

  /** 账号活跃覆盖合法才优先；脏覆盖视为缺失并回落全局，绝不因坏值绕过更严格全局闸。 */
  effectiveActiveWeekMaskFor(accountId: string): string | null {
    const accountMask = this.accountCache.get(accountId)?.activeWeekMask;
    if (isValidWeekActiveMask(accountMask)) return accountMask;
    return this.resolveGlobalActiveWeekMask();
  }

  /** 账号内容覆盖按 null 继承；脏非空值原样交调度器 fail-closed 校验。 */
  effectiveContentActiveMaskFor(accountId: string): string | null {
    return this.accountCache.get(accountId)?.contentActiveMask ?? this.globalCache?.contentActiveMask ?? null;
  }

  /**
   * 调度器每 tick 现读的生效排期。无账号行 → 不自动（零回归）。
   * effectiveMask = 账号覆盖 ?? 全局（唯一解析点）；fail-closed 校验由调用方（调度器）用 isValidWeekActiveMask + isWeekActiveAt 做。
   */
  effectiveScheduleFor(accountId: string): EffectiveContentSchedule {
    const a = this.accountCache.get(accountId);
    if (!a)
      return {
        autoEnabled: false,
        postEnabled: false,
        postMode: 'off',
        postDailyCap: 0,
        commentEnabled: false,
        commentMode: 'off',
        commentDailyCap: 0,
        contactCommentEnabled: false,
        contactCommentMode: 'off',
        contactCommentDailyCap: 0,
        effectiveActiveWeekMask: this.effectiveActiveWeekMaskFor(accountId),
        effectiveMask: this.effectiveContentActiveMaskFor(accountId),
      };
    return {
      autoEnabled: a.autoEnabled,
      postEnabled: a.postEnabled,
      postMode: a.postMode,
      postDailyCap: a.postDailyCap,
      commentEnabled: a.commentEnabled,
      commentMode: a.commentMode,
      commentDailyCap: a.commentDailyCap,
      contactCommentEnabled: a.contactCommentEnabled,
      contactCommentMode: a.contactCommentMode,
      contactCommentDailyCap: a.contactCommentDailyCap,
      effectiveActiveWeekMask: this.effectiveActiveWeekMaskFor(accountId),
      effectiveMask: this.effectiveContentActiveMaskFor(accountId),
    };
  }

  /**
   * 写全局内容格：掩码为 168 位 '0'/'1' 或 null（清空）；非法整块拒。写后 RETURNING 回读、刷镜像。
   */
  async setGlobal(patch: ContentScheduleGlobalPatch, updatedBy: string): Promise<SetContentGlobalResult> {
    if (!('contentActiveMask' in patch)) return { ok: false, reason: 'no_valid_fields' };
    if (!validMaskPatch(patch.contentActiveMask)) return { ok: false, reason: 'invalid_value' };
    const nextMask = patch.contentActiveMask ?? null;
    const { rows } = await writeWithMirrorBump(this.pool, this.mirrorVersionBumper, 'content_schedule', (q) =>
      q.query<GlobalDbRow>(
        `INSERT INTO content_schedule_global (id, content_active_mask, updated_at, updated_by)
       VALUES (1, $1, now(), $2)
       ON CONFLICT (id) DO UPDATE SET content_active_mask = EXCLUDED.content_active_mask,
                                       updated_at = now(), updated_by = EXCLUDED.updated_by
       RETURNING content_active_mask, updated_at, updated_by`,
        [nextMask, updatedBy],
      ),
    );
    const row = rows[0]
      ? this.globalFromDb(rows[0])
      : { contentActiveMask: nextMask, updatedAt: null, updatedBy };
    this.globalCache = row;
    return { ok: true, row };
  }

  /**
   * 写单账号排期：UPSERT-only，写前先校验 accounts 有该账号行（无行 → account_not_found，绝不造幽灵行）；
   * 退役 default 拒；非法值整块拒不部分落库；写后 RETURNING 回读、刷镜像。未传字段保持原值（含默认）。
   */
  async setAccount(
    accountId: string,
    patch: AccountContentSchedulePatch,
    updatedBy: string,
  ): Promise<SetAccountContentScheduleResult> {
    if (accountId === RETIRED_ACCOUNT_ID) return { ok: false, reason: 'retired_account' };

    // 校验补丁：present 字段逐一校验；无 present 字段 → no_valid_fields。
    let hasField = false;
    if ('autoEnabled' in patch) {
      if (typeof patch.autoEnabled !== 'boolean') return { ok: false, reason: 'invalid_value' };
      hasField = true;
    }
    if ('postEnabled' in patch) {
      if (typeof patch.postEnabled !== 'boolean') return { ok: false, reason: 'invalid_value' };
      hasField = true;
    }
    if ('postMode' in patch) {
      if (!isContentScheduleActionMode(patch.postMode)) return { ok: false, reason: 'invalid_value' };
      hasField = true;
    }
    if ('postDailyCap' in patch) {
      if (!validCap(patch.postDailyCap)) return { ok: false, reason: 'invalid_value' };
      hasField = true;
    }
    if ('commentEnabled' in patch) {
      if (typeof patch.commentEnabled !== 'boolean') return { ok: false, reason: 'invalid_value' };
      hasField = true;
    }
    if ('commentMode' in patch) {
      if (!isContentScheduleActionMode(patch.commentMode)) return { ok: false, reason: 'invalid_value' };
      hasField = true;
    }
    if ('commentDailyCap' in patch) {
      if (!validCap(patch.commentDailyCap)) return { ok: false, reason: 'invalid_value' };
      hasField = true;
    }
    if ('contactCommentEnabled' in patch) {
      if (typeof patch.contactCommentEnabled !== 'boolean') return { ok: false, reason: 'invalid_value' };
      hasField = true;
    }
    if ('contactCommentMode' in patch) {
      if (!isContentScheduleActionMode(patch.contactCommentMode)) return { ok: false, reason: 'invalid_value' };
      hasField = true;
    }
    if ('contactCommentDailyCap' in patch) {
      // 联系评论硬上限 0..10（协同 spam 敏感，区别于发帖/评论的 50）；越界整块拒。
      const v = patch.contactCommentDailyCap;
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > CONTACT_COMMENT_DAILY_CAP_MAX)
        return { ok: false, reason: 'invalid_value' };
      hasField = true;
    }
    if ('activeWeekMask' in patch) {
      if (!validMaskPatch(patch.activeWeekMask)) return { ok: false, reason: 'invalid_value' };
      hasField = true;
    }
    if ('contentActiveMask' in patch) {
      if (!validMaskPatch(patch.contentActiveMask)) return { ok: false, reason: 'invalid_value' };
      hasField = true;
    }
    if (!hasField) return { ok: false, reason: 'no_valid_fields' };

    // 一次读取账号存在性与平台事实。平台动作校验发生在任何 UPSERT/联系方式读写前，失败绝不部分落库。
    const account = await this.pool.query<{ platform: string | null }>(
      `SELECT platform FROM accounts WHERE account_id = $1`,
      [accountId],
    );
    if (account.rows.length === 0) return { ok: false, reason: 'account_not_found' };
    if (!scheduledAutomationPatchSupported(account.rows[0]?.platform, patch)) {
      return { ok: false, reason: 'unsupported_automation_action' };
    }

    // 开启自动联系评论的联系方式闸（change content-schedule-group-comments；一码一号于 loosen-group-comment-shared-code
    // 从「硬阻断」放松为「放行 + 提示」）：每次 contactCommentEnabled=true 的写入都重跑。
    // 无联系方式 → no_contact_info 硬拒（没联系方式开开关无意义，提前拦；触发时缺联系方式 fail-closed 仍在，纵深）；
    // 联系方式与其它账号共用 → 不再硬拒，置 sharedContactInfoWarning 放行，防关联封号改由上层如实提示（绝不静默）。
    let sharedContactInfoWarning = false;
    const wantsContactComment = patch.contactCommentMode
      ? actionModeEnabled(patch.contactCommentMode)
      : patch.contactCommentEnabled === true;
    if (wantsContactComment) {
      const code = await this.pool.query<{ contact_info: string | null }>(
        `SELECT contact_info FROM accounts WHERE account_id = $1`,
        [accountId],
      );
      const myCode = code.rows[0]?.contact_info ?? null;
      if (myCode === null) return { ok: false, reason: 'no_contact_info' };
      const shared = await this.pool.query(
        `SELECT 1 FROM accounts WHERE contact_info = $1 AND account_id <> $2 LIMIT 1`,
        [myCode, accountId],
      );
      if (shared.rows.length > 0) sharedContactInfoWarning = true;
    }

    // 未传字段保持原值（原无行则取列默认 false/false/0/null）。
    const prev = this.accountCache.get(accountId);
    const nextAuto = patch.autoEnabled ?? prev?.autoEnabled ?? false;
    const nextPostMode =
      patch.postMode ?? (patch.postEnabled !== undefined ? actionModeFromEnabled(patch.postEnabled) : prev?.postMode ?? 'off');
    const nextPost = actionModeEnabled(nextPostMode);
    const nextCap = patch.postDailyCap ?? prev?.postDailyCap ?? 0;
    const nextCommentMode =
      patch.commentMode ??
      (patch.commentEnabled !== undefined ? actionModeFromEnabled(patch.commentEnabled) : prev?.commentMode ?? 'off');
    const nextCommentEnabled = actionModeEnabled(nextCommentMode);
    const nextCommentCap = patch.commentDailyCap ?? prev?.commentDailyCap ?? 0;
    const nextContactMode =
      patch.contactCommentMode ??
      (patch.contactCommentEnabled !== undefined ? actionModeFromEnabled(patch.contactCommentEnabled) : prev?.contactCommentMode ?? 'off');
    const nextContactEnabled = actionModeEnabled(nextContactMode);
    const nextContactCap = patch.contactCommentDailyCap ?? prev?.contactCommentDailyCap ?? 0;
    const nextActiveMask =
      'activeWeekMask' in patch ? patch.activeWeekMask ?? null : prev?.activeWeekMask ?? null;
    const nextContentMask =
      'contentActiveMask' in patch ? patch.contentActiveMask ?? null : prev?.contentActiveMask ?? null;

    const { rows } = await writeWithMirrorBump(this.pool, this.mirrorVersionBumper, 'content_schedule', (q) =>
      q.query<AccountDbRow>(
        `INSERT INTO account_content_schedule
         (account_id, auto_enabled, post_enabled, post_daily_cap, comment_enabled, comment_daily_cap,
          contact_comment_enabled, contact_comment_daily_cap, post_mode, comment_mode, contact_comment_mode,
          active_week_mask, content_active_mask, updated_at, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, now(), $14)
       ON CONFLICT (account_id) DO UPDATE SET auto_enabled = EXCLUDED.auto_enabled,
                                              post_enabled = EXCLUDED.post_enabled,
                                              post_daily_cap = EXCLUDED.post_daily_cap,
                                              comment_enabled = EXCLUDED.comment_enabled,
                                              comment_daily_cap = EXCLUDED.comment_daily_cap,
                                              contact_comment_enabled = EXCLUDED.contact_comment_enabled,
                                              contact_comment_daily_cap = EXCLUDED.contact_comment_daily_cap,
                                              post_mode = EXCLUDED.post_mode,
                                              comment_mode = EXCLUDED.comment_mode,
                                              contact_comment_mode = EXCLUDED.contact_comment_mode,
                                              active_week_mask = EXCLUDED.active_week_mask,
                                              content_active_mask = EXCLUDED.content_active_mask,
                                              updated_at = now(), updated_by = EXCLUDED.updated_by
       RETURNING account_id, auto_enabled, post_enabled, post_daily_cap, comment_enabled, comment_daily_cap,
                 contact_comment_enabled, contact_comment_daily_cap, post_mode, comment_mode, contact_comment_mode,
                 active_week_mask, content_active_mask, updated_at, updated_by`,
      [
        accountId,
        nextAuto,
        nextPost,
        nextCap,
        nextCommentEnabled,
        nextCommentCap,
        nextContactEnabled,
        nextContactCap,
        nextPostMode,
        nextCommentMode,
        nextContactMode,
        nextActiveMask,
        nextContentMask,
        updatedBy,
      ],
      ),
    );
    const row = rows[0]
      ? this.accountFromDb(rows[0])
      : {
          accountId,
          autoEnabled: nextAuto,
          postEnabled: nextPost,
          postMode: nextPostMode,
          postDailyCap: nextCap,
          commentEnabled: nextCommentEnabled,
          commentMode: nextCommentMode,
          commentDailyCap: nextCommentCap,
          contactCommentEnabled: nextContactEnabled,
          contactCommentMode: nextContactMode,
          contactCommentDailyCap: nextContactCap,
          activeWeekMask: nextActiveMask,
          contentActiveMask: nextContentMask,
          updatedAt: null,
          updatedBy,
        };
    this.accountCache.set(accountId, row);
    return sharedContactInfoWarning ? { ok: true, row, sharedContactInfoWarning: true } : { ok: true, row };
  }

  /**
   * 联系评论每日自动尝试台账（change content-schedule-group-comments）：触发回执 ok（任务真开跑）即记。
   * 尝试型上限的保守方向——被人审拒 / 无强相关目标也占额度；持久、重启不清零、绝不超发。
   */
  async recordContactCommentAttempt(
    accountId: string,
    audit?: { source?: string; noteId?: string; velocity?: number; ageHours?: number },
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO contact_comment_attempts (account_id, source, note_id, velocity, age_hours) VALUES ($1, $2, $3, $4, $5)`,
      [accountId, audit?.source ?? null, audit?.noteId ?? null, audit?.velocity ?? null, audit?.ageHours ?? null],
    );
  }

  /** 该账号今日（Asia/Shanghai 自然日）联系评论自动尝试数。 */
  async countContactAttemptsToday(accountId: string): Promise<number> {
    const { rows } = await this.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM contact_comment_attempts
        WHERE account_id = $1 AND attempted_at >= ${SHANGHAI_DAY_START_SQL}`,
      [accountId],
    );
    return Number(rows[0]?.n ?? '0');
  }

  /**
   * 面板 catalog：所有账号一行（LEFT JOIN accounts 补展示名 + 来源徽标 + configured）。
   * 低频（面板读），直查 PG。含未配账号（侧表无行 → 合成默认全 false/0/继承、configured=false）。
   */
  async listCatalog(): Promise<ContentScheduleCatalogRow[]> {
    const { rows } = await this.pool.query<{
      account_id: string;
      platform: string | null;
      label: string | null;
      group_label: string | null;
      nickname: string | null;
      operator_alias: string | null;
      auto_enabled: boolean | null;
      post_enabled: boolean | null;
      post_mode: string | null;
      post_daily_cap: number | string | null;
      comment_enabled: boolean | null;
      comment_mode: string | null;
      comment_daily_cap: number | string | null;
      contact_comment_enabled: boolean | null;
      contact_comment_mode: string | null;
      contact_comment_daily_cap: number | string | null;
      has_contact_info: boolean;
      active_week_mask: string | null;
      content_active_mask: string | null;
      updated_at: Date | string | null;
      updated_by: string | null;
    }>(
      `SELECT a.account_id, a.platform, a.label, a.group_label, a.nickname, a.operator_alias,
              (a.contact_info IS NOT NULL) AS has_contact_info,
              s.auto_enabled, s.post_enabled, s.post_daily_cap, s.comment_enabled, s.comment_daily_cap,
              s.contact_comment_enabled, s.contact_comment_daily_cap,
              s.post_mode, s.comment_mode, s.contact_comment_mode,
              s.active_week_mask, s.content_active_mask, s.updated_at, s.updated_by
         FROM accounts a
         LEFT JOIN account_content_schedule s ON s.account_id = a.account_id
        WHERE a.account_id <> $1
        ORDER BY a.account_id`,
      [RETIRED_ACCOUNT_ID],
    );
    return rows.map((r) => {
      const configured = r.auto_enabled !== null;
      const hasActiveOverrideMask = isValidWeekActiveMask(r.active_week_mask);
      const hasContentOverrideMask = r.content_active_mask != null;
      // 面板目录的生效掩码走与 automation 侧现读**同一个解析函数**（task 5.3）：
      // api 侧绝不另建 session_config_global 副本、绝不自行合成。
      const effectiveActiveWeekMask = hasActiveOverrideMask
        ? r.active_week_mask
        : this.resolveGlobalActiveWeekMask();
      const effectiveContentActiveMask = r.content_active_mask ?? this.globalCache?.contentActiveMask ?? null;
      const postMode = actionModeFromDb(r.post_mode, r.post_enabled);
      const commentMode = actionModeFromDb(r.comment_mode, r.comment_enabled);
      const contactCommentMode = actionModeFromDb(r.contact_comment_mode, r.contact_comment_enabled);
      const display = resolveAccountDisplayName({
        accountId: r.account_id, operatorAlias: r.operator_alias, nickname: r.nickname, label: r.label,
      });
      return {
        accountId: r.account_id,
        platform: normalizePlatformForCatalog(r.platform),
        label: r.label ?? null,
        groupLabel: r.group_label ?? null,
        nickname: r.nickname ?? null,
        operatorAlias: r.operator_alias ?? null,
        displayName: display.name,
        displayNameSource: display.source,
        availableActions: availableScheduledAutomationActionsForPlatform(r.platform),
        autoEnabled: r.auto_enabled === true,
        postEnabled: actionModeEnabled(postMode),
        postMode,
        postDailyCap: r.post_daily_cap == null ? 0 : Number(r.post_daily_cap),
        commentEnabled: actionModeEnabled(commentMode),
        commentMode,
        commentDailyCap: r.comment_daily_cap == null ? 0 : Number(r.comment_daily_cap),
        contactCommentEnabled: actionModeEnabled(contactCommentMode),
        contactCommentMode,
        contactCommentDailyCap: r.contact_comment_daily_cap == null ? 0 : Number(r.contact_comment_daily_cap),
        hasContactInfo: r.has_contact_info === true,
        activeWeekMask: r.active_week_mask ?? null,
        contentActiveMask: r.content_active_mask ?? null,
        effectiveActiveWeekMask,
        effectiveContentActiveMask,
        activeMaskSource: hasActiveOverrideMask ? 'override' : 'global',
        contentMaskSource: hasContentOverrideMask ? 'override' : 'global',
        hasActiveOverrideMask,
        hasContentOverrideMask,
        maskSource: hasContentOverrideMask ? 'override' : 'global',
        hasOverrideMask: hasContentOverrideMask,
        configured,
        updatedAt: toIso(r.updated_at),
        updatedBy: r.updated_by ?? null,
      };
    });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
