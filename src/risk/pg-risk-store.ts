import pg from 'pg';
import { DEFAULT_PG_CONFIG } from '../cache/index.js';
import type {
  CounterEvent,
  InteractionAction,
  InteractionStore,
  RiskAction,
  RiskQuotaLevel,
  RiskState,
  RiskStatus,
  RiskStore,
} from './types.js';

const { Pool } = pg;

export interface PgRiskStoreOptions {
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  pool?: pg.Pool;
}

export const RISK_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS risk_counters (
  id          BIGSERIAL PRIMARY KEY,
  account_id  TEXT NOT NULL,
  action      TEXT NOT NULL CHECK (action IN ('like','collect','comment','follow','publish','view','comment_like')),
  count       INTEGER NOT NULL DEFAULT 1,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_risk_counters_account_time ON risk_counters (account_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_risk_counters_account_action_time ON risk_counters (account_id, action, occurred_at DESC);
-- 面板今日聚合（todayTotals / todayTotalsByAccount / likeRate）不带 account 前缀、只按 occurred_at 过滤；
-- 上面两个 account 打头的复合索引服务不了纯时间范围扫描 → 补 occurred_at 打头索引消灭全表扫描（change console-cloud-panel-hardening #21）。
CREATE INDEX IF NOT EXISTS idx_risk_counters_time ON risk_counters (occurred_at DESC);

CREATE TABLE IF NOT EXISTS risk_state (
  account_id     TEXT PRIMARY KEY,
  status         TEXT NOT NULL CHECK (status IN ('normal','warned','restricted','frozen')),
  quota_level    TEXT NOT NULL CHECK (quota_level IN ('conservative','normal','aggressive')),
  signal_count   INTEGER NOT NULL DEFAULT 0,
  last_signal_at TIMESTAMPTZ,
  status_since   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS risk_interactions (
  account_id    TEXT NOT NULL,
  note_id       TEXT NOT NULL,
  action        TEXT NOT NULL CHECK (action IN ('like','collect','comment')),
  interacted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, note_id, action)
);

CREATE INDEX IF NOT EXISTS idx_risk_interactions_account_time ON risk_interactions (account_id, interacted_at DESC);

-- 幂等迁移：已存在的 risk_counters 表（CREATE TABLE IF NOT EXISTS 不会改其旧 CHECK）需放行 'comment_like'。
-- 仅当现有 CHECK 还不含 comment_like 时才 DROP+ADD（一次性），避免每次启动重校验整表。
-- 注意：只动 risk_counters（配额计数）；risk_interactions（每笔记去重）刻意不含 comment_like。
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'risk_counters'::regclass
      AND conname = 'risk_counters_action_check'
      AND pg_get_constraintdef(oid) LIKE '%comment_like%'
  ) THEN
    ALTER TABLE risk_counters DROP CONSTRAINT IF EXISTS risk_counters_action_check;
    ALTER TABLE risk_counters ADD CONSTRAINT risk_counters_action_check
      CHECK (action IN ('like','collect','comment','follow','publish','view','comment_like'));
  END IF;
END $$;
`;

export function pgRiskConfigFromEnv(env: NodeJS.ProcessEnv = process.env): Required<Omit<PgRiskStoreOptions, 'pool'>> {
  return {
    host: env.AIDCP_PG_HOST ?? DEFAULT_PG_CONFIG.host,
    port: Number(env.AIDCP_PG_PORT ?? DEFAULT_PG_CONFIG.port),
    database: env.AIDCP_PG_DATABASE ?? env.AIDCP_PG_DB ?? DEFAULT_PG_CONFIG.database,
    user: env.AIDCP_PG_USER ?? DEFAULT_PG_CONFIG.user,
    password: env.AIDCP_PG_PASSWORD ?? DEFAULT_PG_CONFIG.password,
  };
}

export class PgRiskStore implements RiskStore, InteractionStore {
  private readonly pool: pg.Pool;

  constructor(options: PgRiskStoreOptions = {}) {
    const config = pgRiskConfigFromEnv();
    this.pool =
      options.pool ??
      new Pool({
        host: options.host ?? config.host,
        port: options.port ?? config.port,
        database: options.database ?? config.database,
        user: options.user ?? config.user,
        password: options.password ?? config.password,
      });
  }

  async init(): Promise<void> {
    await this.pool.query(RISK_SCHEMA_SQL);
  }

  async loadCounters(accountId: string, since: number): Promise<CounterEvent[]> {
    const { rows } = await this.pool.query<{ action: RiskAction; occurred_at: Date; count: number }>(
      `SELECT action, occurred_at, count FROM risk_counters
       WHERE account_id = $1 AND occurred_at > to_timestamp($2 / 1000.0)
       ORDER BY occurred_at ASC`,
      [accountId, since],
    );
    return rows.map((row) => ({ action: row.action, occurredAt: row.occurred_at.getTime(), count: row.count }));
  }

  async appendCounter(accountId: string, action: RiskAction, occurredAt: number): Promise<void> {
    await this.pool.query(
      `INSERT INTO risk_counters (account_id, action, count, occurred_at)
       VALUES ($1, $2, 1, to_timestamp($3 / 1000.0))`,
      [accountId, action, occurredAt],
    );
  }

  async loadState(accountId: string): Promise<RiskState | null> {
    const { rows } = await this.pool.query<{
      account_id: string;
      status: RiskStatus;
      quota_level: RiskQuotaLevel;
      signal_count: number;
      last_signal_at: Date | null;
      status_since: Date;
      updated_at: Date;
    }>('SELECT * FROM risk_state WHERE account_id = $1', [accountId]);
    const row = rows[0];
    if (!row) return null;
    return {
      accountId: row.account_id,
      status: row.status,
      quotaLevel: row.quota_level,
      signalCount: row.signal_count,
      lastSignalAt: row.last_signal_at?.getTime() ?? null,
      statusSince: row.status_since.getTime(),
      updatedAt: row.updated_at.getTime(),
    };
  }

  async saveState(state: RiskState): Promise<void> {
    await this.pool.query(
      `INSERT INTO risk_state (account_id, status, quota_level, signal_count, last_signal_at, status_since, updated_at)
       VALUES ($1, $2, $3, $4, CASE WHEN $5::bigint IS NULL THEN NULL ELSE to_timestamp($5 / 1000.0) END, to_timestamp($6 / 1000.0), to_timestamp($7 / 1000.0))
       ON CONFLICT (account_id) DO UPDATE SET
         status = EXCLUDED.status,
         quota_level = EXCLUDED.quota_level,
         signal_count = EXCLUDED.signal_count,
         last_signal_at = EXCLUDED.last_signal_at,
         status_since = EXCLUDED.status_since,
         updated_at = EXCLUDED.updated_at`,
      [state.accountId, state.status, state.quotaLevel, state.signalCount, state.lastSignalAt, state.statusSince, state.updatedAt],
    );
  }

  async hasInteraction(accountId: string, noteId: string, action: InteractionAction): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `SELECT 1 FROM risk_interactions
       WHERE account_id = $1 AND note_id = $2 AND action = $3
       LIMIT 1`,
      [accountId, noteId, action],
    );
    return (rowCount ?? 0) > 0;
  }

  async recordInteraction(accountId: string, noteId: string, action: InteractionAction, interactedAt: number): Promise<void> {
    await this.pool.query(
      `INSERT INTO risk_interactions (account_id, note_id, action, interacted_at)
       VALUES ($1, $2, $3, to_timestamp($4 / 1000.0))
       ON CONFLICT (account_id, note_id, action) DO NOTHING`,
      [accountId, noteId, action, interactedAt],
    );
  }

  /**
   * 该账号今日（服务器本地日历日 00:00 起）某动作的互动计数（change content-schedule-comments）。
   * 供内容排期评论日上限判定——持久已发历史（重启不清零），与「任务在跑?1:0」相加做原子上限。
   * date_trunc('day', now()) 取 DB 会话时区当日起点，对齐 publish 侧 countPublishedTodayForAccount 口径。
   */
  async countInteractionsTodayForAccount(accountId: string, action: InteractionAction): Promise<number> {
    const { rows } = await this.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM risk_interactions
        WHERE account_id = $1 AND action = $2 AND interacted_at >= date_trunc('day', now())`,
      [accountId, action],
    );
    return Number(rows[0]?.n ?? '0');
  }

  /**
   * 数据保留：删早于 N 天的配额计数流水（change console-cloud-panel-hardening #21）。
   * 风控只回读最近 1 天（见 loadCounters 的 since），更早的行是永不再被业务读到的死数据。
   * DELETE 走 idx_risk_counters_time（occurred_at），不全表扫描。
   * risk_interactions（每笔记去重台账）刻意不在此清理——去重语义依赖历史留存。
   */
  async purgeCountersOlderThan(days: number): Promise<number> {
    const res = await this.pool.query(
      `DELETE FROM risk_counters WHERE occurred_at < now() - ($1::int * interval '1 day')`,
      [days],
    );
    return res.rowCount ?? 0;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}