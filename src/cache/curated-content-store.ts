/**
 * 精选语料库（PostgreSQL，aidcp 库）。change curated-inspiration-corpus，Phase 1。
 *
 * 把「值得当创作灵感」的观测内容（别人的笔记/评论）+「自己机器人的真实动作」（点赞/收藏）
 * 归并落一张表，供创作侧按账号召回灵感。一行 = 一条内容（账号维度去重）。
 *
 * 去重键 dedup_key = `${accountId}::${contentType}::${sourceId}`，UNIQUE。
 *
 * 两类写入语义（关键红线）：
 *  - upsertObservation（观测）：刷新正文/作者/计数/admit_reason/updated_at，**保留 first_seen_at**，
 *    且**绝不**触碰 bot_liked / bot_collected —— 观测不得把已置的「自有动作标记」抹掉。
 *  - markBotAction（自有动作）：
 *      · like   —— 弱信号，只 UPDATE 既有行（行不存在则 no-op，不自动建行）。
 *      · collect —— 强信号，INSERT ... ON CONFLICT 自动建/纳入；无内容时 body 落 ''、
 *        admit_reason 标 content_missing（诚实置空，绝不编造正文）。
 *
 * 召回 selectForCreation：自有动作优先（collected 权重 2、liked 权重 1），再按 collect_count、updated_at。
 * 保留上限：upsertObservation 后按账号裁到 newest retentionMax（按账号、不跨账号），防无界增长。
 */

import pg from 'pg';
import { DEFAULT_PG_CONFIG } from './pg-anchor-cache.js';

const { Pool } = pg;

export type CuratedContentType = 'note' | 'comment';

/** 一次观测：别人的笔记/评论被判定「值得当灵感」时落库/刷新。 */
export interface CuratedObservation {
  accountId: string;
  contentType: CuratedContentType;
  sourceId: string;
  title?: string;
  body: string;
  author?: string;
  sourceUrl?: string;
  topics: string[];
  likeCount?: number | null;
  collectCount?: number | null;
  commentCount?: number | null;
  admitReason: string;
}

/** 自有动作（collect 自动建行）时可附带的内容，缺失即诚实置空，不编造。 */
export interface CuratedActionContent {
  title?: string;
  body?: string;
  author?: string;
  sourceUrl?: string;
  topics?: string[];
}

/** 召回给创作侧的一条灵感。 */
export interface CuratedSelectItem {
  sourceId: string;
  contentType: CuratedContentType;
  title: string;
  body: string;
  author?: string;
  topics: string[];
  likeCount: number | null;
  collectCount: number | null;
  botLiked: boolean;
  botCollected: boolean;
}

export interface CuratedContentStoreOptions {
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  pool?: pg.Pool;
  /** 每账号保留上限（行数），超出裁最旧。默认 1000。 */
  retentionMax?: number;
}

