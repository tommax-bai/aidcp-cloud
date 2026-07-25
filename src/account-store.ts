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
import { RETIRED_ACCOUNT_ID } from './kernel/account-identity.js';
import { DEFAULT_PG_CONFIG } from './kernel/pg-config.js';
import { writeWithMirrorBump, type MirrorVersionBumper } from './config/mirror-version-store.js';
import { normalizePlatformId, type PlatformId } from './platform/index.js';
import { parseDeploymentTarget, type DeploymentTarget } from './deployment-target.js';
import type { ClaimExecutionTargetResult } from './risk/ownership.js';
import {
  accountDisplayNameCandidates,
  resolveAccountDisplayName,
  type AccountDisplayName,
  type AccountDisplayNameInput,
} from './account-display-name.js';
import type { SchemaEnsurer } from './kernel/schema-capability-contract.js';
import type { AccountIdentityProjectionRow } from './kernel/account-projection-types.js';

const { Pool } = pg;

export type AccountStatusValue = 'active' | 'paused';

/**
 * retire-default-account：'default' 是被退役的保留账号标识，任何入口 MUST NOT 创建 / 接受它。
 * 真实账号一律是登录派生的小红书 userid（≥20 位字母数字，结构上不会等于 'default'）。
 */
// 退役保留账号哨兵 id 抬入 kernel（change decouple-longtail-sweep）供跨边界消费方直接比对；
// 本文件从 kernel 导入并等值再导出，令 api 侧既有消费方无感。
export { RETIRED_ACCOUNT_ID };

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
-- 自愈式加列（change risk-state-cross-process-integrity，迁移 0061）：账号归属的执行目标。
-- 语义 = 「该账号当前由哪个 target 的自动化驱动」，是风控写权谓词的**唯一权威**
-- （MUST NOT 在 risk_state 复制一份，两处必漂移）。服务端按本机部署配置注入，
-- MUST NOT 从客户端请求 / envKey / 自然语言 / 边缘上报推导。
-- **MUST NOT 回填默认值**：回填 'dev' 会把 ol 的生产账号静默划给 dev。NULL = 未归属，
-- 由首个在其上真实握手成功的 target 以条件写原子占位。
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS execution_target TEXT;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'accounts'::regclass
       AND conname = 'accounts_execution_target_check'
  ) THEN
    ALTER TABLE accounts
      ADD CONSTRAINT accounts_execution_target_check
      CHECK (execution_target IS NULL OR execution_target IN ('dev','ol'));
  END IF;
END $$;
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
  /**
   * 账号身份花名册（change automation-accounts-projection）：`account_id` / `platform` / `group_label`
   * 三列的**原样值**，供 automation 域刷新它自己的守卫投影（accounts 属 api 单写，automation
   * MUST NOT 直连本域的库）。
   *
   * ⚠️ 实现 MUST NOT 归一 / trim / 小写化 platform 与 group_label：消费方的守卫谓词是从原来内联
   * accounts 的 SQL 里逐字搬过去的，只有原样值才能保证语义等价。
   */
  listAccountIdentities?(): Promise<readonly AccountIdentityProjectionRow[]>;
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
  /** 读取账号平台，缺账号返 null（供跨 owner 读端口 AccountPlatformReader 区分 account_not_found 与 platform 不符）。 */
  getPlatformOrNull?(accountId: string): Promise<PlatformId | null>;
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
  /**
   * 读账号归属的执行目标（change risk-state-cross-process-integrity）：未归属 / 缺行 → null。
   * `accounts` 由本 store 单写（拆分方案 §5.1），automation 侧只经 AccountOwnershipPort 调用。
   */
  getExecutionTarget?(accountId: string): Promise<DeploymentTarget | null>;
  /**
   * 归属占位：**仅当归属为空**时原子写入，已被占位即返回真实属主，MUST NOT 覆盖。
   * 照抄内容排期小时格的条件 upsert 占位形态（content-schedule-store 的 `WHERE ... IS NULL`）。
   */
  claimExecutionTarget?(accountId: string, target: DeploymentTarget): Promise<ClaimExecutionTargetResult>;
  /**
   * 无条件把归属改写为指定 target（change risk-target-follows-active-session）：归属**跟随当次连接**，
   * 每次握手都调用它把 accounts.execution_target 更新为正在接入的 target。账号不存在 → account_not_found。
   */
  setExecutionTarget?(accountId: string, target: DeploymentTarget): Promise<ClaimExecutionTargetResult>;
  close?(): Promise<void>;
}

