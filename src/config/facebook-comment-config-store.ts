/**
 * 每账号 Facebook 定时评论配置存储（account_facebook_comment_config 表，PostgreSQL）。
 *
 * change facebook-scheduled-comment（2.1，目标选定 2026-07-07 定为「关键词 + 限定容器」）：
 * 后台按账号配置【搜索关键词列表】+【允许的容器列表】（运营方自己的 / 已加入的 Facebook 主页、群）。
 * 执行时随机选一个关键词、只在某个配置容器内部搜索、挑帖评论。
 *
 * 安全不变量（复刻 QuotaConfigStore / ContentScheduleStore）：
 * - fail-closed：关键词或容器任一为空 → effectiveConfigFor().enabled=false（不生效、诚实 no-op）。
 * - 写库成功才刷内存镜像（避免「镜像已变、库未变」不一致）。
 * - 绝不造幽灵行：setAccount 写前校验 accounts 存在；退役保留账号拒。
 * - 非法值（非字符串数组）整块拒 invalid_value，不静默丢弃。
 * 建表幂等（CREATE TABLE IF NOT EXISTS），与 migrations/0034_facebook_comment_config.sql 同源。
 */

import pg from 'pg';
import { DEFAULT_PG_CONFIG } from '../cache/pg-anchor-cache.js';
import { RETIRED_ACCOUNT_ID } from '../account-store.js';

const { Pool } = pg;

/**
 * 容器（群/主页）配置项（change facebook-container-display-name）。
 * `url` 是功能主键（边缘据此导航 + 建站内搜索链，含群 id）；`name` 是人类可读群名（边缘从群页自动解析回填），
 * 未解析出前为空。**对人展示一律用 name（缺则「待识别」占位），绝不展示 url 里的 id**（id 对人无辨识度）。
 */
export interface FacebookContainer {
  url: string;
  name?: string;
}

/** 每账号配置行（面板回显用）。keywords 为字符串数组；containers 为 {url,name} 数组。 */
export interface FacebookCommentConfigRow {
  accountId: string;
  keywords: string[];
  containers: FacebookContainer[];
  updatedAt: string | null;
  updatedBy: string | null;
}

/** 写补丁：未传的字段保持原值（面板可只改关键词或只改容器）。容器可传 url 字符串或 {url,name}。 */
export interface FacebookCommentConfigPatch {
  keywords?: string[];
  containers?: Array<string | FacebookContainer>;
}

export type SetFacebookCommentConfigResult =
  | { ok: true; row: FacebookCommentConfigRow }
  | { ok: false; reason: 'account_not_found' | 'retired_account' | 'invalid_value' | 'no_valid_fields' };

/** fail-closed 生效判定：仅在关键词与容器都非空时启用（单一判定点，供调度器与面板同源消费）。 */
export interface EffectiveFacebookCommentConfig {
  enabled: boolean;
  keywords: string[];
  containers: FacebookContainer[];
}

