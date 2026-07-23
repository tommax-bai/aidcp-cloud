/**
 * 优质评论语料库（PostgreSQL，aidcp 库）。change comment-like-on-detail（B 子系统）。
 *
 * 只存「真点赞成功」的别人优质评论，按主题键归档，供发评论时作【参考（仅作灵感，不可照抄）】。
 * 主题键来自来源笔记标题（无 LLM）：拉丁词 + CJK 字符二元组，跨中英文都能给出重叠信号。
 * 去重：dedup_key（= 评论锚点 comment-<id>）UNIQUE，ON CONFLICT DO NOTHING。
 * 保留：全局上限（newest N），插入后裁旧，防无界增长。
 * PII：存了别人的评论原文 + 作者昵称——仅限「已点赞（已是公开互动）」的评论，带保留上限与下方说明。
 */

import pg from 'pg';
import { DEFAULT_PG_CONFIG } from '../kernel/pg-config.js';
import { ensureCapabilitySchema } from '../schema/schema-capability.js';

const { Pool } = pg;

export const VALUABLE_COMMENT_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS valuable_comments (
  id                SERIAL PRIMARY KEY,
  dedup_key         TEXT NOT NULL UNIQUE,
  comment_text      TEXT NOT NULL,
  author            TEXT,
  source_note_id    TEXT,
  source_note_title TEXT,
  topics            TEXT[] NOT NULL DEFAULT '{}',
  reason            TEXT,
  liked_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_valuable_comments_liked_at ON valuable_comments(liked_at DESC);
CREATE INDEX IF NOT EXISTS idx_valuable_comments_topics ON valuable_comments USING GIN(topics);
`;

/** 从笔记标题派生主题键（无 LLM）：小写拉丁词（≥2 长）+ CJK 字符二元组；去重、截断。 */
export function topicKeysFromTitle(title: string | undefined, max = 24): string[] {
  if (!title) return [];
  const keys = new Set<string>();
  // 拉丁/数字词
  const latin = title.toLowerCase().match(/[a-z0-9]{2,}/g) ?? [];
  for (const w of latin) keys.add(w);
  // CJK 字符二元组
  const cjk = title.match(/[一-鿿]/g) ?? [];
  for (let i = 0; i + 1 < cjk.length; i++) keys.add(cjk[i] + cjk[i + 1]);
  return Array.from(keys).slice(0, max);
}

export interface ValuableCommentInput {
  /** 去重键（用评论锚点 comment-<id>）。 */
  dedupKey: string;
  text: string;
  author?: string;
  sourceNoteId?: string;
  sourceNoteTitle?: string;
  topics: string[];
  reason?: string;
  /** 该评论的点赞数（change curated-inspiration-corpus Phase 2b）；valuable_comments 表不存此列、仅透传给精选语料。 */
  likeCount?: number;
}

export interface ValuableCommentRef {
  text: string;
  author?: string;
  sourceNoteTitle?: string;
}

export interface ValuableCommentStoreOptions {
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  pool?: pg.Pool;
  /** 全局保留上限（行数），超出裁最旧。默认 1000。 */
  retentionMax?: number;
}

export class ValuableCommentStore {
  private readonly pool: pg.Pool;
  private readonly retentionMax: number;

  constructor(options: ValuableCommentStoreOptions = {}) {
    this.retentionMax = options.retentionMax ?? 1000;
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

  /** schema 探测（不建表）。 */
  async init(): Promise<void> {
    // DDL 单一所有者（change cloud-schema-migration-executor 任务 5.x）：只探测、不建表。
    // 探不到即带 version id 明确报错并 fail-closed；MUST NOT 在这里把表建出来继续跑。
    await ensureCapabilitySchema(this.pool, {
      capability: 'valuable_comments',
      sinceVersion: '0066_baseline_cache_corpus_tables',
      ddl: [VALUABLE_COMMENT_SCHEMA_SQL],
    });
  }

  /** 归档一条优质评论（dedup_key 唯一，重复忽略）；插入后裁到全局保留上限。 */
  async archive(input: ValuableCommentInput): Promise<void> {
    await this.pool.query(
      `INSERT INTO valuable_comments (dedup_key, comment_text, author, source_note_id, source_note_title, topics, reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (dedup_key) DO NOTHING`,
      [
        input.dedupKey,
        input.text,
        input.author ?? null,
        input.sourceNoteId ?? null,
        input.sourceNoteTitle ?? null,
        input.topics,
        input.reason ?? null,
      ],
    );
    // 全局保留上限：超出则裁最旧（bound 无界增长）。
    await this.pool.query(
      `DELETE FROM valuable_comments
       WHERE id NOT IN (SELECT id FROM valuable_comments ORDER BY liked_at DESC LIMIT $1)`,
      [this.retentionMax],
    );
  }

  /** 按主题键重叠召回最近的优质评论（topics 为空 → 返回空，调用方据此不注入参考）。 */
  async retrieveByTopics(topics: string[], limit = 3): Promise<ValuableCommentRef[]> {
    if (!topics.length) return [];
    const { rows } = await this.pool.query<{ comment_text: string; author: string | null; source_note_title: string | null }>(
      `SELECT comment_text, author, source_note_title FROM valuable_comments
       WHERE topics && $1::text[] ORDER BY liked_at DESC LIMIT $2`,
      [topics, limit],
    );
    return rows.map((r) => ({ text: r.comment_text, author: r.author ?? undefined, sourceNoteTitle: r.source_note_title ?? undefined }));
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