/** 建表 DDL（幂等，columns-right-on-first-ship；本仓无迁移框架）。 */
export const CURATED_CONTENT_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS curated_content (
  id                 SERIAL PRIMARY KEY,
  account_id         TEXT NOT NULL,
  content_type       TEXT NOT NULL CHECK (content_type IN ('note','comment')),
  source_id          TEXT NOT NULL,
  dedup_key          TEXT NOT NULL UNIQUE,
  title              TEXT,
  body               TEXT,
  author             TEXT,
  source_url         TEXT,
  topics             TEXT[] NOT NULL DEFAULT '{}',
  like_count         INT,
  collect_count      INT,
  comment_count      INT,
  counts_captured_at TIMESTAMPTZ,
  bot_liked          BOOLEAN NOT NULL DEFAULT false,
  bot_collected      BOOLEAN NOT NULL DEFAULT false,
  admit_reason       TEXT,
  first_seen_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_curated_content_topics ON curated_content USING GIN(topics);
CREATE INDEX IF NOT EXISTS idx_curated_content_account_updated ON curated_content (account_id, updated_at DESC);
`;

/** 账号维度去重键。 */
function dedupKeyOf(accountId: string, contentType: CuratedContentType, sourceId: string): string {
  return `${accountId}::${contentType}::${sourceId}`;
}

/** INT 列归一为 number | null（诚实置空：缺失/NULL → null，不编造 0）。 */
function toNumOrNull(v: unknown): number | null {
  return v === null || v === undefined ? null : Number(v);
}

interface CuratedRow {
  source_id: string;
  content_type: string;
  title: string | null;
  body: string | null;
  author: string | null;
  topics: string[] | null;
  like_count: number | string | null;
  collect_count: number | string | null;
  bot_liked: boolean;
  bot_collected: boolean;
}

export class CuratedContentStore {
  private readonly pool: pg.Pool;
  private readonly retentionMax: number;

  constructor(options: CuratedContentStoreOptions = {}) {
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

  /** 建表（幂等）。 */
  async init(): Promise<void> {
    await this.pool.query(CURATED_CONTENT_SCHEMA_SQL);
  }

  /**
   * 观测落库/刷新（账号维度去重）。
   * ON CONFLICT DO UPDATE 刷新正文/作者/计数/admit_reason/updated_at（counts_captured_at=now()），
   * **保留 first_seen_at**，且**不触碰 bot_liked / bot_collected**（观测绝不抹掉已置的自有动作标记）。
   * 写后按账号裁到保留上限。
   */
  async upsertObservation(obs: CuratedObservation): Promise<void> {
    const dedupKey = dedupKeyOf(obs.accountId, obs.contentType, obs.sourceId);
    await this.pool.query(
      `INSERT INTO curated_content
         (account_id, content_type, source_id, dedup_key, title, body, author, source_url,
          topics, like_count, collect_count, comment_count, counts_captured_at, admit_reason, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now(), $13, now())
       ON CONFLICT (dedup_key) DO UPDATE SET
         title              = EXCLUDED.title,
         body               = EXCLUDED.body,
         author             = EXCLUDED.author,
         source_url         = EXCLUDED.source_url,
         topics             = EXCLUDED.topics,
         like_count         = EXCLUDED.like_count,
         collect_count      = EXCLUDED.collect_count,
         comment_count      = EXCLUDED.comment_count,
         counts_captured_at = now(),
         admit_reason       = EXCLUDED.admit_reason,
         updated_at         = now()`,
      [
        obs.accountId,
        obs.contentType,
        obs.sourceId,
        dedupKey,
        obs.title ?? null,
        obs.body,
        obs.author ?? null,
        obs.sourceUrl ?? null,
        obs.topics,
        obs.likeCount ?? null,
        obs.collectCount ?? null,
        obs.commentCount ?? null,
        obs.admitReason,
      ],
    );
    await this.trimToRetention(obs.accountId);
  }

  /**
   * 记一次自有动作。
   *  - like：弱信号，只 UPDATE 既有行 bot_liked=true（行不存在则 no-op，不自动建行）。
   *  - collect：强信号，INSERT ... ON CONFLICT 自动建/纳入；无内容时 body '' 且 admit_reason 标 content_missing。
   */
  async markBotAction(
    accountId: string,
    sourceId: string,
    action: 'like' | 'collect',
    content?: CuratedActionContent,
  ): Promise<void> {
    if (action === 'like') {
      // 点赞为弱信号：只标既有行，不自动建行。
      const dedupKeyNote = dedupKeyOf(accountId, 'note', sourceId);
      const dedupKeyComment = dedupKeyOf(accountId, 'comment', sourceId);
      await this.pool.query(
        `UPDATE curated_content SET bot_liked = true, updated_at = now()
         WHERE dedup_key = $1 OR dedup_key = $2`,
        [dedupKeyNote, dedupKeyComment],
      );
      return;
    }
    // collect：自有收藏自动建/纳入（笔记维度）。
    const dedupKey = dedupKeyOf(accountId, 'note', sourceId);
    const admitReason = content?.body ? 'bot_collect' : 'bot_collect(content_missing)';
    await this.pool.query(
      `INSERT INTO curated_content
         (account_id, content_type, source_id, dedup_key, title, body, author, source_url,
          topics, like_count, collect_count, admit_reason, bot_collected, updated_at)
       VALUES ($1, 'note', $2, $3, $4, $5, $6, $7, $8, NULL, NULL, $9, true, now())
       ON CONFLICT (dedup_key) DO UPDATE SET bot_collected = true, updated_at = now()`,
      [
        accountId,
        sourceId,
        dedupKey,
        content?.title ?? null,
        content?.body ?? '',
        content?.author ?? null,
        content?.sourceUrl ?? null,
        content?.topics ?? [],
        admitReason,
      ],
    );
  }

  /**
   * 归档一条「确认点赞成功」的优质评论（change curated-inspiration-corpus Phase 2）。
   * content_type='comment'、bot_liked=true（机器人确实点赞了这条评论）；like_count 暂为 NULL
   * （边端尚未抓逐条评论赞数）；title 复用为来源笔记标题（评论本身无标题，存来源供角度线索上下文）。
   * dedup_key 重复忽略（评论一经确认点赞即归档，不刷新）；写后按账号裁保留上限。
   */
  async archiveComment(
    accountId: string,
    input: { sourceId: string; text: string; author?: string; topics: string[]; sourceNoteTitle?: string; reason?: string },
  ): Promise<void> {
    const dedupKey = dedupKeyOf(accountId, 'comment', input.sourceId);
    await this.pool.query(
      `INSERT INTO curated_content
         (account_id, content_type, source_id, dedup_key, title, body, author, topics,
          like_count, bot_liked, admit_reason, updated_at)
       VALUES ($1, 'comment', $2, $3, $4, $5, $6, $7, NULL, true, $8, now())
       ON CONFLICT (dedup_key) DO NOTHING`,
      [
        accountId,
        input.sourceId,
        dedupKey,
        input.sourceNoteTitle ?? null,
        input.text,
        input.author ?? null,
        input.topics,
        input.reason ? `confirmed_like:${input.reason}` : 'confirmed_like',
      ],
    );
    await this.trimToRetention(accountId);
  }

  /**
   * 召回给创作侧：自有动作优先（collected 权重 2、liked 权重 1），再按 collect_count、updated_at。
   * 按账号 + 内容类型过滤。
   */
  async selectForCreation(
    accountId: string,
    contentType: CuratedContentType,
    limit: number,
  ): Promise<CuratedSelectItem[]> {
    const { rows } = await this.pool.query<CuratedRow>(
      `SELECT source_id, content_type, title, body, author, topics,
              like_count, collect_count, bot_liked, bot_collected
       FROM curated_content
       WHERE account_id = $1 AND content_type = $2
       ORDER BY (CASE WHEN bot_collected THEN 2 ELSE 0 END + CASE WHEN bot_liked THEN 1 ELSE 0 END) DESC,
                collect_count DESC NULLS LAST,
                updated_at DESC
       LIMIT $3`,
      [accountId, contentType, limit],
    );
    return rows.map((r) => ({
      sourceId: r.source_id,
      contentType: (r.content_type === 'comment' ? 'comment' : 'note') as CuratedContentType,
      title: r.title ?? '',
      body: r.body ?? '',
      author: r.author ?? undefined,
      topics: r.topics ?? [],
      likeCount: toNumOrNull(r.like_count),
      collectCount: toNumOrNull(r.collect_count),
      botLiked: r.bot_liked,
      botCollected: r.bot_collected,
    }));
  }

  /** 按账号裁到 newest retentionMax（按账号、不跨账号）。 */
  private async trimToRetention(accountId: string): Promise<void> {
    await this.pool.query(
      `DELETE FROM curated_content
       WHERE account_id = $1
         AND id NOT IN (
           SELECT id FROM curated_content
           WHERE account_id = $1
           ORDER BY updated_at DESC
           LIMIT $2
         )`,
      [accountId, this.retentionMax],
    );
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
