/**
 * 内容排期存储（content_schedule_global 单例表 + account_content_schedule 旁挂 1:1 侧表，PostgreSQL）。
 *
 * change content-schedule-auto-publish（Phase 1，只做发帖）：多账号「按时段自动发帖」的配置层。
 * - 全局「内容可自动时段」168 格周历掩码（与浏览掩码 session_config_global.active_week_mask **物理分开**）；
 * - 每账号排期（总开关 / 发帖开关 / 发帖日上限 / 可选每账号时段覆盖）。
 *
 * 安全不变量：
 * - **fail-closed**：全局掩码缺失 / 非法 = 不自动（≠ 浏览掩码的「缺失=全天活跃」）；账号无行 / 总开关关 = 完全不自动（零回归）。
 * - 每账号写为 UPSERT，但**写前先校验 accounts 有该账号行**（无行 → account_not_found，绝不造幽灵排期行）；退役 `default` 拒。
 * - 非法值整块拒（掩码非 168 位 '0'/'1'、日上限非非负整数），绝不部分落库；写后 RETURNING 回读真态，诚实非乐观。
 * - effectiveMask（override ?? global）解析只在本 store 一处（`effectiveScheduleFor`），供调度器判定与面板展示同源、不漂移。
 *
 * 红线：本 store 只读写自己那两张表 + 读 accounts 存在性；绝不碰风控状态单写、不碰浏览掩码、不经协议。
 * 建表幂等（CREATE TABLE IF NOT EXISTS），与 migrations/0028_content_schedule.sql 同源。
 */

import pg from 'pg';
import { DEFAULT_PG_CONFIG } from '../cache/pg-anchor-cache.js';
import { RETIRED_ACCOUNT_ID } from '../account-store.js';
import { SHANGHAI_DAY_START_SQL } from '../time/shanghai-day.js';
import { isValidWeekActiveMask } from '../risk/session-limits.js';

const { Pool } = pg;

/** 发帖日上限防御性上界（与 console CAP_MAX 对齐；防异常大值）。 */
export const CONTENT_POST_DAILY_CAP_MAX = 50;
/** 带联系方式评论日上限硬上界（change content-schedule-group-comments）：协同 spam 敏感动作，与 50 刻意分开；UI 建议 ≤3。 */
export const CONTACT_COMMENT_DAILY_CAP_MAX = 10;

/** 全局「内容可自动时段」行。contentActiveMask：168 格 '0'/'1'；null = 未配 = 全 0 = 不自动（fail-closed）。 */
export interface ContentScheduleGlobalRow {
  contentActiveMask: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
}

/** 每账号内容排期行。contentActiveMask：每账号时段覆盖，null = 继承全局。 */
export interface AccountContentScheduleRow {
  accountId: string;
  autoEnabled: boolean;
  postEnabled: boolean;
  postDailyCap: number;
  /** 自动评论开关（change content-schedule-comments）。 */
  commentEnabled: boolean;
  /** 评论日上限；0 = 不自动（与开关双保险）。 */
  commentDailyCap: number;
  /** 自动带联系方式评论开关（change content-schedule-group-comments；开启须过一码一号硬校验）。 */
  contactCommentEnabled: boolean;
  /** 带联系方式评论每日自动尝试上限（0..10 硬上限；尝试型：被拒/无目标也占额度）。 */
  contactCommentDailyCap: number;
  contentActiveMask: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
}

/** 面板 catalog 一行（LEFT JOIN accounts 补展示名 + 来源徽标 + configured）。 */
export interface ContentScheduleCatalogRow {
  accountId: string;
  label: string | null;
  nickname: string | null;
  autoEnabled: boolean;
  postEnabled: boolean;
  postDailyCap: number;
  commentEnabled: boolean;
  commentDailyCap: number;
  contactCommentEnabled: boolean;
  contactCommentDailyCap: number;
  /** 该账号是否已配联系方式（accounts.contact_info IS NOT NULL；带联系方式评论开关的前置徽标）。 */
  hasContactInfo: boolean;
  maskSource: 'override' | 'global';
  hasOverrideMask: boolean;
  /** 侧表有行（false = 纯默认 = 未配 = 不自动）。 */
  configured: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
}

/** 调度器每 tick 现读的生效排期（effectiveMask 已解析：override ?? global）。 */
export interface EffectiveContentSchedule {
  autoEnabled: boolean;
  postEnabled: boolean;
  postDailyCap: number;
  commentEnabled: boolean;
  commentDailyCap: number;
  contactCommentEnabled: boolean;
  contactCommentDailyCap: number;
  effectiveMask: string | null;
}

