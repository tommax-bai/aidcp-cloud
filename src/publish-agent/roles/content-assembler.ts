import { BasePublishRole } from './base-role.js';
import type { RoleConfig } from './base-role.js';
import type {
  PipelineFields,
  CreatedContent,
  CleanedContent,
  AiFlavorScore,
  QualityReport,
  CoverSelection,
  AssembledContent,
} from '../types.js';
import type { PipelineContext } from '../pipeline-context.js';

/**
 * ContentAssembler（瘦身，A 阶段2）— 纯组装，无 LLM / 无 IO。
 * 汇合生产段各上游键产出稳定边界 assembledContent（八字段逐字同形，下游零改动）。
 * 清洗 / AI 味分 / 质量分 / 配图 已分别拆到 ContentCleaner / AiFlavorScorer / QualityScorer / ImageGenerator+CoverSelector。
 */
interface AssemblerInput {
  cleaned: CleanedContent;
  aiFlavor: AiFlavorScore;
  quality: QualityReport;
  cover: CoverSelection;
  created: CreatedContent;
}

export class ContentAssemblerRole extends BasePublishRole<AssemblerInput, AssembledContent> {
  readonly config: RoleConfig = {
    name: 'ContentAssembler',
    // waitAll 五键：各由"无论成败必写自己键"的角色生产（R1 死锁防护）。
    watchKeys: ['cleanedContent', 'aiFlavorScore', 'qualityReport', 'imageDirective', 'coverSelection'],
    waitAll: true,
    timeoutMs: 10000,
    fallback: 'default',
  };
  protected readonly outputKey = 'assembledContent' as const;

  protected extractInput(snapshot: Partial<PipelineFields>): AssemblerInput {
    return {
      cleaned: snapshot.cleanedContent!,
      aiFlavor: snapshot.aiFlavorScore!,
      quality: snapshot.qualityReport!,
      cover: snapshot.coverSelection!,
      // createdContent 取 tags：早已就绪，从 snapshot 取、不入 watchKeys（避免与 cleanedContent 重复触发条件）。
      created: snapshot.createdContent!,
    };
  }

  protected async execute(input: AssemblerInput, _context: PipelineContext<PipelineFields>): Promise<AssembledContent> {
    return {
      finalContent: input.cleaned.content,
      finalTags: input.created.tags,
      imageUrl: input.cover.imageUrl,
      aiScore: input.aiFlavor.aiScore,
      qualityScore: input.quality.qualityScore,
      rewritten: input.cleaned.rewritten,
      flaggedPhrases: input.cleaned.flaggedPhrases,
      assembledAt: this.clock(),
    };
  }

  protected override getDefaultOutput(): AssembledContent {
    return {
      finalContent: '',
      finalTags: [],
      imageUrl: null,
      aiScore: 0,
      qualityScore: 0,
      rewritten: false,
      flaggedPhrases: [],
      assembledAt: this.clock(),
    };
  }
}
