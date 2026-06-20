import { BasePublishRole } from './base-role.js';
import type { RoleConfig } from './base-role.js';
import type { PipelineFields, CreatedContent, MentionSelection } from '../types.js';
import type { PipelineContext } from '../pipeline-context.js';

/**
 * MentionStrategist — @提及决策（A 阶段3，纯规则、确定性、不调 LLM）。
 * 本阶段无 @ 数据源（无好友/协作者/被点赞作者的可 @ 句柄），规则恒回 []：
 * 无人可选时绝不伪造 @ 句柄（红线：不编造/不凑数）。
 * 预留：将来从 createdContent / 点赞内容抽取真实可 @ 对象（去重、剔自身、≤10）。
 */
export class MentionStrategistRole extends BasePublishRole<CreatedContent, MentionSelection> {
  readonly config: RoleConfig = {
    name: 'MentionStrategist',
    watchKeys: ['createdContent'],
    timeoutMs: 5000,
    fallback: 'default',
  };
  protected readonly outputKey = 'mentionSelection' as const;

  protected extractInput(snapshot: Partial<PipelineFields>): CreatedContent {
    return snapshot.createdContent!;
  }

  protected async execute(
    _input: CreatedContent,
    _context: PipelineContext<PipelineFields>,
  ): Promise<MentionSelection> {
    // 本阶段无 @ 数据源 → 恒回 []，不伪造句柄。
    return { selectedMentions: [], selectedAt: this.clock() };
  }

  protected override getDefaultOutput(): MentionSelection {
    return { selectedMentions: [], selectedAt: this.clock() };
  }
}