export interface ContentScheduleGlobalPatch {
  contentActiveMask?: string | null;
}

export interface AccountContentSchedulePatch {
  autoEnabled?: boolean;
  postEnabled?: boolean;
  postDailyCap?: number;
  commentEnabled?: boolean;
  commentDailyCap?: number;
  contactCommentEnabled?: boolean;
  contactCommentDailyCap?: number;
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
       * 开启自动带联系方式评论时该联系方式与其它账号共用（一码一号从「硬阻断」放松为「放行 + 提示」，
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
        | 'no_contact_info';
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
  content_active_mask TEXT,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by          TEXT
);
-- 自愈加列（change content-schedule-comments，迁移 0029 文档伴随）：Phase 2 评论动作两列，
-- 既有表靠幂等 ALTER 在 init() 补上；默认 false / 0 = 不自动（fail-closed，零回归）。
ALTER TABLE account_content_schedule ADD COLUMN IF NOT EXISTS comment_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE account_content_schedule ADD COLUMN IF NOT EXISTS comment_daily_cap INTEGER NOT NULL DEFAULT 0;
-- 自愈加列（change content-schedule-group-comments → generalize-contact-info，物理改名迁移 0036 文档伴随）：Phase 3 带联系方式评论两列，默认 false/0 = 不自动。
ALTER TABLE account_content_schedule ADD COLUMN IF NOT EXISTS contact_comment_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE account_content_schedule ADD COLUMN IF NOT EXISTS contact_comment_daily_cap INTEGER NOT NULL DEFAULT 0;
-- 带联系方式评论每日自动尝试台账（尝试型持久日上限：触发回执 ok 即记；重启不清零、绝不超发）。
CREATE TABLE IF NOT EXISTS contact_comment_attempts (
  id           BIGSERIAL PRIMARY KEY,
  account_id   TEXT NOT NULL,
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_contact_comment_attempts_account ON contact_comment_attempts (account_id, attempted_at);
`;

export interface ContentScheduleStoreOptions {
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  pool?: pg.Pool;
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
  post_daily_cap: number | string;
  comment_enabled: boolean;
  comment_daily_cap: number | string;
  contact_comment_enabled: boolean;
  contact_comment_daily_cap: number | string;
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

export class ContentScheduleStore {
  private readonly pool: pg.Pool;
  private globalCache: ContentScheduleGlobalRow | null = null;
  private readonly accountCache = new Map<string, AccountContentScheduleRow>();

  constructor(options: ContentScheduleStoreOptions = {}) {
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
    await this.pool.query(CONTENT_SCHEDULE_SCHEMA_SQL);
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
              content_active_mask, updated_at, updated_by
         FROM account_content_schedule`,
    );
    this.accountCache.clear();
    for (const r of a.rows) this.accountCache.set(r.account_id, this.accountFromDb(r));
  }

  private globalFromDb(r: GlobalDbRow): ContentScheduleGlobalRow {
    return {
      contentActiveMask: r.content_active_mask ?? null,
      updatedAt: toIso(r.updated_at),
      updatedBy: r.updated_by ?? null,
    };
  }

  private accountFromDb(r: AccountDbRow): AccountContentScheduleRow {
    return {
      accountId: r.account_id,
      autoEnabled: r.auto_enabled === true,
      postEnabled: r.post_enabled === true,
      postDailyCap: Number(r.post_daily_cap),
      commentEnabled: r.comment_enabled === true,
      commentDailyCap: Number(r.comment_daily_cap),
      contactCommentEnabled: r.contact_comment_enabled === true,
      contactCommentDailyCap: Number(r.contact_comment_daily_cap),
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
   * 调度器每 tick 现读的生效排期。无账号行 → 不自动（零回归）。
   * effectiveMask = 账号覆盖 ?? 全局（唯一解析点）；fail-closed 校验由调用方（调度器）用 isValidWeekActiveMask + isWeekActiveAt 做。
   */
  effectiveScheduleFor(accountId: string): EffectiveContentSchedule {
    const a = this.accountCache.get(accountId);
    if (!a)
      return {
        autoEnabled: false,
        postEnabled: false,
        postDailyCap: 0,
        commentEnabled: false,
        commentDailyCap: 0,
        contactCommentEnabled: false,
        contactCommentDailyCap: 0,
        effectiveMask: null,
      };
    return {
      autoEnabled: a.autoEnabled,
      postEnabled: a.postEnabled,
      postDailyCap: a.postDailyCap,
      commentEnabled: a.commentEnabled,
      commentDailyCap: a.commentDailyCap,
      contactCommentEnabled: a.contactCommentEnabled,
      contactCommentDailyCap: a.contactCommentDailyCap,
      effectiveMask: a.contentActiveMask ?? this.globalCache?.contentActiveMask ?? null,
    };
  }

  /**
   * 写全局内容格：掩码为 168 位 '0'/'1' 或 null（清空）；非法整块拒。写后 RETURNING 回读、刷镜像。
   */
  async setGlobal(patch: ContentScheduleGlobalPatch, updatedBy: string): Promise<SetContentGlobalResult> {
    if (!('contentActiveMask' in patch)) return { ok: false, reason: 'no_valid_fields' };
    if (!validMaskPatch(patch.contentActiveMask)) return { ok: false, reason: 'invalid_value' };
    const nextMask = patch.contentActiveMask ?? null;
    const { rows } = await this.pool.query<GlobalDbRow>(
      `INSERT INTO content_schedule_global (id, content_active_mask, updated_at, updated_by)
       VALUES (1, $1, now(), $2)
       ON CONFLICT (id) DO UPDATE SET content_active_mask = EXCLUDED.content_active_mask,
                                       updated_at = now(), updated_by = EXCLUDED.updated_by
       RETURNING content_active_mask, updated_at, updated_by`,
      [nextMask, updatedBy],
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
    if ('postDailyCap' in patch) {
      if (!validCap(patch.postDailyCap)) return { ok: false, reason: 'invalid_value' };
      hasField = true;
    }
    if ('commentEnabled' in patch) {
      if (typeof patch.commentEnabled !== 'boolean') return { ok: false, reason: 'invalid_value' };
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
    if ('contactCommentDailyCap' in patch) {
      // 带联系方式评论硬上限 0..10（协同 spam 敏感，区别于发帖/评论的 50）；越界整块拒。
      const v = patch.contactCommentDailyCap;
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > CONTACT_COMMENT_DAILY_CAP_MAX)
        return { ok: false, reason: 'invalid_value' };
      hasField = true;
    }
    if ('contentActiveMask' in patch) {
      if (!validMaskPatch(patch.contentActiveMask)) return { ok: false, reason: 'invalid_value' };
      hasField = true;
    }
    if (!hasField) return { ok: false, reason: 'no_valid_fields' };

    // 校验账号存在（防造幽灵行）——不为退役 / 不存在账号建排期行。
    const exists = await this.pool.query(`SELECT 1 FROM accounts WHERE account_id = $1`, [accountId]);
    if (exists.rows.length === 0) return { ok: false, reason: 'account_not_found' };

    // 开启自动带联系方式评论的联系方式闸（change content-schedule-group-comments；一码一号于 loosen-group-comment-shared-code
    // 从「硬阻断」放松为「放行 + 提示」）：每次 contactCommentEnabled=true 的写入都重跑。
    // 无联系方式 → no_contact_info 硬拒（没联系方式开开关无意义，提前拦；触发时缺联系方式 fail-closed 仍在，纵深）；
    // 联系方式与其它账号共用 → 不再硬拒，置 sharedContactInfoWarning 放行，防关联封号改由上层如实提示（绝不静默）。
    let sharedContactInfoWarning = false;
    if (patch.contactCommentEnabled === true) {
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
    const nextPost = patch.postEnabled ?? prev?.postEnabled ?? false;
    const nextCap = patch.postDailyCap ?? prev?.postDailyCap ?? 0;
    const nextCommentEnabled = patch.commentEnabled ?? prev?.commentEnabled ?? false;
    const nextCommentCap = patch.commentDailyCap ?? prev?.commentDailyCap ?? 0;
    const nextContactEnabled = patch.contactCommentEnabled ?? prev?.contactCommentEnabled ?? false;
    const nextContactCap = patch.contactCommentDailyCap ?? prev?.contactCommentDailyCap ?? 0;
    const nextMask =
      'contentActiveMask' in patch ? patch.contentActiveMask ?? null : prev?.contentActiveMask ?? null;

    const { rows } = await this.pool.query<AccountDbRow>(
      `INSERT INTO account_content_schedule
         (account_id, auto_enabled, post_enabled, post_daily_cap, comment_enabled, comment_daily_cap,
          contact_comment_enabled, contact_comment_daily_cap, content_active_mask, updated_at, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now(), $10)
       ON CONFLICT (account_id) DO UPDATE SET auto_enabled = EXCLUDED.auto_enabled,
                                              post_enabled = EXCLUDED.post_enabled,
                                              post_daily_cap = EXCLUDED.post_daily_cap,
                                              comment_enabled = EXCLUDED.comment_enabled,
                                              comment_daily_cap = EXCLUDED.comment_daily_cap,
                                              contact_comment_enabled = EXCLUDED.contact_comment_enabled,
                                              contact_comment_daily_cap = EXCLUDED.contact_comment_daily_cap,
                                              content_active_mask = EXCLUDED.content_active_mask,
                                              updated_at = now(), updated_by = EXCLUDED.updated_by
       RETURNING account_id, auto_enabled, post_enabled, post_daily_cap, comment_enabled, comment_daily_cap,
                 contact_comment_enabled, contact_comment_daily_cap, content_active_mask, updated_at, updated_by`,
      [accountId, nextAuto, nextPost, nextCap, nextCommentEnabled, nextCommentCap, nextContactEnabled, nextContactCap, nextMask, updatedBy],
    );
    const row = rows[0]
      ? this.accountFromDb(rows[0])
      : {
          accountId,
          autoEnabled: nextAuto,
          postEnabled: nextPost,
          postDailyCap: nextCap,
          commentEnabled: nextCommentEnabled,
          commentDailyCap: nextCommentCap,
          contactCommentEnabled: nextContactEnabled,
          contactCommentDailyCap: nextContactCap,
          contentActiveMask: nextMask,
          updatedAt: null,
          updatedBy,
        };
    this.accountCache.set(accountId, row);
    return sharedContactInfoWarning ? { ok: true, row, sharedContactInfoWarning: true } : { ok: true, row };
  }

  /**
   * 带联系方式评论每日自动尝试台账（change content-schedule-group-comments）：触发回执 ok（任务真开跑）即记。
   * 尝试型上限的保守方向——被人审拒 / 无强相关目标也占额度；持久、重启不清零、绝不超发。
   */
  async recordContactCommentAttempt(accountId: string): Promise<void> {
    await this.pool.query(`INSERT INTO contact_comment_attempts (account_id) VALUES ($1)`, [accountId]);
  }

  /** 该账号今日（Asia/Shanghai 自然日）带联系方式评论自动尝试数。 */
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
      label: string | null;
      nickname: string | null;
      auto_enabled: boolean | null;
      post_enabled: boolean | null;
      post_daily_cap: number | string | null;
      comment_enabled: boolean | null;
      comment_daily_cap: number | string | null;
      contact_comment_enabled: boolean | null;
      contact_comment_daily_cap: number | string | null;
      has_contact_info: boolean;
      content_active_mask: string | null;
      updated_at: Date | string | null;
      updated_by: string | null;
    }>(
      `SELECT a.account_id, a.label, a.nickname, (a.contact_info IS NOT NULL) AS has_contact_info,
              s.auto_enabled, s.post_enabled, s.post_daily_cap, s.comment_enabled, s.comment_daily_cap,
              s.contact_comment_enabled, s.contact_comment_daily_cap,
              s.content_active_mask, s.updated_at, s.updated_by
         FROM accounts a
         LEFT JOIN account_content_schedule s ON s.account_id = a.account_id
        WHERE a.account_id <> $1
        ORDER BY a.account_id`,
      [RETIRED_ACCOUNT_ID],
    );
    return rows.map((r) => {
      const configured = r.auto_enabled !== null;
      const hasOverrideMask = r.content_active_mask != null;
      return {
        accountId: r.account_id,
        label: r.label ?? null,
        nickname: r.nickname ?? null,
        autoEnabled: r.auto_enabled === true,
        postEnabled: r.post_enabled === true,
        postDailyCap: r.post_daily_cap == null ? 0 : Number(r.post_daily_cap),
        commentEnabled: r.comment_enabled === true,
        commentDailyCap: r.comment_daily_cap == null ? 0 : Number(r.comment_daily_cap),
        contactCommentEnabled: r.contact_comment_enabled === true,
        contactCommentDailyCap: r.contact_comment_daily_cap == null ? 0 : Number(r.contact_comment_daily_cap),
        hasContactInfo: r.has_contact_info === true,
        maskSource: hasOverrideMask ? 'override' : 'global',
        hasOverrideMask,
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
