import type { Soul } from '../soul/types.js';

// ─── 从 publish/types.ts 迁移的类型 ────────────────────────────────────────────

/** 一个已积累的技术概念（concepts 表的投影）。 */
export interface Concept {
  /** 概念关键词 */
  keyword: string;
  /** 来源笔记标题（可空） */
  sourceNote?: string;
  /** 发现时间（毫秒时间戳，可空） */
  discoveredAt?: number;
}

/** 一条点赞过的笔记摘要（供生成内容时引用真实细节）。 */
export interface LikedNote {
  /** 点赞记录 id（用于回填 source_liked_ids） */
  id: number;
  /** 笔记标题 */
  title: string;
  /** 正文摘要 */
  summary: string;
  /** 作者（可空） */
  author?: string;
}

/** 去 AI 味后处理结果。 */
export interface PostProcessResult {
  /** 处理后的正文（可能被重写） */
  content: string;
  /** 0-1，AI 味浓度评分（命中禁用词越多越高） */
  aiScore: number;
  /** 是否触发了重写 */
  rewritten: boolean;
  /** 命中的禁用词/句式 */
  flaggedPhrases: string[];
}

/** 发布记录状态。 */
export type PublishStatus = 'draft' | 'published' | 'failed' | 'needs_review';

/** 一条发布记录（publish_log 表的投影）。 */
export interface PublishRecord {
  id?: number;
  title: string | null;
  content: string;
  /** 引用的概念关键词 */
  sourceConcepts: string[];
  /** 引用的点赞内容 id */
  sourceLikedIds: number[];
  status: PublishStatus;
  /** 发布成功后回填的平台帖子 id */
  platformPostId?: string | null;
  /** 生成的配图 URL（审计用；是否真附着以 imagesAttached 为准）。 */
  imageUrl?: string | null;
  /** 配图是否真实附着到帖子。降级纯文字时为 false——「该帖是否真有图」的权威信号。 */
  imagesAttached?: boolean;
}

// ─── 管道角色类型 ──────────────────────────────────────────────────────────────

/** 触发器输入度量 */
export interface TriggerInput {
  metrics: {
    hoursSinceLastPublish: number;
    newConceptCount: number;
    likedSinceLastPublish: number;
  };
  generateInput: {
    concepts: Array<{ keyword: string; sourceNote?: string; discoveredAt?: number }>;
    likedContents: Array<{ id: number; title: string; summary: string; author: string }>;
    soul: Soul;
    recentPosts: string[];
  };
  recentPublished: string[];
}

/** ContentScout 输出 */
export interface ScoutDecision {
  shouldPublish: boolean;
  publishDirection: string;
  keyPoints: string[];
  confidence: number;
  reason: string;
  scoutedAt: number;
}

/** ContentCreator 输出 */
export interface CreatedContent {
  title: string;
  content: string;
  tags: string[];
  tone: 'professional' | 'casual' | 'technical' | 'narrative';
  style: Record<string, string>;
  createdAt: number;
}

/** ImageDirector 输出 */
export interface ImageDirective {
  imagePrompt: string | null;
  imageUrl: string | null;
  imageStyle: 'photography' | 'illustration' | 'dataviz' | 'isometric' | null;
  fallbackStrategy: 'skip' | 'color_placeholder';
  directedAt: number;
}

/** ContentAssembler 输出（稳定边界：阶段2 细拆后逐字不改） */
export interface AssembledContent {
  finalContent: string;
  finalTags: string[];
  imageUrl: string | null;
  aiScore: number;
  qualityScore: number;
  rewritten: boolean;
  flaggedPhrases: string[];
  assembledAt: number;
}

// ─── 阶段2 生产段细拆新增中间键（A 重构 publish-content-media-roles） ──────────

/** ContentTypeSelector 输出：内容类型（现恒图文，kind 联合预留 video/text）。 */
export interface ContentType {
  kind: 'image_text' | 'video' | 'text';
  selectedAt: number;
}

/** ImagePlanner 输出：配图决策（要不要图 / prompt / 风格 / 张数）。 */
export interface ImagePlan {
  wantImage: boolean;
  imagePrompt: string | null;
  imageStyle: ImageDirective['imageStyle'];
  imageCount: number;
  fallbackStrategy: ImageDirective['fallbackStrategy'];
  plannedAt: number;
}

/** ContentCleaner 输出：去 AI 味后处理结果（PostProcessResult + cleanedAt）。 */
export interface CleanedContent {
  content: string;
  rewritten: boolean;
  flaggedPhrases: string[];
  aiScore: number;
  cleanedAt: number;
}

/** AiFlavorScorer 输出：AI 味分（对 cleanedContent.aiScore 的显式投影）。 */
export interface AiFlavorScore {
  aiScore: number;
  scoredAt: number;
}

/** QualityScorer 输出：质量评分（LLM 评审；失败按 aiScore 公式降级）。 */
export interface QualityReport {
  qualityScore: number;
  reviewedAt: number;
}

/** CoverSelector 输出：封面选择（无图诚实回 null + hasCover:false）。 */
export interface CoverSelection {
  imageUrl: string | null;
  hasCover: boolean;
  selectedAt: number;
}

// ─── 阶段3 元数据 + 合规决策键（A 重构 publish-metadata-compliance-roles） ──────
// 纯决策（cloud）：产出但本阶段不应用到边缘（edge 应用 + 落库 + 防篡改持久化 → stage-4）。
// assembledContent 八字段逐字不动；元数据走并行 publishMetadata 键。

