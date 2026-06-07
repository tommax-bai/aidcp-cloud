import { BasePublishRole } from './base-role.js';
import type { RoleConfig } from './base-role.js';
import type { PipelineFields, CreatedContent, ImageDirective, AssembledContent } from '../types.js';
import type { PipelineContext } from '../pipeline-context.js';
import { buildAssemblerPrompt } from '../prompts.js';
import { executeWithFallback } from '../retry-strategy.js';
import type { QwenClient } from '../../llm/qwen.js';
import type { PostProcessResult } from '../types.js';

export interface PostProcessorLike {
  process(content: string): Promise<PostProcessResult>;
}

export interface ContentAssemblerDeps {
  llmClient: QwenClient;
  postProcessor: PostProcessorLike;
  clock?: () => number;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
}

interface AssemblerInput {
  createdContent: CreatedContent;
  imageDirective: ImageDirective;
}

export class ContentAssemblerRole extends BasePublishRole<AssemblerInput, AssembledContent> {
  readonly config: RoleConfig = {
    name: 'ContentAssembler',
    watchKeys: ['createdContent', 'imageDirective'],
    waitAll: true,
    timeoutMs: 20000,
    fallback: 'default',
  };
  protected readonly outputKey = 'assembledContent' as const;
  private llmClient: QwenClient;
  private postProcessor: PostProcessorLike;

  constructor(deps: ContentAssemblerDeps) {
    super({ logger: deps.logger, clock: deps.clock });
    this.llmClient = deps.llmClient;
    this.postProcessor = deps.postProcessor;
  }

  protected extractInput(snapshot: Partial<PipelineFields>): AssemblerInput {
    return {
      createdContent: snapshot.createdContent!,
      imageDirective: snapshot.imageDirective!,
    };
  }

  protected async execute(input: AssemblerInput, _context: PipelineContext<PipelineFields>): Promise<AssembledContent> {
    const { createdContent, imageDirective } = input;

    // Step 1: PostProcessor 禁用词检测 + 去AI味
    const ppResult = await this.postProcessor.process(createdContent.content);

    // Step 2: LLM 质量评审
    const { result: review, usedFallback } = await executeWithFallback(
      async () => {
        const raw = await this.llmClient.chat([
          { role: 'system', content: '你是内容质量评审员。严格返回JSON。' },
          { role: 'user', content: buildAssemblerPrompt(createdContent, ppResult) },
        ]);
        return this.parseReviewOutput(raw);
      },
      { default: { qualityScore: Math.round((1 - ppResult.aiScore) * 70) }, reason: 'LLM review failed' },
    );

    if (usedFallback) {
      this.logger.warn('[ContentAssembler] LLM review failed, using aiScore-based qualityScore');
    }

    // Step 3: 组装最终内容
    return {
      finalContent: ppResult.content,
      finalTags: createdContent.tags,
      imageUrl: imageDirective.imageUrl,
      aiScore: ppResult.aiScore,
      qualityScore: review.qualityScore,
      rewritten: ppResult.rewritten,
      flaggedPhrases: ppResult.flaggedPhrases,
      assembledAt: this.clock(),
    };
  }

  private parseReviewOutput(raw: string): { qualityScore: number } {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('No JSON found in Assembler review output');
    const obj = JSON.parse(match[0]);
    const score = Number(obj.qualityScore);
    return { qualityScore: isNaN(score) ? 50 : Math.max(0, Math.min(100, score)) };
  }
}
