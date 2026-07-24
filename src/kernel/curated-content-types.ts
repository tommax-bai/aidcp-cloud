/**
 * 精选灵感库的**纯数据模型类型**（kernel 段）。
 *
 * 只含精选内容 / 参照图 / 文字卡转写 / 面板行的类型与接口，无 SQL、无 pg 连接、无存储类、无读写函数——
 * 那些（CURATED_CONTENT_SCHEMA_SQL、CuratedContentStore 类、normalize* 函数、CuratedContentStoreOptions）
 * 留在 src/cache/curated-content-store.ts（content）。本文件供发布管线纯类型闭包与 api/automation 侧
 * type-only 共导，绝不让消费方拿到存储实现。
 */

import type { ReferenceVisualAnalysis } from './visual-reference-types.js';
import type { SourcePublishedAtPrecision, SourcePublishedAtStatus } from '../time/source-published-time.js';

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

export type TextCardTranscriptionStatus = 'complete' | 'partial' | 'failed';
export type TextCardTranscriptionCardStatus = 'transcribed' | 'empty' | 'failed';

/**
 * 一张来源文字卡的有序转写。sourceArrayIndex 是与 reference_images JSONB 数组绑定的权威槽位；
 * sourceIndex 只记录边缘看到的平台 index，不能用它代替数组槽位。
 */
export interface TextCardTranscriptionCard {
  sourceArrayIndex: number;
  sourceIndex: number;
  /** 云端收到本次图片快照的时刻；不是伪造的边缘抓取时间。 */
  capturedAt: number;
  status: TextCardTranscriptionCardStatus;
  text?: string;
  reason?: string;
}

/** curated_content.text_card_transcription 的唯一结构化事实源。 */
export interface TextCardTranscription {
  version: 1;
  status: TextCardTranscriptionStatus;
  /** sha256 over ordered sourceArrayIndex/sourceIndex/usableUrl identities. */
  anchor: string;
  provider: string;
  model: string;
  transcribedAt: number;
  cards: TextCardTranscriptionCard[];
}

export interface CuratedTextCardContext {
  referenceImages: CuratedReferenceImage[];
  transcription?: TextCardTranscription;
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
  /** Raw platform evidence. When present, publishedObservedAt is required as the conversion anchor. */
  publishedAtText?: string;
  publishedObservedAt?: number;
  admitReason: string;
  referenceImages?: CuratedReferenceImageInput[];
  textCardTranscription?: TextCardTranscription;
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
  publishedAtText?: string;
  publishedObservedAt?: number;
}

/** Successful non-empty source admission, used by the first-post onboarding trigger. */
export interface CuratedSourceAdmission {
  accountId: string;
  contentType: CuratedSourceContentType;
  sourceId: string;
  title?: string;
  body: string;
  author?: string;
  sourceUrl?: string;
  topics: string[];
  referenceImages: CuratedReferenceImage[];
  textCardTranscription?: TextCardTranscription;
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
  textCardTranscription?: TextCardTranscription;
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
  sourcePublishedAtText: string | null;
  sourcePublishedAt: number | null;
  sourcePublishedAtPrecision: SourcePublishedAtPrecision | null;
  sourcePublishedAtStatus: SourcePublishedAtStatus | null;
  sourcePublishedAtObservedAt: number | null;
  botLiked: boolean;
  botCollected: boolean;
  admitReason: string | null;
  firstSeenAt: number;
  updatedAt: number;
  referenceImages: CuratedReferenceImage[];
  visualAnalysis?: ReferenceVisualAnalysis;
  /** Internal/operator view; client-auth mapping intentionally does not expose source OCR text. */
  textCardTranscription?: TextCardTranscription;
}

/** 面板列表结果：当前筛选下的一页行 + 一致的总条数（供分页器）。 */
export interface CuratedPanelListResult {
  items: CuratedPanelRow[];
  total: number;
}

/** 客户端灵感库分页结果。行仍是 store 内部投影；HTTP 层必须再做最小披露映射。 */
export interface CuratedClientListResult {
  items: CuratedPanelRow[];
  total: number;
}

/** 客户端灵感库筛选：created/uncreated 只切分原可创作集合；all 保留精选池全量。 */
export type CuratedClientCreationStatus = 'uncreated' | 'created' | 'creatable' | 'all';

/** 客户端灵感库排序：只允许固定产品语义，调用方不得提交 SQL 字段或方向。 */
export type CuratedClientSort = 'weighted' | 'collects' | 'likes' | 'recent';

/**
 * 精选库缺表时的**哨兵错误**（原定义在 src/cache/curated-content-store.ts）。抬入 kernel 供
 * api 侧（client-auth-server / panel-server）在 `instanceof` 处捕获而无需 type-only 依赖 content 的存储类。
 * 纯 Error 子类：无 SQL / 无 pg / 无进程内活状态，满足 §4.7 kernel 准入（与 kernel/schema-capability-contract 的
 * SchemaCapabilityError 同一手法）。
 */
export class CuratedContentUnavailableError extends Error {
  constructor(readonly operation: string) {
    super(`curated content store unavailable (missing table) during ${operation}`);
    this.name = 'CuratedContentUnavailableError';
  }
}

/**
 * 精选库的**账号维读侧窄面**（consumer-facing reader port）。api 侧 client-auth-server 只驱动
 * 「按账号分页列表」与「按账号取单条」两个只读方法；返回类型全为本文件既有 kernel 纯类型。
 * content 侧 CuratedContentStore 结构兼容本端口，由组合根注入其实例；存储类不 import 本契约。
 */
export interface CuratedContentReader {
  listForClient(
    accountId: string,
    opts: { creationStatus: CuratedClientCreationStatus; sort?: CuratedClientSort; limit: number; offset: number },
  ): Promise<CuratedClientListResult>;
  getOneForAccount(id: number, accountId: string): Promise<CuratedPanelRow | null>;
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
