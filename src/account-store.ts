/**
 * accounts 主表持久化（PostgreSQL，aidcp 库）。
 *
 * 多账号重构第一步：用真 accounts 主表替换硬编码单账号；seed 一个 account_id='default' 行
 * 对齐风控/会话的现有字面量，使已按账号 keyed 的表（risk_state 等）有父行。
 * 运营暂停态持久化于此（status/paused_at），重启后由 AccountStateManager 加载，
 * 故被暂停账号不会因内存丢失而静默复活。
 *
 * 与传输层 pausedEdges（验证码硬停）区分：这里是运营意图（durable），那里是验证码门控。
 */

import pg from 'pg';
import { DEFAULT_PG_CONFIG } from './cache/pg-anchor-cache.js';

const { Pool } = pg;

export type AccountStatusValue = 'active' | 'paused';

/** accounts 建表 + seed 默认账号（幂等：表已存在不重建、default 行已存在不重复插）。 */
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
INSERT INTO accounts (account_id, label) VALUES ('default', 'default')
ON CONFLICT (account_id) DO NOTHING;
`;

export interface AccountRecord {
  accountId: string;
  status: AccountStatusValue;
  pausedAt: number | null;
}

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

  /** 建表 + seed default（幂等）。 */
  async init(): Promise<void> {
    await this.pool.query(ACCOUNTS_SCHEMA_SQL);
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
    const clean = nickname.trim();
    if (!clean) return;
    const value = clean.length > 64 ? clean.slice(0, 64) : clean;
    await this.pool.query(
      `INSERT INTO accounts (account_id, label, nickname) VALUES ($1, $1, $2)
       ON CONFLICT (account_id) DO UPDATE SET nickname = EXCLUDED.nickname`,
      [accountId, value],
    );
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
