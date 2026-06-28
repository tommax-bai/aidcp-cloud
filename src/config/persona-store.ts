/**
 * 账号人设存储（persona_config 表，PostgreSQL）。
 *
 * change account-persona-config：把原全局单份 soul.yaml 做成「按账号可配 + 热加载」。
 * 落库 + 内存镜像；派发 / 发布时按当前账号解析人设 —— PUT 后无需重启即生效。
 *
 * 安全不变量（复刻 RoleConfigStore）：
 * - 绝不 brick：某账号缺行 / 为空 / 解析失败，解析器回落打包 soul.yaml（永不抛）。
 * - 写库成功才刷内存镜像（避免「镜像已变、库未变」不一致）。
 *
 * 建表幂等（CREATE TABLE IF NOT EXISTS），与 migrations/0011_persona_config.sql 同源。
 * 注意：persona_config FK 到 accounts，故 init() 须在 accounts 表建好之后调用（server 装配顺序保证）。
 */

import pg from 'pg';
import { readFileSync } from 'node:fs';
import { DEFAULT_PG_CONFIG } from '../cache/pg-anchor-cache.js';
import { loadSoulFromYaml, defaultSoulPath, type Soul } from '../soul/index.js';

const { Pool } = pg;

/** 单账号人设行（含审计字段，供面板非乐观回显）。 */
export interface PersonaRow {
  accountId: string;
  /** soul 文本（loadSoulFromYaml 可解析）。 */
  persona: string;
  updatedAt: string | null;
  updatedBy: string | null;
}

/** 账号目录项（人设列表需列出所有账号，含无覆盖者）。 */
export interface PersonaAccount {
  accountId: string;
  label: string | null;
}

