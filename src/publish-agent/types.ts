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
