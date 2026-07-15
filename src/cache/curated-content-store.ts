/**
 * 精选语料库（PostgreSQL，aidcp 库）。change curated-inspiration-corpus，Phase 1。
 *
 * 把「值得当创作灵感」的观测内容（别人的笔记/评论）+「自己机器人的真实动作」（点赞/收藏）
 * 归并落一张表，供创作侧按账号召回灵感。一行 = 一条内容（账号维度去重）。
 *
 * 去重键 dedup_key = `${accountId}::${contentType}::${sourceId}`，UNIQUE。
 *
 * 两类写入语义（关键红线）：
 *  - upsertObservation（观测）：非空正文才写入；刷新正文/作者/计数/admit_reason/updated_at，**保留 first_seen_at**，
 *    且**绝不**触碰 bot_liked / bot_collected —— 观测不得把已置的「自有动作标记」抹掉。
 *  - markBotAction（自有动作）：
 *      · like   —— 弱信号，只 UPDATE 既有行（行不存在则 no-op，不自动建行）。
 *      · collect —— 强信号，有非空正文时 INSERT ... ON CONFLICT 自动建/纳入；
 *        无非空正文时只补标记既有行，绝不补建空正文精选壳行。
 *
 * 召回 selectForCreation：自有动作优先（collected 权重 2、liked 权重 1），再按 collect_count、updated_at。
 * 保留上限：upsertObservation 后按账号裁到 newest retentionMax（按账号、不跨账号），防无界增长。
 */

import pg from 'pg';
import { DEFAULT_PG_CONFIG } from './pg-anchor-cache.js';
import type { ReferenceVisualAnalysis } from '../publish-agent/visual-reference-types.js';
import type { VisualAnalysisAnchor } from '../publish-agent/visual-reference-analyzer.js';
import { normalizeReferenceVisualAnalysis } from '../publish-agent/visual-reference-analyzer.js';

const { Pool } = pg;

export type CuratedSourceContentType = 'image_text' | 'video';
export type CuratedContentType = CuratedSourceContentType | 'comment';
export type CuratedContentTypeFilter = CuratedContentType | 'note' | 'source_post';

export type CuratedReferenceImageStatus = 'stored' | 'url_only' | 'fetch_failed' | 'unsupported';

/**
 * 封面形态枚举（change textcard-cover-form，design D3）。
 * 持久化四值收窄：screenshot 等并入 other（无行为差异的分类是死分类）；
 * 管线层的 unknown（未感知/失败/低置信）不入库——error 不持久化、无负缓存。
 */
export type CuratedCoverForm = 'text_card' | 'photo' | 'illustration' | 'other';

/**
 * 参照图形态感知注解（change textcard-cover-form，design D1/D3）。
 * 注解是缓存不是事实源：`detectedFor` 为判定锚（= 判定时该 item 的 capturedAt，重抓必变、零 TTL）；
 * 被观测刷新洗掉 = 下次发布重测，自愈。刻意**不含**颜色/坐标/OCR 文本字段（防搬运结构隔离，D13）。
 */
export interface CuratedReferenceImageFormGuess {
  form: CuratedCoverForm;
  /** 置信度 0..1（原样持久化；阈值在消费端施加——存观测不存策略）。 */
  confidence: number;
  /** 判定时刻（epoch ms，正整数）。 */
  detectedAt: number;
  /** 判定锚 = 判定时 item 的 capturedAt（epoch ms，正整数）；与 item 当前 capturedAt 相等才算缓存命中。 */
  detectedFor: number;
  /** 判定用的视觉模型名（非空）。 */
  model: string;
  /** 判定用的厂商 id（可缺）。 */
  provider?: string;
}

export interface CuratedReferenceImage {
  index: number;
  sourceUrl: string;
  ossUrl?: string;
  width?: number;
  height?: number;
  alt?: string;
  captureStatus: CuratedReferenceImageStatus;
  capturedAt: number;
  /** 形态感知注解（change textcard-cover-form）；经白名单校验，非法即整体丢弃、保图片本体。 */
  formGuess?: CuratedReferenceImageFormGuess;
}

export interface CuratedReferenceImageInput {
  index?: number;
  url?: string;
  sourceUrl?: string;
  ossUrl?: string;
  width?: number;
  height?: number;
  alt?: string;
  captureStatus?: CuratedReferenceImageStatus;
  capturedAt?: number;
  /** 原始形态注解（DB/上游 JSON 未经校验，unknown；normalize 白名单校验后才带出）。 */
  formGuess?: unknown;
}

export type CuratedReferenceImageRelocator = (ctx: {
  accountId: string;
  sourceId: string;
  images: CuratedReferenceImage[];
}) => Promise<CuratedReferenceImage[]>;