export const FACEBOOK_COMMENT_CONFIG_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS account_facebook_comment_config (
  account_id  TEXT PRIMARY KEY,
  keywords    JSONB NOT NULL DEFAULT '[]'::jsonb,
  containers  JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  TEXT
);
`;

export interface FacebookCommentConfigStoreOptions {
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  pool?: pg.Pool;
}

interface FbConfigDbRow {
  account_id: string;
  keywords: unknown;
  containers: unknown;
  updated_at: Date | string | null;
  updated_by: string | null;
}

/** JSONB → string[]：仅保留字符串项、trim、丢空串、去重（防脏行 / 防注入无关值）。 */
function coerceList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const v = item.trim();
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

/** 入参校验：必须是字符串数组（或 undefined=不改）；非法 → null（整块拒）。合法则 sanitize。 */
function sanitizeInput(raw: string[] | undefined): string[] | null | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) return null;
  if (!raw.every((x) => typeof x === 'string')) return null;
  return coerceList(raw);
}

/**
 * JSONB / 面板入参 → FacebookContainer[]。**向后兼容**：既接受历史的裸 url 字符串项，也接受 {url,name} 对象项；
 * trim url、丢空、按 url 去重；name 仅在非空字符串时保留（否则待边缘解析回填）。
 */
function coerceContainers(raw: unknown): FacebookContainer[] {
  if (!Array.isArray(raw)) return [];
  const out: FacebookContainer[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    let url = '';
    let name: string | undefined;
    if (typeof item === 'string') {
      url = item.trim();
    } else if (item && typeof item === 'object') {
      const o = item as Record<string, unknown>;
      if (typeof o.url === 'string') url = o.url.trim();
      if (typeof o.name === 'string' && o.name.trim()) name = o.name.trim();
    }
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push(name ? { url, name } : { url });
  }
  return out;
}

/** 容器入参校验：数组，每项是字符串或含字符串 url 的对象；否则 null（整块拒）。合法则 coerce。 */
function sanitizeContainersInput(
  raw: Array<string | FacebookContainer> | undefined,
): FacebookContainer[] | null | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) return null;
  for (const x of raw) {
    if (typeof x === 'string') continue;
    if (x && typeof x === 'object' && typeof (x as { url?: unknown }).url === 'string') continue;
    return null;
  }
  return coerceContainers(raw);
}

export class FacebookCommentConfigStore {
  private readonly pool: pg.Pool;
  private cache = new Map<string, FacebookCommentConfigRow>();

  constructor(options: FacebookCommentConfigStoreOptions = {}) {
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
    await this.pool.query(FACEBOOK_COMMENT_CONFIG_SCHEMA_SQL);
    await this.reload();
  }

  private async reload(): Promise<void> {
    const { rows } = await this.pool.query<FbConfigDbRow>(
      `SELECT account_id, keywords, containers, updated_at, updated_by FROM account_facebook_comment_config`,
    );
    const next = new Map<string, FacebookCommentConfigRow>();
    for (const r of rows) next.set(r.account_id, this.toRow(r));
    this.cache = next;
  }

  private toRow(r: FbConfigDbRow): FacebookCommentConfigRow {
    return {
      accountId: r.account_id,
      keywords: coerceList(r.keywords),
      containers: coerceContainers(r.containers),
      updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null,
      updatedBy: r.updated_by ?? null,
    };
  }

  /** 面板回显：缺行返回空默认（keywords/containers 空数组）。 */
  getForAccount(accountId: string): FacebookCommentConfigRow {
    return (
      this.cache.get(accountId) ?? {
        accountId,
        keywords: [],
        containers: [],
        updatedAt: null,
        updatedBy: null,
      }
    );
  }

  /** 调度器消费点：fail-closed 收口——关键词与容器都非空才 enabled。 */
  effectiveConfigFor(accountId: string): EffectiveFacebookCommentConfig {
    const row = this.getForAccount(accountId);
    return {
      enabled: row.keywords.length > 0 && row.containers.length > 0,
      keywords: row.keywords,
      containers: row.containers,
    };
  }

  /**
   * 写一个账号的配置（面板 PUT）。未传字段保持原值。
   * 非法值整块拒；退役账号拒；账号不存在拒（防幽灵行）；UPSERT + RETURNING 回读真态；写成功才刷缓存。
   */
  async setAccount(
    accountId: string,
    patch: FacebookCommentConfigPatch,
    updatedBy: string,
  ): Promise<SetFacebookCommentConfigResult> {
    if (accountId === RETIRED_ACCOUNT_ID) return { ok: false, reason: 'retired_account' };

    const keywords = sanitizeInput(patch.keywords);
    const containers = sanitizeContainersInput(patch.containers);
    if (keywords === null || containers === null) return { ok: false, reason: 'invalid_value' };
    if (keywords === undefined && containers === undefined) return { ok: false, reason: 'no_valid_fields' };

    const exists = await this.pool.query(`SELECT 1 FROM accounts WHERE account_id = $1`, [accountId]);
    if (exists.rows.length === 0) return { ok: false, reason: 'account_not_found' };

    // 现有行（回显/合并基准）：未传的字段沿用现值。
    const current = this.getForAccount(accountId);
    const nextKeywords = keywords ?? current.keywords;
    const nextContainers = containers ?? current.containers;

    const { rows } = await this.pool.query<FbConfigDbRow>(
      `INSERT INTO account_facebook_comment_config (account_id, keywords, containers, updated_at, updated_by)
       VALUES ($1, $2::jsonb, $3::jsonb, now(), $4)
       ON CONFLICT (account_id) DO UPDATE
         SET keywords = EXCLUDED.keywords,
             containers = EXCLUDED.containers,
             updated_at = now(),
             updated_by = EXCLUDED.updated_by
       RETURNING account_id, keywords, containers, updated_at, updated_by`,
      [accountId, JSON.stringify(nextKeywords), JSON.stringify(nextContainers), updatedBy],
    );
    const row = this.toRow(rows[0]);
    this.cache.set(accountId, row); // 写库成功才刷镜像。
    return { ok: true, row };
  }

  /**
   * 自动回填容器真实群名（change facebook-container-display-name）：边缘在容器内搜索时读出真名，
   * 云端据此把配置里 url 匹配的容器名刷新——人只看群名、不看 id。
   * best-effort：不改 updated_by/updated_at（非运营编辑），url 未配置/名称未变/出错均静默跳过、绝不波及主链路。
   */
  async resolveContainerName(accountId: string, url: string, name: string): Promise<void> {
    const u = (url ?? '').trim();
    const n = (name ?? '').trim();
    if (!u || !n) return;
    const current = this.cache.get(accountId);
    if (!current) return; // 无配置行 → 无可回填
    const idx = current.containers.findIndex((c) => c.url === u);
    if (idx < 0) return; // 该 url 未配置（可能已被运营删/换）→ 忽略
    if (current.containers[idx].name === n) return; // 名称未变 → 免写
    const nextContainers = current.containers.map((c, i) => (i === idx ? { url: c.url, name: n } : c));
    try {
      const { rows } = await this.pool.query<FbConfigDbRow>(
        `UPDATE account_facebook_comment_config SET containers = $2::jsonb WHERE account_id = $1
         RETURNING account_id, keywords, containers, updated_at, updated_by`,
        [accountId, JSON.stringify(nextContainers)],
      );
      if (rows[0]) this.cache.set(accountId, this.toRow(rows[0]));
    } catch {
      /* best-effort：群名回填绝不波及主链路 */
    }
  }
}
