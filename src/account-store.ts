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
import { normalizePlatformId, type PlatformId } from './platform/index.js';
import {
  accountDisplayNameCandidates,
  resolveAccountDisplayName,
  type AccountDisplayName,
  type AccountDisplayNameInput,
} from './account-display-name.js';

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
  operator_alias TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- 自愈式加列（change account-real-nickname，迁移 0020 文档伴随）：本仓无迁移执行器，
-- 已存在的 accounts 表靠这条幂等 ALTER 在 init() 时补上 nickname 列（CREATE TABLE IF NOT EXISTS 不改既有表）。
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS nickname TEXT;
-- 账号级运营别名（change unified-account-display-name）：与平台 nickname 物理分离，空值为 NULL。
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS operator_alias TEXT;
-- 自愈式加列（change platform-abstraction-layer）：accounts.platform 是运行时平台事实源。
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS platform TEXT NOT NULL DEFAULT 'xiaohongshu';
-- 自愈式加列（change account-group-chat-injection → generalize-contact-info，物理改名迁移 0036）：每账号「联系方式」，
-- 供 /comment --contact 注入。verbatim 存储——写入不 trim / 不截断（见 setContactInfo），与 nickname / group_label 刻意相反。
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS contact_info TEXT;
-- 旧账号级慢启动列：environment-level-slow-start 后仅保留一次性迁移与代码回滚数据，不再参与运行时读写。
-- NULL = 关（默认）；非 NULL = 开，且该时刻即爬坡第 1 天的起点（写入时已对齐上海日起点）。
-- 一列同时表达开关 / 起点 / 三态 → 结构上不可能出现 enabled=true && since=NULL 这种非法组合。
-- MUST NOT 用 created_at 当起点：那是「第一次连上本云端库」，cookie 导入的三年老号会被算「第 1 天」。
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS slow_start_since TIMESTAMPTZ;
-- retire-default-account：不再 seed 'default' 占位行。账号父行由真实账号握手时 ensureAccount 幂等登记产生。
`;

export interface AccountRecord {
  accountId: string;
  status: AccountStatusValue;
  pausedAt: number | null;
}

export interface PlatformAccountRecord extends AccountRecord {
  platform: PlatformId;
}

/**
 * setGroupLabel 结果（change editable-account-group-label）：诚实可区分——
 * 成功回读真态；退役保留账号 / 无对应行以 ok:false + 具名 reason 返回，绝不静默成功。
 */
export type SetGroupLabelResult =
  | { ok: true; groupLabel: string | null }
  | { ok: false; reason: 'account_not_found' | 'retired_account' };

/**
 * setContactInfo 结果（change account-group-chat-injection → generalize-contact-info）：诚实可区分，同 setGroupLabel 形态——
 * 成功回读真态；退役保留账号 / 无对应行以 ok:false + 具名 reason 返回，绝不静默成功。
 */
export type SetContactInfoResult =
  | { ok: true; contactInfo: string | null }
  | { ok: false; reason: 'account_not_found' | 'retired_account' };

export type SetOperatorAliasResult =
  | { ok: true; operatorAlias: string | null; display: AccountDisplayName }
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
   * 仅插入、绝不覆盖已配置行（不动既有 status/label/标签/绑定/platform）。
   * platform（facebook-scheduled-comment 2.5）：仅在插入新行时写入 edge 声明的平台，
   * 修复全新 Facebook 账号首连被 platform_mismatch 死锁的问题；既有行的 platform 保持事实源不变。
   */
  ensureAccount?(accountId: string, platform?: PlatformId): Promise<void>;
  /**
   * 写入账号的平台真实昵称（change account-real-nickname）：单写，按 account_id upsert。
   * 实现拒空白（trim 为空即 no-op，绝不用空覆盖已有真名）；调用方只在拿到可证明属己的非空昵称时调。
   */
  setNickname?(accountId: string, nickname: string): Promise<void>;
  /**
   * 同步读账号昵称（change account-real-nickname）：读 init() 预热 + setNickname 写后更新的进程内缓存，
   * 返回 string|null（缺行/库内 NULL=null）。**同步**是为采集收尾做差异写库判定，
   * 不让 PG await 阻塞回 feed。缺省 → 调用方按 null 处理。
   */
  getNickname?(accountId: string): string | null;
  /** 设置/清除账号级运营别名；UPDATE-only，成功后同步刷新显示名目录。 */
  setOperatorAlias?(accountId: string, alias: string | null): Promise<SetOperatorAliasResult>;
  /** 同步读取统一显示名与来源。 */
  getDisplayName?(accountId: string): AccountDisplayName;
  /** 同步读取人工选号可接受的别名/平台昵称/运营标签候选，不含 accountId。 */
  getDisplayNameCandidates?(accountId: string): string[];
  /**
   * 写账号分组标签（change editable-account-group-label）：单写、UPDATE-only（**不 seed 造行**）。
   * trim 后空（空串 / 纯空白 / null）→ 写 NULL（清空分组）；退役保留账号与无对应行以可区分结果返回；
   * 写后经 RETURNING 回读真态。面板层只经此方法写，绝不 raw UPDATE。
   */
  setGroupLabel?(accountId: string, groupLabel: string | null): Promise<SetGroupLabelResult>;
  /**
   * 写账号「联系方式」（change account-group-chat-injection → generalize-contact-info）：单写、UPDATE-only（**不 seed 造行**）。
   * **verbatim——不 trim、不设长度上限、保留 emoji / 换行 / 首尾空白**（与 setGroupLabel 的 trim+64 截断刻意相反）；
   * 空 / 纯空白 / null → 写 NULL（清空）；退役保留账号与无对应行以可区分结果返回；写后经 RETURNING 回读真态。
   * 面板层只经此方法写，绝不 raw UPDATE。
   */
  setContactInfo?(accountId: string, contactInfo: string | null): Promise<SetContactInfoResult>;
  /**
   * 读账号「联系方式」（change account-group-chat-injection → generalize-contact-info）：异步直读 PG，返回 verbatim 值 / null。
   * 供 /comment 任务开始处解析一次（人工触发的低频路径，可 await PG，无需同步缓存）。缺行 / 库内 NULL → null。
   */
  getContactInfo?(accountId: string): Promise<string | null>;
  /**
   * 读账号分组标签 `group_label`（change feishu-per-team-notification-routing）：异步直读 PG，返回值 / null。
   * 供出站按团队路由（账号 → group_label → 目标群）解析一次。缺行 / 库内 NULL → null；读失败由调用方按「无团队路由」兜底（落默认群），绝不当致命错误。
   */
  getGroupLabel?(accountId: string): Promise<string | null>;
  /** 读取账号平台；缺省/旧数据按 xiaohongshu 归一。 */
  getPlatform?(accountId: string): Promise<PlatformId>;
  /** 按平台枚举账号；返回状态字段，调用方可据 active/paused 做调度闸。 */
  listByPlatform?(platform: PlatformId): Promise<PlatformAccountRecord[]>;
  /**
   * 同步读账号平台（change account-level-slow-start）：读 init() 预热 + getPlatform 回填的镜像。
   * **缺键 → undefined（未知），MUST NOT 回落 xiaohongshu**——回落会让 FB 号按小红书曲线跑
   * （D1 view=50 而非 20，差 2.5 倍）。调用方据 undefined 判 eligible=false、不 clamp（见 design D5）。
   * 同步、零 IO、永不抛。
   */
  platformFor?(accountId: string): PlatformId | undefined;
  /**
   * 同步读账号入库时刻（change account-level-slow-start）：**仅供 env 全局旁路
   * `AIDCP_COLDSTART_RAMP=true` 这条历史路径**现读，且仅在账号级未开启时才被查询。
   * MUST NOT 用作慢启动起点（它是「第一次连上本云端库」，不是平台注册时间）。同步、零 IO、永不抛。
   */
  createdAtFor?(accountId: string): number | undefined;
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

interface AccountPlatformRow extends AccountRow {
  platform: string | null;
}

/** accounts 主表持久化（PostgreSQL）。 */
export class PgAccountStore implements AccountStore {
  private readonly pool: pg.Pool;
  /** 统一账号显示名目录：init 预热，昵称/运营别名写后同步更新。 */
  private readonly displayNameCache = new Map<string, AccountDisplayNameInput>();
  /** 账号平台缓存（init 预热 + getPlatform 回填）。accounts.platform 是事实源，缓存只做读路径加速。 */
  private readonly platformCache = new Map<string, PlatformId>();
  /** 账号入库时刻镜像（change account-level-slow-start）：init() 预热全表。
   *  **仅供 env 全局旁路 AIDCP_COLDSTART_RAMP 这条历史路径现读**；不参与慢启动起点。 */
  private readonly createdAtCache = new Map<string, number>();

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
    const { rows } = await this.pool.query<{
      account_id: string;
      nickname: string | null;
      operator_alias: string | null;
      label: string | null;
      platform: string | null;
      created_at: Date | null;
    }>('SELECT account_id, nickname, operator_alias, label, platform, created_at FROM accounts');
    for (const r of rows) {
      this.displayNameCache.set(r.account_id, {
        accountId: r.account_id,
        operatorAlias: r.operator_alias ?? null,
        nickname: r.nickname ?? null,
        label: r.label ?? null,
      });
      this.platformCache.set(r.account_id, normalizePlatformId(r.platform));
      if (r.created_at) this.createdAtCache.set(r.account_id, r.created_at.getTime());
    }
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
  async ensureAccount(accountId: string, platform?: PlatformId): Promise<void> {
    // retire-default-account：绝不为退役保留标识建行（防任何路径把 'default' 重新登记进主表）。
    if (accountId === RETIRED_ACCOUNT_ID) {
      console.warn(`[account-store] 拒绝登记退役保留账号 '${RETIRED_ACCOUNT_ID}'（retire-default-account）`);
      return;
    }
    // facebook-scheduled-comment 2.5：新账号登记时按 edge 声明的平台建行（缺省回落 xhs，行为不变）。
    // ON CONFLICT DO NOTHING → 既有行的 platform 绝不被覆盖（平台仍以现有行为事实源）。
    // RETURNING 判定是否真插入了新行：仅新行才回填 platformCache（既有行不触碰缓存，防污染）。
    // account-level-slow-start：同批回填 createdAtCache。风控的 env 全局旁路（AIDCP_COLDSTART_RAMP）
    // 已从「建 controller 时 await PG 读 created_at」改为经 provider 现读内存镜像；本进程 init() 之后
    // 新登记的账号若不在此回填，该旁路会对它静默失效（默认关，但那是回滚拉杆，不能悄悄少一半）。
    const normalized = platform ? normalizePlatformId(platform) : 'xiaohongshu';
    const { rows } = await this.pool.query<{
      platform: string;
      created_at: Date | null;
      label: string | null;
      nickname: string | null;
      operator_alias: string | null;
    }>(
      `INSERT INTO accounts (account_id, label, platform) VALUES ($1, $1, $2)
       ON CONFLICT (account_id) DO NOTHING RETURNING platform, created_at, label, nickname, operator_alias`,
      [accountId, normalized],
    );
    if (rows.length > 0) {
      this.displayNameCache.set(accountId, {
        accountId,
        operatorAlias: rows[0].operator_alias ?? null,
        nickname: rows[0].nickname ?? null,
        label: rows[0].label ?? accountId,
      });
      this.platformCache.set(accountId, normalizePlatformId(rows[0].platform));
      if (rows[0].created_at) this.createdAtCache.set(accountId, rows[0].created_at.getTime());
    }
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
    // 更新同步缓存：后续握手 / UI 立即读到最新展示名；XHS 启动仍会继续检测平台昵称变化。
    const previous = this.displayNameCache.get(accountId);
    this.displayNameCache.set(accountId, {
      accountId,
      operatorAlias: previous?.operatorAlias ?? null,
      nickname: value,
      label: previous?.label ?? accountId,
    });
  }

  /**
   * 同步读昵称（change account-real-nickname）：读 init() 预热 + setNickname 更新的进程内缓存。
   * 缺键（未预热到 / 新账号）或库内 NULL → 返回 null（= 「需采集」）。绝不 await PG（握手同步算门用）。
   */
  getNickname(accountId: string): string | null {
    return this.displayNameCache.get(accountId)?.nickname?.trim() || null;
  }

  async setOperatorAlias(accountId: string, alias: string | null): Promise<SetOperatorAliasResult> {
    if (accountId === RETIRED_ACCOUNT_ID) return { ok: false, reason: 'retired_account' };
    const clean = (alias ?? '').trim();
    const value = clean ? clean.slice(0, 80) : null;
    const { rows } = await this.pool.query<{
      operator_alias: string | null;
      nickname: string | null;
      label: string | null;
    }>(
      `UPDATE accounts SET operator_alias = $2 WHERE account_id = $1
       RETURNING operator_alias, nickname, label`,
      [accountId, value],
    );
    if (rows.length === 0) return { ok: false, reason: 'account_not_found' };
    const record: AccountDisplayNameInput = {
      accountId,
      operatorAlias: rows[0].operator_alias ?? null,
      nickname: rows[0].nickname ?? null,
      label: rows[0].label ?? null,
    };
    this.displayNameCache.set(accountId, record);
    return { ok: true, operatorAlias: record.operatorAlias ?? null, display: resolveAccountDisplayName(record) };
  }

  getDisplayName(accountId: string): AccountDisplayName {
    return resolveAccountDisplayName(this.displayNameCache.get(accountId) ?? { accountId });
  }

  getDisplayNameCandidates(accountId: string): string[] {
    return accountDisplayNameCandidates(this.displayNameCache.get(accountId) ?? { accountId });
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
   * 写「联系方式」（change account-group-chat-injection → generalize-contact-info）：单写、UPDATE-only + RETURNING。
   * - 退役保留账号 `default` 直接拒（不落库、不静默成功）；
   * - **verbatim**：仅用 trim 判空以决定「清空 vs 设值」，非空则**原样存**（不 trim 内容、不截断，保留 emoji / 换行 / 首尾空白）；
   * - 空 / 纯空白 / null → 写 NULL（清空）；
   * - 无对应行（0 rows）→ account_not_found，**绝不 seed 造幽灵行**；
   * - 返回 RETURNING 回读的真值（写后真态，绝不乐观 ok）。
   */
  async setContactInfo(
    accountId: string,
    contactInfo: string | null,
  ): Promise<SetContactInfoResult> {
    if (accountId === RETIRED_ACCOUNT_ID) return { ok: false, reason: 'retired_account' };
    const raw = contactInfo ?? '';
    // verbatim：仅判空决定清空，非空原样存（含首尾空白 / emoji / 换行），绝不 trim 内容 / 截断。
    const value = raw.trim() === '' ? null : raw;
    const { rows } = await this.pool.query<{ contact_info: string | null }>(
      `UPDATE accounts SET contact_info = $2 WHERE account_id = $1 RETURNING contact_info`,
      [accountId, value],
    );
    if (rows.length === 0) return { ok: false, reason: 'account_not_found' };
    return { ok: true, contactInfo: rows[0].contact_info };
  }

  /**
   * 读「联系方式」（change account-group-chat-injection → generalize-contact-info）：异步直读，返回 verbatim 值 / null。
   * /comment 任务开始处解析一次（低频人工路径，可 await PG）。缺行 / 库内 NULL → null。
   */
  async getContactInfo(accountId: string): Promise<string | null> {
    const { rows } = await this.pool.query<{ contact_info: string | null }>(
      `SELECT contact_info FROM accounts WHERE account_id = $1`,
      [accountId],
    );
    return rows.length > 0 ? rows[0].contact_info ?? null : null;
  }

  /**
   * 读账号分组标签（change feishu-per-team-notification-routing）：异步直读，返回值 / null。
   * 缺行 / 库内 NULL → null。出站路由解析用（低频，可 await PG）；读异常向上抛，由解析器 try/catch 落默认群。
   */
  async getGroupLabel(accountId: string): Promise<string | null> {
    const { rows } = await this.pool.query<{ group_label: string | null }>(
      `SELECT group_label FROM accounts WHERE account_id = $1`,
      [accountId],
    );
    return rows.length > 0 ? rows[0].group_label ?? null : null;
  }

  async getPlatform(accountId: string): Promise<PlatformId> {
    if (accountId === RETIRED_ACCOUNT_ID) return 'xiaohongshu';
    const cached = this.platformCache.get(accountId);
    if (cached) return cached;
    const { rows } = await this.pool.query<{ platform: string | null }>(
      `SELECT platform FROM accounts WHERE account_id = $1`,
      [accountId],
    );
    const platform = normalizePlatformId(rows[0]?.platform);
    if (rows.length > 0) this.platformCache.set(accountId, platform);
    return platform;
  }

  /**
   * 同步读账号平台（见 AccountStore.platformFor 契约）：**缺键 → undefined（未知），绝不回落 xiaohongshu**。
   * 与 getPlatform 刻意不同：那条是异步读库 + normalizePlatformId 归一（缺值回落小红书），
   * 这条服务于冷启动曲线选择——回落一次就是 FB 号按小红书曲线跑（D1 view=50 而非 20）。
   */
  platformFor(accountId: string): PlatformId | undefined {
    return this.platformCache.get(accountId);
  }

  /** 同步读账号入库时刻（见 AccountNurtureProvider.createdAtFor 契约）：仅供 env 旁路，缺键 → undefined。 */
  createdAtFor(accountId: string): number | undefined {
    return this.createdAtCache.get(accountId);
  }

  // getNurtureMeta 已删（change account-level-slow-start，task 2.3）：它是构造期 async 解析一次的
  // 养号元数据读，唯一消费者是 registry 的 nurtureMetaResolver；后者已被同步 provider 现读取代。
  // 保留它 = 同一事实两个源（一个现读镜像、一个读库快照），迟早漂移，故删而不留。

  async listByPlatform(platform: PlatformId): Promise<PlatformAccountRecord[]> {
    const normalized = normalizePlatformId(platform);
    const { rows } = await this.pool.query<AccountPlatformRow>(
      `SELECT account_id, status, paused_at, platform FROM accounts WHERE platform = $1 ORDER BY account_id`,
      [normalized],
    );
    return rows.map((r) => ({
      accountId: r.account_id,
      status: r.status === 'paused' ? 'paused' : 'active',
      pausedAt: r.paused_at ? r.paused_at.getTime() : null,
      platform: normalizePlatformId(r.platform),
    }));
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