// 抓取精选集时每条内容持久化的参考图上限（灵感素材池，非发布图张数）。18 = 小红书单帖图片数上界。
// 与发布侧 IMAGE_COUNT_HARD_MAX/REFERENCE_IMAGE_MAX_COUNT=9（小红书图文帖硬约束）解耦：
// 存全一篇的图、发布生成仍只取子集（≤9）。
export const CURATED_REFERENCE_IMAGE_DEFAULT_LIMIT = 18;
export const CURATED_REFERENCE_IMAGE_HARD_MAX = 18;

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
  referenceImages?: CuratedReferenceImageInput[];
}

/** 自有动作（collect 自动建行）时可附带的内容；缺少非空正文时不补建精选壳行。 */
export interface CuratedActionContent {
  title?: string;
  body?: string;
  author?: string;
  sourceUrl?: string;
  topics?: string[];
  mediaType?: CuratedSourceContentType;
  referenceImages?: CuratedReferenceImageInput[];
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
  referenceImages: CuratedReferenceImage[];
  visualAnalysis?: ReferenceVisualAnalysis;
}

/**
 * 面板（后台管理）用的一行完整视图（camelCase、时间戳 epoch ms）。
 * 与召回视图 CuratedSelectItem 不同：带 id（删除需用）+ 全字段，供运营查看 / 治理。
 * 计数诚实置空：缺失为 null（区别真实 0）；时间戳缺失为 null。
 */
export interface CuratedPanelRow {
  id: number;
  accountId: string;
  contentType: CuratedContentType;
  sourceId: string;
  title: string | null;
  body: string | null;
  author: string | null;
  sourceUrl: string | null;
  topics: string[];
  likeCount: number | null;
  collectCount: number | null;
  commentCount: number | null;
  countsCapturedAt: number | null;
  botLiked: boolean;
  botCollected: boolean;
  admitReason: string | null;
  firstSeenAt: number;
  updatedAt: number;
  referenceImages: CuratedReferenceImage[];
  visualAnalysis?: ReferenceVisualAnalysis;
}

/** 面板列表结果：当前筛选下的一页行 + 一致的总条数（供分页器）。 */
export interface CuratedPanelListResult {
  items: CuratedPanelRow[];
  total: number;
}

/** 面板筛选面：驱动筛选下拉 + 清理前影响预览（按账号）。 */
export interface CuratedFacets {
  /** 该账号实际出现的纳入原因去重 + 各自计数 + 携机器人点赞/收藏标记的高权重行数。 */
  admitReasons: { admitReason: string | null; count: number; botActionCount: number }[];
  imageTextCount: number;
  videoCount: number;
  /** 兼容旧前端：noteCount = imageTextCount + videoCount。 */
  noteCount: number;
  commentCount: number;
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
  referenceImageLimit?: number;
  referenceImageRelocator?: CuratedReferenceImageRelocator;
  logger?: Pick<Console, 'warn'>;
}

