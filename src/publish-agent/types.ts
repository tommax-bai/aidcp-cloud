import type { Soul } from '../soul/types.js';

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

/** ContentAssembler 输出 */
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
