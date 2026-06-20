/**
 * 概念持久化（PostgreSQL，aidcp 库）。
 *
 * 把"已知/待搜"的技术概念落到 PG，使浏览行为跨会话有记忆：
 * - 启动时把 known + candidates 载入 ConceptPool，避免重复搜同一关键词；
 * - 发现新概念时 INSERT（status='candidate'）；
 * - 执行搜索后 UPDATE 该概念 status='searched'。
 *
 * 表 concepts:
 *   id           SERIAL PK
 *   keyword      TEXT UNIQUE   概念关键词
 *   status       TEXT          'candidate' | 'searched' | 'known'
 *   source_note  TEXT          来源笔记标题（可空）
 *   discovered_at TIMESTAMPTZ  发现时间
 *   searched_at  TIMESTAMPTZ   搜索时间（可空）
 *
 * 连接默认指向本机 aidcp 库（与 PgAnchorCache 一致），可注入 Pool 复用连接。
 */

import pg from 'pg';
import { DEFAULT_PG_CONFIG } from './pg-anchor-cache.js';
import type { ConceptPool } from '../event-bus/types.js';

const { Pool } = pg;

export type ConceptStatus = 'candidate' | 'searched' | 'known';

export interface ConceptRecord {
  keyword: string;
  status: ConceptStatus;
  sourceNote: string | null;
}

export interface ConceptStoreOptions {
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  pool?: pg.Pool;
}

/** 建表 DDL（幂等）。 */
export const CONCEPT_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS concepts (
  id            SERIAL PRIMARY KEY,
  keyword       TEXT NOT NULL UNIQUE,
  status        TEXT NOT NULL DEFAULT 'candidate'
                CHECK (status IN ('candidate','searched','known')),
  source_note   TEXT,
  discovered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  searched_at   TIMESTAMPTZ
);
`;

interface ConceptRow {
  keyword: string;
  status: string;
  source_note: string | null;
}

function toStatus(s: string): ConceptStatus {
  return s === 'searched' || s === 'known' ? s : 'candidate';
}

/** PostgreSQL 概念存储。 */
export class ConceptStore {
  private readonly pool: pg.Pool;

  constructor(options: ConceptStoreOptions = {}) {
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

  /** 初始化表（幂等） */
  async init(): Promise<void> {
    await this.pool.query(CONCEPT_SCHEMA_SQL);
  }

  /** 读取所有概念记录 */
  async list(): Promise<ConceptRecord[]> {
    const { rows } = await this.pool.query<ConceptRow>(
      'SELECT keyword, status, source_note FROM concepts ORDER BY discovered_at ASC',
    );
    return rows.map((r) => ({
      keyword: r.keyword,
      status: toStatus(r.status),
      sourceNote: r.source_note,
    }));
  }

  /**
   * 载入概念池：
   * - status 为 'searched' / 'known' → 进 known（不再重复搜）；
   * - status 为 'candidate' → 进 candidates 队列，并登记来源。
   */
  async loadPool(): Promise<ConceptPool> {
    const records = await this.list();
    const pool: ConceptPool = { known: [], candidates: [], source: new Map() };
    for (const r of records) {
      if (r.status === 'candidate') {
        pool.candidates.push(r.keyword);
        if (r.sourceNote) pool.source.set(r.keyword, r.sourceNote);
      } else {
        pool.known.push(r.keyword);
      }
    }
    return pool;
  }

  /**
   * 新增一个候选概念（已存在则忽略，保留原状态）。
   * 返回是否真正插入了新行。
   */
  async addCandidate(keyword: string, sourceNote?: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `INSERT INTO concepts (keyword, status, source_note)
       VALUES ($1, 'candidate', $2)
       ON CONFLICT (keyword) DO NOTHING`,
      [keyword, sourceNote ?? null],
    );
    return (rowCount ?? 0) > 0;
  }

  /** 批量新增候选概念，返回真正新增的关键词 */
  async addCandidates(keywords: string[], sourceNote?: string): Promise<string[]> {
    const added: string[] = [];
    for (const kw of keywords) {
      if (await this.addCandidate(kw, sourceNote)) added.push(kw);
    }
    return added;
  }

  /** 标记某概念为已搜索（不存在则插入为 searched）。 */
  async markSearched(keyword: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO concepts (keyword, status, searched_at)
       VALUES ($1, 'searched', now())
       ON CONFLICT (keyword) DO UPDATE SET status = 'searched', searched_at = now()`,
      [keyword],
    );
  }

  /** 自某时刻起新发现的概念数（stage-4 PublishScheduler 概念积累扳机用）。 */
  async countNewSince(sinceMs: number): Promise<number> {
    const { rows } = await this.pool.query<{ n: string }>(
      'SELECT count(*)::int AS n FROM concepts WHERE discovered_at > to_timestamp($1 / 1000.0)',
      [sinceMs],
    );
    return Number(rows[0]?.n ?? 0);
  }

  /** 自某时刻起新发现的概念关键词（供 TriggerInput.generateInput.concepts）。 */
  async getNewConceptsSince(sinceMs: number, limit = 20): Promise<string[]> {
    const { rows } = await this.pool.query<{ keyword: string }>(
      'SELECT keyword FROM concepts WHERE discovered_at > to_timestamp($1 / 1000.0) ORDER BY discovered_at DESC LIMIT $2',
      [sinceMs, limit],
    );
    return rows.map((r) => r.keyword);
  }

  /** 关闭连接池 */
  async close(): Promise<void> {
    await this.pool.end();
  }
}
