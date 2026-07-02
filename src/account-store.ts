/**
 * accounts 主表持久化（PostgreSQL，aidcp 库）。
 *
 * 多账号重构：用真 accounts 主表替换硬编码单账号。'default' 已退役为保留禁用标识
 * （change retire-default-account），不再 seed；账号父行改由真实账号握手时 ensureAccount 幂等登记产生。
 * 运营暂停态持久化于此（status/paused_at），重启后由 AccountStateManager 加载，
 * 故被暂停账号不会因内存丢失而静默复活。
 *
 * 与传输层 pausedEdges（验证码硬停）区分：这里是运营意图（durable），那里是验证码门控。
 */

import pg from 'pg';
import { DEFAULT_PG_CONFIG } from './cache/pg-anchor-cache.js';

const { Pool } = pg;

export type AccountStatusValue = 'active' | 'paused';

/**
 * retire-default-account：'default' 是被退役的保留账号标识，任何入口 MUST NOT 创建 / 接受它。
 * 真实账号一律是登录派生的小红书 userid（≥20 位字母数字，结构上不会等于 'default'）。
 */
export const RETIRED_ACCOUNT_ID = 'default';

/** accounts 建表（幂等：表已存在不重建）。retire-default-account 后不再 seed 任何占位行。 */
export const ACCOUNTS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS accounts (
  account_id    TEXT PRIMARY KEY,
  label         TEXT,
  platform      TEXT NOT NULL DEFAULT 'xiaohongshu',
  persona_ref   TEXT,
  quota_level   TEXT NOT NULL DEFAULT 'normal'
                CHECK (quota_level IN ('conservative','normal','aggressive')),
  status        TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('active','paused')),
  paused_at     TIMESTAMPTZ,
  machine_label TEXT,
  group_label   TEXT,
  nickname      TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- 自愈式加列（change account-real-nickname，迁移 0020 文档伴随）：本仓无迁移执行器，