export const PERSONA_CONFIG_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS persona_config (
  account_id  TEXT PRIMARY KEY REFERENCES accounts(account_id) ON DELETE CASCADE,
  persona     TEXT NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  TEXT
);
`;

export interface PersonaStoreOptions {
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  pool?: pg.Pool;
}

interface PersonaDbRow {
  account_id: string;
  persona: string;
  updated_at: Date | string | null;
  updated_by: string | null;
}

interface AccountDbRow {
  account_id: string;
  label: string | null;
}

export class PersonaStore {
  private readonly pool: pg.Pool;
  private cache = new Map<string, PersonaRow>();

  constructor(options: PersonaStoreOptions = {}) {
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

  /** 建表 + 载入内存镜像。须在 accounts 表建好之后调用（FK 依赖）。 */
  async init(): Promise<void> {
    await this.pool.query(PERSONA_CONFIG_SCHEMA_SQL);
    await this.reload();
  }

  private async reload(): Promise<void> {
    const { rows } = await this.pool.query<PersonaDbRow>(
      `SELECT account_id, persona, updated_at, updated_by FROM persona_config`,
    );
    const next = new Map<string, PersonaRow>();
    for (const r of rows) {
      next.set(r.account_id, {
        accountId: r.account_id,
        persona: r.persona ?? '',
        updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null,
        updatedBy: r.updated_by ?? null,
      });
    }
    this.cache = next;
  }

  /**
   * 同步取某账号的人设文本（解析器每次派发用，读内存镜像，不打 PG）。
   * 缺行 / 空文本一律返回 null（回落由解析器处理）；永不抛。
   */
  getForAccount(accountId: string): string | null {
    const v = this.cache.get(accountId);
    if (!v) return null;
    return v.persona.trim() ? v.persona : null;
  }

  /** 取某账号的完整行（含审计字段，面板详情/列表回显用）。缺行返回 undefined。 */
  getRow(accountId: string): PersonaRow | undefined {
    return this.cache.get(accountId);
  }

  /** 全部覆盖行（面板列表 + 审计用）。 */
  getAll(): Map<string, PersonaRow> {
    return this.cache;
  }

  /** 列出所有账号（含无人设覆盖者）。读 accounts 表，供面板列表用（非热路径）。 */
  async listAccounts(): Promise<PersonaAccount[]> {
    const { rows } = await this.pool.query<AccountDbRow>(
      `SELECT account_id, label FROM accounts ORDER BY account_id`,
    );
    return rows.map((r) => ({ accountId: r.account_id, label: r.label ?? null }));
  }

  /** 账号是否存在（写前校验，避免 FK 违反；不存在返回 false）。 */
  async accountExists(accountId: string): Promise<boolean> {
    const { rows } = await this.pool.query<{ one: number }>(
      `SELECT 1 AS one FROM accounts WHERE account_id = $1`,
      [accountId],
    );
    return rows.length > 0;
  }

  /**
   * 写库 + 刷内存镜像（热加载）。先写库成功、再刷镜像（写库失败则镜像不变）。
   * personaText 应为已通过校验的非空 soul 文本（校验在 facade 内做）。
   */
  async set(accountId: string, personaText: string, updatedBy: string): Promise<PersonaRow> {
    const { rows } = await this.pool.query<PersonaDbRow>(
      `INSERT INTO persona_config (account_id, persona, updated_at, updated_by)
       VALUES ($1, $2, now(), $3)
       ON CONFLICT (account_id)
       DO UPDATE SET persona = EXCLUDED.persona, updated_at = now(), updated_by = EXCLUDED.updated_by
       RETURNING account_id, persona, updated_at, updated_by`,
      [accountId, personaText, updatedBy],
    );
    const row = rows[0];
    const result: PersonaRow = {
      accountId,
      persona: personaText,
      updatedAt: row?.updated_at ? new Date(row.updated_at).toISOString() : null,
      updatedBy: row?.updated_by ?? updatedBy,
    };
    this.cache.set(accountId, result);
    return result;
  }

  /** 清除某账号的人设覆盖（删行 → 回落打包默认）。写库成功才删镜像。 */
  async clear(accountId: string): Promise<void> {
    await this.pool.query(`DELETE FROM persona_config WHERE account_id = $1`, [accountId]);
    this.cache.delete(accountId);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

/** 按账号解析人设（派发 / 发布的热路径取值口）。 */
export type PersonaResolver = (accountId?: string) => Soul;

export interface PersonaResolverDeps {
  /** 人设存储（缺失 = 全程回落打包默认，不 brick）。 */
  store?: Pick<PersonaStore, 'getForAccount'>;
  /** 打包默认 soul（启动 fail-fast 已验证可解析，恒定可用的最终回落）。 */
  fallbackSoul: Soul;
  logger?: Pick<Console, 'warn'>;
}

/**
 * 造一个按账号解析人设的取值口（纯函数式：每次调用读镜像 → 解析 → 回落）。
 * 回落链：命中镜像且可解析 → 用之；否则（无行 / 空 / 解析失败）回落打包默认。永不抛。
 */
export function createPersonaResolver(deps: PersonaResolverDeps): PersonaResolver {
  const logger = deps.logger ?? console;
  return (accountId = '__unbound__'): Soul => {
    const text = deps.store?.getForAccount(accountId) ?? null;
    if (!text) return deps.fallbackSoul;
    try {
      return loadSoulFromYaml(text);
    } catch (err) {
      // 写入门已挡非法人设，此处为防御性兜底（理论上不达）：记 warn 并回落，绝不抛、绝不 brick。
      logger.warn(`[persona] 账号 ${accountId} 人设解析失败，回落打包默认: ${(err as Error).message}`);
      return deps.fallbackSoul;
    }
  };
}

/** 读打包 soul.yaml 原文（面板编辑「回落」账号时的起点模板）；进程内缓存一份。 */
let cachedDefaultPersonaText: string | null = null;
export function getDefaultPersonaText(): string {
  if (cachedDefaultPersonaText === null) {
    cachedDefaultPersonaText = readFileSync(defaultSoulPath(), 'utf8');
  }
  return cachedDefaultPersonaText;
}
