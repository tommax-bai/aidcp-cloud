import { BasePublishRole } from './base-role.js';
import type { RoleConfig } from './base-role.js';
import type { PipelineFields, CreatedContent, CleanedContent, QualityReport, PostProcessResult, ImageCategory } from '../types.js';
import type { PipelineContext } from '../pipeline-context.js';
import { buildAssemblerPrompt } from '../prompts.js';
import { executeWithFallback } from '../retry-strategy.js';
import type { ChatLlmClient } from '../../llm/qwen.js';
import type { Soul } from '../../soul/types.js';

// change raise-model-call-timeouts-for-thinking-models：角色闸 ≥ 单次模型天花板（180s）且同传进 chat()，
// 使一次合法的 thinking 质量评审不被角色秒表提前掐断（旧 20s 峰值必误超时→退化公式打分）。env 可调。
const QUALITY_TIMEOUT_MS = Number(process.env.AIDCP_PUBLISH_QUALITY_TIMEOUT_MS ?? 180_000);

interface QualityScorerInput {
  created: CreatedContent;
  cleaned: CleanedContent;
  // change category-adaptive-images-and-judgment：评审接人设 + 本帖品类（管线内已可达，无新跨阶段 plumbing）。
  soul: Soul | null;
  category: ImageCategory;
}

/**
 * QualityScorer — 内容质量评分（A 阶段2，从 ContentAssembler 拆出 Step 2）。
 * LLM 评审产出 qualityScore；失败/非法 JSON → 按 aiScore 公式降级（逐字沿用现 content-assembler.ts:66）。
 * 与 AiFlavorScorer 分职：本角色只产 qualityScore，绝不硬编码满分、绝不抹分。
 */
export interface QualityScorerDeps {
  llmClient: ChatLlmClient;
  clock?: () => number;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
}

export class QualityScorerRole extends BasePublishRole<QualityScorerInput, QualityReport> {
  readonly config: RoleConfig = {
    name: 'QualityScorer',
    watchKeys: ['cleanedContent'],
    timeoutMs: QUALITY_TIMEOUT_MS,
    fallback: 'default',
  };
  protected readonly outputKey = 'qualityReport' as const;
  private llmClient: ChatLlmClient;

  constructor(deps: QualityScorerDeps) {
    super({ logger: deps.logger, clock: deps.clock });
    this.llmClient = deps.llmClient;
  }

  protected extractInput(snapshot: Partial<PipelineFields>): QualityScorerInput {
    return {
      created: snapshot.createdContent!,
      cleaned: snapshot.cleanedContent!,
      soul: snapshot.trigger?.generateInput?.soul ?? null,
      category: snapshot.postCategory?.category ?? 'general',
    };
  }

  protected async execute(input: QualityScorerInput, context: PipelineContext<PipelineFields>): Promise<QualityReport> {
    const ppResult: PostProcessResult = {
      content: input.cleaned.content,
      aiScore: input.cleaned.aiScore,
      rewritten: input.cleaned.rewritten,
      flaggedPhrases: input.cleaned.flaggedPhrases,
    };
    const { result: review, usedFallback } = await executeWithFallback(
      async () => {
        const raw = await this.llmClient.chat([
          { role: 'system', content: '你是内容质量评审员。严格返回JSON。' },
          // 评审对象必须是将发布文本：正文用清洗稿（未重写时与草稿相同）；标题/标签仍取定稿来源。
          { role: 'user', content: buildAssemblerPrompt({ ...input.created, content: input.cleaned.content }, ppResult, input.soul, input.category) },
        ], { timeoutMs: QUALITY_TIMEOUT_MS, accountId: this.accountIdFrom(context) });
        return this.parseReviewOutput(raw);
      },
      // 降级：逐字沿用历史公式 round((1-aiScore)*70)（无 AI 味时基准 70；绝不硬编码满分）。见 design Open Questions。
      { default: { qualityScore: Math.round((1 - input.cleaned.aiScore) * 70) }, reason: 'LLM quality review failed' },
    );
    if (usedFallback) this.logger.warn('[QualityScorer] 评审失败，按 aiScore 公式降级');
    return { qualityScore: review.qualityScore, reviewedAt: this.clock() };
  }

  protected override getDefaultOutput(): QualityReport {
    return { qualityScore: 50, reviewedAt: this.clock() };
  }

  private parseReviewOutput(raw: string): { qualityScore: number } {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('No JSON found in QualityScorer output');
    const obj = JSON.parse(match[0]);
    const score = Number(obj.qualityScore);
    return { qualityScore: isNaN(score) ? 50 : Math.max(0, Math.min(100, score)) };
  }
}
