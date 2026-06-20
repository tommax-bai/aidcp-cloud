/**
 * 点赞笔记持久化（PostgreSQL，aidcp 库）。
 *
 * A 阶段4 来源血缘：真实 like 完成时落库一条，使发帖能追溯到「催生它的点赞笔记」，
 * 让 publish_log.source_liked_ids 填真实 id（不再写死 []）。
 *
 * 表 liked_notes：id SERIAL PK / note_id TEXT UNIQUE / title / summary / author / liked_at。
 */

import pg from 'pg';
import { DEFAULT_PG_CONFIG } from './pg-anchor-cache.js';

const { Pool } = pg;

export const LIKED_NOTE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS liked_notes (
  id        SERIAL PRIMARY KEY,
  note_id   TEXT NOT NULL UNIQUE,
  title     TEXT NOT NULL DEFAULT '',
  summary   TEXT NOT NULL DEFAULT '',
  author    TEXT,
  liked_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_liked_notes_liked_at ON liked_notes(liked_at DESC);
`;

export interface LikedNoteRecord {
  id: number;
  title: string;
  summary: string;
  author?: string;
}

export interface LikedNoteStoreOptions {
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  pool?: pg.Pool;
}

/** PostgreSQL 点赞笔记存储。 */
export class LikedNoteStore {
  private readonly pool: pg.Pool;

  constructor(options: LikedNoteStoreOptions = {}) {
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

  /** 建表（幂等）。 */
  async init(): Promise<void> {
    await this.pool.query(LIKED_NOTE_SCHEMA_SQL);
  }

  /**
   * 记录一条点赞笔记（note_id 唯一，重复忽略保留首条）。
   * note 详情不可得时（仅有 noteId）以空 title/summary 落库——如实记"点过但详情缺"，不编造。
   */
  async recordLike(noteId: string, detail?: { title?: string; summary?: string; author?: string }): Promise<void> {
    await this.pool.query(
      `INSERT INTO liked_notes (note_id, title, summary, author)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (note_id) DO NOTHING`,
      [noteId, detail?.title ?? '', detail?.summary ?? '', detail?.author ?? null],
    );
  }

  /** 自某时刻起的点赞笔记（供 TriggerInput.generateInput.likedContents / sourceLikedIds）。 */
  async recentSince(sinceMs: number, limit = 20): Promise<LikedNoteRecord[]> {
    const { rows } = await this.pool.query<{ id: number; title: string; summary: string; author: string | null }>(
      `SELECT id, title, summary, author FROM liked_notes
       WHERE liked_at > to_timestamp($1 / 1000.0) ORDER BY liked_at DESC LIMIT $2`,
      [sinceMs, limit],
    );
    return rows.map((r) => ({ id: r.id, title: r.title, summary: r.summary, author: r.author ?? undefined }));
  }

  /** 自某时刻起的点赞数。 */
  async countSince(sinceMs: number): Promise<number> {
    const { rows } = await this.pool.query<{ n: string }>(
      'SELECT count(*)::int AS n FROM liked_notes WHERE liked_at > to_timestamp($1 / 1000.0)',
      [sinceMs],
    );
    return Number(rows[0]?.n ?? 0);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