export interface PgAccountStoreOptions {
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  pool?: pg.Pool;
  /** schema 保障能力注入端口（必填、无默认）：组合根传 automation 的 ensureCapabilitySchema，本文件只从 kernel 取类型。 */
  schemaEnsurer: SchemaEnsurer;
  /**
   * 跨进程失效通道（change config-mirror-cross-process-invalidation task 2.4）：
   * 运营暂停态是**闸门镜像**——它决定是否继续对真实平台下发动作。暂停写入必须推进版本，
   * 否则「运营在 dev 后台点了暂停、后台回写入成功」而 ol 进程的镜像到重启前一直是 active，
   * 账号继续点赞。缺省 = 不推版本（行为逐位退回今日现状）。
   */
  mirrorVersionBumper?: MirrorVersionBumper;
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
  private readonly mirrorVersionBumper?: MirrorVersionBumper;
  /** 统一账号显示名目录：init 预热，昵称/运营别名写后同步更新。 */
  private readonly displayNameCache = new Map<string, AccountDisplayNameInput>();
  /** 账号平台缓存（init 预热 + getPlatform 回填）。accounts.platform 是事实源，缓存只做读路径加速。 */
  private readonly platformCache = new Map<string, PlatformId>();
  /** 账号入库时刻镜像（change account-level-slow-start）：init() 预热全表。
   *  **仅供 env 全局旁路 AIDCP_COLDSTART_RAMP 这条历史路径现读**；不参与慢启动起点。 */
  private readonly createdAtCache = new Map<string, number>();

  private readonly schemaEnsurer: SchemaEnsurer;

