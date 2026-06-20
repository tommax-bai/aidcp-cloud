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
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
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

  async close(): Promise<void> {
    await this.pool.end();
  }
}
