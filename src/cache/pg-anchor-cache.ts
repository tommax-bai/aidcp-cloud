/**
 * PostgreSQL 锚点缓存（云端主缓存 + 反污染晋升）。
 *
 * 与 edge 侧内存版 AnchorCache 对应，但云端是"全站共享、可持久化"的主缓存：
 * - main 表 anchors：已晋升的稳定锚点（边缘读它命中）；
 * - staging 表 anchor_staging：LLM 新解析的候选，连续确认 confirmThreshold 次才晋升。
 *
 * 反污染要义：一次 LLM 解析不直接覆盖主缓存，避免单次错误被复制成系统性故障
 * （与 edge 侧策略一致，只是落到 PG 以便跨边缘节点共享与离线晋升）。
 *
 * 连接参数默认指向本机：127.0.0.1:5432 / db=aidcp / user=aidcp。
 */

import pg from 'pg';
import type { RemoteAnchor } from '../comm/protocol.js';

const { Pool } = pg;

export interface PgAnchorCacheOptions {
  connectionString?: string;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  /** 暂存锚点晋升主缓存所需的连续确认成功次数 */
  confirmThreshold?: number;
  /** 注入已建好的 pg Pool（测试/复用连接池用） */
  pool?: pg.Pool;
}

/**
 * 默认连接配置（本机 PG）。
 *
 * 注意：口令**不再硬编码**。`password` 为惰性 getter，仅从环境变量 `PGPASSWORD` 读取，
 * 缺失即抛错（fail-fast），避免静默连库失败或误用错误口令。历史上此处曾内联明文口令并入 git——
 * 已移除，须改用 `PGPASSWORD` / `DATABASE_URL` / 显式传入 `password`。详见 docs/environment-database.md。
 *
 * 由于多数调用点写作 `options.password ?? DEFAULT_PG_CONFIG.password`，`??` 短路保证：
 * 显式传入或 env 已给口令时不会触发 getter；仅在两者都缺失时才抛错。
 */
export const DEFAULT_PG_CONFIG = {
  host: '127.0.0.1',
  port: 5432,
  database: 'aidcp',
  user: 'aidcp',
  get password(): string {
    const pw = process.env.PGPASSWORD;
    if (!pw || !pw.trim()) {
      throw new Error(
        'PG 口令缺失：请设置环境变量 PGPASSWORD（或改用 DATABASE_URL / 显式传入 password）。' +
          '已移除硬编码默认口令，详见 docs/environment-database.md。',
      );
    }
    return pw;
  },
};

function readEnvString(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() ? value : undefined;
}

function readEnvPort(): number | undefined {
  const value = readEnvString('PGPORT');
  if (!value) return undefined;
  const port = Number(value);
  return Number.isInteger(port) && port > 0 ? port : undefined;
}

function resolvePgConfig(options: PgAnchorCacheOptions): pg.PoolConfig {
  const envConnectionString = readEnvString('DATABASE_URL');
  const connectionString = options.connectionString ?? envConnectionString;
  if (connectionString) {
    return { connectionString };
  }

  return {
    host: options.host ?? readEnvString('PGHOST') ?? DEFAULT_PG_CONFIG.host,
    port: options.port ?? readEnvPort() ?? DEFAULT_PG_CONFIG.port,
    database: options.database ?? readEnvString('PGDATABASE') ?? DEFAULT_PG_CONFIG.database,
    user: options.user ?? readEnvString('PGUSER') ?? DEFAULT_PG_CONFIG.user,
    password: options.password ?? readEnvString('PGPASSWORD') ?? DEFAULT_PG_CONFIG.password,
  };
}

export interface PromotionResult {
  promoted: boolean;
  successes: number;
  needed: number;
}

/** 建表 DDL（幂等）。serverside 唯一键为 action_id。 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS anchors (
  action_id   TEXT PRIMARY KEY,
  role        TEXT,
  text        TEXT,
  text_match  TEXT DEFAULT 'contains',
  attributes  JSONB DEFAULT '{}'::jsonb,
  scope       JSONB,
  hit_count   INTEGER NOT NULL DEFAULT 0,
  fail_count  INTEGER NOT NULL DEFAULT 0,
  last_verified TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS anchor_staging (
  action_id   TEXT PRIMARY KEY,
  role        TEXT,
  text        TEXT,
  text_match  TEXT DEFAULT 'contains',
  attributes  JSONB DEFAULT '{}'::jsonb,
  scope       JSONB,
  successes   INTEGER NOT NULL DEFAULT 0,
  fingerprint TEXT NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

/** 锚点定位指纹（忽略统计字段），用于判断暂存是否稳定 */
export function anchorFingerprint(a: RemoteAnchor): string {
  return JSON.stringify({
    role: a.role ?? '',
    text: a.text ?? '',
    textMatch: a.textMatch ?? 'contains',
    attributes: a.attributes ?? {},
    scope: a.scope ?? {},
  });
}

interface AnchorRow {
  action_id: string;
  role: string | null;
  text: string | null;
  text_match: string | null;
  attributes: Record<string, string> | null;
  scope: RemoteAnchor['scope'] | null;
}