-- 已存在的 accounts 表靠这条幂等 ALTER 在 init() 时补上 nickname 列（CREATE TABLE IF NOT EXISTS 不改既有表）。
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS nickname TEXT;
-- 自愈式加列（change account-group-chat-injection，迁移 0027 文档伴随）：每账号「关联群聊引流码」，
-- 供 /comment group:on 注入引流。verbatim 存储——写入不 trim / 不截断（见 setGroupChatInfo），与 nickname / group_label 刻意相反。
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS group_chat_info TEXT;
-- retire-default-account：不再 seed 'default' 占位行。账号父行由真实账号握手时 ensureAccount 幂等登记产生。
`;

export interface AccountRecord {
  accountId: string;
  status: AccountStatusValue;
  pausedAt: number | null;
}

/**
 * setGroupLabel 结果（change editable-account-group-label）：诚实可区分——
 * 成功回读真态；退役保留账号 / 无对应行以 ok:false + 具名 reason 返回，绝不静默成功。
 */
export type SetGroupLabelResult =
  | { ok: true; groupLabel: string | null }
  | { ok: false; reason: 'account_not_found' | 'retired_account' };

/**
 * setGroupChatInfo 结果（change account-group-chat-injection）：诚实可区分，同 setGroupLabel 形态——
 * 成功回读真态；退役保留账号 / 无对应行以 ok:false + 具名 reason 返回，绝不静默成功。
 */
export type SetGroupChatInfoResult =
  | { ok: true; groupChatInfo: string | null }
  | { ok: false; reason: 'account_not_found' | 'retired_account' };

/** AccountStateManager 依赖的最小存储接口（便于内存打桩、不依赖真 PG）。 */
export interface AccountStore {
  init?(): Promise<void>;
  /** 列出全部账号的暂停态（启动加载用）。 */
  listAll(): Promise<AccountRecord[]>;
  /** upsert 一个账号的暂停态（pause 未注册账号时自动建行）。 */
  setPaused(accountId: string, paused: boolean, at: number | null): Promise<void>;
  /**
   * 幂等登记一个账号（握手时新账号自动入主表，multi-account-node-support D4）。
   * 仅插入、绝不覆盖已配置行（不动既有 status/label/标签/绑定）。
   */
  ensureAccount?(accountId: string): Promise<void>;
  /**
   * 写入账号的平台真实昵称（change account-real-nickname）：单写，按 account_id upsert。
   * 实现拒空白（trim 为空即 no-op，绝不用空覆盖已有真名）；调用方只在拿到可证明属己的非空昵称时调。
   */
  setNickname?(accountId: string, nickname: string): Promise<void>;
  /**
   * 同步读账号昵称（change account-real-nickname）：读 init() 预热 + setNickname 写后更新的进程内缓存，
   * 返回 string|null（缺行/库内 NULL=null）。**同步**是为握手时同步算「需采集」判定、不留 await PG 的异步窗口
   * （否则在途 page.cards 会驱动 open_note 插进采集绕路，R3-MAJOR）。缺省 → 调用方按 null 处理。
   */
  getNickname?(accountId: string): string | null;
  /**
   * 写账号分组标签（change editable-account-group-label）：单写、UPDATE-only（**不 seed 造行**）。
   * trim 后空（空串 / 纯空白 / null）→ 写 NULL（清空分组）；退役保留账号与无对应行以可区分结果返回；
   * 写后经 RETURNING 回读真态。面板层只经此方法写，绝不 raw UPDATE。
   */
  setGroupLabel?(accountId: string, groupLabel: string | null): Promise<SetGroupLabelResult>;
  /**
   * 写账号「关联群聊引流码」（change account-group-chat-injection）：单写、UPDATE-only（**不 seed 造行**）。
   * **verbatim——不 trim、不设长度上限、保留 emoji / 换行 / 首尾空白**（与 setGroupLabel 的 trim+64 截断刻意相反）；
   * 空 / 纯空白 / null → 写 NULL（清空）；退役保留账号与无对应行以可区分结果返回；写后经 RETURNING 回读真态。
   * 面板层只经此方法写，绝不 raw UPDATE。
   */
  setGroupChatInfo?(accountId: string, groupChatInfo: string | null): Promise<SetGroupChatInfoResult>;
  /**
   * 读账号「关联群聊引流码」（change account-group-chat-injection）：异步直读 PG，返回 verbatim 值 / null。
   * 供 /comment 任务开始处解析一次（人工触发的低频路径，可 await PG，无需同步缓存）。缺行 / 库内 NULL → null。
   */
  getGroupChatInfo?(accountId: string): Promise<string | null>;
  close?(): Promise<void>;
}

export interface PgAccountStoreOptions {
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  pool?: pg.Pool;
}

interface AccountRow {
  account_id: string;
  status: string;
  paused_at: Date | null;
}

/** accounts 主表持久化（PostgreSQL）。 */
export class PgAccountStore implements AccountStore {
  private readonly pool: pg.Pool;
  /** 账号昵称的进程内同步缓存（change account-real-nickname）：init() 预热全表 + setNickname 写后更新。
   *  供握手同步算「需采集」判定，避免 await PG 的异步窗口；缺键=未知 → getNickname 返回 null。 */
  private readonly nicknameCache = new Map<string, string | null>();

  constructor(options: PgAccountStoreOptions = {}) {
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

  /** 建表 + seed default（幂等）+ 预热昵称同步缓存。 */
  async init(): Promise<void> {
    await this.pool.query(ACCOUNTS_SCHEMA_SQL);
    // 预热昵称缓存（change account-real-nickname）：供握手同步读，避免每次握手 await PG。
    const { rows } = await this.pool.query<{ account_id: string; nickname: string | null }>(
      'SELECT account_id, nickname FROM accounts',
    );
    for (const r of rows) this.nicknameCache.set(r.account_id, r.nickname ?? null);
  }

  async listAll(): Promise<AccountRecord[]> {
    const { rows } = await this.pool.query<AccountRow>(
      'SELECT account_id, status, paused_at FROM accounts',
    );
    return rows.map((r) => ({
      accountId: r.account_id,
      status: r.status === 'paused' ? 'paused' : 'active',
      pausedAt: r.paused_at ? r.paused_at.getTime() : null,
    }));
  }

  async setPaused(accountId: string, paused: boolean, at: number | null): Promise<void> {
    // retire-default-account：退役保留标识无对应账号，绝不为其建 / 改行。
    if (accountId === RETIRED_ACCOUNT_ID) {
      console.warn(`[account-store] 忽略对退役保留账号 '${RETIRED_ACCOUNT_ID}' 的 setPaused（retire-default-account）`);
      return;
    }
    const status: AccountStatusValue = paused ? 'paused' : 'active';
    const pausedAt = paused && at ? new Date(at) : null;
    await this.pool.query(
      `INSERT INTO accounts (account_id, label, status, paused_at)
       VALUES ($1, $1, $2, $3)
       ON CONFLICT (account_id) DO UPDATE SET status = EXCLUDED.status, paused_at = EXCLUDED.paused_at`,
      [accountId, status, pausedAt],
    );
  }

  /**
   * 幂等登记账号（握手时新账号自动入主表）：INSERT ... ON CONFLICT DO NOTHING。
   * 仅插入、**绝不覆盖**已配置行（不动既有 status/label/paused_at/标签）。新行 status 取 DB 默认
   * （active=「未被运营暂停」这一运营维度）；账号是否就绪由**人设绑定派生字段**（persona_config 行是否存在）
   * 独立判定——未绑人设的账号仍被诚实启动闸拦住、不会真跑（multi-account-node-support D3/D4）。
   */
  async ensureAccount(accountId: string): Promise<void> {
    // retire-default-account：绝不为退役保留标识建行（防任何路径把 'default' 重新登记进主表）。
    if (accountId === RETIRED_ACCOUNT_ID) {
      console.warn(`[account-store] 拒绝登记退役保留账号 '${RETIRED_ACCOUNT_ID}'（retire-default-account）`);
      return;
    }
    await this.pool.query(
      `INSERT INTO accounts (account_id, label) VALUES ($1, $1) ON CONFLICT (account_id) DO NOTHING`,
      [accountId],
    );
  }

  /**
   * 写入登录账号的平台真实昵称（change account-real-nickname）：单写、自愈 upsert。
   * 拒空白（绝不用空覆盖已有真名）；防御性长度上限（小红书昵称远短于此，防异常拼接污染）。
   * 行不存在时连带 seed（label=account_id），与 ensureAccount/setPaused 同款兜底。
   */
  async setNickname(accountId: string, nickname: string): Promise<void> {
    // retire-default-account：退役保留标识无对应账号，绝不为其建 / 改行。
    if (accountId === RETIRED_ACCOUNT_ID) return;
    const clean = nickname.trim();
    if (!clean) return;
    const value = clean.length > 64 ? clean.slice(0, 64) : clean;
    await this.pool.query(
      `INSERT INTO accounts (account_id, label, nickname) VALUES ($1, $1, $2)
       ON CONFLICT (account_id) DO UPDATE SET nickname = EXCLUDED.nickname`,
      [accountId, value],
    );
    // 更新同步缓存：写后再握手（重连）即读到非空 → 不再重绕（幂等）。
    this.nicknameCache.set(accountId, value);
  }

  /**
   * 同步读昵称（change account-real-nickname）：读 init() 预热 + setNickname 更新的进程内缓存。
   * 缺键（未预热到 / 新账号）或库内 NULL → 返回 null（= 「需采集」）。绝不 await PG（握手同步算门用）。
   */
  getNickname(accountId: string): string | null {
    return this.nicknameCache.get(accountId) ?? null;
  }

  /**
   * 写账号分组标签（change editable-account-group-label）：单写、UPDATE-only + RETURNING。
   * - 退役保留账号 `default` 直接拒（不落库、不静默成功）；
   * - trim 后空 → 写 NULL（清空分组），MUST NOT 存纯空白脏值；防御性长度上限（防异常拼接污染）；
   * - 无对应行（0 rows）→ 返回 account_not_found，**绝不 seed 造幽灵行**（区别于 setNickname 的握手竞态 upsert）；
   * - 返回 RETURNING 回读的真值（写后真态，绝不乐观 ok）。
   */
  async setGroupLabel(accountId: string, groupLabel: string | null): Promise<SetGroupLabelResult> {
    if (accountId === RETIRED_ACCOUNT_ID) return { ok: false, reason: 'retired_account' };
    const clean = (groupLabel ?? '').trim();
    const value = clean === '' ? null : clean.length > 64 ? clean.slice(0, 64) : clean;
    const { rows } = await this.pool.query<{ group_label: string | null }>(
      `UPDATE accounts SET group_label = $2 WHERE account_id = $1 RETURNING group_label`,
      [accountId, value],
    );
    if (rows.length === 0) return { ok: false, reason: 'account_not_found' };
    return { ok: true, groupLabel: rows[0].group_label };
  }

  /**
   * 写「关联群聊引流码」（change account-group-chat-injection）：单写、UPDATE-only + RETURNING。
   * - 退役保留账号 `default` 直接拒（不落库、不静默成功）；
   * - **verbatim**：仅用 trim 判空以决定「清空 vs 设值」，非空则**原样存**（不 trim 内容、不截断，保留 emoji / 换行 / 首尾空白）；
   * - 空 / 纯空白 / null → 写 NULL（清空）；
   * - 无对应行（0 rows）→ account_not_found，**绝不 seed 造幽灵行**；
   * - 返回 RETURNING 回读的真值（写后真态，绝不乐观 ok）。
   */
  async setGroupChatInfo(
    accountId: string,
    groupChatInfo: string | null,
  ): Promise<SetGroupChatInfoResult> {
    if (accountId === RETIRED_ACCOUNT_ID) return { ok: false, reason: 'retired_account' };
    const raw = groupChatInfo ?? '';
    // verbatim：仅判空决定清空，非空原样存（含首尾空白 / emoji / 换行），绝不 trim 内容 / 截断。
    const value = raw.trim() === '' ? null : raw;
    const { rows } = await this.pool.query<{ group_chat_info: string | null }>(
      `UPDATE accounts SET group_chat_info = $2 WHERE account_id = $1 RETURNING group_chat_info`,
      [accountId, value],
    );
    if (rows.length === 0) return { ok: false, reason: 'account_not_found' };
    return { ok: true, groupChatInfo: rows[0].group_chat_info };
  }

  /**
   * 读「关联群聊引流码」（change account-group-chat-injection）：异步直读，返回 verbatim 值 / null。
   * /comment 任务开始处解析一次（低频人工路径，可 await PG）。缺行 / 库内 NULL → null。
   */
  async getGroupChatInfo(accountId: string): Promise<string | null> {
    const { rows } = await this.pool.query<{ group_chat_info: string | null }>(
      `SELECT group_chat_info FROM accounts WHERE account_id = $1`,
      [accountId],
    );
    return rows.length > 0 ? rows[0].group_chat_info ?? null : null;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