  constructor(options: PgAccountStoreOptions) {
    this.schemaEnsurer = options.schemaEnsurer;
    this.mirrorVersionBumper = options.mirrorVersionBumper;
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

  /** schema 探测（不建表） + seed default（幂等）+ 预热昵称同步缓存。 */
  async init(): Promise<void> {
    // DDL 单一所有者（change cloud-schema-migration-executor 任务 5.x）：只探测、不建表。
    // 探不到即带 version id 明确报错并 fail-closed；MUST NOT 在这里把表建出来继续跑。
    await this.schemaEnsurer(this.pool, {
      capability: 'accounts',
      sinceVersion: '0065_baseline_identity_tables',
      ddl: [ACCOUNTS_SCHEMA_SQL],
    });
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

  /**
   * 账号身份花名册（change automation-accounts-projection）：三列**原样**返回，不归一、不 trim。
   * 唯一消费方是 automation 域的守卫投影刷新器，经 kernel 端口 `AccountRosterSourcePort` 取。
   */
  async listAccountIdentities(): Promise<readonly AccountIdentityProjectionRow[]> {
    const { rows } = await this.pool.query<{
      account_id: string;
      platform: string | null;
      group_label: string | null;
    }>('SELECT account_id, platform, group_label FROM accounts');
    return rows.map((r) => ({
      accountId: r.account_id,
      // 库内 platform 是 NOT NULL DEFAULT，理论上不会是 NULL；真遇上也不猜平台，落空串让
      // 消费方的平台谓词自然判假（fail-closed），MUST NOT 在这里补一个默认平台。
      platform: r.platform ?? '',
      groupLabel: r.group_label ?? null,
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
    // 暂停/恢复与版本推进同事务：写库失败 → 回滚 → 版本不进（也不会有人据此刷镜像）。
    await writeWithMirrorBump(this.pool, this.mirrorVersionBumper, 'account_status', (q) =>
      q.query(
        `INSERT INTO accounts (account_id, label, status, paused_at)
       VALUES ($1, $1, $2, $3)
       ON CONFLICT (account_id) DO UPDATE SET status = EXCLUDED.status, paused_at = EXCLUDED.paused_at`,
        [accountId, status, pausedAt],
      ),
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
   * 账号平台，缺账号返 null（与 getPlatform 的「缺值回落 xiaohongshu」刻意不同）：作 AccountPlatformReader
   * 端口实现，让跨 owner 调用方区分「账号不存在」与「平台不符」。命中即回填平台缓存。
   */
  async getPlatformOrNull(accountId: string): Promise<PlatformId | null> {
    if (accountId === RETIRED_ACCOUNT_ID) return 'xiaohongshu';
    const cached = this.platformCache.get(accountId);
    if (cached) return cached;
    const { rows } = await this.pool.query<{ platform: string | null }>(
      `SELECT platform FROM accounts WHERE account_id = $1`,
      [accountId],
    );
    if (rows.length === 0) return null;
    const platform = normalizePlatformId(rows[0].platform);
    this.platformCache.set(accountId, platform);
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

  /**
   * 读账号归属 target（change risk-state-cross-process-integrity）：缺行 / 库内 NULL → null。
   * **不缓存**：归属是准入与写权的判据，陈旧一秒就可能让非属主多写一次 risk_state。
   * 调用频率是「每次握手一次 + 每次面板写口一次」，不是热路径。
   */
  async getExecutionTarget(accountId: string): Promise<DeploymentTarget | null> {
    const { rows } = await this.pool.query<{ execution_target: string | null }>(
      `SELECT execution_target FROM accounts WHERE account_id = $1`,
      [accountId],
    );
    if (rows.length === 0) return null;
    return parseDeploymentTarget(rows[0].execution_target);
  }

  /**
   * 归属占位：条件 UPDATE 原子写入，**仅当 execution_target IS NULL**。
   * - 写成功（1 行）→ claimed；
   * - 0 行且账号存在 → already_owned_by（回读真实属主，绝不覆盖）；
   * - 0 行且账号不存在 → account_not_found（**绝不 seed 造行**：归属是对既有账号的事实标注）。
   *
   * 并发占位（dev 与 ol 几乎同时握手）由行锁串行化，后到者命中 0 行 → 诚实观察到已被占位。
   */
  async claimExecutionTarget(
    accountId: string,
    target: DeploymentTarget,
  ): Promise<ClaimExecutionTargetResult> {
    if (accountId === RETIRED_ACCOUNT_ID) return { outcome: 'account_not_found' };
    const { rows } = await this.pool.query<{ execution_target: string | null }>(
      `UPDATE accounts SET execution_target = $2
        WHERE account_id = $1 AND execution_target IS NULL
        RETURNING execution_target`,
      [accountId, target],
    );
    if (rows.length > 0) return { outcome: 'claimed', target };
    const owner = await this.getExecutionTarget(accountId);
    if (owner) return { outcome: 'already_owned_by', target: owner };
    // 0 行 + 归属仍为空 ⇒ 账号行不存在（否则条件必然命中）。
    const { rowCount } = await this.pool.query(`SELECT 1 FROM accounts WHERE account_id = $1`, [accountId]);
    if ((rowCount ?? 0) === 0) return { outcome: 'account_not_found' };
    // 极罕见：并发把归属写成合法值又被清空。诚实报「未占到」而不是假装成功。
    return { outcome: 'account_not_found' };
  }

  /**
   * 无条件把归属改写为指定 target（change risk-target-follows-active-session）：握手路径每次调用它，
   * 让 accounts.execution_target 跟随当次连接。账号不存在 → account_not_found（不 seed 造行）。
   */
  async setExecutionTarget(accountId: string, target: DeploymentTarget): Promise<ClaimExecutionTargetResult> {
    if (accountId === RETIRED_ACCOUNT_ID) return { outcome: 'account_not_found' };
    const { rows } = await this.pool.query<{ execution_target: string | null }>(
      `UPDATE accounts SET execution_target = $2 WHERE account_id = $1 RETURNING execution_target`,
      [accountId, target],
    );
    if (rows.length === 0) return { outcome: 'account_not_found' };
    return { outcome: 'claimed', target };
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
