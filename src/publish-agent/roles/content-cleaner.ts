import { BasePublishRole } from './base-role.js';
import type { RoleConfig } from './base-role.js';
import type { PipelineFields, CreatedContent, CleanedContent, PostProcessResult } from '../types.js';
import type { PipelineContext } from '../pipeline-context.js';
import { executeWithFallback } from '../retry-strategy.js';
import { exclamationMaxForTone } from '../post-processor.js';

/** 去 AI 味后处理器接口（从原 ContentAssembler 迁出，server 注入 PostProcessor）。 */
export interface PostProcessorLike {
  process(content: string, exclamationMax?: number): Promise<PostProcessResult>;
}

/**
 * 去 AI 味清洗超时（change raise-model-call-timeouts-for-thinking-models）。
 * 实际模型调用在 server.ts 注入的 PostProcessor.rewrite（llm.complete）里，故此常量**同时**给角色闸与该 complete() 的超时，
 * 两处共读、防漂移；MUST ≥ 单次模型调用天花板（180s），角色闸绝不短于所包裹的模型预算。重写比普通生成更慢，故给足。
 */
export const CLEAN_TIMEOUT_MS = Number(process.env.AIDCP_PUBLISH_CLEAN_TIMEOUT_MS ?? 180_000);

/**
 * ContentCleaner — 去 AI 味清洗（A 阶段2，从 ContentAssembler 拆出 Step 1）。
 * 复用现有 PostProcessor（不改其实现），产出 cleanedContent（含 aiScore，供下游评分/组装）。
 * R1 死锁防护：execute 用 executeWithFallback 兜底，无论成败必写 cleanedContent 键。
 */
export interface ContentCleanerDeps {
  postProcessor: PostProcessorLike;
  clock?: () => number;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
}

export class ContentCleanerRole extends BasePublishRole<CreatedContent, CleanedContent> {
  readonly config: RoleConfig = {
    name: 'ContentCleaner',
    watchKeys: ['createdContent'],
    timeoutMs: CLEAN_TIMEOUT_MS,
    fallback: 'default',
  };
  protected readonly outputKey = 'cleanedContent' as const;
  private postProcessor: PostProcessorLike;

  constructor(deps: ContentCleanerDeps) {
    super({ logger: deps.logger, clock: deps.clock });
    this.postProcessor = deps.postProcessor;
  }

  protected extractInput(snapshot: Partial<PipelineFields>): CreatedContent {
    return snapshot.createdContent!;
  }

  protected async execute(input: CreatedContent, _context: PipelineContext<PipelineFields>): Promise<CleanedContent> {
    // 感叹号检测上限按本帖语气分档（与生成侧 buildCreatorPrompt 同一套口径）：生活/情感类放宽、专业/克制类保持严。
    const exclamationMax = exclamationMaxForTone(input.tone);
    const { result: pp, usedFallback } = await executeWithFallback(
      () => this.postProcessor.process(input.content, exclamationMax),
      {
        // 清洗失败降级：退回原文、按"无 AI 味检出"记 aiScore=0（如实标未重写），保证键必写不死锁。
        default: { content: input.content, aiScore: 0, rewritten: false, flaggedPhrases: [] } as PostProcessResult,
        reason: 'postProcessor.process failed',
      },
    );
    if (usedFallback) this.logger.warn('[ContentCleaner] 清洗失败，降级退回原文');
    return {
      content: pp.content,
      rewritten: pp.rewritten,
      flaggedPhrases: pp.flaggedPhrases,
      aiScore: pp.aiScore,
      cleanedAt: this.clock(),
    };
  }

  protected override getDefaultOutput(): CleanedContent {
    return { content: '', rewritten: false, flaggedPhrases: [], aiScore: 0, cleanedAt: this.clock() };
  }
}
