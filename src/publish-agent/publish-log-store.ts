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
  platform_post_id TEXT,
  publish_metadata JSONB,
  ai_enforced      BOOLEAN NOT NULL DEFAULT false,
  image_url        TEXT,
  images_attached  BOOLEAN NOT NULL DEFAULT false
);
-- 既有表向后兼容（幂等）：A 阶段4 元数据落库 + 防篡改审计列。
ALTER TABLE publish_log ADD COLUMN IF NOT EXISTS publish_metadata JSONB;
ALTER TABLE publish_log ADD COLUMN IF NOT EXISTS ai_enforced BOOLEAN NOT NULL DEFAULT false;
-- publish-media-upload（配图收口）：审计用 image_url + 权威「真有图」信号 images_attached。
ALTER TABLE publish_log ADD COLUMN IF NOT EXISTS image_url TEXT;
ALTER TABLE publish_log ADD COLUMN IF NOT EXISTS images_attached BOOLEAN NOT NULL DEFAULT false;
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
      `INSERT INTO publish_log (title, content, source_concepts, source_liked_ids, status, platform_post_id, image_url, images_attached)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [
        record.title,
        record.content,
        record.sourceConcepts,
        record.sourceLikedIds,
        record.status,
        record.platformPostId ?? null,
        record.imageUrl ?? null,
        // 插入时配图尚未上传，权威信号默认 false；上传成功后由 markImagesAttached 置 true。
        record.imagesAttached ?? false,
      ],
    );
    return rows[0].id;
  }

  /** 配图收口：标记该帖配图是否真实附着（降级纯文字时为 false）。image_url 保留供审计。 */
  async markImagesAttached(id: number, attached: boolean): Promise<void> {
    await this.pool.query('UPDATE publish_log SET images_attached = $2 WHERE id = $1', [id, attached]);
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

  /** 落库发帖元数据（A 阶段4 血缘/可观测）+ 防篡改审计标记。 */
  async recordMetadata(id: number, metadata: unknown, aiEnforced: boolean): Promise<void> {
    await this.pool.query('UPDATE publish_log SET publish_metadata = $2, ai_enforced = $3 WHERE id = $1', [
      id,
      JSON.stringify(metadata),
      aiEnforced,
    ]);
  }

  /** 最近一次发布的时间戳（毫秒）；无记录返回 null。供 PublishScheduler 概念积累扳机基准。 */
  async getMostRecentPublishTime(): Promise<number | null> {
    const { rows } = await this.pool.query<{ ts: string | null }>(
      `SELECT extract(epoch from max(published_at)) * 1000 AS ts FROM publish_log WHERE status = 'published'`,
    );
    const ts = rows[0]?.ts;
    return ts == null ? null : Number(ts);
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
