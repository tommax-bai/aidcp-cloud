/**
 * 告警日志存储（alerts 表，PostgreSQL）。
 *
 * V1（change aidcp-console-panel-mvp，task 9.5）：append-only 告警事件日志。
 * - 写入点：飞书卡发送点（验证码协调器 maybeAlert）——P0/P1 阻断弹窗。
 * - 解决点：验证码清除点（onCleared）按 edge set resolved_at。
 * - 读出：面板 GET /api/alerts + dashboard summary（panel-store 直接 SELECT，design D2）。
 *
 * 复用 P0–P3 分级（feishu/types.ts AlertSeverity，与 risk-control §7 / product-exception §1 同套）。
 * 与 risk_state.signalCount 区分：这是事件日志（多行、可解决），signalCount 是滑窗计数。
 * 建表幂等（CREATE TABLE IF NOT EXISTS），与 migrations/0006_alerts.sql 同源。
 */

import pg from 'pg';
import { DEFAULT_PG_CONFIG } from '../cache/pg-anchor-cache.js';
import type { AlertSeverity } from '../feishu/types.js';

const { Pool } = pg;

export const ALERTS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS alerts (
  alert_id    BIGSERIAL PRIMARY KEY,
  severity    TEXT NOT NULL CHECK (severity IN ('P0','P1','P2','P3')),
  type        TEXT NOT NULL,
  account_id  TEXT,
  edge_id     TEXT,
  title       TEXT NOT NULL,
  detail      TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_alerts_created ON alerts (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_alerts_unresolved_edge ON alerts (edge_id) WHERE resolved_at IS NULL;
`;

export interface AlertRecordInput {
  severity: AlertSeverity;
  /** 告警来源种类，如 'captcha' / 'block'。 */
  type: string;
  accountId?: string;
  edgeId?: string;
  title: string;
  detail?: string;
}

export interface AlertRow {
  alertId: number;
  severity: AlertSeverity;
  type: string;
  accountId: string | null;
  edgeId: string | null;
  title: string;
  detail: string | null;
  createdAt: number;
  resolvedAt: number | null;
}

/** 告警存储最小接口（便于打桩/测试，不依赖真 PG）。 */
export interface AlertStore {
  init(): Promise<void>;
  /** 写一条告警，返回新 alert_id。 */
  raise(input: AlertRecordInput, at?: number): Promise<{ alertId: number }>;
  /** 按 edge 解决其所有未解决告警（验证码清除点），返回解决条数。 */
  resolveByEdge(edgeId: string, at?: number): Promise<number>;
  /**
   * 按 alert_id 解决单条未解决告警（面板手动勾销，change alert-resolution-by-id）。
   * 不依赖 edge_id——故对 edge_id=NULL 的告警（如节奏过载）与从未收到配对清除的告警都可解决。
   * 返回真实解决条数（0=没这条/已解决，1=本次解决），绝不假成功。
   */
  resolveById(alertId: number, at?: number): Promise<number>;
  list(options?: { limit?: number; includeResolved?: boolean }): Promise<AlertRow[]>;
  close?(): Promise<void>;
}

export interface PgAlertStoreOptions {
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  pool?: pg.Pool;
}

interface AlertDbRow {
  alert_id: string | number;
  severity: AlertSeverity;
  type: string;
  account_id: string | null;
  edge_id: string | null;
  title: string;
  detail: string | null;
  created_at: Date;
  resolved_at: Date | null;
}

function toAlertRow(r: AlertDbRow): AlertRow {
  return {
    alertId: Number(r.alert_id),
    severity: r.severity,
    type: r.type,
    accountId: r.account_id,
    edgeId: r.edge_id,
    title: r.title,
    detail: r.detail,
    createdAt: r.created_at.getTime(),
    resolvedAt: r.resolved_at ? r.resolved_at.getTime() : null,
  };
}

export class PgAlertStore implements AlertStore {
  private readonly pool: pg.Pool;

  constructor(options: PgAlertStoreOptions = {}) {
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
    await this.pool.query(ALERTS_SCHEMA_SQL);
  }

  async raise(input: AlertRecordInput, at?: number): Promise<{ alertId: number }> {
    const { rows } = await this.pool.query<{ alert_id: string | number }>(
      `INSERT INTO alerts (severity, type, account_id, edge_id, title, detail, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, ${at !== undefined ? 'to_timestamp($7 / 1000.0)' : 'now()'})
       RETURNING alert_id`,
      at !== undefined
        ? [input.severity, input.type, input.accountId ?? null, input.edgeId ?? null, input.title, input.detail ?? null, at]
        : [input.severity, input.type, input.accountId ?? null, input.edgeId ?? null, input.title, input.detail ?? null],
    );
    return { alertId: Number(rows[0]?.alert_id ?? 0) };
  }

  async resolveByEdge(edgeId: string, at?: number): Promise<number> {
    const { rowCount } = await this.pool.query(
      `UPDATE alerts SET resolved_at = ${at !== undefined ? 'to_timestamp($2 / 1000.0)' : 'now()'}
       WHERE edge_id = $1 AND resolved_at IS NULL`,
      at !== undefined ? [edgeId, at] : [edgeId],
    );
    return rowCount ?? 0;
  }

  async resolveById(alertId: number, at?: number): Promise<number> {
    // 镜像 resolveByEdge：同守 `resolved_at IS NULL`，故与按 edge 自动清除并存时靠行锁串行、
    // 后到者命中 0 行、幂等诚实。只 UPDATE resolved_at，绝不碰风控单写、绝不 resumeEdge。
    const { rowCount } = await this.pool.query(
      `UPDATE alerts SET resolved_at = ${at !== undefined ? 'to_timestamp($2 / 1000.0)' : 'now()'}
       WHERE alert_id = $1 AND resolved_at IS NULL`,
      at !== undefined ? [alertId, at] : [alertId],
    );
    return rowCount ?? 0;
  }

  async list(options: { limit?: number; includeResolved?: boolean } = {}): Promise<AlertRow[]> {
    const limit = options.limit ?? 100;
    const where = options.includeResolved ? '' : 'WHERE resolved_at IS NULL';
    const { rows } = await this.pool.query<AlertDbRow>(
      `SELECT alert_id, severity, type, account_id, edge_id, title, detail, created_at, resolved_at
       FROM alerts ${where} ORDER BY created_at DESC LIMIT $1`,
      [limit],
    );
    return rows.map(toAlertRow);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