/** 建表 DDL（幂等，columns-right-on-first-ship；本仓无迁移框架）。 */
export const CURATED_CONTENT_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS curated_content (
  id                 SERIAL PRIMARY KEY,
  account_id         TEXT NOT NULL,
  content_type       TEXT NOT NULL CHECK (content_type IN ('image_text','video','comment')),
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
  reference_images   JSONB NOT NULL DEFAULT '[]'::jsonb,
  visual_analysis    JSONB,
  bot_liked          BOOLEAN NOT NULL DEFAULT false,
  bot_collected      BOOLEAN NOT NULL DEFAULT false,
  admit_reason       TEXT,
  first_seen_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE curated_content ADD COLUMN IF NOT EXISTS reference_images JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE curated_content ADD COLUMN IF NOT EXISTS visual_analysis JSONB;
CREATE INDEX IF NOT EXISTS idx_curated_content_topics ON curated_content USING GIN(topics);
CREATE INDEX IF NOT EXISTS idx_curated_content_account_updated ON curated_content (account_id, updated_at DESC);

DO $$
BEGIN
  IF to_regclass('public.curated_content') IS NOT NULL THEN
    ALTER TABLE curated_content DROP CONSTRAINT IF EXISTS curated_content_content_type_check;

    -- split-curated-source-media-types：存量 note 无法可靠反推是否视频，统一迁为 image_text。
    UPDATE curated_content target
       SET bot_liked = target.bot_liked OR legacy.bot_liked,
           bot_collected = target.bot_collected OR legacy.bot_collected,
           title = COALESCE(target.title, legacy.title),
           body = COALESCE(NULLIF(target.body, ''), legacy.body),
           author = COALESCE(target.author, legacy.author),
           source_url = COALESCE(target.source_url, legacy.source_url),
           topics = CASE WHEN COALESCE(array_length(target.topics, 1), 0) = 0 THEN legacy.topics ELSE target.topics END,
           reference_images = CASE
                                WHEN target.reference_images = '[]'::jsonb THEN legacy.reference_images
                                ELSE target.reference_images
                              END,
           like_count = COALESCE(target.like_count, legacy.like_count),
           collect_count = COALESCE(target.collect_count, legacy.collect_count),
           comment_count = COALESCE(target.comment_count, legacy.comment_count),
           admit_reason = COALESCE(target.admit_reason, legacy.admit_reason),
           updated_at = GREATEST(target.updated_at, legacy.updated_at)
      FROM curated_content legacy
     WHERE target.account_id = legacy.account_id
       AND target.source_id = legacy.source_id
       AND target.content_type = 'image_text'
       AND legacy.content_type = 'note'
       AND target.id <> legacy.id;

    DELETE FROM curated_content legacy
      USING curated_content target
     WHERE target.account_id = legacy.account_id
       AND target.source_id = legacy.source_id
       AND target.content_type = 'image_text'
       AND legacy.content_type = 'note'
       AND target.id <> legacy.id;

    UPDATE curated_content
       SET content_type = 'image_text',
           dedup_key = account_id || '::image_text::' || source_id
     WHERE content_type = 'note';

    ALTER TABLE curated_content
      ADD CONSTRAINT curated_content_content_type_check
      CHECK (content_type IN ('image_text','video','comment'));
  END IF;
END $$;
`;

/** 账号维度去重键。 */
function dedupKeyOf(accountId: string, contentType: CuratedContentType, sourceId: string): string {
  return `${accountId}::${contentType}::${sourceId}`;
}

function normalizeContentType(value: string): CuratedContentType {
  if (value === 'comment') return 'comment';
  if (value === 'video') return 'video';
  return 'image_text';
}

function normalizeSourceMediaType(value: unknown): CuratedSourceContentType {
  return value === 'video' ? 'video' : 'image_text';
}

function appendContentTypeFilter(conds: string[], params: unknown[], contentType: CuratedContentTypeFilter): void {
  if (contentType === 'note' || contentType === 'source_post') {
    conds.push(`content_type IN ('image_text', 'video')`);
    return;
  }
  params.push(contentType);
  conds.push(`content_type = $${params.length}`);
}

/** INT 列归一为 number | null（诚实置空：缺失/NULL → null，不编造 0）。 */
function toNumOrNull(v: unknown): number | null {
  return v === null || v === undefined ? null : Number(v);
}

function clampReferenceImageLimit(limit: number | undefined): number {
  const raw = limit ?? CURATED_REFERENCE_IMAGE_DEFAULT_LIMIT;
  if (!Number.isFinite(raw)) return CURATED_REFERENCE_IMAGE_DEFAULT_LIMIT;
  return Math.max(0, Math.min(CURATED_REFERENCE_IMAGE_HARD_MAX, Math.floor(raw)));
}

function cleanOptionalString(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t ? t : undefined;
}

function cleanReferenceUrl(v: unknown): string | undefined {
  const t = cleanOptionalString(v);
  if (!t) return undefined;
  try {
    const u = new URL(t);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : undefined;
  } catch {
    return undefined;
  }
}

function positiveInt(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined;
}

function isReferenceImageStatus(v: unknown): v is CuratedReferenceImageStatus {
  return v === 'stored' || v === 'url_only' || v === 'fetch_failed' || v === 'unsupported';
}

/** 形态枚举守卫（感知服务解析模型输出也复用此守卫，枚举只此一处）。 */
export function isCuratedCoverForm(v: unknown): v is CuratedCoverForm {
  return v === 'text_card' || v === 'photo' || v === 'illustration' || v === 'other';
}

/** 严格正整数（形态注解时间戳专用：0/负数/小数/非数一律不合法——区别于 positiveInt 的 ≥0 取整语义）。 */
function strictPositiveInt(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : undefined;
}

/**
 * 形态注解白名单归一（change textcard-cover-form）：form ∈ 枚举、confidence 有限数 ∈[0,1]、
 * detectedAt/detectedFor 正整数、model 非空字符串；**任一项非法 → 整体丢弃注解（undefined）**，
 * 由调用方保留图片本体字段（绝不因注解脏而丢图、绝不抛错）。provider 可缺，非法只丢 provider。
 */
export function normalizeCuratedReferenceImageFormGuess(v: unknown): CuratedReferenceImageFormGuess | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  if (!isCuratedCoverForm(o.form)) return undefined;
  const confidence = o.confidence;
  if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    return undefined;
  }
  const detectedAt = strictPositiveInt(o.detectedAt);
  const detectedFor = strictPositiveInt(o.detectedFor);
  if (detectedAt === undefined || detectedFor === undefined) return undefined;
  const model = cleanOptionalString(o.model);
  if (!model) return undefined;
  const provider = cleanOptionalString(o.provider);
  return {
    form: o.form,
    confidence,
    detectedAt,
    detectedFor,
    model,
    ...(provider ? { provider } : {}),
  };
}

export function normalizeCuratedReferenceImages(
  input: CuratedReferenceImageInput[] | undefined,
  opts: { now?: number; limit?: number; defaultStatus?: CuratedReferenceImageStatus } = {},
): CuratedReferenceImage[] {
  if (!Array.isArray(input) || input.length === 0) return [];
  const now = opts.now ?? Date.now();
  const limit = clampReferenceImageLimit(opts.limit);
  if (limit <= 0) return [];
  const seen = new Set<string>();
  const out: CuratedReferenceImage[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') continue;
    const sourceUrl = cleanReferenceUrl(raw.sourceUrl ?? raw.url);
    const ossUrl = cleanReferenceUrl(raw.ossUrl);
    if (!sourceUrl && !ossUrl) continue;
    const dedupeKey = sourceUrl ?? ossUrl!;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    const width = positiveInt(raw.width);
    const height = positiveInt(raw.height);
    const alt = cleanOptionalString(raw.alt);
    const idx = positiveInt(raw.index);
    // 形态注解白名单（change textcard-cover-form）：非法只丢 formGuess、图片本体照常保留。
    const formGuess = normalizeCuratedReferenceImageFormGuess(raw.formGuess);
    out.push({
      index: idx ?? out.length,
      sourceUrl: sourceUrl ?? ossUrl!,
      ...(ossUrl ? { ossUrl } : {}),
      ...(width !== undefined ? { width } : {}),
      ...(height !== undefined ? { height } : {}),
      ...(alt ? { alt } : {}),
      captureStatus: isReferenceImageStatus(raw.captureStatus) ? raw.captureStatus : opts.defaultStatus ?? (ossUrl ? 'stored' : 'url_only'),
      capturedAt: positiveInt(raw.capturedAt) ?? now,
      ...(formGuess ? { formGuess } : {}),
    });
    if (out.length >= limit) break;
  }
  return out;
}

function parseReferenceImages(v: unknown): CuratedReferenceImage[] {
  if (Array.isArray(v)) {
    return normalizeCuratedReferenceImages(v as CuratedReferenceImageInput[], {
      limit: CURATED_REFERENCE_IMAGE_HARD_MAX,
    });
  }
  if (typeof v === 'string' && v.trim()) {
    try {
      const parsed = JSON.parse(v) as CuratedReferenceImageInput[];
      return parseReferenceImages(parsed);
    } catch {
      return [];
    }
  }
  return [];
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
  reference_images: unknown;
  visual_analysis: unknown;
}

/** 面板列表用的完整 snake-case 行（含 id 与全字段；total_count 来自 COUNT(*) OVER()）。 */
interface CuratedPanelDbRow {
  id: number;
  account_id: string;
  content_type: string;
  source_id: string;
  title: string | null;
  body: string | null;
  author: string | null;
  source_url: string | null;
  topics: string[] | null;
  like_count: number | string | null;
  collect_count: number | string | null;
  comment_count: number | string | null;
  counts_captured_at: Date | null;
  bot_liked: boolean;
  bot_collected: boolean;
  admit_reason: string | null;
  first_seen_at: Date;
  updated_at: Date;
  total_count?: number | string;
  reference_images: unknown;
  visual_analysis: unknown;
}

/** snake-case 行 → 面板 camelCase 视图（时间戳转 epoch ms、INT 诚实置空）。 */
function rowToPanelView(r: CuratedPanelDbRow): CuratedPanelRow {
  const visualAnalysis = normalizeReferenceVisualAnalysis(r.visual_analysis);
  return {
    id: r.id,
    accountId: r.account_id,
    contentType: normalizeContentType(r.content_type),
    sourceId: r.source_id,
    title: r.title,
    body: r.body,
    author: r.author,
    sourceUrl: r.source_url,
    topics: r.topics ?? [],
    likeCount: toNumOrNull(r.like_count),
    collectCount: toNumOrNull(r.collect_count),
    commentCount: toNumOrNull(r.comment_count),
    countsCapturedAt: r.counts_captured_at ? r.counts_captured_at.getTime() : null,
    botLiked: r.bot_liked,
    botCollected: r.bot_collected,
    admitReason: r.admit_reason,
    firstSeenAt: r.first_seen_at.getTime(),
    updatedAt: r.updated_at.getTime(),
    referenceImages: parseReferenceImages(r.reference_images),
    ...(visualAnalysis ? { visualAnalysis } : {}),
  };
}

export class CuratedContentStore {
  private readonly pool: pg.Pool;
  private readonly retentionMax: number;
  private readonly referenceImageLimit: number;
  private readonly referenceImageRelocator?: CuratedReferenceImageRelocator;
  private readonly logger?: Pick<Console, 'warn'>;

  constructor(options: CuratedContentStoreOptions = {}) {
    this.retentionMax = options.retentionMax ?? 1000;
    this.referenceImageLimit = clampReferenceImageLimit(options.referenceImageLimit);
    this.referenceImageRelocator = options.referenceImageRelocator;
    this.logger = options.logger;
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

  private async prepareReferenceImages(
    accountId: string,
    sourceId: string,
    input: CuratedReferenceImageInput[] | undefined,
  ): Promise<CuratedReferenceImage[]> {
    const normalized = normalizeCuratedReferenceImages(input, { limit: this.referenceImageLimit });
    if (normalized.length === 0 || !this.referenceImageRelocator) return normalized;
    try {
      return normalizeCuratedReferenceImages(await this.referenceImageRelocator({ accountId, sourceId, images: normalized }), {
        limit: this.referenceImageLimit,
      });
    } catch (err) {
      this.logger?.warn?.(`[CuratedContentStore] reference image relocation failed: ${(err as Error).message}`);
      return normalized;
    }
  }

  /**
   * 观测落库/刷新（账号维度去重）；正文为空则不写入精选素材。
   * ON CONFLICT DO UPDATE 刷新正文/作者/计数/admit_reason/updated_at（counts_captured_at=now()），
   * **保留 first_seen_at**，且**不触碰 bot_liked / bot_collected**（观测绝不抹掉已置的自有动作标记）。
   * 写后按账号裁到保留上限。
   */
  async upsertObservation(obs: CuratedObservation): Promise<void> {
    const body = obs.body.trim();
    if (!body) return;
    const dedupKey = dedupKeyOf(obs.accountId, obs.contentType, obs.sourceId);
    const referenceImages = await this.prepareReferenceImages(obs.accountId, obs.sourceId, obs.referenceImages);
    await this.pool.query(
      `INSERT INTO curated_content
         (account_id, content_type, source_id, dedup_key, title, body, author, source_url,
          topics, reference_images, like_count, collect_count, comment_count, counts_captured_at, admit_reason, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13, now(), $14, now())
       ON CONFLICT (dedup_key) DO UPDATE SET
         title              = EXCLUDED.title,
         body               = EXCLUDED.body,
         author             = EXCLUDED.author,
         source_url         = EXCLUDED.source_url,
         topics             = EXCLUDED.topics,
         reference_images   = CASE
                                WHEN EXCLUDED.reference_images = '[]'::jsonb THEN curated_content.reference_images
                                ELSE EXCLUDED.reference_images
                              END,
         visual_analysis    = CASE
                                WHEN EXCLUDED.reference_images = '[]'::jsonb THEN curated_content.visual_analysis
                                WHEN EXCLUDED.reference_images = curated_content.reference_images THEN curated_content.visual_analysis
                                ELSE NULL
                              END,
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
        body,
        obs.author ?? null,
        obs.sourceUrl ?? null,
        obs.topics,
        JSON.stringify(referenceImages),
        obs.likeCount ?? null,
        obs.collectCount ?? null,
        obs.commentCount ?? null,
        obs.admitReason,
      ],
    );
    await this.trimToRetention(obs.accountId);
  }

  async refreshReferenceImages(
    accountId: string,
    sourceId: string,
    contentType: CuratedSourceContentType,
    input: CuratedReferenceImageInput[] | undefined,
  ): Promise<number> {
    const referenceImages = await this.prepareReferenceImages(accountId, sourceId, input);
    if (referenceImages.length === 0) return 0;
    const { rowCount } = await this.pool.query(
      `UPDATE curated_content
          SET reference_images = $4::jsonb,
              visual_analysis = NULL,
              updated_at = now()
        WHERE account_id = $1
          AND source_id = $2
          AND content_type = $3`,
      [accountId, sourceId, contentType, JSON.stringify(referenceImages)],
    );
    return rowCount ?? 0;
  }

  /**
   * 形态注解定点回写（change textcard-cover-form，design D1 修正）。
   *
   * 单条 UPDATE + jsonb_set **只写目标 item 的 formGuess**（`index` 为 reference_images
   * JSONB 数组下标，非 item 的 index 字段），WHERE 内嵌 capturedAt 锚比对：
   * 目标 item 存在 且（item 无 capturedAt 或 = guess.detectedFor）才写；锚不符即 0 行**弃写**
   * （浏览闭环刚整体替换了图集数组——绝不覆盖新图集）。PG 行锁下单语句原子，
   * MUST NOT 以「JS 读-改-整数组回写」实现（TOCTOU 会把新图集盖回旧值）。
   *
   * 同一条语句顺带把归一化 capturedAt（= guess.detectedFor）落盘作锚——存量缺 capturedAt 的
   * item 若不落锚则缓存永不命中、每次发布白付一次视觉调用。
   *
   * 红线：**绝不触碰行 updated_at**（selectForCreation 按其排序，抬了扰动创作召回）。
   * 返回是否真写入（rowCount>0）；guess 不过白名单/参数非法 → 直接 false，绝不抛错。
   */
  async annotateReferenceImageFormGuess(
    rowId: number,
    index: number,
    guess: CuratedReferenceImageFormGuess,
  ): Promise<boolean> {
    const normalized = normalizeCuratedReferenceImageFormGuess(guess);
    if (!normalized || !Number.isInteger(rowId) || !Number.isInteger(index) || index < 0) {
      this.logger?.warn?.(
        `[CuratedContentStore] annotateReferenceImageFormGuess rejected invalid input (rowId=${rowId}, index=${index})`,
      );
      return false;
    }
    const { rowCount } = await this.pool.query(
      `UPDATE curated_content
          SET reference_images = jsonb_set(
                jsonb_set(
                  reference_images,
                  ARRAY[$2::text, 'capturedAt'],
                  COALESCE(reference_images #> ARRAY[$2::text, 'capturedAt'], to_jsonb($4::bigint)),
                  true
                ),
                ARRAY[$2::text, 'formGuess'],
                $3::jsonb,
                true
              )
        WHERE id = $1
          AND jsonb_typeof(reference_images #> ARRAY[$2::text]) = 'object'
          AND (reference_images #> ARRAY[$2::text, 'capturedAt'] IS NULL
               OR reference_images #> ARRAY[$2::text, 'capturedAt'] = to_jsonb($4::bigint))`,
      [rowId, String(index), JSON.stringify(normalized), normalized.detectedFor],
    );
    return (rowCount ?? 0) > 0;
  }

  /**
   * 整组视觉分析缓存回写。只写 visual_analysis、不抬 updated_at；WHERE 同语句核对本次实际分析的
   * 前 N 张有序图片锚（index/capturedAt/usableUrl），浏览闭环若已换图则弃写，避免旧分析覆盖新素材。
   */
  async annotateReferenceVisualAnalysis(
    rowId: number,
    analysis: ReferenceVisualAnalysis,
    anchors: VisualAnalysisAnchor[],
  ): Promise<boolean> {
    const normalized = normalizeReferenceVisualAnalysis(analysis);
    if (
      !normalized ||
      (normalized.status !== 'analyzed' && normalized.status !== 'partial') ||
      !Number.isInteger(rowId) ||
      rowId <= 0 ||
      anchors.length === 0 ||
      anchors.length > 9
    ) return false;
    const expected = anchors.map((anchor) => ({
      sourceArrayIndex: anchor.sourceArrayIndex,
      sourceIndex: anchor.sourceIndex,
      capturedAt: anchor.capturedAt,
      url: anchor.url,
    }));
    const { rowCount } = await this.pool.query(
      `UPDATE curated_content
          SET visual_analysis = $2::jsonb
        WHERE id = $1
          AND (
            SELECT COALESCE(
              jsonb_agg(
                jsonb_build_object(
                  'sourceArrayIndex', src.usable_pos - 1,
                  'sourceIndex', COALESCE((src.item->>'index')::int, src.usable_pos - 1),
                  'capturedAt', COALESCE((src.item->>'capturedAt')::bigint, 0),
                  'url', COALESCE(NULLIF(src.item->>'ossUrl', ''), src.item->>'sourceUrl')
                ) ORDER BY src.pos
              ),
              '[]'::jsonb
            )
            FROM (
              SELECT item, pos, row_number() OVER (ORDER BY pos) AS usable_pos
                FROM jsonb_array_elements(reference_images) WITH ORDINALITY AS images(item, pos)
               WHERE COALESCE(NULLIF(item->>'ossUrl', ''), NULLIF(item->>'sourceUrl', '')) IS NOT NULL
               ORDER BY pos
               LIMIT $4
            ) src
          ) = $3::jsonb`,
      [rowId, JSON.stringify(normalized), JSON.stringify(expected), anchors.length],
    );
    return (rowCount ?? 0) > 0;
  }

  /**
   * 记一次自有动作。
   *  - like：弱信号，只 UPDATE 既有行 bot_liked=true（行不存在则 no-op，不自动建行）。
   *  - collect：强信号，有非空正文时 INSERT ... ON CONFLICT 自动建/纳入；无正文时只标既有行、不补建壳行。
   */
  async markBotAction(
    accountId: string,
    sourceId: string,
    action: 'like' | 'collect',
    content?: CuratedActionContent,
  ): Promise<void> {
    if (action === 'like') {
      // 点赞为弱信号：只标既有行，不自动建行。
      await this.pool.query(
        `UPDATE curated_content SET bot_liked = true, updated_at = now()
         WHERE account_id = $1
           AND source_id = $2
           AND content_type IN ('image_text', 'video')`,
        [accountId, sourceId],
      );
      return;
    }
    // collect：自有收藏自动建/纳入（源帖维度）；没有非空正文时不补建精选壳行。
    const body = content?.body?.trim();
    if (!body) {
      await this.pool.query(
        `UPDATE curated_content SET bot_collected = true, updated_at = now()
         WHERE account_id = $1
           AND source_id = $2
           AND content_type IN ('image_text', 'video')`,
        [accountId, sourceId],
      );
      return;
    }

    const mediaType = normalizeSourceMediaType(content?.mediaType);
    const dedupKey = dedupKeyOf(accountId, mediaType, sourceId);
    const referenceImages = await this.prepareReferenceImages(accountId, sourceId, content?.referenceImages);
    await this.pool.query(
      `INSERT INTO curated_content
         (account_id, content_type, source_id, dedup_key, title, body, author, source_url,
          topics, reference_images, like_count, collect_count, admit_reason, bot_collected, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, NULL, NULL, $11, true, now())
       ON CONFLICT (dedup_key) DO UPDATE SET
         bot_collected = true,
         reference_images = CASE
                              WHEN curated_content.reference_images = '[]'::jsonb THEN EXCLUDED.reference_images
                              ELSE curated_content.reference_images
                            END,
         updated_at = now()`,
      [
        accountId,
        mediaType,
        sourceId,
        dedupKey,
        content?.title ?? null,
        body,
        content?.author ?? null,
        content?.sourceUrl ?? null,
        content?.topics ?? [],
        JSON.stringify(referenceImages),
        'bot_collect',
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
    input: { sourceId: string; text: string; author?: string; topics: string[]; sourceNoteTitle?: string; reason?: string; likeCount?: number | null },
  ): Promise<void> {
    const dedupKey = dedupKeyOf(accountId, 'comment', input.sourceId);
    await this.pool.query(
      `INSERT INTO curated_content
         (account_id, content_type, source_id, dedup_key, title, body, author, topics,
          like_count, bot_liked, admit_reason, updated_at)
       VALUES ($1, 'comment', $2, $3, $4, $5, $6, $7, $8, true, $9, now())
       ON CONFLICT (dedup_key) DO NOTHING`,
      [
        accountId,
        input.sourceId,
        dedupKey,
        input.sourceNoteTitle ?? null,
        input.text,
        input.author ?? null,
        input.topics,
        input.likeCount ?? null,
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
    contentType: CuratedContentTypeFilter,
    limit: number,
  ): Promise<CuratedSelectItem[]> {
    const params: unknown[] = [accountId];
    const conds = ['account_id = $1'];
    appendContentTypeFilter(conds, params, contentType);
    params.push(limit);
    const limitIdx = params.length;
    const { rows } = await this.pool.query<CuratedRow>(
      `SELECT source_id, content_type, title, body, author, topics,
              like_count, collect_count, bot_liked, bot_collected, reference_images, visual_analysis
       FROM curated_content
       WHERE ${conds.join(' AND ')}
       ORDER BY (CASE WHEN bot_collected THEN 2 ELSE 0 END + CASE WHEN bot_liked THEN 1 ELSE 0 END) DESC,
                collect_count DESC NULLS LAST,
                like_count DESC NULLS LAST,
                updated_at DESC
       LIMIT $${limitIdx}`,
      params,
    );
    return rows.map((r) => {
      const visualAnalysis = normalizeReferenceVisualAnalysis(r.visual_analysis);
      return {
        sourceId: r.source_id,
        contentType: normalizeContentType(r.content_type),
        title: r.title ?? '',
        body: r.body ?? '',
        author: r.author ?? undefined,
        topics: r.topics ?? [],
        likeCount: toNumOrNull(r.like_count),
        collectCount: toNumOrNull(r.collect_count),
        botLiked: r.bot_liked,
        botCollected: r.bot_collected,
        referenceImages: parseReferenceImages(r.reference_images),
        ...(visualAnalysis ? { visualAnalysis } : {}),
      };
    });
  }

  // ── 后台管理（change curated-content-admin-page）：只读检索 + 治理写 ──────────────
  // 红线：治理写（deleteOne / clearEmptyBody）把 account_id 写进 WHERE 防越权（id 是全局 SERIAL，故账号必填）；
  //      只读检索（listForPanel / facetsForPanel）accountId 给定＝按账号过滤、缺省＝全账号合并视图（每行携 account_id、
  //      删除仍按行账号防越权）；缺表（42P01）只读路径优雅降空，不抛 500。

  /**
   * 面板列表（分页只读）。
   * accountId 给定＝按该账号过滤；缺省（undefined/空）＝全账号合并视图（运营便利，每行带 account_id、删除仍按行账号防越权）。
   * 动态 WHERE 拼 account_id（可选）+ content_type / admit_reason 精确过滤，按 updated_at DESC，
   * COUNT(*) OVER() 同查询取回当前筛选总数。空结果集 total 兜底 0；缺表 42P01 → {items:[],total:0} 降级。
   */
  async listForPanel(
    accountId: string | undefined,
    opts: { contentType?: CuratedContentTypeFilter; admitReason?: string; limit: number; offset: number },
  ): Promise<CuratedPanelListResult> {
    const params: unknown[] = [];
    const conds: string[] = [];
    if (accountId) {
      params.push(accountId);
      conds.push(`account_id = $${params.length}`);
    }
    if (opts.contentType) {
      appendContentTypeFilter(conds, params, opts.contentType);
    }
    if (opts.admitReason) {
      params.push(opts.admitReason);
      conds.push(`admit_reason = $${params.length}`);
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    params.push(opts.limit);
    const limitIdx = params.length;
    params.push(opts.offset);
    const offsetIdx = params.length;
    try {
      const { rows } = await this.pool.query<CuratedPanelDbRow>(
        `SELECT id, account_id, content_type, source_id, title, body, author, source_url, topics,
                like_count, collect_count, comment_count, counts_captured_at, reference_images,
                visual_analysis,
                bot_liked, bot_collected, admit_reason, first_seen_at, updated_at,
                COUNT(*) OVER() AS total_count
         FROM curated_content
         ${where}
         ORDER BY updated_at DESC
         LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
        params,
      );
      const total = rows.length > 0 ? Number(rows[0].total_count) : 0;
      return { items: rows.map(rowToPanelView), total };
    } catch (err) {
      if ((err as { code?: string }).code === '42P01') return { items: [], total: 0 };
      throw err;
    }
  }

  /**
   * 面板筛选面：纳入原因去重 + 各自计数 + 携双标记的高权重行数 + 笔记/评论计数。
   * accountId 给定＝按该账号；缺省（undefined/空）＝全账号合并统计（驱动全账号视图下的筛选下拉）。
   * 驱动筛选下拉（不硬编码原因）与清理前影响预览。缺表 42P01 → 空降级。
   */
  async facetsForPanel(accountId?: string): Promise<CuratedFacets> {
    const where = accountId ? 'WHERE account_id = $1' : '';
    const params = accountId ? [accountId] : [];
    try {
      const reasonsP = this.pool.query<{ admit_reason: string | null; count: string; bot_action_count: string }>(
        `SELECT admit_reason,
                COUNT(*) AS count,
                SUM(CASE WHEN bot_liked OR bot_collected THEN 1 ELSE 0 END) AS bot_action_count
         FROM curated_content
         ${where}
         GROUP BY admit_reason
         ORDER BY count DESC`,
        params,
      );
      const typesP = this.pool.query<{ content_type: string; count: string }>(
        `SELECT content_type, COUNT(*) AS count
         FROM curated_content
         ${where}
         GROUP BY content_type`,
        params,
      );
      const [reasonsR, typesR] = await Promise.all([reasonsP, typesP]);
      let imageTextCount = 0;
      let videoCount = 0;
      let commentCount = 0;
      for (const r of typesR.rows) {
        if (r.content_type === 'comment') commentCount = Number(r.count);
        else if (r.content_type === 'video') videoCount = Number(r.count);
        else imageTextCount = Number(r.count);
      }
      return {
        admitReasons: reasonsR.rows.map((r) => ({
          admitReason: r.admit_reason,
          count: Number(r.count),
          botActionCount: Number(r.bot_action_count),
        })),
        imageTextCount,
        videoCount,
        noteCount: imageTextCount + videoCount,
        commentCount,
      };
    } catch (err) {
      if ((err as { code?: string }).code === '42P01') {
        return { admitReasons: [], imageTextCount: 0, videoCount: 0, noteCount: 0, commentCount: 0 };
      }
      throw err;
    }
  }

  /**
   * 读单行（行级动作用，change curated-note-actions）。
   * account_id 必进 WHERE 防越权（同 deleteOne：id 是全局 SERIAL，仅凭 id 不可触别账号行）。
   * 未命中/跨账号不匹配 → null；缺表 42P01 → null 优雅降级，不抛 500。
   */
  async getOneForAccount(id: number, accountId: string): Promise<CuratedPanelRow | null> {
    try {
      const { rows } = await this.pool.query<CuratedPanelDbRow>(
        `SELECT id, account_id, content_type, source_id, title, body, author, source_url, topics,
                like_count, collect_count, comment_count, counts_captured_at, reference_images,
                visual_analysis,
                bot_liked, bot_collected, admit_reason, first_seen_at, updated_at
         FROM curated_content
         WHERE id = $1 AND account_id = $2`,
        [id, accountId],
      );
      return rows.length > 0 ? rowToPanelView(rows[0]) : null;
    } catch (err) {
      if ((err as { code?: string }).code === '42P01') return null;
      throw err;
    }
  }

  /**
   * 删除单条（误纳入/低质/隐私）。account_id 必进 WHERE 防越权（仅凭全局 id 不可触别账号行）。
   * 返回真实删除行数（0|1）——删 0 与删 1 由调用方诚实区分，绝不假成功。
   * 注意：删除仅清当前快照；准入不查史，下次再观测到且仍达标会经 upsert 重新纳入。
   */
  async deleteOne(accountId: string, id: number): Promise<number> {
    const { rowCount } = await this.pool.query(`DELETE FROM curated_content WHERE id = $1 AND account_id = $2`, [
      id,
      accountId,
    ]);
    return rowCount ?? 0;
  }

  /**
   * 清理「空正文壳行」（body 为 NULL 或空串），按账号约束。
   * 刻意用「正文为空」一条确定性谓词，而非「按纳入原因」——空壳行恰带机器人收藏标记（高权重），
   * 任何「按原因 + 默认保护机器人动作行」的清理都会保护壳行、误删有正文优质行。返回真实清理条数。
   */
  async clearEmptyBody(accountId: string): Promise<number> {
    const { rowCount } = await this.pool.query(
      `DELETE FROM curated_content WHERE account_id = $1 AND (body IS NULL OR body = '')`,
      [accountId],
    );
    return rowCount ?? 0;
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