export type Visibility = 'public' | 'friends_only' | 'self_only';
export type PublishMode = 'immediate' | 'draft' | 'scheduled';
export type PermissionLevel = 'allow' | 'restrict' | 'disable';

/** TopicStrategist 输出：话题（3-30，扩展 createdContent.tags，不编造凑数）。 */
export interface TopicSelection {
  selectedTopics: string[];
  selectedAt: number;
}
/** MentionStrategist 输出：@提及（去重、剔自身、≤10，无人选回 []）。 */
export interface MentionSelection {
  selectedMentions: string[];
  selectedAt: number;
}
/** LocationStrategist 输出：地点（可空，无则 null，不编造）。 */
export interface LocationSelection {
  selectedLocation: string | null;
  selectedAt: number;
}
/** CollectionStrategist 输出：合集（可空，无则 null，不编造）。 */
export interface CollectionSelection {
  selectedCollection: string | null;
  selectedAt: number;
}
/** VisibilityDecider 输出：可见范围（云端必选非 null；失败保守降 self_only，绝不隐式 public）。 */
export interface VisibilityDecision {
  visibility: Visibility;
  reason: string;
  decidedAt: number;
}
/** PermissionDecider 输出：评论/保存权限（失败保守关闭）。 */
export interface PermissionDecision {
  comment: PermissionLevel;
  save: 'allow' | 'disable';
  decidedAt: number;
}
/** PublishModeDecider 输出：发布方式（定时须未来且 ≤7 天；非定时 publishTime=null）。 */
export interface PublishModeDecision {
  mode: PublishMode;
  publishTime: number | null;
  decidedAt: number;
}
/** 合规声明（2026 硬规：含 AI 生成则强制 ai=true；aiEnforced 置位后不可降）。 */
export interface Compliance {
  ai?: boolean;
  ad?: boolean;
  origin?: boolean;
  /** AI 声明被红线强制置位（aiScore 超阈或命中关键词）；一经置位禁止降级。 */
  aiEnforced?: boolean;
}
/** ComplianceDecider 输出。 */
export interface ComplianceDecision {
  compliance: Compliance;
  decidedAt: number;
}

/** MetadataAggregator 汇合产出：发帖元数据（并行于 assembledContent，本阶段不应用到边缘）。 */
export interface PublishMetadata {
  topics: string[];
  mentions: string[];
  location: string | null;
  collection: string | null;
  /** 云端必选非 null。 */
  visibility: Visibility;
  permissions: { comment: PermissionLevel; save: 'allow' | 'disable' };
  mode: PublishMode;
  publishTime: number | null;
  compliance: Compliance;
  /** 元数据完整度 0-1（如实，缺失项计 0、不虚高）。 */
  metadataScore: number;
  decidedAt: number;
}

/** 元数据保守默认（不凑数/不伪造/最保守，单一来源；各角色降级与聚合兜底共用）。 */
export const METADATA_DEFAULT_VALUES: Omit<PublishMetadata, 'decidedAt'> = {
  topics: [],
  mentions: [],
  location: null,
  collection: null,
  visibility: 'self_only',
  permissions: { comment: 'disable', save: 'disable' },
  mode: 'draft',
  publishTime: null,
  compliance: {},
  metadataScore: 0,
};

/** ApprovalGatekeeper 输出 */
export interface GateDecision {
  needsApproval: boolean;
  recommendedAction: 'auto_publish' | 'manual_review' | 'retry' | 'abort';
  reason: string;
  decidedAt: number;
}

/** PublishExecutor 输出 */
export interface PublishResult {
  recordId: number | null;
  status: 'draft' | 'published' | 'needs_review' | 'failed' | 'skipped';
  dispatched: boolean;
  envelope: unknown | null;
  completedAt: number;
}

/** 管道上下文字段映射（Blackboard 的 schema） */
export interface PipelineFields {
  trigger: TriggerInput;
  scoutDecision: ScoutDecision;
  createdContent: CreatedContent;
  // 阶段2 生产段细拆中间键
  contentType: ContentType;
  imagePlan: ImagePlan;
  cleanedContent: CleanedContent;
  aiFlavorScore: AiFlavorScore;
  qualityReport: QualityReport;
  coverSelection: CoverSelection;
  imageDirective: ImageDirective;
  assembledContent: AssembledContent;
  // 阶段3 元数据 + 合规决策键（并行于发布链，本阶段不应用到边缘）
  topicSelection: TopicSelection;
  mentionSelection: MentionSelection;
  locationSelection: LocationSelection;
  collectionSelection: CollectionSelection;
  visibilityDecision: VisibilityDecision;
  permissionDecision: PermissionDecision;
  publishModeDecision: PublishModeDecision;
  complianceDecision: ComplianceDecision;
  publishMetadata: PublishMetadata;
  gateDecision: GateDecision;
  publishResult: PublishResult;
  /** 特殊信号：质量不达标时的重试请求 */
  retrySignal: { reason: string; attempt: number };
}

/** 管道运行状态 */
export type PipelineStatus = 'idle' | 'running' | 'completed' | 'failed' | 'timeout';

/** 角色调用选项 */
export interface RoleInvokeOptions {
  timeoutMs?: number;
  fallbackBehavior?: 'skip' | 'abort' | 'default';
}

/** PublishOrchestrator 依赖 */
export interface OrchestratorDeps {
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
  clock?: () => number;
  idGen?: () => string;
  pipelineTimeoutMs?: number;
}
