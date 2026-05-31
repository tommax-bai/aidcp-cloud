/**
 * 发布服务（云端）：协调 触发判定 → 内容生成 → 去 AI 味后处理 → 落库 → 经边缘发布。
 *
 * 发布动作本身在浏览器里完成，云端通过 EdgePusher 把 publish.request 推给边缘，
 * 由 edge 侧的 publish flow 实际执行（edge 侧实现不在本任务范围）。
 *
 * 落库：每次生成都会写一条 publish_log（status 流转 draft → published/failed/needs_review）。
 * platform_post_id 在收到 edge 的 publish.result 后由上层回填（updatePostId）。
 */

import pg from 'pg';
import { DEFAULT_PG_CONFIG } from '../cache/pg-anchor-cache.js';
import { makeEnvelope, type Envelope, type PublishRequestPayload } from '../comm/protocol.js';
import type { EdgePusher } from '../comm/ws-server.js';
import { PublishTrigger } from './trigger.js';
import { ContentGenerator } from './generator.js';
import { PostProcessor } from './post-processor.js';
import {
  type GenerateInput,
  type PublishRecord,
  type PublishStatus,
  type TriggerMetrics,
  type TriggerDecision,
} from './types.js';

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

export interface PublishServiceDeps {
  trigger: PublishTrigger;
  generator: ContentGenerator;
  postProcessor: PostProcessor;
  store: PublishLogSink;
  /** 注入时钟（测试用） */
  clock?: () => number;
  /** id 生成器（信封 id，测试用） */
  idGen?: () => string;
  /** 重写后 aiScore 超过该值则标记 needs_review，默认 0.5（约命中 2 项） */
  needsReviewThreshold?: number;
}

/** 一次发布尝试的结果。 */
export interface PublishRunResult {
  /** 触发判定 */
  decision: TriggerDecision;
  /** 是否真正生成并下发了帖子 */
  dispatched: boolean;
  /** 落库记录 id（未发布时为 null） */
  recordId: number | null;
  /** 最终落库状态 */
  status: PublishStatus | null;
  /** 送达的边缘连接数 */
  edgeCount: number;
  /** 下发的信封（便于观测/测试） */
  envelope: Envelope | null;
  /** 后处理命中的禁用词 */
  flaggedPhrases: string[];
}

/** 发布服务：串联触发 → 生成 → 后处理 → 落库 → 下发。 */
export class PublishService {
  private readonly clock: () => number;
  private seq = 0;
  private readonly idGen: () => string;
  private readonly needsReviewThreshold: number;

  constructor(private readonly deps: PublishServiceDeps) {
    this.clock = deps.clock ?? Date.now;
    this.idGen = deps.idGen ?? (() => `pub-${++this.seq}`);
    this.needsReviewThreshold = deps.needsReviewThreshold ?? 0.5;
  }

  /**
   * 跑一次发布流程。
   * @param metrics 触发度量
   * @param input   生成素材（concepts / likedContents / soul / recentPosts）
   * @param pusher  边缘推送器
   * @param edgeId  可选定向 edgeId
   */
  async run(
    metrics: TriggerMetrics,
    input: GenerateInput,
    pusher: EdgePusher,
    edgeId?: string,
  ): Promise<PublishRunResult> {
    const decision = this.deps.trigger.evaluate(metrics);
    if (!decision.shouldPublish) {
      return {
        decision,
        dispatched: false,
        recordId: null,
        status: null,
        edgeCount: 0,
        envelope: null,
        flaggedPhrases: [],
      };
    }

    // 生成内容。
    const generated = await this.deps.generator.generate(input);

    // 去 AI 味后处理。
    const processed = await this.deps.postProcessor.process(generated.content);

    // 决定落库状态：后处理后 aiScore 仍偏高 → needs_review（不下发，等人工）。
    const needsReview = processed.aiScore >= this.needsReviewThreshold;
    const status: PublishStatus = needsReview ? 'needs_review' : 'draft';

    const record: PublishRecord = {
      title: generated.title || null,
      content: processed.content,
      sourceConcepts: input.concepts.map((c) => c.keyword),
      sourceLikedIds: input.likedContents.map((n) => n.id),
      status,
    };
    const recordId = await this.deps.store.insert(record);

    if (needsReview) {
      // 命中过多，不自动发布，留待人工审核。
      return {
        decision,
        dispatched: false,
        recordId,
        status,
        edgeCount: 0,
        envelope: null,
        flaggedPhrases: processed.flaggedPhrases,
      };
    }

    // 下发给边缘执行发布。
    const payload: PublishRequestPayload = {
      title: generated.title,
      content: processed.content,
      tags: generated.tags,
    };
    const envelope = makeEnvelope('publish.request', this.idGen(), this.clock(), payload);
    const edgeCount = pusher.pushToEdges(envelope, edgeId);

    return {
      decision,
      dispatched: edgeCount > 0,
      recordId,
      status,
      edgeCount,
      envelope,
      flaggedPhrases: processed.flaggedPhrases,
    };
  }
}