function rowToAnchor(row: AnchorRow): RemoteAnchor {
  const anchor: RemoteAnchor = { actionId: row.action_id };
  if (row.role) anchor.role = row.role;
  if (row.text) anchor.text = row.text;
  if (row.text_match === 'exact' || row.text_match === 'contains') anchor.textMatch = row.text_match;
  if (row.attributes && Object.keys(row.attributes).length > 0) anchor.attributes = row.attributes;
  if (row.scope) anchor.scope = row.scope;
  return anchor;
}

/** PostgreSQL 锚点主缓存 */
export class PgAnchorCache {
  private readonly pool: pg.Pool;
  private readonly confirmThreshold: number;

  constructor(options: PgAnchorCacheOptions = {}) {
    this.confirmThreshold = Math.max(1, options.confirmThreshold ?? 2);
    this.pool = options.pool ?? new Pool(resolvePgConfig(options));
  }

  /** 初始化表结构（幂等） */
  async init(): Promise<void> {
    await this.pool.query(SCHEMA_SQL);
  }

  /** 读主缓存锚点 */
  async get(actionId: string): Promise<RemoteAnchor | null> {
    const { rows } = await this.pool.query<AnchorRow>(
      'SELECT action_id, role, text, text_match, attributes, scope FROM anchors WHERE action_id = $1',
      [actionId],
    );
    return rows[0] ? rowToAnchor(rows[0]) : null;
  }

  /** 直接写主缓存（建库/离线晋升用） */
  async put(anchor: RemoteAnchor): Promise<void> {
    await this.pool.query(
      `INSERT INTO anchors (action_id, role, text, text_match, attributes, scope, last_verified, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, now(), now())
       ON CONFLICT (action_id) DO UPDATE SET
         role = EXCLUDED.role, text = EXCLUDED.text, text_match = EXCLUDED.text_match,
         attributes = EXCLUDED.attributes, scope = EXCLUDED.scope,
         last_verified = now(), updated_at = now()`,
      [
        anchor.actionId,
        anchor.role ?? null,
        anchor.text ?? null,
        anchor.textMatch ?? 'contains',
        JSON.stringify(anchor.attributes ?? {}),
        anchor.scope ? JSON.stringify(anchor.scope) : null,
      ],
    );
  }

  /** 命中成功：更新统计 */
  async recordHit(actionId: string): Promise<void> {
    await this.pool.query(
      'UPDATE anchors SET hit_count = hit_count + 1, fail_count = 0, last_verified = now() WHERE action_id = $1',
      [actionId],
    );
  }

  /** 命中后校验失败：累计失败计数 */
  async recordFailure(actionId: string): Promise<void> {
    await this.pool.query(
      'UPDATE anchors SET fail_count = fail_count + 1 WHERE action_id = $1',
      [actionId],
    );
  }

  /**
   * 暂存一个 LLM 新解析锚点（反污染：不直接进主缓存）。
   * 若与已暂存指纹不一致，重置确认计数（说明还不稳定）。
   */
  async stage(anchor: RemoteAnchor): Promise<void> {
    const fp = anchorFingerprint(anchor);
    await this.pool.query(
      `INSERT INTO anchor_staging (action_id, role, text, text_match, attributes, scope, successes, fingerprint, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, 0, $7, now())
       ON CONFLICT (action_id) DO UPDATE SET
         role = EXCLUDED.role, text = EXCLUDED.text, text_match = EXCLUDED.text_match,
         attributes = EXCLUDED.attributes, scope = EXCLUDED.scope,
         successes = CASE WHEN anchor_staging.fingerprint = EXCLUDED.fingerprint
                          THEN anchor_staging.successes ELSE 0 END,
         fingerprint = EXCLUDED.fingerprint, updated_at = now()`,
      [
        anchor.actionId,
        anchor.role ?? null,
        anchor.text ?? null,
        anchor.textMatch ?? 'contains',
        JSON.stringify(anchor.attributes ?? {}),
        anchor.scope ? JSON.stringify(anchor.scope) : null,
        fp,
      ],
    );
  }

  /**
   * 对暂存锚点确认一次成功；累计达阈值则晋升主缓存并清理暂存。
   */
  async confirmStaged(actionId: string): Promise<PromotionResult> {
    const { rows } = await this.pool.query<AnchorRow & { successes: number }>(
      `UPDATE anchor_staging SET successes = successes + 1, updated_at = now()
       WHERE action_id = $1
       RETURNING action_id, role, text, text_match, attributes, scope, successes`,
      [actionId],
    );
    const row = rows[0];
    if (!row) return { promoted: false, successes: 0, needed: this.confirmThreshold };

    if (row.successes >= this.confirmThreshold) {
      await this.put(rowToAnchor(row));
      await this.dropStaged(actionId);
      return { promoted: true, successes: row.successes, needed: this.confirmThreshold };
    }
    return { promoted: false, successes: row.successes, needed: this.confirmThreshold };
  }

  /** 暂存锚点校验失败：丢弃 */
  async dropStaged(actionId: string): Promise<void> {
    await this.pool.query('DELETE FROM anchor_staging WHERE action_id = $1', [actionId]);
  }

  /** 关闭连接池 */
  async close(): Promise<void> {
    await this.pool.end();
  }
}
