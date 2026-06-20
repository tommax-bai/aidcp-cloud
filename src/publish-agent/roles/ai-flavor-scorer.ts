import { BasePublishRole } from './base-role.js';
import type { RoleConfig } from './base-role.js';
import type { PipelineFields, CleanedContent, AiFlavorScore } from '../types.js';
import type { PipelineContext } from '../pipeline-context.js';

/**
 * AiFlavorScorer — AI 味分（A 阶段2）。
 * 对 cleanedContent.aiScore 的**显式投影**：不重算、不篡改，恒等写出。
 * 拆成独立角色是为「一职一角色」+ 留独立演进点（将来可换更强的 AI 味判定）。
 */
export class AiFlavorScorerRole extends BasePublishRole<CleanedContent, AiFlavorScore> {
  readonly config: RoleConfig = {
    name: 'AiFlavorScorer',
    watchKeys: ['cleanedContent'],
    timeoutMs: 5000,
    fallback: 'default',
  };
  protected readonly outputKey = 'aiFlavorScore' as const;

  protected extractInput(snapshot: Partial<PipelineFields>): CleanedContent {
    return snapshot.cleanedContent!;
  }

  protected async execute(input: CleanedContent, _context: PipelineContext<PipelineFields>): Promise<AiFlavorScore> {
    // 恒等投影：aiScore 如实取自清洗结果，绝不篡改/抹零。
    return { aiScore: input.aiScore, scoredAt: this.clock() };
  }

  protected override getDefaultOutput(): AiFlavorScore {
    return { aiScore: 0, scoredAt: this.clock() };
  }
}
