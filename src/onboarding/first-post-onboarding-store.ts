/**
 * Persistent account-level state for the first-post onboarding flow.
 *
 * One row is created at the first successful persona bind and is never deleted by
 * persona updates/unbinds. This makes "first" durable instead of inferring it from
 * the current persona row, which can legitimately disappear and be recreated.
 */

import pg from 'pg';
import { DEFAULT_PG_CONFIG } from '../cache/pg-anchor-cache.js';

const { Pool } = pg;

export type FirstPostOnboardingState = 'searching' | 'generating' | 'generated';

export interface FirstPostOnboardingRow {
  accountId: string;
  state: FirstPostOnboardingState;
  startedAt: number;
  sourceId: string | null;
  lastError: string | null;
  generatedAt: number | null;
}

export const FIRST_POST_ONBOARDING_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS first_post_onboarding (
  account_id   TEXT PRIMARY KEY REFERENCES accounts(account_id) ON DELETE CASCADE,
  state        TEXT NOT NULL DEFAULT 'searching'
               CHECK (state IN ('searching', 'generating', 'generated')),
  started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  source_id    TEXT,
  last_error   TEXT,
  generated_at TIMESTAMPTZ,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_first_post_onboarding_state
  ON first_post_onboarding (state, updated_at);
`;

export interface FirstPostOnboardingStoreOptions {
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  pool?: pg.Pool;
}

interface DbRow {
  account_id: string;
  state: FirstPostOnboardingState;
  started_at: Date | string;
  source_id: string | null;
  last_error: string | null;
  generated_at: Date | string | null;
}

function epoch(value: Date | string | null): number | null {
  if (value === null) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function toRow(row: DbRow): FirstPostOnboardingRow {
  return {
    accountId: row.account_id,
    state: row.state,
    startedAt: epoch(row.started_at) ?? 0,
    sourceId: row.source_id ?? null,
    lastError: row.last_error ?? null,
    generatedAt: epoch(row.generated_at),
  };
}

export class FirstPostOnboardingStore {
  private readonly pool: pg.Pool;

  constructor(options: FirstPostOnboardingStoreOptions = {}) {
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

  async init(): Promise<void> {
    await this.pool.query(FIRST_POST_ONBOARDING_SCHEMA_SQL);
  }

  /** Returns true only when this call created the account's lifetime onboarding row. */
  async armFirstBind(accountId: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `INSERT INTO first_post_onboarding (account_id, state, started_at, updated_at)
       VALUES ($1, 'searching', now(), now())
       ON CONFLICT (account_id) DO NOTHING`,
      [accountId],
    );
    return (rowCount ?? 0) > 0;
  }

  async get(accountId: string): Promise<FirstPostOnboardingRow | null> {
    const { rows } = await this.pool.query<DbRow>(
      `SELECT account_id, state, started_at, source_id, last_error, generated_at
         FROM first_post_onboarding
        WHERE account_id = $1`,
      [accountId],
    );
    return rows[0] ? toRow(rows[0]) : null;
  }

  /** Atomic account claim: duplicate/concurrent curated events can move searching only once. */
  async claim(accountId: string, sourceId: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `UPDATE first_post_onboarding
          SET state = 'generating', source_id = $2, last_error = NULL, updated_at = now()
        WHERE account_id = $1 AND state = 'searching'`,
      [accountId, sourceId],
    );
    return (rowCount ?? 0) > 0;
  }

  /** Release only the matching in-flight source so a stale outcome cannot undo a newer claim. */
  async release(accountId: string, sourceId: string, reason: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `UPDATE first_post_onboarding
          SET state = 'searching', source_id = NULL, last_error = $3, updated_at = now()
        WHERE account_id = $1 AND state = 'generating' AND source_id = $2`,
      [accountId, sourceId, reason.slice(0, 500)],
    );
    return (rowCount ?? 0) > 0;
  }

  /** Complete only the matching in-flight source after the existing publish pipeline produced a real artifact. */
  async complete(accountId: string, sourceId: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `UPDATE first_post_onboarding
          SET state = 'generated', last_error = NULL, generated_at = now(), updated_at = now()
        WHERE account_id = $1 AND state = 'generating' AND source_id = $2`,
      [accountId, sourceId],
    );
    return (rowCount ?? 0) > 0;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
