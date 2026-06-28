/**
 * publish_log 持久化（PostgreSQL，aidcp 库）。
 *
 * 从 src/publish/publisher.ts 迁移而来，作为独立模块存在于 publish-agent/ 下。
 */

import pg from 'pg';
import { DEFAULT_PG_CONFIG } from '../cache/pg-anchor-cache.js';
import type { PublishRecord, PublishStatus, PublishMetadata } from './types.js';

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
                   CHECK (status IN ('draft','pending_approval','published','failed','needs_review')),
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
-- publish-history-account-and-detail：
--   account_id（迁移 0005 已加；此处补进 canonical SQL，使全新 init() 的库也有该列，insert 真正写入真实账号）；
--   post_url（带 xsec_token 的完整详情页分享 URL，发布成功后回写；抓不到存 NULL）。
ALTER TABLE publish_log ADD COLUMN IF NOT EXISTS account_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE publish_log ADD COLUMN IF NOT EXISTS post_url TEXT;
CREATE INDEX IF NOT EXISTS idx_publish_log_account ON publish_log (account_id);
-- decouple-publish-generation-from-dispatch：status 增加 'pending_approval'（生成候审段产物、待人审、未下发）。
-- 既有表的 CHECK 约束需放开新取值（幂等：先 DROP IF EXISTS 默认约束名再以新集合重建）。无新表/新列。
ALTER TABLE publish_log DROP CONSTRAINT IF EXISTS publish_log_status_check;
ALTER TABLE publish_log ADD CONSTRAINT publish_log_status_check
  CHECK (status IN ('draft','pending_approval','published','failed','needs_review'));
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
  return s === 'published' || s === 'failed' || s === 'needs_review' || s === 'pending_approval' ? s : 'draft';
}

/**
 * 下发段从落库草稿重建发布所需的最小快照（change decouple-publish-generation-from-dispatch）。
 * 标题/正文/图取自 publish_log 列；话题与发帖元数据取自 publish_metadata JSONB（生成候审段经 recordMetadata 落库）。
 * 下发忠于此快照、绝不重生成（陈旧亦照发）。
 */
export interface DispatchDraft {
  recordId: number;
  accountId: string;
  title: string | null;
  content: string;
  imageUrl: string | null;
  /** 发帖元数据（含 topics/mentions/location/collection/visibility/permissions/mode/publishTime/compliance）；缺则 null。 */
  metadata: PublishMetadata | null;
  status: PublishStatus;
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
      `INSERT INTO publish_log (title, content, source_concepts, source_liked_ids, status, platform_post_id, image_url, images_attached, account_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
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
        // 发布账号：来自触发上下文；缺省回落 'default'（单账号向后兼容），让发布历史可真正按账号区分。
        record.accountId ?? 'default',
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

  /**
   * 发布成功后回填平台帖子 id（并置为 published）；可选回写带 xsec_token 的完整详情页分享 URL。
   * postUrl 缺省/为 null 时不覆盖既有值（边缘抓不到 URL 时诚实置空，绝不写假链接）。
   */
  async updatePostId(id: number, postId: string, postUrl?: string | null): Promise<void> {
    await this.pool.query(
      `UPDATE publish_log SET platform_post_id = $2, post_url = COALESCE($3, post_url), status = 'published' WHERE id = $1`,
      [id, postId, postUrl ?? null],
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

  /** 列出所有待审草稿 id（change decouple-publish-generation-from-dispatch）：供下发段兜底扫描补触发。 */
  async listPendingApprovalIds(): Promise<number[]> {
    const { rows } = await this.pool.query<{ id: number }>(
      `SELECT id FROM publish_log WHERE status = 'pending_approval' ORDER BY id ASC`,
    );
    return rows.map((r) => r.id);
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

  /**
   * 读回一条草稿快照供下发段重建发布输入（change decouple-publish-generation-from-dispatch）。
   * 不限状态（下发段自行据 status 幂等去重）；不存在返回 null。MUST NOT 触发重生成——只读已落库的冻结草稿。
   */
  async loadForDispatch(recordId: number): Promise<DispatchDraft | null> {
    const { rows } = await this.pool.query<{
      id: number;
      account_id: string | null;
      title: string | null;
      content: string;
      image_url: string | null;
      publish_metadata: unknown;
      status: string;
    }>(
      `SELECT id, account_id, title, content, image_url, publish_metadata, status
       FROM publish_log WHERE id = $1`,
      [recordId],
    );
    const r = rows[0];
    if (!r) return null;
    let metadata: PublishMetadata | null = null;
    if (r.publish_metadata != null) {
      // JSONB 列：pg 驱动通常已解析为对象；兼容字符串形态。解析失败诚实置 null（下发走保守默认、不崩）。
      try {
        metadata = (typeof r.publish_metadata === 'string'
          ? JSON.parse(r.publish_metadata)
          : r.publish_metadata) as PublishMetadata;
      } catch {
        metadata = null;
      }
    }
    return {
      recordId: r.id,
      accountId: r.account_id ?? 'default',
      title: r.title,
      content: r.content,
      imageUrl: r.image_url,
      metadata,
      status: toStatus(r.status),
    };
  }

  /**
   * 该账号是否已有一份未推进终态的待审草稿（change decouple-publish-generation-from-dispatch）。
   * 用于生成段堆积保护：已有 pending_approval 草稿时不再为该账号生成新草稿。
   */
  async hasPendingApprovalForAccount(accountId: string): Promise<boolean> {
    const { rows } = await this.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM publish_log WHERE account_id = $1 AND status = 'pending_approval'`,
      [accountId],
    );
    return Number(rows[0]?.n ?? '0') > 0;
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
  updatePostId(id: number, postId: string, postUrl?: string | null): Promise<void>;
  updateStatus(id: number, status: PublishStatus): Promise<void>;
}
