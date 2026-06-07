/**
 * publish_log 持久化（PostgreSQL，aidcp 库）。
 *
 * 从 src/publish/publisher.ts 迁移而来，作为独立模块存在于 publish-agent/ 下。
 */

import pg from 'pg';
import { DEFAULT_PG_CONFIG } from '../cache/pg-anchor-cache.js';
import type { PublishRecord, PublishStatus } from './types.js';

const { Pool } = pg;

/** publish_log 建表 DDL（幂等）。 */
export const PUBLISH_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS publish_log (
  id               SERIAL PRIMARY KEY,
  published_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  title            TEXT,
  content          TEXT NOT NULL,
  source_concepts  TEXT[] NOT NULL DEFAULT '{}',
  source_liked_ids INT[] DEFAULT '{}',
  status           TEXT NOT NULL DEFAULT 'draft'
                   CHECK (status IN ('draft','published','failed','needs_review')),
  platform_post_id TEXT
);
`;

export interface PublishLogStoreOptions {
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  pool?: pg.Pool;
}

interface PublishRow {
  id: number;
  title: string | null;
  content: string;
  source_concepts: string[] | null;
  source_liked_ids: number[] | null;
  status: string;
  platform_post_id: string | null;
}

function toStatus(s: string): PublishStatus {
  return s === 'published' || s === 'failed' || s === 'needs_review' ? s : 'draft';
}

/** publish_log 持久化（PostgreSQL，aidcp 库）。 */
export class PublishLogStore {
  private readonly pool: pg.Pool;

  constructor(options: PublishLogStoreOptions = {}) {
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

  /** 初始化表（幂等）。 */
  async init(): Promise<void> {
    await this.pool.query(PUBLISH_SCHEMA_SQL);
  }

  /** 写入一条发布记录，返回新行 id。 */
  async insert(record: PublishRecord): Promise<number> {
    const { rows } = await this.pool.query<{ id: number }>(
      `INSERT INTO publish_log (title, content, source_concepts, source_liked_ids, status, platform_post_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [
        record.title,
        record.content,
        record.sourceConcepts,
        record.sourceLikedIds,
        record.status,
        record.platformPostId ?? null,
      ],
    );
    return rows[0].id;
  }

  /** 更新一条记录的状态。 */
  async updateStatus(id: number, status: PublishStatus): Promise<void> {
    await this.pool.query('UPDATE publish_log SET status = $2 WHERE id = $1', [id, status]);
  }

  /** 发布成功后回填平台帖子 id（并置为 published）。 */
  async updatePostId(id: number, postId: string): Promise<void> {
    await this.pool.query(
      `UPDATE publish_log SET platform_post_id = $2, status = 'published' WHERE id = $1`,
      [id, postId],
    );
  }

  /** 取最近 n 篇已发布帖子的正文（供生成时避免重复话题）。 */
  async recentPublishedContents(limit = 3): Promise<string[]> {
    const { rows } = await this.pool.query<{ content: string }>(
      `SELECT content FROM publish_log WHERE status = 'published'
       ORDER BY published_at DESC LIMIT $1`,
      [limit],
    );
    return rows.map((r) => r.content);
  }

  /** 取最近一条发布记录（任意状态），用于计算距上次发布时长。 */
  async latest(): Promise<PublishRecord | null> {
    const { rows } = await this.pool.query<PublishRow>(
      `SELECT id, title, content, source_concepts, source_liked_ids, status, platform_post_id
       FROM publish_log ORDER BY published_at DESC LIMIT 1`,
    );
    const r = rows[0];
    if (!r) return null;
    return {
      id: r.id,
      title: r.title,
      content: r.content,
      sourceConcepts: r.source_concepts ?? [],
      sourceLikedIds: r.source_liked_ids ?? [],
      status: toStatus(r.status),
      platformPostId: r.platform_post_id,
    };
  }

  /** 关闭连接池。 */
  async close(): Promise<void> {
    await this.pool.end();
  }
}

/** 发布记录的最小存储接口（便于单测打桩，不依赖真实 PG）。 */
export interface PublishLogSink {
  insert(record: PublishRecord): Promise<number>;
  updatePostId(id: number, postId: string): Promise<void>;
  updateStatus(id: number, status: PublishStatus): Promise<void>;
}
